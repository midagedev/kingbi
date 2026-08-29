import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { getWind } from './wind.js';
import { makePresenceGate } from './present-gate.js';

// 굴뚝 연기 + 아궁이 불씨 — 새벽·해질녘 밥 짓는 연기의 정서.
//   setupSmoke({ scene, getBuilding }) → { group, setTime, setEnabled, update(dt), onBuildingChanged }
//
// 구현 방침 (night-glow.js 패턴 — builder 무수정 traverse 접근, 결정론):
//  - 굴뚝 anchor: 건물 그룹 traverse로 name='chimney' 를 찾는다.
//      · userData.smokeEmission (chimney-plan 방출점, building-local) 이 있으면 월드로 변환.
//      · 없으면 그룹 bbox 상단(+0.15) — 대표 종가 등 plan 미부착 경로.
//    choga 진흙 스택도 같은 이름 계약(재질 동일성 휴리스틱 폐기).
//  - 연기: 부드러운 radial 빌보드(Sprite, 가산 아님·반투명 회백). 굴뚝 위로 상승하며
//    폭이 벌어지고 소산. 각 파티클 own material(개별 opacity/rotation).
//  - wind.js getWind(t)를 read-only import — 방출 시각의 바람으로 드리프트를 계산해
//    거스트가 만든 눕힘이 위로 전파(traveling kink). 무풍(window.__windScale=0)은 수직 상승.
//  - 시간대: 새벽·해질녘 최대(밥짓기), 낮 미약, 밤 은은. 색도 시간대로 물든다.
//  - 아궁이 불씨: name='agungiEmber'(emissive 면)·'agungiFire'(PointLight)를
//    시간대로 변조(밤·밥짓는 시간 발광, 낮 소등). night-glow와 독립(창호는 night-glow 담당).
//  - 결정론: Math.random 미사용. 위상/해시/시간 t 순수 함수 → shot 재현성.

const PARTICLES = 30;   // 굴뚝당 파티클 수 기본(연속 컬럼용 조밀 오버랩)
const MAX_ANCHORS = 3;  // 동시 굴뚝 상한 기본(giwa 1 · choga 1 + 여유)
const PRESENT_EPSILON = 0.002;

// 부감 임포스터 배율(look-audit R4). 근접 튜닝값(6.4m 상승·최대 3.25m 폭)은 도성 부감 480m 에서
//   기둥 하나가 13px·7px 로, 지형 위에서 사실상 판별되지 않는다. 원경에서만 기둥을 높이고 넓히고
//   진하게 해 "밥 짓는 마을"이 부감에서 읽히게 한다(실제 굴뚝 연기도 수십 m를 오르므로, 근접
//   6m 기둥이야말로 근접 프레임용 축약이다). setAerial(0) = 근접 실제 스케일(기본, 무회귀).
const AERIAL_RISE_MUL = 3.4;
const AERIAL_SIZE_MUL = 3.2;
const AERIAL_OPACITY_MUL = 1.55;

// 시간대별 프로파일: amp=피어오름 세기, col=연기색, op=개별 파티클 불투명도(오버랩 누적),
//   rise=상승 높이(m), ember=아궁이 불씨 emissive 강도, fire=아궁이 PointLight 강도.
const TIME = {
  dawn:   { amp: 1.00, col: 0xbcc4d0, op: 0.20, rise: 6.4, ember: 1.30, fire: 1.5 },
  day:    { amp: 0.35, col: 0xccd0cc, op: 0.13, rise: 6.0, ember: 0.00, fire: 0.0 },
  sunset: { amp: 1.00, col: 0xdcc2a2, op: 0.21, rise: 6.4, ember: 1.50, fire: 1.7 },
  night:  { amp: 0.55, col: 0x969eae, op: 0.17, rise: 5.6, ember: 1.80, fire: 2.6 },
};

const fract = (x) => x - Math.floor(x);
function hash1(n) { const x = Math.sin(n * 127.13 + 11.7) * 43758.5453; return x - Math.floor(x); }
// 불씨 일렁임(결정론). 저주파 숨쉬기 + 고주파 지터, 난수 없음.
function flicker(t) { return 0.80 + 0.13 * Math.sin(t * 7.3) + 0.07 * Math.sin(t * 17.9 + 1.3); }

// 부드러운 radial 알파 텍스처(흰 중심 → 투명 가장자리). 색은 material.color가 물들인다.
function makeSmokeTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  gradient.addColorStop(0.0, 'rgba(255,255,255,0.70)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.30)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// opts.particles / opts.maxAnchors(캡): 다중 굴뚝 공유 인스턴스(#105 앰비언스 필드)가 앵커 수를 늘리고
//   굴뚝당 파티클(=스프라이트 드로우콜)을 줄여 드로우콜 예산 안에 든다. 미지정 시 기존 상수(무회귀).
// opts.gateOnChange(기본 true): 건물/앵커 교체 시 조기노출 게이트를 0으로 리셋할지. 공유 연기(#105
//   필드)는 앵커 집합이 카메라 이동으로 자주 바뀌므로 false 로 두어 전체 명멸(팟)을 막는다(게이트부).
export function setupSmoke({ scene, getBuilding, particles, maxAnchors, gateOnChange = true } = {}) {
  const NP = Math.max(1, particles || PARTICLES);        // 굴뚝당 파티클(캡)
  const NA = Math.max(1, maxAnchors || MAX_ANCHORS);     // 동시 굴뚝 상한(캡)
  let time = 'day';
  let enabled = false;
  let t = 0;   // 연기·불씨 누적 시계(결정론)
  let fadeMul = 1;   // 근접 링 활성/해제 크로스페이드 배율(연기 불투명도·불씨). 1=무영향.
  let aerial = 0;    // 부감 임포스터 전환도(0=근접 실제 스케일). 소비자가 거리에서 판정해 주입.

  // 시간대 크로스페이드: 프로파일(세기·색·불씨)을 목표로 지수 접근(즉시 스냅 opt-in).
  const dayProf = TIME.day;
  const curProf = { amp: dayProf.amp, op: dayProf.op, rise: dayProf.rise, ember: dayProf.ember, fire: dayProf.fire };
  const tgtProf = { ...curProf };
  const curCol = new THREE.Color().setHex(dayProf.col);
  const tgtCol = new THREE.Color().setHex(dayProf.col);
  const PROF_RATE = 2.4;   // ≈1.6s 프로파일 전환(sky 크로스페이드와 결이 맞게)
  function setProfTarget(name) {
    const p = TIME[name] || TIME.day;
    tgtProf.amp = p.amp; tgtProf.op = p.op; tgtProf.rise = p.rise; tgtProf.ember = p.ember; tgtProf.fire = p.fire;
    tgtCol.setHex(p.col);
  }
  function snapProf() {
    curProf.amp = tgtProf.amp; curProf.op = tgtProf.op; curProf.rise = tgtProf.rise;
    curProf.ember = tgtProf.ember; curProf.fire = tgtProf.fire; curCol.copy(tgtCol);
  }

  const group = new THREE.Group();
  group.name = 'smoke';
  group.visible = false;
  const tex = makeSmokeTexture();

  // 스프라이트 풀(재사용). 각자 own material 로 개별 opacity/rotation/color.
  const pool = [];
  for (let i = 0; i < NA * NP; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xffffff,
    });
    const sp = new THREE.Sprite(mat);
    sp.visible = false;
    sp.renderOrder = 3;
    group.add(sp);
    pool.push(sp);
  }

  let lastBuilding = null;
  let emitters = [];       // [{ anchor:{x,y,z}, sprites:[Sprite..] }]
  let embers = [];         // 아궁이 불씨 재질(emissive)
  let fires = [];          // 아궁이 PointLight
  // 조기 노출 게이트(#61): 굴뚝이 서고 조립이 정착한 뒤에만 연기가 스멀스멀 오른다. 히어로 빈 터·
  // 리롤 조립 중엔 0 → "빈 터 위 연기" 방지. reset=건물 교체, present=enabled·건물·visible.
  const gate = makePresenceGate({ delay: 1.4, up: 1.8, down: 0.4 });
  let bldChanged = false;  // 이번 프레임 건물 교체 여부(게이트 reset)

  // 건물 traverse로 굴뚝 anchor·아궁이 불씨를 탐지하고 스프라이트를 배정.
  const _emissionLocal = new THREE.Vector3();
  const _box = new THREE.Box3();
  function detect(b) {
    emitters = []; embers = []; fires = [];
    for (const sp of pool) { sp.visible = false; sp.material.opacity = 0; }
    if (!b) return;
    b.updateMatrixWorld(true);
    const anchors = [];
    // name='chimney': plan emission 우선, 없으면 bbox 상단(종가 등).
    b.traverse((o) => {
      if (o.name !== 'chimney') return;
      const local = o.userData && o.userData.smokeEmission;
      if (local && Number.isFinite(local.x) && Number.isFinite(local.y) && Number.isFinite(local.z)) {
        _emissionLocal.set(local.x, local.y, local.z);
        o.localToWorld(_emissionLocal);
        anchors.push({ x: _emissionLocal.x, y: _emissionLocal.y, z: _emissionLocal.z });
        return;
      }
      _box.setFromObject(o);
      anchors.push({
        x: (_box.min.x + _box.max.x) / 2,
        y: _box.max.y + 0.15,
        z: (_box.min.z + _box.max.z) / 2,
      });
    });
    // 아궁이 불씨(있을 때만) — 이름 계약 agungiEmber / agungiFire 유지.
    b.traverse((o) => {
      if (o.name === 'agungiEmber' && o.material) embers.push(o.material);
      else if (o.name === 'agungiFire' && o.isLight) fires.push(o);
    });
    anchors.slice(0, NA).forEach((a, ai) => {
      const sprites = pool.slice(ai * NP, (ai + 1) * NP);
      for (const sp of sprites) sp.visible = true;
      emitters.push({ anchor: a, sprites });
    });
    applyColor();
  }

  function applyColor() {
    for (const e of emitters) for (const sp of e.sprites) sp.material.color.copy(curCol);
  }

  // 아궁이 불씨·화광 시간대 변조(밤·밥짓는 시간 발광, 낮 소등). enabled + 조기노출 게이트(#61) 곱.
  //   (아궁이 부재는 건물 자식이라 히어로엔 이미 숨지만, 조립 중 조기 발광 방지 위해 게이트 동조.)
  function applyEmber(now) {
    const fl = enabled ? flicker(now) : 1;
    const eI = enabled ? curProf.ember * fl * gate.value * fadeMul : 0;
    const fI = enabled ? curProf.fire * fl * gate.value * fadeMul : 0;
    for (const m of embers) m.emissiveIntensity = eI;
    for (const l of fires) { l.intensity = fI; l.visible = enabled && curProf.fire > 0.02 && gate.value > 0.02; }
  }

  function ensureBuilding() {
    const b = getBuilding && getBuilding();
    if (b !== lastBuilding) { lastBuilding = b; bldChanged = true; detect(b); }
    return b;
  }

  function update(dt) {
    const b = ensureBuilding();
    // 게이트: 건물이 보이고 조립 정착 후에만 오른다(매 프레임 갱신 — enabled 무관하게 상태 추종).
    const present = enabled && !!b && b.visible;
    const g = gate.update(dt, { present, reset: gateOnChange && bldChanged });
    bldChanged = false;
    // 완전히 소거된 거리에서는 gate/건물 교체까지만 추적하고 스프라이트 궤적·프로파일 CPU는 쉰다.
    if (!enabled || fadeMul <= PRESENT_EPSILON) { applyEmber(t); return; }
    t += dt;
    // 시간대 프로파일 크로스페이드(세기·색·불씨). 색은 매 프레임 스프라이트에 반영.
    const kp = Math.min(1, dt * PROF_RATE);
    curProf.amp += (tgtProf.amp - curProf.amp) * kp;
    curProf.op += (tgtProf.op - curProf.op) * kp;
    curProf.rise += (tgtProf.rise - curProf.rise) * kp;
    curProf.ember += (tgtProf.ember - curProf.ember) * kp;
    curProf.fire += (tgtProf.fire - curProf.fire) * kp;
    curCol.lerp(tgtCol, kp);
    applyColor();
    const prof = curProf;
    // 부감 임포스터 배율(연속 — 전환 중에도 팟 없이 근접 스케일로 수축).
    const riseMul = 1 + aerial * (AERIAL_RISE_MUL - 1);
    const sizeMul = 1 + aerial * (AERIAL_SIZE_MUL - 1);
    const opMul = 1 + aerial * (AERIAL_OPACITY_MUL - 1);
    for (const e of emitters) {
      const a = e.anchor;
      e.sprites.forEach((sp, i) => {
        const ph = i / NP;                              // 위상 오프셋(연속 스트림)
        const jit = hash1(i * 2.17 + a.x * 0.13 + 1.7); // 결정론 지터
        const life = 6.0 + 1.2 * hash1(i * 1.7 + 3.1);  // 파티클 수명 6.0~7.2s(위상 균일 유지)
        const f = fract(t / life + ph);                 // 0→1 생애

        const y = a.y + f * prof.rise * riseMul;        // 상승

        // 바람 드리프트: 방출 시각 te의 바람으로 → 거스트 눕힘이 컬럼을 타고 위로 전파.
        const te = t - f * life;
        const w = getWind(te);
        const drift = f * life * 0.5 * riseMul;         // 방출 후 경과에 비례한 수평 이동
        const lean = 1 + w.gust * 0.6;
        let x = a.x + w.dirX * w.speed * drift * lean;
        let z = a.z + w.dirZ * w.speed * drift * lean;

        // 난류 흔들림(위로 갈수록 커짐)
        const sway = 0.2 + 0.8 * f;
        x += sway * Math.sin(t * 0.9 + ph * 6.28 + f * 3.5 + jit * 6.0) * 0.3;
        z += sway * Math.cos(t * 0.75 + ph * 5.1 + f * 3.0 + jit * 4.0) * 0.3;

        sp.position.set(x, y, z);

        const size = (0.5 + f * 2.5 + jit * 0.25) * sizeMul;  // 상승하며 폭 확대(하단부터 오버랩)
        sp.scale.set(size, size, 1);

        const fin = smoothstep(0, 0.05, f);             // 하단 즉시 페이드인(굴뚝 상단 연결)
        const fout = 1 - smoothstep(0.55, 1.0, f);      // 상단 소산
        // g=조기 노출 게이트(#61), fadeMul=근접 링 크로스페이드, opMul=부감 임포스터 가산
        sp.material.opacity = Math.min(1, prof.op * prof.amp * fin * fout * g * fadeMul * opMul);
        sp.material.rotation = f * 1.2 + jit * 6.28;    // 완만 회전
      });
    }
    applyEmber(t);
  }

  function setTime(name, opts = {}) {
    time = name;
    setProfTarget(name);
    if (opts.immediate) { snapProf(); applyColor(); }
    applyEmber(t);
  }
  function setEnabled(v) {
    enabled = !!v;
    group.visible = enabled && fadeMul > PRESENT_EPSILON;
    if (!group.visible) for (const sp of pool) sp.material.opacity = 0;
    applyEmber(t);
  }
  function onBuildingChanged() { lastBuilding = null; ensureBuilding(); applyEmber(t); }
  // 근접 링 활성/해제 크로스페이드(0..1). 연기·불씨 최종 세기를 배율(팟 방지).
  function setFade(v) {
    fadeMul = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    group.visible = enabled && fadeMul > PRESENT_EPSILON;
    if (!group.visible) for (const sp of pool) sp.material.opacity = 0;
    applyEmber(t);
  }

  // 부감 임포스터 전환도(0..1). 거리 판정은 소비자(마을 앰비언스 필드)가 소유한다.
  function setAerial(v) {
    aerial = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }
  return { group, setTime, setEnabled, update, onBuildingChanged, setFade, setAerial };
}
