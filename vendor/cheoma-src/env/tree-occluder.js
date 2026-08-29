import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { patchInstFadeMaterial } from './inst-fade-shader.js';

// 전경 나무 오클루더 페이드 — 프레임워크 무관 ES 모듈.
//   setupTreeOccluder({ getSubject }) →
//     { register(group, opts), setSubject(point), update(camera, dt), dispose() }
//
// 자동 궤도 회전 중 카메라와 피사체(건물·마을 중심) 사이를 가로막는 근경 나무가 화면을 통째로
// 덮으며 지나가 시야가 막히는 걸 막는다. 시선을 가리는 나무만 부드럽게 dithered 페이드(스크린도어
// 투명)해 반투명하게 비치게 하고, 벗어나면 원복한다. 급격한 팝 없이 ~0.4s 이즈.
//
// 대상: InstancedMesh + 공유 MeshStandardMaterial 구조(env/trees.js·village scatterTrees).
//  - 재질을 onBeforeCompile 로 체인 패치(seasons·snow 패치 뒤에 얹힘): 인스턴스별 instFade(0..1)
//    를 IGN(interleaved-gradient noise) 디더 임계로 써서 fade 미만 픽셀을 discard. 정적 stipple 이라
//    프레임 간 깜빡임 없고, fade 가 이즈되며 픽셀이 서서히 생겼다 사라져 부드러운 반투명으로 읽힌다.
//  - 성능: 오클루전 타깃 재계산은 스로틀(RECOMPUTE_DT)+반경 프리필터(피사체보다 먼 나무 조기 제외),
//    instFade 이징만 매 프레임. 나무 캐노피 월드좌표는 정적이라 register 시 1회 캐시.
//  - 앱 마을은 VillageHandle.updateLod가 선택 필지 target을 setSubject로 전달하고 프레임당 한 번
//    update한다. 독립 호출자는 getSubject를 주고 자신의 프레임 루프에서 update한다.

const MIN_FADE = 0.18;     // 완전 오클루전 시 잔여 불투명(≈18% 픽셀 유지 → 반투명하게 비침)
const EASE_TAU = 0.14;     // 페이드 이징 시상수(초) — 약 0.4s 수렴(팝 방지)
const RECOMPUTE_DT = 0.09; // 오클루전 타깃 재계산 주기(초) — 매 프레임 전체 투영 금지
const SCREEN_IN = 0.13;    // 화면중심 반경 이내 = 완전 페이드
const SCREEN_OUT = 0.62;   // 이 반경 밖 = 페이드 없음(가장자리 나무는 시야를 안 막음)

// 컷 구간(focus 컷어웨이가 near plane 으로 걷어낸 전경) 안의 나무는 반투명이 아니라 완전 제거다.
//   near plane 은 프래그먼트 단위 클립이라 "지형면은 near 안쪽(사라짐) + 그 위 수관은 near 밖(생존)"
//   경계에 걸린 인스턴스가 땅 없이 공중에 남는다. 인스턴스를 통째로 걷어야 그 기하가 해소된다.
const CUT_FADE = 0;
// 판정 기준은 인스턴스의 실제 바운딩 구다: 구가 컷 평면보다 앞에 걸치면(어느 한 조각이라도 잘리면)
//   통째로 뺀다. 임의의 여유 상수를 두면 큰 수관은 여전히 반쪽으로 잘리고(부유), 작은 나무는 필요
//   없이 사라져 컷 경계 뒤에 민둥 띠가 남는다. 여유는 접선 인스턴스의 깜빡임만 막는 수치 오차폭이다.
const CUT_EPSILON = 0.5;

export function setupTreeOccluder({ getSubject } = {}) {
  // entries: { mesh, attr, pos(Float32 n*3 캐노피 월드), n, cur, tgt, cutOnly }
  const entries = [];
  // 컷 깊이(카메라 전방 view 깊이, m). 0 = 비활성. focus 컷어웨이가 실제로 발동한 프레임만 > 0.
  let cut = 0;
  // 공유 재질에 디더 페이드 주입(체인). seasons(vertex)·snow(fragment) 패치를 보존한다.
  function patchMaterial(mat) {
    patchInstFadeMaterial(mat);
  }

  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  // cutOnly: 화면중심 오클루전 페이드에는 참여하지 않고 컷 구간 은닉만 받는 등록(산 숲).
  //   숲은 시선 차단 판정 대상이 아니다(마을 밖 능선은 원래 보여야 한다) — 지형이 사라진 자리에만
  //   동반 은닉된다. 이 엔트리는 캐노피 대신 인스턴스 바운딩 구(월드 중심 + 스케일 반영 반경)를
  //   캐시해, 컷 평면에 걸치는 인스턴스를 정확히 골라낸다. 나무는 정적이라 등록 시 1회면 된다.
  function register(group, { canopyY = 4.0, cutOnly = false } = {}) {
    if (!group) return;
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isInstancedMesh) return;
      const n = o.count;
      if (!o.geometry.getAttribute('instFade')) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
        a.setUsage(THREE.DynamicDrawUsage);
        o.geometry.setAttribute('instFade', a);
      }
      const attr = o.geometry.getAttribute('instFade');
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const sphere = o.geometry.boundingSphere;
      const pos = new Float32Array(n * 3);
      const rad = cutOnly ? new Float32Array(n) : null;
      for (let i = 0; i < n; i++) {
        o.getMatrixAt(i, _m);
        if (cutOnly) {
          _v.copy(sphere.center).applyMatrix4(_m).applyMatrix4(o.matrixWorld);
          // 회전이 섞인 인스턴스 행렬에서도 반경 상한은 최대 축 스케일(열 길이)로 얻는다.
          const e = _m.elements;
          rad[i] = sphere.radius * Math.max(
            Math.hypot(e[0], e[1], e[2]),
            Math.hypot(e[4], e[5], e[6]),
            Math.hypot(e[8], e[9], e[10]),
          );
        } else {
          _v.set(0, canopyY, 0).applyMatrix4(_m).applyMatrix4(o.matrixWorld);
        }
        pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
      }
      entries.push({
        mesh: o, attr, pos, rad, n,
        cur: new Float32Array(n).fill(1), tgt: new Float32Array(n).fill(1),
        cutOnly, easing: false, cutActive: false,
      });
      patchMaterial(Array.isArray(o.material) ? o.material[0] : o.material);
    });
  }

  const _cam = new THREE.Vector3();
  const _subj = new THREE.Vector3();
  const _manualSubject = new THREE.Vector3();
  let hasManualSubject = false;
  const _dir = new THREE.Vector3();
  const _p = new THREE.Vector3();
  function setSubject(subject) {
    if (subject && [subject.x, subject.y, subject.z].every(Number.isFinite)) {
      _manualSubject.copy(subject);
      hasManualSubject = true;
    } else {
      hasManualSubject = false;
    }
  }
  // 컷 전용 엔트리(산 숲): 투영·거리 프리필터 없이 바운딩 구 중심 깊이 한 번의 내적만 본다.
  //   컷이 꺼진 프레임은 호출 자체를 건너뛰므로(cutActive) 평시 비용은 0이다.
  function recomputeCut(e, camDotDir) {
    const armed = cut > 0;
    const limit = cut + CUT_EPSILON;
    for (let i = 0; i < e.n; i++) {
      let t = 1;
      if (armed) {
        const depth = e.pos[i * 3] * _dir.x + e.pos[i * 3 + 1] * _dir.y
          + e.pos[i * 3 + 2] * _dir.z - camDotDir;
        // 구가 평면 앞으로 조금이라도 넘어오면 통째로 뺀다. 카메라 뒤(depth + rad <= 0)는 애초에
        // 화면에 없으므로 건드리지 않는다.
        const radius = e.rad[i];
        if (depth + radius > 0 && depth - radius < limit) t = CUT_FADE;
      }
      e.tgt[i] = t;
    }
    e.cutActive = armed;
    e.easing = true;
  }

  function recompute(camera) {
    _cam.setFromMatrixPosition(camera.matrixWorld);
    const s = (getSubject && getSubject()) || (hasManualSubject ? _manualSubject : null);
    _subj.copy(s || _subj.set(0, 0, 0));
    _dir.set(0, 0, -1).applyQuaternion(camera.quaternion); // 카메라 전방(월드)
    const camDotDir = _cam.dot(_dir); // 뒤편 판정용(할당 없이 (P-cam)·dir = P·dir - cam·dir)
    const subjDist = _cam.distanceTo(_subj);
    const cutoff2 = (subjDist * 0.92) ** 2; // 피사체보다 (거의) 먼 나무는 오클루더 아님
    for (const e of entries) {
      if (e.cutOnly) {
        if (cut > 0 || e.cutActive) recomputeCut(e, camDotDir);
        continue;
      }
      for (let i = 0; i < e.n; i++) {
        _p.set(e.pos[i * 3], e.pos[i * 3 + 1], e.pos[i * 3 + 2]);
        const depth = _p.dot(_dir) - camDotDir;
        // 컷 구간 안이면 오클루전 등급(MIN_FADE 잔여)이 아니라 완전 제거다. 땅이 사라진 자리에
        // 반투명 수관이 남는 것도 부유 나무로 읽힌다.
        if (cut > 0 && depth > 0 && depth < cut) { e.tgt[i] = CUT_FADE; continue; }
        if (_p.distanceToSquared(_cam) > cutoff2) { e.tgt[i] = 1; continue; } // 프리필터
        if (depth <= 0) { e.tgt[i] = 1; continue; }                           // 카메라 뒤편 제외
        _p.project(camera); // → NDC
        if (_p.z <= -1 || _p.z >= 1) { e.tgt[i] = 1; continue; }
        const r = Math.hypot(_p.x, _p.y);
        const occ = smoothstep(SCREEN_OUT, SCREEN_IN, r); // 화면중심=1, 가장자리=0
        e.tgt[i] = 1 - occ * (1 - MIN_FADE);
      }
    }
  }

  function ease(dt) {
    const k = Math.min(1, dt / EASE_TAU);
    for (const e of entries) {
      if (e.cutOnly && !e.easing) continue;
      let dirty = false;
      for (let i = 0; i < e.n; i++) {
        const nx = e.cur[i] + (e.tgt[i] - e.cur[i]) * k;
        if (Math.abs(nx - e.cur[i]) > 1e-4) { e.cur[i] = nx; e.attr.array[i] = nx; dirty = true; }
      }
      if (dirty) e.attr.needsUpdate = true;
      else if (e.cutOnly) e.easing = false;   // 수렴한 숲 엔트리는 매 프레임 순회에서 빠진다
    }
  }

  let since = 1e9;
  let primed = false; // 첫 패스는 타깃으로 스냅(시작 페이드인 애니 없음). 정적 카메라(결정론 하네스)는
                      //   즉시 수렴→안정 → 픽셀 재현 유지. 이후 프레임은 카메라 이동 시에만 이징.
  function update(camera, dt) {
    if (!entries.length || !camera) return;
    since += dt;
    if (since >= RECOMPUTE_DT) { recompute(camera); since = 0; }
    if (!primed) { for (const e of entries) snap(e); primed = true; }
    else ease(dt);
  }
  function snap(e) {
    for (let i = 0; i < e.n; i++) { e.cur[i] = e.tgt[i]; e.attr.array[i] = e.tgt[i]; }
    e.attr.needsUpdate = true;
  }

  // focus 컷어웨이가 걷어낸 전경 깊이(카메라 전방 view 깊이 m). 0/비유한값이면 해제되고
  //   다음 recompute 한 번이 모든 타깃을 1 로 되돌린 뒤 이징으로 복원한다(팝 없음).
  function setCut(depth) {
    cut = Number.isFinite(depth) && depth > 0 ? depth : 0;
  }

  function dispose() {
    entries.length = 0;
  }

  return { register, setSubject, setCut, update, dispose };
}
