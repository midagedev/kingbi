import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { getWind } from './wind.js';

// focus 링 바람 풀(#90) — 줌인 한정 인스턴스드 풀. 부감엔 링 자체가 없으므로 grass 도 비존재.
//
//   const grass = setupGrass(parent, {
//     bounds: { W, D },           // 필지 로컬 치수(중심 0, +z=남 대문/−z=북 몸채)
//     matrix,                     // 필지 월드 강체행렬(로컬→월드). 회전 반영. 기본 identity
//     yard: { x, z, r },          // 로컬 마당(닭) 중심 — 비워둘 동선. 선택
//     style, gateW,               // 건물 발자국·대문 개구부 비움 휴리스틱
//     sun,                        // 역광 글로우용 DirectionalLight. 선택
//     seed, count,                // 결정론 시드 / 포기 수(기본 둘레 비례)
//     season,                     // 초기 계절(spring|summer|autumn|winter). 기본 summer
//   });
//   grass.setFade(0..1);   // focus 링 크로스페이드(animals/smoke/motes 규약). GPU 셰이더 배율(높이).
//   grass.setSeason(name); // 여름 초록 / 가을 금빛 / 겨울 마름 — 색 크로스페이드
//   grass.setTime(name);   // 시간대별 역광 글로우 세기·틴트(sunset/dawn 최대)
//   grass.update(dt);      // 매 프레임: 바람 판독→흔들림 uniform, 계절/글로우 보간
//   grass.dispose();       // 지오/재질 해제(container disposeSubtree 도 커버)
//
// 구현 방침:
//  - 단일 InstancedMesh(삼각 블레이드 포기 지오) → 드로우콜 +1. castShadow=false(그림자 패스 0).
//    수백 포기를 한 콜에. 부감 비존재(링 생성 시에만 존재).
//  - 흔들림: onBeforeCompile 버텍스 셰이더 — 블레이드 높이 가중(aBladeH) 굽힘 + 시간 uniform +
//    인스턴스별 위상 지터(instanceMatrix 위치 해시). wind.js getWind(t) 판독으로 연기·낙엽과
//    같은 방향·거스트 타이밍에 흔들린다(wind.js 무수정).
//  - 역광 글로우: 카메라→풀 방향이 태양 방향과 정렬될 때(역광) 끝단이 따뜻하게 발광(forward-scatter,
//    motes 게이트와 동일 원리) → 골든아워 머니샷.
//  - 계절 틴트: uGrassRoot/uGrassTip 두 색 uniform 을 크로스페이드. 겨울은 마른 짚색+짧게.
//  - 결정론: makeRng(seed) 만 사용(Math.random 금지) → shot 재현.
//  - onBeforeCompile 함정 준수: 커스텀 uniform 은 전부 스칼라/vec3(배열 동적 인덱싱 없음),
//    색 uniform 은 THREE.Color(.copy(Color)→NaN 회피), 고유 접두 이름(체이닝 충돌 없음 —
//    grass 재질은 이 파일 전용 신규 인스턴스라 seasons/weather 패치와 무관).

const TAU = Math.PI * 2;

// 계절별 풀색(뿌리/끝). 끝이 밝고 따뜻, 뿌리는 어둡고 채도 낮게 → 깊이감.
const SEASON_COL = {
  spring: { root: 0x3c5322, tip: 0x8fb84a, dry: 0.0, hMul: 1.0 },   // 신록
  summer: { root: 0x33501e, tip: 0x74992f, dry: 0.0, hMul: 1.0 },   // 짙은 여름 초록
  autumn: { root: 0x6b5a24, tip: 0xc7a24a, dry: 0.5, hMul: 0.92 },  // 금빛 마름
  winter: { root: 0x6a5c3f, tip: 0x9b8a63, dry: 0.85, hMul: 0.74 }, // 마른 짚·성김
};

// 시간대별 역광 글로우 세기·틴트. sunset/dawn 최대(골든아워), day 미약, night 극미·쿨.
//
// 세기 상한은 "끝단이 금빛으로 살짝 발광"이다. 이전 sunset 1.9 는 uGrassWarm(선형 ≈1.0,0.59,0.20)에
//   곱해져 blade 끝의 emissive 를 1.9 까지 올렸다 — bloomThreshold(sunset 0.80) 를 두 배 넘겨
//   전 포기가 흰~형광 노랑으로 타올라 담장 아래가 불꽃 노이즈로 읽혔다(docs/look-grammar.md §3
//   입자·생명감: 발광은 역광을 보여주는 장치이지 그 자체가 광원이 아니다).
//   이제 피크가 임계 바로 위(≈0.82×R)에 머물러 끝단만 헤일로를 얻는다.
const TIME_GLOW = {
  dawn:   { int: 0.72, warm: 0xffd9a0 },
  day:    { int: 0.26, warm: 0xeef0e4 },
  sunset: { int: 0.82, warm: 0xffca7a },
  night:  { int: 0.14, warm: 0xb9c6e0 },
};

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ── 삼각 블레이드 포기 지오메트리 ─────────────────────────────────────────────
// 한 포기 = 여러 블레이드(테이퍼 리본, 앞으로 살짝 굽음)를 방사로 모은 클러스터. 로컬 뿌리=원점,
// +y=위. aBladeH: 블레이드 높이 분율(0 뿌리→1 끝) — 셰이더 굽힘/색 그라디언트/글로우 가중.
// 인덱스드 → 인스턴싱 호환. 노멀은 위로 살짝 편향(잔디 매스가 하늘·태양을 부드럽게 받게).
function buildTuftGeometry(rng) {
  const BLADES = 6;
  const SEG = 3;                 // 높이 세그(부드러운 굽힘)
  const pos = [], nrm = [], bh = [], idx = [];
  let base = 0;

  const up = new THREE.Vector3(0, 1, 0);
  const _p = new THREE.Vector3(), _n = new THREE.Vector3();
  const rotY = new THREE.Matrix4(), trans = new THREE.Matrix4(), m = new THREE.Matrix4();

  for (let b = 0; b < BLADES; b++) {
    const az = rng() * TAU;                       // 방사 방향
    const off = 0.02 + rng() * 0.10;              // 포기 중심에서 벌어짐
    const cx = Math.cos(az) * off, cz = Math.sin(az) * off;
    const H = 0.40 + rng() * 0.34;                // 블레이드 높이(역광 림 위해 살짝 웃자람)
    const arc = (0.10 + rng() * 0.18);            // 앞으로 굽는 정도(로컬 +x)
    const baseW = 0.032 + rng() * 0.016;
    rotY.makeRotationY(az + (rng() - 0.5) * 0.8); // 블레이드 자체 yaw
    trans.makeTranslation(cx, 0, cz);
    m.multiplyMatrices(trans, rotY);

    // 각 세그 두 정점(폭 방향 ±). 로컬: 높이 y, 폭 z, 굽힘 x.
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const y = H * t;
      const x = arc * t * t;                      // 2차 아크(끝일수록 앞으로)
      const w = baseW * (1 - 0.88 * t);           // 끝으로 테이퍼
      for (const sign of [-1, 1]) {
        _p.set(x, y, sign * w * 0.5).applyMatrix4(m);
        pos.push(_p.x, _p.y, _p.z);
        // 리본 면노멀 근사(굽힘 반영) — 위로 편향은 아래 일괄 처리.
        _n.set(-2 * arc * t, 1, 0).normalize().applyMatrix4(rotY);
        nrm.push(_n.x, _n.y, _n.z);
        bh.push(t);
      }
    }
    // 세그 사이 쿼드 두 삼각형
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2, c = base + s * 2 + 1, d = base + (s + 1) * 2, e = base + (s + 1) * 2 + 1;
      idx.push(a, c, d, c, e, d);
    }
    base += (SEG + 1) * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aBladeH', new THREE.Float32BufferAttribute(bh, 1));
  geo.setIndex(idx);
  // 노멀 위 편향: 잔디 매스가 개별 블레이드 각도 대신 하늘/태양을 부드럽게 받게(잔디밭 느낌).
  const na = geo.attributes.normal.array;
  for (let i = 0; i < na.length; i += 3) {
    _n.set(na[i], na[i + 1], na[i + 2]).lerp(up, 0.55).normalize();
    na[i] = _n.x; na[i + 1] = _n.y; na[i + 2] = _n.z;
  }
  geo.attributes.normal.needsUpdate = true;
  const trisPerTuft = BLADES * SEG * 2;
  return { geo, trisPerTuft };
}

// ── 배치(#106): 길가·고샅 가장자리 중심 ──────────────────────────────────────────
// 조선 마을 풀은 손질된 마당 안이 아니라 담장 바깥 길 어깨·고샅(골목) 가장자리에 무성하다. 그래서
// 배치 무게를 필지 앞(=frontDir=+z=대문/길)의 길 어깨와 그 양옆 고샅으로 옮기고, 마당 안은 담장 밑
// 성긴 밴드만 남긴다(#90 은 마당 안 중심이었다). 반환 pt.lane 으로 분포 검증(verify-ambfield).
// 비움: 대문 진입 동선·건물 발자국·마당 중앙 동선·마당(닭) 중심. 담장 밑동 밀착(제곱 편향)으로 성토
//   패드 밖 낮은 노면 위로 뜨는 것을 억제한다(패드 축대 부유 방지).
// 담 밑동 스커트(#§7.5 W3-3): 담 몸체 바로 밑 wallSkirt(m) 안에서는 밀도와 키를 함께 떨어뜨린다.
//   종전 배치는 담장 밑동으로 제곱 편향해 무성하게 몰렸고(부유 억제 목적), 그 결과 근접 컷에서
//   토담 하부 습윤 흔적·막돌 굽이 양면에서 완전히 가려 authored 디테일이 화면에서 사라졌다
//   (docs/architectural-authenticity.md §7.3 A4 / §7.4-8). 밑동을 비우지는 않는다 — 처마 낙수선·
//   그늘·통행으로 눌린 짧은 잔풀은 실제로 있으므로, 무성함을 밖으로 한 뼘 밀고 밑동은 낮게 남긴다.
//   밀도만 줄이면 부족하다: 총 개수는 목표치까지 다시 채워지고 살아남은 포기의 최대 키는 그대로여서
//   화면상 가림 높이가 거의 안 변한다(실측). 그래서 이 띠 안에서는 s·hVar 곱에 절대 상한을 걸어
//   최대 키를 강제로 낮춘다 — blade 지오 최대 높이 0.74m 기준 밑동에서 ≈0.26m(막돌 굽 0.37m 아래).
const skirtKeep = (k) => 0.18 + 0.82 * k * k;
const skirtHeightCap = (k) => 0.35 + 0.65 * k;

function buildPlacements({ W, D, yard, style, gateW, seed, count, wallSkirt = 0.55 }) {
  const rng = makeRng(seed);
  const hw = W / 2, hd = D / 2;
  // dWall = 담 평면까지의 거리. 통과하면 s 배율을 돌려준다(탈락 시 null).
  const skirt = Math.max(0, wallSkirt);
  const pressed = (dWall, s, hVar) => {
    if (skirt <= 0) return 1;
    const k = Math.min(1, Math.max(0, dWall) / skirt);
    if (k >= 1) return 1;
    if (rng() > skirtKeep(k)) return null;
    const cap = skirtHeightCap(k);
    const product = s * hVar;
    return product > cap ? cap / product : 1;
  };

  // 건물 발자국(북쪽 몸채) 회피 — 마당 안 배치에만 적용.
  const bHalfW = W * 0.30;
  const bZbot = -hd + D * (style === 'choga' ? 0.42 : 0.55);
  const inBuilding = (x, z) => Math.abs(x) < bHalfW && z > -hd && z < bZbot;
  const onPath = (x, z) => Math.abs(x) < 1.35 && z > bZbot - 0.5;   // 대문→몸채 디딤돌 길
  const gHalf = (gateW || 2.0) * 0.5 + 0.7;
  const inGateGap = (x, z) => z > hd - 1.2 && Math.abs(x) < gHalf;   // 마당 안 대문 진입 동선
  const inYard = yard && Number.isFinite(yard.x)
    ? (x, z) => ((x - yard.x) ** 2 + (z - yard.z) ** 2) < (yard.r * 1.05) ** 2
    : () => false;
  const gateGapX = gHalf + 0.2;      // 길 어깨에서도 대문 정면은 성기게(진입 인상)

  const pts = [];
  let nRoad = 0, nAlley = 0, nRest = 0, nYard = 0;
  const tRoad = Math.round(count * 0.42);    // 앞(+z) 길 어깨 — 가장 무성
  const tAlley = Math.round(count * 0.24);   // 앞쪽 좌우 고샅 어깨
  const tRest = Math.round(count * 0.12);    // 뒤/옆 성긴 잡초
  // 나머지(≈22%)는 마당 안 담장 밑 성긴 밴드.

  // 1) 앞 길 어깨(+z 바깥): 담장 밑동에서 길 쪽으로 밴드. 대문 정면만 성기게(양옆으로 갈라짐).
  let a = 0;
  while (nRoad < tRoad && a++ < tRoad * 40) {
    const x = (rng() * 2 - 1) * (hw + 0.6);
    const z = hd + 0.12 + 0.1 + rng() * rng() * 1.7;   // 제곱 편향(성토 패드 밖 부유 억제) — 밑동은 아래 스커트가 눌러 준다
    if (Math.abs(x) < gateGapX && rng() > 0.15) continue;
    const s0 = 0.6 + rng() * 0.5, h0 = 0.8 + rng() * 0.45;
    const k = pressed(z - hd, s0, h0);
    if (k === null) continue;
    pts.push({ x, z, ext: true, lane: 'road', yaw: rng() * TAU, s: s0 * k, hVar: h0 });
    nRoad++;
  }

  // 2) 앞쪽 좌우 고샅 어깨(±x 바깥, 앞 절반 z>0 편향): 골목을 따라 자란 풀.
  a = 0;
  while (nAlley < tAlley && a++ < tAlley * 40) {
    const side = rng() < 0.5 ? 1 : -1;
    const x = side * (hw + 0.12 + 0.1 + rng() * rng() * 1.5);
    const z = (rng() * 1.35 - 0.35) * hd;               // 앞(z>0) 편향, 뒤쪽도 약간
    const s0 = 0.55 + rng() * 0.45, h0 = 0.75 + rng() * 0.4;
    const k = pressed(Math.abs(x) - hw, s0, h0);
    if (k === null) continue;
    pts.push({ x, z, ext: true, lane: 'alley', yaw: rng() * TAU, s: s0 * k, hVar: h0 });
    nAlley++;
  }

  // 3) 뒤/옆 성긴 잡초(담장 바깥 밑동, 전방위 소량).
  a = 0;
  while (nRest < tRest && a++ < tRest * 40) {
    const pick = rng.int(0, 3);
    const out = 0.1 + rng() * 0.5;
    let x, z;
    if (pick === 1) { x = (rng() * 2 - 1) * (hw - 0.4); z = -hd - out; }
    else if (pick === 2) { x = hw + out; z = (rng() * 2 - 1) * (hd - 0.4); }
    else if (pick === 3) { x = -hw - out; z = (rng() * 2 - 1) * (hd - 0.4); }
    else { x = (rng() * 2 - 1) * (hw - 0.4); z = hd + out; if (Math.abs(x) < gateGapX) continue; }
    const s0 = 0.5 + rng() * 0.35, h0 = 0.7 + rng() * 0.3;
    const k = pressed(out, s0, h0);
    if (k === null) continue;
    pts.push({ x, z, ext: true, lane: 'rest', yaw: rng() * TAU, s: s0 * k, hVar: h0 });
    nRest++;
  }

  // 4) 마당 안: 담장 밑 성긴 밴드만(소량). 중앙·건물·마당 중심·대문 진입은 비움.
  const band = Math.min(2.2, Math.min(W, D) * 0.2);
  const inMargin = 0.32;
  const tYard = Math.max(0, count - pts.length);
  a = 0;
  while (nYard < tYard && a++ < tYard * 50) {
    const x = (rng() * 2 - 1) * (hw - inMargin);
    const z = (rng() * 2 - 1) * (hd - inMargin);
    if (inBuilding(x, z) || onPath(x, z) || inGateGap(x, z) || inYard(x, z)) continue;
    const ed = Math.min(hw - Math.abs(x), hd - Math.abs(z));   // 최근접 벽까지
    const w = ed <= band ? (0.9 - 0.55 * (ed / band)) : 0.03;  // 담장 밑만, 중앙 거의 없음
    if (rng() > w) continue;
    const s0 = 0.7 + rng() * 0.5, h0 = 0.82 + rng() * 0.4;
    const k = pressed(ed, s0, h0);
    if (k === null) continue;
    pts.push({ x, z, ext: false, lane: 'yard', yaw: rng() * TAU, s: s0 * k, hVar: h0 });
    nYard++;
  }

  pts.lanes = { road: nRoad, alley: nAlley, rest: nRest, yard: nYard };
  return pts;
}

// 생업 오브젝트는 계절 전환 전에 세 계절의 잠재 위치를 모두 예약한다. 기존 RNG 스트림과
// 풀 분포는 먼저 완전히 소비하고, 그 결정적 후보 배열만 안정 필터링한다. 재시도·보충 배치는
// 하지 않으므로 새 난수 소비나 계절별 풀 팝 없이 같은 한 InstancedMesh를 유지한다.
function clearGrassObstacles(placements, obstacles) {
  if (!Array.isArray(obstacles) || obstacles.length === 0) return placements;
  const circles = obstacles.filter((obstacle) => (
    obstacle?.shape === 'circle'
    && Number.isFinite(obstacle.x)
    && Number.isFinite(obstacle.z)
    && Number.isFinite(obstacle.radius)
    && obstacle.radius >= 0
  ));
  if (circles.length === 0) return placements;

  const filtered = placements.filter((placement) => !circles.some((obstacle) => (
    Math.hypot(placement.x - obstacle.x, placement.z - obstacle.z) <= obstacle.radius
  )));
  filtered.lanes = { road: 0, alley: 0, rest: 0, yard: 0 };
  for (const placement of filtered) {
    if (Object.hasOwn(filtered.lanes, placement.lane)) filtered.lanes[placement.lane]++;
  }
  return filtered;
}

export function setupGrass(parent, {
  bounds = { W: 20, D: 18 }, matrix = null, yard = null, style = 'hanok', gateW = 2.0,
  sun = null, seed = 4343, count, season = 'summer', grassObstacles = null,
  wallSkirt = 0.55,
} = {}) {
  const W = bounds.W || 20, D = bounds.D || 18;
  // 밀도 상향(#106): #90 기저 공식 대비 ~1.75× (길가·고샅 어깨로 재배치하며 무성함 강화). 상한 1200
  //   (기저 캡 700 에서도 밀도 ≥1.5 유지). 단일 InstancedMesh 라 인스턴스만 늘 뿐 드로우콜 불변(+1).
  const baseN = Math.max(160, Math.min(700, Math.round(2 * (W + D) * 7)));
  const N = count || Math.min(1200, Math.round(baseN * 1.75));

  const geoRng = makeRng((seed ^ 0x9e3d) >>> 0);
  const { geo, trisPerTuft } = buildTuftGeometry(geoRng);
  const candidates = buildPlacements({
    W, D, yard, style, gateW, seed: (seed ^ 0x51ed) >>> 0, count: N, wallSkirt,
  });
  const pts = clearGrassObstacles(candidates, grassObstacles);

  // ── 재질(MeshStandardMaterial 패치) ──
  const uGrassTime = { value: 0 };
  const uGrassWind = { value: new THREE.Vector2(0, 0) };
  const uGrassGust = { value: 0 };
  const uGrassFade = { value: 0 };                     // 크로스페이드(높이 배율)
  const uGrassRoot = { value: linCol(SEASON_COL[season] ? SEASON_COL[season].root : 0x33501e) };
  const uGrassTip = { value: linCol(SEASON_COL[season] ? SEASON_COL[season].tip : 0x74992f) };
  const uSunDir = { value: new THREE.Vector3(0, 1, 0) };
  const uGrassGlow = { value: 0.5 };
  const uGrassWarm = { value: linCol(0xffca7a) };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrassTime = uGrassTime;
    shader.uniforms.uGrassWind = uGrassWind;
    shader.uniforms.uGrassGust = uGrassGust;
    shader.uniforms.uGrassFade = uGrassFade;
    shader.uniforms.uGrassRoot = uGrassRoot;
    shader.uniforms.uGrassTip = uGrassTip;
    shader.uniforms.uSunDir = uSunDir;
    shader.uniforms.uGrassGlow = uGrassGlow;
    shader.uniforms.uGrassWarm = uGrassWarm;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBladeH;
        uniform float uGrassTime;
        uniform vec2  uGrassWind;
        uniform float uGrassGust;
        uniform float uGrassFade;
        uniform vec3  uGrassRoot;
        uniform vec3  uGrassTip;
        uniform vec3  uSunDir;
        uniform float uGrassGlow;
        varying vec3  vGrassTint;
        varying float vGrassGlowV;`)
      // 색 그라디언트(뿌리→끝) + 인스턴스별 편차. 크로스페이드는 uGrassFade(아래 높이 배율).
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING
        vec3 gInst = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float gJit = fract(sin(dot(gInst, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        #else
        float gJit = 0.5;
        #endif
        vGrassTint = mix(uGrassRoot, uGrassTip, aBladeH) * (0.80 + 0.42 * gJit);`)
      // 높이 배율(크로스페이드 grow-in): 뿌리 고정, 끝이 자란다. 오브젝트 공간(로컬 +y=수직).
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.y *= uGrassFade;`)
      // instanceMatrix 적용 후 월드 방향 바람 굽힘 + 역광 글로우 산출.
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec3 gip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float gph = fract(sin(dot(gip, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 6.2831853;
          float gbw = aBladeH * aBladeH;                                  // 끝일수록 크게 굽음
          float gsw = 0.66 * sin(uGrassTime * 1.6 + gph) + 0.34 * sin(uGrassTime * 3.3 + gph * 1.7);
          float gamp = (0.55 + 0.95 * uGrassGust) * (0.55 + 0.85 * gsw);
          mvPosition.x += uGrassWind.x * gbw * gamp;
          mvPosition.z += uGrassWind.y * gbw * gamp;
        #endif
        vec4 gWorld = modelMatrix * mvPosition;
        vec3 gView = normalize(gWorld.xyz - cameraPosition);
        float gFwd = max(dot(gView, normalize(uSunDir)), 0.0);
        // 전방산란은 시선이 태양축에 거의 맞을 때만 성립한다. 지수 3 은 측광 화각에서도 절반쯤
        //   남아 마당 전체가 균일하게 발광했다 → 6 으로 좁혀 진짜 역광 프레임에만 피어나게 한다.
        //   또 뿌리 바닥값을 거의 없애(0.15→0.04) 발광이 잎끝 실루엣에 모이게 한다.
        vGrassGlowV = pow(gFwd, 6.0) * (0.04 + 0.96 * aBladeH * aBladeH) * uGrassGlow;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGrassWarm;
        varying vec3 vGrassTint;
        varying float vGrassGlowV;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vGrassTint;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uGrassWarm * vGrassGlowV;`);
  };

  const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
  mesh.name = 'focusGrass';
  mesh.castShadow = false;          // 그림자 패스 0(드로우콜 +1 유지) + 얇은 블레이드 자기그림자 노이즈 회피
  mesh.receiveShadow = true;        // 담장·몸채 그림자를 받아 지면에 안착(추가 드로우콜 없음)
  mesh.frustumCulled = false;
  // 색 패스는 uGrassFade grow-in + 바람 변형을 쓰지만 전역 MeshDepthMaterial은 둘 다 모른다.
  // 얇은 장식 풀이 완전 높이의 정적 깊이로 먼저 팝하지 않도록 지면/건물 깊이를 그대로 사용한다.
  mesh.userData.dofDepth = false;

  // 인스턴스 행렬: 로컬 TRS(yaw+scale+pos) → 필지 월드행렬 곱(회전 반영). y=0=지면.
  const parcelM = matrix ? matrix.clone() : new THREE.Matrix4();
  const _lm = new THREE.Matrix4(), _wm = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _pos = new THREE.Vector3(), _scl = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const hMul = SEASON_COL[season] ? SEASON_COL[season].hMul : 1.0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _q.setFromAxisAngle(_up, p.yaw);
    _pos.set(p.x, 0, p.z);
    _scl.set(p.s, p.s * p.hVar * hMul, p.s);
    _lm.compose(_pos, _q, _scl);
    _wm.multiplyMatrices(parcelM, _lm);
    mesh.setMatrixAt(i, _wm);
  }
  mesh.instanceMatrix.needsUpdate = true;

  parent.add(mesh);

  // ── 시간대·계절 상태(크로스페이드) ──
  let t = 0;
  const rootCur = uGrassRoot.value, tipCur = uGrassTip.value;
  const rootTgt = rootCur.clone(), tipTgt = tipCur.clone();
  let glowCur = uGrassGlow.value, glowTgt = glowCur;
  const warmTgt = uGrassWarm.value.clone();
  const _sunDir = new THREE.Vector3();
  const SEASON_RATE = 2.4, TIME_RATE = 2.2;

  function setSeason(name, opts = {}) {
    const s = SEASON_COL[name] || SEASON_COL.summer;
    rootTgt.copy(linCol(s.root));
    tipTgt.copy(linCol(s.tip));
    if (opts.immediate) { rootCur.copy(rootTgt); tipCur.copy(tipTgt); }
    // hMul(겨울 성김·마름)은 인스턴스 스케일에 반영돼 rebuild 없이는 즉시 미반영 — 색만 크로스페이드.
  }
  function setTime(name, opts = {}) {
    const g = TIME_GLOW[name] || TIME_GLOW.day;
    glowTgt = g.int;
    warmTgt.copy(linCol(g.warm));
    if (opts.immediate) { glowCur = glowTgt; uGrassGlow.value = glowCur; uGrassWarm.value.copy(warmTgt); }
  }
  setSeason(season, { immediate: true });

  // 크로스페이드 배율(focus 링 규약). 0=지면에 잠김, 1=완전. GPU 셰이더 배율(CPU 비용 0).
  function setFade(v) {
    uGrassFade.value = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    mesh.visible = uGrassFade.value > 0.002;
  }

  function update(dt) {
    t += dt;
    // 바람: wind.js 판독(연기·낙엽과 동일 필드·거스트 타이밍). 흔들림 진폭 계수.
    const w = getWind(t);
    uGrassTime.value = t;
    uGrassWind.value.set(w.dirX * w.speed * 0.55, w.dirZ * w.speed * 0.55);
    uGrassGust.value = w.gust;
    if (sun) { _sunDir.copy(sun.position).normalize(); uSunDir.value.copy(_sunDir); }
    // 계절 색·시간대 글로우 지수 접근(크로스페이드).
    const ks = Math.min(1, dt * SEASON_RATE), kt = Math.min(1, dt * TIME_RATE);
    rootCur.lerp(rootTgt, ks); tipCur.lerp(tipTgt, ks);
    glowCur += (glowTgt - glowCur) * kt; uGrassGlow.value = glowCur;
    uGrassWarm.value.lerp(warmTgt, kt);
  }

  function dispose() {
    parent.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return {
    mesh, setFade, setSeason, setTime, update, dispose,
    // drawInfo.lanes: 배치 분포(#106 검증). ext(road+alley+rest) = 길가/외곽, yard = 마당 안.
    drawInfo: { instances: pts.length, triangles: pts.length * trisPerTuft, baseN, lanes: pts.lanes || null },
  };
}
