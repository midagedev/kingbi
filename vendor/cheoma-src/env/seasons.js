import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { createLeafSaddleGeometry, LEAF_SHAPE_GLSL } from './detail-particle-geometry.js';
import { getWind } from './wind.js';
import { planEnvLitterSpots, seasonGroundCarpetGoal } from './season-ground-plan.js';
import { buildSeasonGroundCarpet } from './season-ground-carpet.js';

// 계절 시스템 — 가을 단풍·봄 벚꽃·여름 신록·겨울 휴면색.
//   setupSeasons(envGroup, { layout }) → { setSeason(name, opts), update(dt), dispose() }
//   name: 'spring' | 'summer' | 'autumn' | 'winter'
//
// 구현 방침:
//  - 잎 색은 나무 재질(공유 MeshStandardMaterial)의 셰이더를 onBeforeCompile 로 패치해
//    vertex 단계에서 vColor 를 계절 목표색으로 이동시킨다. 재질을 교체하지 않으므로
//    weather.js 의 적설 패치(fragment, color_fragment 이후)와 자연히 합성된다
//    (잎 색 → 그 위에 눈 블렌딩). 소나무(species 0)는 상록으로 무시.
//  - 개체별 phase: instanceMatrix 위치 해시로 잎 색 채도·명도와 물드는 시차를 흩뜨린다.
//  - 계절 전환은 항상 여름(초록)을 경유해 보간 → 빨강↔분홍 직접 보간의 진흙색을 피한다.
//  - 지면은 terrain 재질에 aGround 마스크 기반 곱연산 틴트(가을 마른 금빛/봄 신록)를
//    주입 — 박석 마당은 유지, 풀·숲 원경만 은은하게. 부감 계절축(U4)은 이 틴트 + 논
//    (paddies) + 수관 색이며, 낙하 입자를 거대화하거나 FAR Points 를 복제하지 않는다.
//  - 낙하 파티클: 나무 수관에서 흩날리는 낙엽/벚꽃잎(종별 저폴리 곡면, 물리 폭 계약).
//    바람 사인 요동 + 회전 낙하 + 지면/수관 끝 페이드. 근경 전용 체감 밀도.
//  - 지면 카펫/litter(#219): spring 벚꽃 패치 + autumn 낙엽 무더기. 단일 InstancedMesh
//    (+1 draw, 0 Points). 전 필지 고밀도 카펫 금지 — 나무 밑·마당 구석 스팟만.

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 수종별 계절 목표 잎색 (index = SPECIES). pine(0)은 미사용(상록).
const AUTUMN = [0x000000, 0xe8c33a, 0xc8452c, 0xa5762f, 0xcf6b4e]; // 은행 진노랑 / 단풍 주홍 / 잡목 갈금 / 벚 코랄
const SPRING = [0x000000, 0x9cc24a, 0x8fbf52, 0x93c256, 0xf2bcd0]; // 신록 연둣빛 / 벚 연분홍
const WINTER = [0x000000, 0x776e4e, 0x6d5747, 0x665e4c, 0x745f57]; // 낙엽 진 뒤 남은 가지·마른 잎의 저채도
const SEASON_AMT = { spring: 0.85, summer: 0, autumn: 0.92, winter: 0.96 };

// 지면 곱연산 톤 (aGround 영역). 여름=중립. 부감 계절축(U4): 가을은 마른 풀 금빛,
// 봄은 신록이 여름과 분명히 갈라지도록 강도·채도를 살짝 올린다(입자 거대화 대신).
const GROUND_MUL = {
  spring: new THREE.Vector3(0.86, 1.14, 0.72),
  summer: new THREE.Vector3(1, 1, 1),
  autumn: new THREE.Vector3(1.28, 1.04, 0.42),
  winter: new THREE.Vector3(1.04, 0.98, 0.86),
};
const GROUND_AMT = { spring: 0.82, summer: 0, autumn: 1.0, winter: 0.82 };

const RATE = 2.6;          // 색/지면 보간 속도 (1/s) — 대략 1.5s 안에 여름 경유 전환
const PART_RATE = 2.4;     // 파티클 페이드 속도
const TREE_SWAY = 1.15;    // 나무 수관 흔들림 진폭(월드 단위 배율)
const LITTER_UP = 38;      // 낙엽 지면 누적 0→1 시간(초) — 은은히
const LITTER_DOWN = 12;    // 낙엽 사라짐 시간(초)
const TAU = Math.PI * 2;
// 얇은 잎 투과 계수(역광 발색). 낙하 낙엽 재질 전용이며 값은 실측으로 정했다 —
//   판정 기준은 "역광 프레임에서 잎 luma max ≤ 프레임 luma p99.9"(석양 하이라이트를 넘지 않는다).
//   0.55는 잎 max 176 > p99.9 165로 **위반**(잎이 발광체로 읽힘), 0.42는 163으로 통과하면서 발색은
//   충분하고(p90 100), 0.30은 약하다(p90 83). 실측은 `post=0` 생 렌더이므로 컴포저 ON에서 bloom이
//   이 웜 픽셀을 집어 올린다 — 너무 뜨겁게 읽히면 후퇴선은 0.30~0.35다.
const uLeafTransmit = { value: 0.42 };

export function setupSeasons(envGroup, { layout, paddies = null } = {}) {
  let disposed = false;
  // ---------- 대상 재질 수집 ----------
  const treesGroup = envGroup.getObjectByName('trees');
  const terrainGroup = envGroup.getObjectByName('terrain');
  const treeInsts = treesGroup ? treesGroup.children.filter((o) => o.isInstancedMesh) : [];
  const treeMat = treeInsts.length ? treeInsts[0].material : null;
  const terrainMesh = terrainGroup ? terrainGroup.getObjectByName('terrain') : null;
  const terrainMat = terrainMesh ? terrainMesh.material : null;

  // ---------- 공유 uniform ----------
  // 잎 목표색은 수종(은행·단풍·잡목·벚)별 vec3 uniform 4개. three.js onBeforeCompile 에서
  // 배열 uniform 의 동적 인덱싱은 업로드가 불안정하므로 스칼라 uniform + 정적 분기로 처리.
  const uCol = [0, 1, 2, 3].map(() => ({ value: new THREE.Vector3(0.15, 0.32, 0.12) }));
  const uTargetAmt = { value: 0 };
  const uGroundMul = { value: new THREE.Vector3(1, 1, 1) };
  const uGroundAmt = { value: 0 };
  // 나무 흔들림: 바람 필드(wind.js)를 vertex 셰이더로 넘겨 수관을 월드 방향으로 미세하게 눕힌다.
  // 거스트가 불면 파티클과 함께 크게 휘어 "바람이 분다"가 화면 전체에서 동기화돼 읽힌다.
  const uWind = { value: new THREE.Vector2(0, 0) };
  const uWindTime = { value: 0 };

  if (treeMat) patchTrees(treeMat, uCol, uTargetAmt, uWind, uWindTime);
  if (terrainMat) patchTerrain(terrainMat, uGroundMul, uGroundAmt);

  // ---------- 파티클(낙엽/벚꽃) ----------
  const leaves = buildLeaves(treeInsts);
  if (leaves) envGroup.add(leaves.mesh);
  // 지면 카펫/litter(#219): 봄 벚꽃 패치 + 가을 낙엽. 나무 밑·마당 구석 스팟, +1 draw.
  const litter = buildLitter(treeInsts, layout);
  if (litter) envGroup.add(litter.mesh);

  // ---------- 전환 상태기계 ----------
  // 항상 여름(amt→0)으로 내렸다가, 목표 팔레트로 다시 올린다.
  let season = 'summer';
  let pending = 'summer';
  let phase = 'idle';            // 'out' | 'in' | 'idle'
  let amt = 0;                   // 잎 색 강도 (uTargetAmt)
  let amtGoal = 0;
  let gAmt = 0;                  // 지면 강도
  let gAmtGoal = 0;
  const gMul = new THREE.Vector3(1, 1, 1);       // 현재 지면 곱
  const gMulGoal = new THREE.Vector3(1, 1, 1);
  let partAmt = 0;               // 파티클 가시 강도
  let partGoal = 0;
  let litterLevel = 0;           // 낙엽 지면 누적 진행도(0..1)
  let litterGoal = 0;
  let pinnedLitter = null;       // shot 하네스로 특정 누적 단계 고정(null=자유 진행)
  let t = 0;

  function applyPalette(name) {
    const src = name === 'autumn' ? AUTUMN : name === 'winter' ? WINTER : SPRING;
    // uCol[0..3] = 은행(1)·단풍(2)·잡목(3)·벚(4). Color→Vector3 은 채널을 직접 옮긴다
    // (Vector3.copy 는 .x/.y/.z 를 읽어 Color 를 그대로 넣으면 NaN 이 된다).
    for (let i = 0; i < 4; i++) {
      const c = linCol(src[i + 1] || 0x2a4020);
      uCol[i].value.set(c.r, c.g, c.b);
    }
    gMulGoal.copy(GROUND_MUL[name] || GROUND_MUL.summer);
    if (leaves) leaves.setSeason(name);
    if (litter) litter.setSeason(name);
  }

  function setSeason(name, opts = {}) {
    if (disposed) return;
    if (!['spring', 'summer', 'autumn', 'winter'].includes(name)) name = 'summer';
    pending = name;
    partGoal = name === 'spring' || name === 'autumn' ? 1 : 0;
    // 지면 카펫: 봄(벚꽃 패치) + 가을(낙엽). 부감은 색 축, 근경 밀도는 이 레이어가 담당.
    litterGoal = seasonGroundCarpetGoal(name);
    // 다랑이 논 계절 전파(자체 보간). shot 모드는 즉시 세팅.
    if (paddies) { if (opts.immediate) paddies.applyImmediate(name); else paddies.setSeason(name); }

    if (opts.immediate) {
      season = name;
      phase = 'idle';
      if (name !== 'summer') applyPalette(name);
      amt = amtGoal = SEASON_AMT[name];
      gAmt = gAmtGoal = GROUND_AMT[name];
      gMul.copy(GROUND_MUL[name] || GROUND_MUL.summer);
      gMulGoal.copy(gMul);
      partAmt = partGoal;
      litterLevel = opts.litter != null ? opts.litter : litterGoal;
      if (litter) {
        // applyPalette already setSeason for non-summer; summer keeps last palette while level→0.
        if (name === 'spring' || name === 'autumn') litter.setSeason(name);
        litter.setLevel(litterLevel);
      }
      pushUniforms();
      if (leaves) { leaves.mesh.visible = partAmt > 0.01; leaves.prewarm(); }
      return;
    }
    // 부드러운 전환: 먼저 여름으로 내린다(현재가 이미 여름이면 즉시 in 으로).
    phase = 'out';
    amtGoal = 0;
    gAmtGoal = 0;
  }

  function pushUniforms() {
    uTargetAmt.value = amt;
    uGroundAmt.value = gAmt;
    uGroundMul.value.copy(gMul);
  }

  function update(dt) {
    if (disposed) return;
    t += dt;
    const k = Math.min(1, dt * RATE);

    if (phase === 'out') {
      amt += (0 - amt) * k;
      gAmt += (0 - gAmt) * k;
      if (amt < 0.02) {
        amt = 0; gAmt = 0;
        season = pending;
        if (season === 'summer') {
          phase = 'idle';
        } else {
          applyPalette(season);
          amtGoal = SEASON_AMT[season];
          gAmtGoal = GROUND_AMT[season];
          phase = 'in';
        }
      }
    } else if (phase === 'in') {
      amt += (amtGoal - amt) * k;
      gAmt += (gAmtGoal - gAmt) * k;
      gMul.lerp(gMulGoal, k);
      if (Math.abs(amtGoal - amt) < 0.01) { amt = amtGoal; gAmt = gAmtGoal; phase = 'idle'; }
    }
    pushUniforms();

    // 바람 uniform 갱신(나무 흔들림). 필드는 wind.js 하나 → 파티클과 거스트 타이밍 동기.
    const w = getWind(t);
    uWind.value.set(w.dirX * w.speed * TREE_SWAY, w.dirZ * w.speed * TREE_SWAY);
    uWindTime.value = t;

    // 파티클
    partAmt += (partGoal - partAmt) * Math.min(1, dt * PART_RATE);
    if (leaves) {
      const vis = partAmt > 0.01;
      leaves.mesh.visible = vis;
      if (vis) leaves.update(dt, t, partAmt, w);
    }

    // 낙엽 지면 누적(선형 램프, 은은히). 가을 진입 후 서서히 늘고, 떠나면 서서히 사라진다.
    if (pinnedLitter != null) {
      litterLevel = pinnedLitter;
    } else if (litterGoal > litterLevel) {
      litterLevel = Math.min(litterGoal, litterLevel + dt / LITTER_UP);
    } else {
      litterLevel = Math.max(litterGoal, litterLevel - dt / LITTER_DOWN);
    }
    if (litter) litter.setLevel(litterLevel);

    if (paddies) paddies.update(dt);   // 논 계절색·물강도 보간
  }

  // shot 하네스 훅: 낙엽 누적 단계 고정(은은한 증가 비교 컷). v=null 이면 자유 진행.
  let seasonDebug = null;
  if (typeof window !== 'undefined') {
    seasonDebug = { setLitter(v) { pinnedLitter = v; if (v != null && litter) { litterLevel = v; litter.setLevel(v); } } };
    window.__season = seasonDebug;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (leaves) {
      envGroup.remove(leaves.mesh);
      leaves.mesh.geometry.dispose();
      leaves.mesh.material.dispose();
      leaves.depthMaterial?.dispose();
      if (leaves.tex) leaves.tex.dispose();
    }
    if (litter) {
      envGroup.remove(litter.mesh);
      litter.dispose();
    }
    uTargetAmt.value = 0;
    uGroundAmt.value = 0;
    if (typeof window !== 'undefined' && window.__season === seasonDebug) delete window.__season;
  }

  return { setSeason, update, dispose, get season() { return season; } };
}

// ---------- 재질 셰이더 패치 ----------

function patchTrees(mat, uCol, uTargetAmt, uWind, uWindTime) {
  if (mat.userData.__seasonPatched) return;
  mat.userData = mat.userData || {};
  mat.userData.__seasonPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uCol1 = uCol[0];
    shader.uniforms.uCol2 = uCol[1];
    shader.uniforms.uCol3 = uCol[2];
    shader.uniforms.uCol4 = uCol[3];
    shader.uniforms.uTargetAmt = uTargetAmt;
    shader.uniforms.uWind = uWind;
    shader.uniforms.uWindTime = uWindTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aFoliage;
        attribute float aSpecies;
        uniform vec3 uCol1;
        uniform vec3 uCol2;
        uniform vec3 uCol3;
        uniform vec3 uCol4;
        uniform float uTargetAmt;
        uniform vec2 uWind;
        uniform float uWindTime;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
      #if defined( USE_INSTANCING )
      if (aFoliage > 0.5) {
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float h = fract(sin(dot(ip, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        int sp = int(aSpecies + 0.5);
        vec3 tgt = uCol1;                          // 은행(1)
        if (sp == 2) tgt = uCol2;                  // 단풍
        else if (sp == 3) tgt = uCol3;             // 잡목
        else if (sp == 4) tgt = uCol4;             // 벚
        tgt *= (0.80 + 0.36 * h);                  // 개체별 채도·명도 편차
        float amt = sp == 0 ? 0.0 : uTargetAmt;    // 소나무(0)는 상록
        float localAmt = clamp(amt * (0.70 + 0.58 * h), 0.0, 1.0); // 물드는 시차
        vColor.rgb = mix(vColor.rgb, tgt, localAmt);
      }
      #endif`)
      // 바람 흔들림: instanceMatrix 적용 후(월드 공간)에 수관을 바람 방향으로 눕힌다. 높이가 높은
      // 잎일수록 크게, 개체별 위상으로 서로 다르게. 줄기(aFoliage=0)는 고정.
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          if (aFoliage > 0.5) {
            vec3 wip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            float wph = fract(sin(dot(wip, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
            float hf = clamp((mvPosition.y - wip.y) / 6.0, 0.0, 1.6);
            float sway = 0.6 * sin(uWindTime * 1.7 + wph) + 0.4 * sin(uWindTime * 3.1 + wph * 1.7);
            vec2 disp = uWind * hf * (0.55 + 0.6 * sway);
            mvPosition.x += disp.x;
            mvPosition.z += disp.y;
          }
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.needsUpdate = true;
}

function patchTerrain(mat, uGroundMul, uGroundAmt) {
  if (mat.userData.__seasonPatched) return;
  mat.userData = mat.userData || {};
  mat.userData.__seasonPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uGroundMul = uGroundMul;
    shader.uniforms.uGroundAmt = uGroundAmt;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGround;\nvarying float vGround;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGround = aGround;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGroundMul;\nuniform float uGroundAmt;\nvarying float vGround;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), uGroundMul, uGroundAmt * vGround);`);
  };
  mat.needsUpdate = true;
}

// ---------- 낙엽/벚꽃 파티클 ----------
// 지면 데칼 실루엣 아틀라스는 season-ground-carpet.js 소유. 낙하 잎은 월드 곡면 geometry.

function buildLeaves(treeInsts) {
  // 낙엽수(은행·단풍·잡목·벚)에서 이미터 수집. instanceMatrix 이동 = 지면 높이.
  const shed = new Set(['ginkgo', 'maple', 'misc', 'cherry']);
  const emitters = [];
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), quat = new THREE.Quaternion();
  for (const inst of treeInsts) {
    if (!shed.has(inst.name)) continue;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m4);
      m4.decompose(pos, quat, scl);
      const s = (scl.x + scl.z) * 0.5;
      emitters.push({ x: pos.x, y: pos.y, z: pos.z, r: 2.6 * s, top: 8.5 * s, bot: 3.4 * s, sp: inst.name });
    }
  }
  if (!emitters.length) return null;

  // 가중 이미터 선택: 화면 안(건물 주변, 원점 가까이)의 나무가 낙엽을 더 많이 뿌리게 해
  // 원경 숲에 흩어져 안 보이는 문제를 피한다.
  const weights = emitters.map((e) => 1 / (1 + Math.pow(Math.hypot(e.x, e.z) / 44, 2.4)));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pickEmitter = (u) => {
    let acc = u * wsum;
    for (let k = 0; k < emitters.length; k++) { acc -= weights[k]; if (acc <= 0) return emitters[k]; }
    return emitters[emitters.length - 1];
  };

  // #125 개수 대폭 감축(사용자: "색종이 축제 아니라 바람에 이따금 지는 잎"). 640→~150. 나무 방출
  //   낙엽은 마을 중심 근경에서만 보이는 보조분(원점 밖 focus 근경은 petals 담당) → 성기게 충분.
  //   per-frame 갱신 루프도 감축분만큼 저비용(성능 우선).
  // 2026-07-25 사용자가 반대 방향을 지시했다: "좀 더 많이 날려도 좋겠어 가을 분위기 나게". 1.6배까지만
  //   올린다 — #125의 "색종이 축제 금지"가 여전히 상한이고, 구 640은 그 상한을 넘은 값이었다.
  //   드로우콜은 단일 InstancedMesh라 불변이고 비용은 per-frame 행렬 합성 루프에만 붙는다.
  const N = Math.min(260, emitters.length * 6);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  // 낙하 낙엽은 적설 대상이 아니다. 두 가지 이유가 있고 **두 번째가 실제 버그였다**.
  //   ① 공중에 떠 있는 잎에 눈이 쌓이는 것은 물리적으로 틀리고, 눈 프레임에서 `patchSnow`의 up-facing
  //      커버리지가 저작 팔레트를 흰색으로 덮는다.
  //   ② `uSnowAmount = 0`(맑음)에서도 이 패치가 **잎을 검게 만들고 있었다** — 실측 A/B: 적설 패치를
  //      되돌리면 day 순검정 0.46 / 평균 [33,28,16] / 최명 [131,119,75](무채도 탠), 옵트아웃하면
  //      순검정 **0**  / 평균 [144,83,40] / 최명 [225,188,71](은행 황금). sunset은 0.83 → 0.03.
  //      diffuse mix·normal fixup은 `uSnowAmount = 0`에서 항등이므로, 적설 패치의 **vertex 노멀 주입이
  //      이 재질의 `<beginnormal_vertex>` 치환과 충돌**한 것이다(CLAUDE.md "패치 치환 순서 역전" 함정).
  //   `snowSurface === false`가 `patchSnowMaterial`의 정식 옵트아웃이다. **다시 켜지 말 것.**
  mat.userData.snowSurface = false;
  const geo = createLeafSaddleGeometry();
  geo.setAttribute('aLeafSpecies', new THREE.InstancedBufferAttribute(new Float32Array(N), 1));
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLeafTransmit = uLeafTransmit;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLeafSpecies;
        ${LEAF_SHAPE_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec3 objectNormal = leafSpeciesNormal(aLeafSpecies);`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = leafSpeciesShape(aLeafSpecies);`);
    // 얇은 잎의 투과(backlight). 2026-07-26 실측이 드러낸 것: 색 사슬은 정상인데 낙하 잎의 약 46%가
    //   순검정이었다. 원인은 버그가 아니라 **무한히 얇은 단일 판을 물리 BRDF로만 조명한 결과**다 —
    //   카메라를 향한 면이 태양·하늘을 등진 개체는 직사광을 못 받아 검게 남는다. 실제 낙엽은 얇아서
    //   역광에서 빛을 투과해 빛나며, 그게 이 앱의 플래그십 룩(골든아워 역광)과 정확히 같은 방향이다.
    //   전방 산란이라 제곱으로 좁히고, 알베도(`diffuseColor` = 저작 팔레트)를 곱해 **은행 황금·단풍
    //   주홍이 역광에서 발색**하게 한다. uniform 1개, 새 프로그램·드로우콜 0.
    shader.fragmentShader = shader.fragmentShader
      // `shader.uniforms`에 값을 넣는 것은 **선언을 만들지 않는다** — 선언 없이는
      //   `'uLeafTransmit' : undeclared identifier`로 프래그먼트가 죽고 잎이 아예 안 그려진다.
      .replace('#include <common>', `#include <common>
        uniform float uLeafTransmit;`)
      // `NUM_DIR_LIGHTS`는 three의 `replaceLightNums`가 `onBeforeCompile` **뒤에** 숫자로 치환하므로
      //   이 `#if`는 최종 소스에서 `#if 1 > 0`이 된다(실측 확인).
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
          float leafBack = max(0.0, dot(-normal, directionalLights[0].direction));
          reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[0].color
            * (leafBack * leafBack) * uLeafTransmit;
        #endif`);
  };
  // 셰이더 본문이 바뀌었으므로 키를 올린다(상수 키 + 다른 본문은 프로그램 오재사용의 씨앗이다).
  mat.customProgramCacheKey = () => 'cheoma-season-leaf-species-v2';
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'seasonLeaves';
  // 2026-07-26: 색은 **지오메트리의 per-instance `color` 속성**으로 준다. `instanceColor`가 아니다.
  //   이 재질은 `vertexColors: true`인데 지오메트리에 `color` 속성이 없었고, three는 플래그만 보고
  //   `USE_COLOR`를 정의하므로 `color_vertex`의 `vColor.rgb *= color`가 **바인딩되지 않은 attribute**를
  //   곱했다. 그 결과 `color_fragment`의 `diffuseColor *= vColor`에서 잎이 순검정이 되고(실측 46%),
  //   `instanceColor`로 넣은 은행 황금·단풍 주홍이 화면에 **한 번도 도달하지 못했다**(밝은 잎 실측
  //   [131,119,75] 무채도 탠 = 흰 알베도 조명). 반대로 `vertexColors`를 떼면 fragment가 `vColor`를
  //   선언조차 하지 않아 `instanceColor`가 조용히 버려진다 — 그래서 처방은 "속성을 채우는" 쪽뿐이다.
  //   `aLeafSpecies`와 같은 어휘(`InstancedBufferAttribute`)이고, 곱은 정확히 한 번만 일어난다.
  geo.setAttribute('color', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
  mesh.frustumCulled = false;
  mesh.renderOrder = 16;
  mesh.visible = false;
  const depthMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aLeafSpecies;
      ${LEAF_SHAPE_GLSL}
      void main() {
        vec4 local = vec4(leafSpeciesShape(aLeafSpecies), 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * local;
      }`,
    fragmentShader: `
      #include <packing>
      void main() { gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }`,
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
  });
  depthMaterial.allowOverride = false;
  depthMaterial.name = 'season-leaf-dof-depth';
  mesh.userData.dofDepthMaterial = depthMaterial;

  // 파티클 상태
  const st = [];
  let s = 0x9e3779b9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) {
    const e = pickEmitter(rnd());
    st.push({
      e,
      hh: rnd() * e.top,                 // 지면 위 높이 (0..top)
      ox: (rnd() * 2 - 1),               // 정규화 반경 오프셋
      oz: (rnd() * 2 - 1),
      phase: rnd() * Math.PI * 2,
      swaySpd: 0.6 + rnd() * 0.9,
      swayAmp: 0.6 + rnd() * 1.1,
      fall: 1.1 + rnd() * 1.3,
      spin: rnd() * Math.PI * 2,
      spinSpd: (rnd() * 2 - 1) * 1.8,
      size: 0.06 + rnd() * 0.06,           // 가을 6~12cm, 봄은 sizeScale로 2.7~5.4cm
      tilt: rnd(),                        // 회전축 성향
    });
  }

  const dummy = new THREE.Object3D();
  let t2 = 0;             // 현재 애니메이션 시간(요동 위상)
  let fallScale = 1;      // 계절별 낙하 계수 (봄 벚꽃잎이 더 느리고 가볍게)
  let sizeScale = 1;
  let windX = 0, windZ = 0, windGust = 0; // 매 프레임 wind.js 필드에서 갱신

  function setSeason(name) {
    const spring = name === 'spring';
    fallScale = spring ? 0.6 : 1.0;
    // 가을 2.4배는 사용자 지시(2026-07-25 "낙엽같은게 조금 더 컸으면" → "윤곽을 알아볼 수 있게 살짝
    // 과장해서 키우고")다. 14~29cm는 오동·플라타너스(20~30cm) 상단이라 단풍 기준으로는 과장이지만
    // 수종 밴드를 벗어나지 않는다. petals.js autumn `size` 2.4배와 같은 비율로 묶여 있다.
    // 봄 벚꽃잎은 실물이 2~3cm이므로 배율을 함께 올리지 않는다(0.45 유지 → 2.7~5.4cm).
    sizeScale = spring ? 0.45 : 2.4;
    // 카메라 카드 대신 공유 곡면 geometry가 월드에서 실제로 회전한다. 수종별 차이는
    // 실루엣·곡면 normal·실제 크기·팔레트로 유지한다.
    const GINKGO = [0xf2c53d, 0xf0b429, 0xe8b21f, 0xf5ce4a];       // 순수 황금(은행)
    const MAPLE  = [0xc0392b, 0xd35400, 0xe0491f, 0xb83a1e, 0xd9622b]; // 진홍~주황(단풍)
    const WARM   = [0xd9772b, 0xc86a2a, 0xcf9a3a, 0xbe7d34];       // 벚·잡목 낙엽(오렌지-브라운)
    const SP     = [0xf3c4d6, 0xf0b0c8, 0xe79bbf, 0xfad9e6];       // 봄 벚꽃
    const col = new THREE.Color();
    const species = geo.attributes.aLeafSpecies.array;
    const leafColors = geo.attributes.color.array;
    for (let i = 0; i < N; i++) {
      const sp = st[i].e.sp;
      let pal;
      if (spring) { pal = SP; species[i] = 0; }
      else if (sp === 'ginkgo') { pal = GINKGO; species[i] = 1; }
      else if (sp === 'maple') { pal = MAPLE; species[i] = 2; }
      else if (sp === 'misc') {
        pal = (i & 1) ? GINKGO : MAPLE;
        species[i] = (i & 1) ? 1 : 2;
      } else { pal = WARM; species[i] = 0; }
      col.copy(linCol(pal[(i * 5) % pal.length]));
      const j = 0.85 + ((i * 2654435761) % 1000) / 1000 * 0.3;  // 개체 밝기 편차
      col.multiplyScalar(j);
      leafColors[i * 3] = col.r; leafColors[i * 3 + 1] = col.g; leafColors[i * 3 + 2] = col.b;
    }
    geo.attributes.color.needsUpdate = true;
    geo.attributes.aLeafSpecies.needsUpdate = true;
  }

  function writeOne(i, globalFade) {
    const p = st[i];
    const e = p.e;
    // 아래로 내려올수록 수관 밖으로 부채꼴로 흩어진다(공중에 퍼지는 낙엽).
    const fallT = 1 - Math.min(1, Math.max(0, p.hh / e.top));
    const spread = e.r * (0.6 + 1.5 * fallT);
    // 거스트가 불면 요동이 커지고 소용돌이가 세진다.
    const swirl = 1 + windGust * 1.8;
    const wob = Math.sin(t2 * p.swaySpd + p.phase);
    const wob2 = Math.cos(t2 * p.swaySpd * 0.8 + p.phase);
    // 바람 횡류: 낮게 내려올수록(fallT↑) 더 멀리 실려간다.
    const carry = (0.6 + 1.6 * fallT);
    const px = e.x + p.ox * spread + wob * p.swayAmp * (0.5 + fallT) * swirl + windX * carry;
    const pz = e.z + p.oz * spread + wob2 * p.swayAmp * (0.5 + fallT) * swirl + windZ * carry;
    const py = e.y + e.bot * 0.2 + p.hh;
    // 끝단 페이드: 지면 근처(하강 끝) + 수관 꼭대기(재생성 직후) 축소
    const endFade = Math.min(smoothstep(0, 1.4, p.hh), smoothstep(e.top, e.top - 1.4, p.hh));
    const sc = p.size * sizeScale * globalFade * (0.3 + 0.7 * endFade);
    dummy.position.set(px, py, pz);
    dummy.rotation.set(p.spin * (0.5 + p.tilt), p.spin, p.spin * (0.3 + p.tilt * 0.4));
    dummy.scale.setScalar(sc);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }

  function update(dt, tt, globalFade, w) {
    t2 = tt;
    if (w) { windX = w.dirX * w.speed * 1.6; windZ = w.dirZ * w.speed * 1.6; windGust = w.gust; }
    for (let i = 0; i < N; i++) {
      const p = st[i];
      p.hh -= p.fall * fallScale * dt;
      if (p.hh < 0) p.hh += p.e.top;             // 재순환
      p.spin += (p.spinSpd + windGust * 1.5) * dt; // 거스트에 회전 가속
      writeOne(i, globalFade);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function prewarm() {
    // shot 모드: 위상 없이 즉시 한 번 배치(공중 정지 방지용 최소 셋업).
    t2 = 0;
    for (let i = 0; i < N; i++) writeOne(i, 1);
    mesh.instanceMatrix.needsUpdate = true;
  }

  return { mesh, depthMaterial, setSeason, update, prewarm };
}

// ---------- 지면 카펫 / litter (#219) ----------
// 봄·가을 근경 지면 밀도. 스팟 계획은 season-ground-plan.js, 렌더는 season-ground-carpet.js
// (단일 InstancedMesh, FAR Points 금지). setLevel(0..1)로 개체별 임계값을 넘어 "쌓이는" 느낌.
function buildLitter(treeInsts, layout = {}) {
  const shed = new Set(['ginkgo', 'maple', 'misc', 'cherry']);
  const bases = [];
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), quat = new THREE.Quaternion();
  for (const inst of treeInsts) {
    if (!shed.has(inst.name)) continue;
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m4); m4.decompose(pos, quat, scl);
      const s = (scl.x + scl.z) * 0.5;
      bases.push({ x: pos.x, y: pos.y, z: pos.z, r: 2.6 * s });
    }
  }
  // 화면 안(원점 가까운) 나무 우선 — 원경 스팟이 예산만 먹고 근경이 비는 문제 회피.
  bases.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
  const spots = planEnvLitterSpots({ bases, layout, seed: 0x1234abcd });
  return buildSeasonGroundCarpet({ spots, name: 'seasonLitter', season: 'autumn' });
}
