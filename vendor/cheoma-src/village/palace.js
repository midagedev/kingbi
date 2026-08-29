import * as THREE from 'three';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import {
  makeDancheongVariant,
  makeMaterials,
  canonicalizeSharedMaterials,
} from '../builder/palette.js';
import { resolveDancheong } from '../builder/dancheong.js';
import {
  addMaterialResource,
  collectObjectResources,
  disposeObjectResources,
} from '../core/three-resources.js';
import { buildCorridor } from '../layout/corridor.js';
import { buildGate } from '../layout/gate.js';
import { buildFence } from '../layout/fence.js';
import { buildBridge } from '../builder/bridge.js';
import { mergeStatic } from './instancing.js';
import { palaceOuterPrecinctPlan } from './palace-precinct-plan.js';

// ─────────────────────────────────────────────────────────────────────────
// 궁궐 컴파운드 오케스트레이터 (#88). docs/palace-layout.md §8 알고리즘 구현.
//
//   조선 궁궐 = "행각(行閣)으로 두른 마당(일곽)을 남북 축선에 꿴 것". 인접 일곽은
//   독립 담이 아니라 하나의 행각을 경계로 공유한다(담=행각). 정전→편전→침전→중궁전
//   순으로 마당이 작아지고 격식이 낮아진다. 동궁(+x)·궐내각사(-x)가 측면에 붙고,
//   진입부(정문↔중문 사이)에 금천교가 놓인다.
//
//   신규 지오메트리 빌더 없음 — buildBuilding(전각)·buildCorridor(행각=담)·
//   buildGate(문)·buildBridge(금천교)·buildFence(궁장)만 조립한다.
//
//   좌표계: 로컬 +z = 남(진입/정문), -z = 북(배산/후원). 전각은 모두 +z(남) 정면.
//     원점 = 궁역 중심. buildPalaceCore 가 이 그룹을 frontDir 로 회전·성토패드 위에 올린다.
//
//   buildPalaceCompound({ w, d, tier, variant, seed, mats }) → THREE.Group
// ─────────────────────────────────────────────────────────────────────────

// 행각 세그먼트 로컬 +Z(마당 개방)가 마당 중심을 향하도록 하는 innerSide.
//   corners SW→SE→NE→NW(로컬 +z=남) 는 시계방향(shoelace<0)이라 좌법선이 바깥 →
//   중심 향(우법선)으로 뒤집으려면 -1. (시각 검증 완료.)
const INNER = -1;
const lifecycle = new WeakMap();

function collectPaletteResources(palette) {
  const materials = new Set();
  const textures = new Set();
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) addMaterialResource(value, materials, textures);
    else if (value?.isTexture) textures.add(value);
  }
  return { materials, textures };
}

// 부속·소전각 배치용 처마 외연 반치수(로컬 AABB). buildBuilding 결과는 월대·처마·마루장식까지
// 포함하므로, 이 실측 외연을 이격 산정 기준으로 써야 지붕이 본채·이웃·행각과 겹치지 않는다(#97).
function footprintHalf(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return {
    x: Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
    z: Math.max(Math.abs(b.min.z), Math.abs(b.max.z)),
    minZ: b.min.z, maxZ: b.max.z,
  };
}

// 전각 프리셋 변주 — PRESETS.korea 를 격식별로 축소(신규 프리셋 아님, 스프레드 파생).
// roofRank palace: multi-곽 궁 전각만 잡상·취두를 받는다 (관아 hero와 분리, #150 C).
function hallPreset(role, seed) {
  const k = PRESETS.korea;
  if (role === 'jeongjeon') {
    // 정전(근정전): 정면 5칸·2중 월대·돌난간. 궁의 얼굴 — 기준 100%.
    return {
      ...k, seed, roofRank: 'palace',
      podiumTiers: 2, podiumRailing: true, frontBays: 5, sideBays: 3,
    };
  }
  if (role === 'pyeonjeon') {
    // 편전(사정전): 정면 3칸·단층 월대. 일상 집무.
    return {
      ...k, seed, roofRank: 'palace',
      podiumTiers: 1, podiumTierH: 1.0, podiumRailing: false,
      frontBays: 3, sideBays: 3, columnHeight: 3.7,
      centerBayW: 3.5, middleBayW: 3.0, endBayW: 2.6,
    };
  }
  // 침전·중궁전(강녕전·교태전): 주거형 — 더 낮고 아담, 공포 절제.
  return {
    ...k, seed, roofRank: 'palace',
    podiumTiers: 1, podiumTierH: 0.8, podiumRailing: false,
    frontBays: 3, sideBays: 3, columnHeight: 3.4, bracketTiers: 1, interBrackets: 1,
    centerBayW: 3.2, middleBayW: 2.8, endBayW: 2.4, ridgeH: 0.42,
  };
}

// 티어별 궁역 스펙(§6-3). 축선 일곽은 남→북 순서(진입부 다음부터).
function tierSpec(tier) {
  if (tier === 'capital') {
    // capital 축소판 60×90: 3일곽(정전+편전+침전) + 금천교, 측면 블록 생략.
    return {
      w: 60, d: 90, entryD: 20,
      areas: [
        { role: 'jeongjeon', W: 32, D: 38, corridorDepth: 3.0, colH: 3.2, gate: 'soseuldaemun', gateW: 7.2, court: 'jojeong' },
        { role: 'pyeonjeon', W: 27, D: 26, corridorDepth: 2.4, colH: 2.7, gate: 'iljakmun', gateW: 3.0 },
        { role: 'chimjeon', W: 28, D: 24, corridorDepth: 2.4, colH: 2.6, gate: 'iljakmun', gateW: 3.0 },
      ],
      flanks: [],
    };
  }
  // hanyang 플래그십 96×150: 4일곽 축선 + 동궁(+x) + 궐내각사(-x) + 금천교 + 후원 여백.
  return {
    w: 96, d: 150, entryD: 24,
    areas: [
      { role: 'jeongjeon', W: 34, D: 40, corridorDepth: 3.0, colH: 3.2, gate: 'soseuldaemun', gateW: 7.6, court: 'jojeong' },
      { role: 'pyeonjeon', W: 28, D: 28, corridorDepth: 2.4, colH: 2.7, gate: 'iljakmun', gateW: 3.2 },
      { role: 'chimjeon', W: 30, D: 26, corridorDepth: 2.4, colH: 2.6, gate: 'iljakmun', gateW: 3.2, satellites: 4 },
      { role: 'junggung', W: 24, D: 22, corridorDepth: 2.4, colH: 2.5, gate: 'iljakmun', gateW: 3.0, backGarden: true },
    ],
    flanks: [
      { role: 'donggung', side: +1, W: 22, D: 30, attachTo: 'pyeonjeon' },
      { role: 'gwolnaegaksa', side: -1, W: 24, D: 34, attachTo: 'pyeonjeon', subCells: 4 },
    ],
  };
}

// 한 행각 변(2점 폴리라인)을 세운다. gap(개구) 이 있으면 중앙을 비우고 두 토막으로.
//   a,b 는 변의 두 끝(로컬). 변은 항상 사각형 CCW 순회 방향으로 준다(INNER 일관).
function wallRun(root, a, b, gap, depth, colH, seed) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz);
  if (L < 0.1) return;
  const ux = dx / L, uz = dz / L;
  const runs = [];
  if (gap && gap < L - 1.0) {
    const h = gap / 2, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    runs.push([a, { x: mx - ux * h, z: mz - uz * h }]);
    runs.push([{ x: mx + ux * h, z: mz + uz * h }, b]);
  } else {
    runs.push([a, b]);
  }
  for (let i = 0; i < runs.length; i++) {
    const [p, q] = runs[i];
    if (Math.hypot(q.x - p.x, q.z - p.z) < 0.6) continue;
    const { group } = buildCorridor({
      points: [p, q], closed: false, mats: root.userData.mats,
      seed: (seed + i) >>> 0, depth, colH, innerSide: INNER,
    });
    root.add(group);
  }
}

// 모서리 기둥(변을 따로 세우면 buildCorridor 가 코너 포스트를 안 붙이므로 수동).
function cornerPost(root, x, z, colH) {
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.18, colH, 10), root.userData.mats.wood);
  post.position.set(x, colH / 2, z); post.castShadow = true;
  root.add(post);
}

// 사각 행각 일곽. cx,cz 중심, W×D 외곽. sides 로 변별 존재·개구 제어.
//   반환: 개구(문) 배치용 정보. 담=행각(행각 바깥벽이 곧 경계담) — 독립 담 없음.
function enclosure(root, cx, cz, W, D, { depth, colH, sides, seed }) {
  const chw = W / 2 - depth / 2, chd = D / 2 - depth / 2;   // 행각 중심선(바깥면=외곽)
  const SW = { x: cx - chw, z: cz + chd }, SE = { x: cx + chw, z: cz + chd };
  const NE = { x: cx + chw, z: cz - chd }, NW = { x: cx - chw, z: cz - chd };
  // CCW 순회: S(SW→SE) E(SE→NE) N(NE→NW) W(NW→SW)
  if (sides.south) wallRun(root, SW, SE, sides.southGap, depth, colH, seed ^ 0x11);
  if (sides.east) wallRun(root, SE, NE, 0, depth, colH, seed ^ 0x22);
  if (sides.north) wallRun(root, NE, NW, sides.northGap, depth, colH, seed ^ 0x33);
  if (sides.west) wallRun(root, NW, SW, 0, depth, colH, seed ^ 0x44);
  // 모서리 기둥: 인접 두 변이 모두 있을 때만.
  if (sides.south && sides.west) cornerPost(root, SW.x, SW.z, colH);
  if (sides.south && sides.east) cornerPost(root, SE.x, SE.z, colH);
  if (sides.north && sides.east) cornerPost(root, NE.x, NE.z, colH);
  if (sides.north && sides.west) cornerPost(root, NW.x, NW.z, colH);
  return { chw, chd };
}

// 문 배치(로컬 +z 정면 = 남). 행각 개구 자리에 앉힌다.
function placeGate(root, type, x, z, { width, seed, faceSouth = true }) {
  const g = buildGate(type, { mats: root.userData.mats, seed, width });
  g.position.set(x, 0, z);
  g.rotation.y = faceSouth ? 0 : Math.PI;
  root.add(g);
  return g;
}

// 전각 배치 — 마당 북측(안쪽), 남향(+z). buildBuilding 자체 월대 포함.
//   반환 { group, frontZ } (frontZ=전각 남단 처마, 어도·품계석 배치 기준).
function placeHall(root, preset, cx, czNorthFace, depth, name) {
  // 공유 재질셋(#149): preset.mats(호출측이 shareMats 시 세팅)가 있으면 전각이 그걸 공유 → 병합 붕괴.
  const hall = buildBuilding(preset);
  const L = hall.userData.layout;
  const backMargin = (preset.podiumMarginS || 1.4) + 1.2;
  const hallHalfD = L.zEave + (preset.podiumMarginS || 1.4);
  const hz = czNorthFace + depth + backMargin + hallHalfD;   // 북벽 안쪽에 등을 붙임
  hall.position.set(cx, 0, hz);
  hall.name = name;
  hall.userData.palaceRole = name;
  root.add(hall);
  return { group: hall, frontZ: hz + L.zEave + 0.5, layout: L };
}

// 조정(정전 마당) — 박석 바닥 + 3열 어도 + 품계석 12쌍(인스턴싱).
function layJojeong(root, cx, cz, W, D, depth, frontZ, gateZ) {
  const M = root.userData.mats;
  const netW = W - 2 * depth;
  const courtMinZ = Math.min(frontZ, gateZ);
  const courtMaxZ = Math.max(frontZ, gateZ);
  // 박석: 밝은 회백색 거친 판석 평면(흙 마당 대신).
  const bakseok = new THREE.Mesh(
    new THREE.PlaneGeometry(netW - 0.4, (gateZ - frontZ) - 0.4),
    new THREE.MeshStandardMaterial({ color: 0xb9b3a4, roughness: 1.0 }));
  bakseok.rotation.x = -Math.PI / 2;
  bakseok.position.set(cx, 0.02, (frontZ + gateZ) / 2);
  bakseok.receiveShadow = true;
  root.add(bakseok);
  // 어도: 살짝 높은 3열 답도(중앙열 넓음). 정문→전각 계단.
  const adoW = 2.6, adoL = gateZ - frontZ - 1.0;
  const ado = new THREE.Mesh(
    new THREE.BoxGeometry(adoW, 0.14, adoL),
    new THREE.MeshStandardMaterial({ color: 0xa89f8c, roughness: 1.0 }));
  ado.position.set(cx, 0.07, (frontZ + gateZ) / 2);
  ado.receiveShadow = ado.castShadow = true;
  root.add(ado);
  // 품계석: 어도 양쪽 두 줄, 각 12개(정1품~종9품). InstancedMesh 1개(반복 소품).
  const geo = new THREE.CylinderGeometry(0.16, 0.2, 0.85, 8);
  const inst = new THREE.InstancedMesh(geo, M.stoneDark, 24);
  inst.name = 'pumgyeseok';
  const m = new THREE.Matrix4();
  const rowX = adoW / 2 + 1.6;
  const z0 = frontZ + 1.6, z1 = gateZ - 3.0;
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const z = z0 + (z1 - z0) * (i / 11);
    for (const sx of [-1, 1]) {
      m.makeTranslation(cx + sx * rowX, 0.42, z);
      inst.setMatrixAt(n++, m);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = inst.receiveShadow = true;
  root.add(inst);
  return {
    id: 'jojeong',
    role: 'state-court',
    footprint: [
      { x: cx - netW * 0.5, z: courtMaxZ },
      { x: cx + netW * 0.5, z: courtMaxZ },
      { x: cx + netW * 0.5, z: courtMinZ },
      { x: cx - netW * 0.5, z: courtMinZ },
    ],
    y: 0.02,
  };
}

// 금천 + 금천교(진입부). 명당수는 동서류(x축), 홍예교가 남북(축선)으로 건넌다.
function layGeumcheon(root, cx, cz, seed) {
  const M = root.userData.mats;
  // 금천(얕은 도랑 + 물) — 동서로 흐르는 좁은 개천.
  const streamW = 26, streamD = 6.5;
  const ditch = new THREE.Mesh(
    new THREE.BoxGeometry(streamW, 0.5, streamD),
    new THREE.MeshStandardMaterial({ color: 0x6b6355, roughness: 1.0 }));
  ditch.position.set(cx, -0.24, cz);
  ditch.receiveShadow = true;
  root.add(ditch);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(streamW - 0.6, streamD - 1.2),
    new THREE.MeshStandardMaterial({ color: 0x33506a, roughness: 0.35, metalness: 0.0 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, -0.06, cz);
  root.add(water);
  // 금천교: 낮은 판석 돌다리(#97). 종전 홍예교(type:'arch', span 9·폭 6.5)는 정점≈4.57m로 진입부를
  // 압도하고 마른 지면 위 붕 뜬 인상이었다 → 고증(경복궁 영제교·창덕궁 금천교는 낮고 편평)을 좇아
  // 낮은 판석교로 축소. span=크로싱(로컬 X, 금천 폭 6.5 + 양안 받침), width=통행 폭(어도급). 축선(z) 90° 회전.
  const bridge = buildBridge({ type: 'slab', span: streamD + 2.0, width: 4.6, deckY: 0.5, piers: 2, seed });
  bridge.position.set(cx, 0.06, cz);
  bridge.rotation.y = Math.PI / 2;
  root.add(bridge);
}

export function buildPalaceCompound({
  w, d, tier = 'hanyang', variant = 'axial', seed = 5, mats,
  merge = true, presetOverrides = null, shareMats = true, dancheong = null,
} = {}) {
  const explicitDancheong = dancheong ? {
    ...dancheong,
    ...(dancheong.clarity != null ? { dancheongClarity: dancheong.clarity } : {}),
    ...(dancheong.splendor != null ? { dancheongSplendor: dancheong.splendor } : {}),
  } : {};
  const requestedDancheong = resolveDancheong('palace', {
    ...(mats?.dancheong || {}),
    ...(presetOverrides || {}),
    ...explicitDancheong,
  });
  const sameDancheong = mats?.dancheong
    && mats.dancheong.clarityBucket === requestedDancheong.clarityBucket
    && mats.dancheong.splendorBucket === requestedDancheong.splendorBucket;
  const M = mats
    ? (sameDancheong ? mats : makeDancheongVariant(mats, requestedDancheong))
    : makeMaterials('palace', requestedDancheong);
  // #149 재질 공유 게이트: shareMats(기본 ON) 면 전 전각이 M 한 벌을 공유 + 시각 동일 재질 통일 →
  //   부감 병합(palaceMerged)이 전각 경계까지 무너진다(한양 궁 병합 392→61콜). false 면 구 동작
  //   (전각마다 makeMaterials·통일 없음) — A/B 측정·회귀 진단용.
  const hallMats = shareMats ? M : undefined;
  const spec = tierSpec(tier);
  // 편집 오버라이드(#93): 전 전각 buildBuilding 프리셋에 일괄 적용 — 궁 전체 일관 반영.
  //   칸수/월대단수 등 일곽-구조 종속 키는 호출측(edit-schema)이 보내지 않는 규약.
  const applyOv = (p) => Object.assign(p, presetOverrides || {}, {
    dancheongClarity: requestedDancheong.dancheongClarity,
    dancheongSplendor: requestedDancheong.dancheongSplendor,
    // Edits must not demote multi-곽 halls off the palace ornament rank.
    roofRank: 'palace',
  });
  // 요청 궁역(w,d)이 있으면 존중하되, 스펙 축선이 들어갈 최소치로 클램프.
  const W = Math.max(w || spec.w, spec.w);
  const D = Math.max(d || spec.d, spec.d);
  const hw = W / 2, hd = D / 2;

  const root = new THREE.Group();
  root.name = `palace-compound-${tier}`;
  root.userData.mats = M;

  const areaHandles = [];   // 편집 승격용 개별 일곽 핸들

  // 공유 재질 정규화 캐시(#149): 일곽을 가로질러 누적된다. 빌더가 부재별로 clone 한 "시각 동일"
  //   재질(창방 색동·문짝 분합·기와면 골·합각·처마 띠·적새)을 canon 인스턴스로 통일해, 부감 병합
  //   (palaceMerged)이 전각·일곽 경계까지 무너지게 한다. 픽셀 동일 보장(서명이 렌더 필드를 모두 담음).
  const matCanon = new Map();

  // 정적 히어로라 일곽 단위로 재질별 병합(드로우콜 억제). 병합 그룹이 픽킹 단위(heroHandle 유사).
  //   merge=false 면 미병합(before 측정용). 병합 후에도 그룹 name·userData 로 편집 노출 유지.
  const finalize = (grp) => {
    if (shareMats) canonicalizeSharedMaterials(grp, matCanon);   // #149 시각 동일 재질 통일(일곽 누적)
    if (!merge) { root.add(grp); return grp; }
    const merged = mergeStatic([grp], grp.name);
    merged.userData = grp.userData;
    root.add(merged);
    return merged;
  };

  // ── 1) 궁성 담(궁장) — 외곽 폐곡선 + 남측 광화문 개구 ──
  const outerPrecinct = palaceOuterPrecinctPlan(W, D);
  const { group: palaceWall } = buildFence({
    points: outerPrecinct.wall.points,
    closed: true,
    height: outerPrecinct.wall.height,
    thickness: outerPrecinct.wall.thickness,
    seed,
    mats: M,
    wallStyle: outerPrecinct.wall.wallStyle,
    openings: [outerPrecinct.wall.opening],
  });
  palaceWall.name = 'palace-wall';
  // 광화문(궁성 남문) — 솟을대문 3칸급, 개구 자리. (궁장·광화문은 아래 entry 그룹에서 조립.)
  const gwanghwa = buildGate(outerPrecinct.gate.type, {
    mats: M,
    seed,
    width: outerPrecinct.gate.width,
  });
  gwanghwa.position.set(outerPrecinct.gate.position.x, 0, outerPrecinct.gate.position.z);
  gwanghwa.rotation.y = outerPrecinct.gate.rotationY;
  gwanghwa.name = 'gate-gwanghwamun';

  // ── 2) 진입부: 중문(흥례문) → 금천교 → (정전 정문). 고증 순서(§2): 광화문→흥례문→영제교→근정문. ──
  const entry = new THREE.Group(); entry.name = 'palace-entry'; entry.userData.mats = M;
  entry.add(palaceWall); entry.add(gwanghwa);
  const southInner = hd - 0.8;                 // 궁장 남벽 안쪽
  const heungrye = buildGate('soseuldaemun', { mats: M, seed: seed ^ 0x88, width: 2.9 });
  const heungryeZ = southInner - spec.entryD * 0.30;   // 광화문 마당 지나 중문
  heungrye.position.set(0, 0, heungryeZ);
  heungrye.name = 'gate-heungryemun';
  entry.add(heungrye);
  layGeumcheon(entry, 0, southInner - spec.entryD * 0.62, seed ^ 0x77);   // 중문과 정문 사이 명당수

  // ── 3) 축선 일곽 스택(남→북), 담(행각) 공유 ──
  //   각 일곽의 남면은 이전 일곽 북벽이 겸한다(담 공유). 첫 일곽만 남벽을 세운다.
  let southFace = southInner - spec.entryD;     // 첫 일곽(정전) 남 외곽면
  for (let i = 0; i < spec.areas.length; i++) {
    const A = spec.areas[i];
    const isFirst = i === 0, isLast = i === spec.areas.length - 1;
    const cz = southFace - A.D / 2;
    const grp = new THREE.Group();
    grp.name = `ilgwak-${A.role}`;
    grp.userData.mats = M;
    // 행각 변 존재: 남벽은 첫 일곽만(이후는 이전 북벽 공유), 북벽은 항상(다음 일곽의 남경계 겸).
    const sides = {
      south: isFirst, southGap: A.gateW,
      north: true, northGap: isLast ? 0 : A.gateW,   // 마지막은 후원쪽 폐쇄
      east: true, west: true,
    };
    const { chd } = enclosure(grp, 0, cz, A.W, A.D, { depth: A.corridorDepth, colH: A.colH, sides, seed: seed + i * 7 });
    const northFace = cz - A.D / 2;

    // 정문(남 개구) — 첫 일곽은 근정문(솟을대문), 이후는 이전 북벽 개구에 일각문.
    const southGateZ = cz + chd + A.corridorDepth / 2;
    if (isFirst) {
      placeGate(grp, 'soseuldaemun', 0, southGateZ, { width: 2.8, seed: seed + i });
    }
    // 북 통행문(다음 일곽으로) — 일각문.
    if (!isLast) {
      const northGateZ = cz - chd - A.corridorDepth / 2;
      placeGate(grp, 'iljakmun', 0, northGateZ, { width: 1.9, seed: seed + i + 100 });
    }

    // 전각 + 월대.
    const preset = applyOv(hallPreset(A.role, (seed ^ (0x1000 * (i + 1))) >>> 0));
    preset.mats = hallMats;   // #149 공유 재질셋(shareMats 시 M, 아니면 undefined=구 동작)
    const {
      group: hall,
      frontZ,
      layout: hallLayout,
    } = placeHall(grp, preset, 0, northFace, A.corridorDepth, `hall-${A.role}`);

    // 조정(정전 전용): 박석·어도·품계석.
    let focusSemantic = null;
    if (A.court === 'jojeong') {
      const court = layJojeong(
        grp,
        0,
        cz,
        A.W,
        A.D,
        A.corridorDepth,
        frontZ,
        southGateZ - 1.0,
      );
      const hallZ = hall.position.z;
      const hallFootprint = [
        { x: -hallLayout.xEave, z: hallZ + hallLayout.zEave },
        { x: hallLayout.xEave, z: hallZ + hallLayout.zEave },
        { x: hallLayout.xEave, z: hallZ - hallLayout.zEave },
        { x: -hallLayout.xEave, z: hallZ - hallLayout.zEave },
      ];
      const courtCenterZ = (court.footprint[0].z + court.footprint[2].z) * 0.5;
      focusSemantic = {
        id: 'palace:jeongjeon-court',
        representative: {
          id: 'hall-jeongjeon',
          role: 'jeongjeon',
          footprint: hallFootprint,
          minY: 0,
          maxY: hallLayout.totalH,
        },
        courtyard: court,
        target: {
          x: 0,
          y: 3.2,
          z: hallZ * 0.62 + courtCenterZ * 0.38,
        },
      };
    }
    // 침전 부속(satellites): 본채 좌우 옆칸(side-aisle)에 이격된 소채. 본채 월대가 마당 깊이를
    // 대부분 차지하므로, 본채 실측 외연과 행각 사이 여유폭에서 겹치지 않는 최대 scale 을 역산해
    // 앉힌다(#97 — 종전엔 scale 0.72·cz+1.0 고정이라 본채 지붕에 관통). 붙여 쌓지 않는 게 원칙.
    if (A.satellites) {
      const satPreset = applyOv({ ...hallPreset('chimjeon', seed + 900), frontBays: 3, sideBays: 2, columnHeight: 3.0, podiumTiers: 1, podiumTierH: 0.6, mats: hallMats });
      const proto = buildBuilding(satPreset);
      const pf = footprintHalf(proto);
      const hf = footprintHalf(hall);            // 본채 실측 외연(월대 포함)
      const gap = 1.0;
      const interiorHX = A.W / 2 - A.corridorDepth;
      const aisle = interiorHX - hf.x;            // 본채 옆 여유폭
      const scale = Math.min(0.6, (aisle - 2 * gap) / 2 / pf.x);
      if (scale > 0.18) {                          // 소채가 유의미하게 들어갈 때만
        const shx = pf.x * scale;
        const sxOff = hf.x + gap + shx;
        const satCz = (hf.minZ + hf.maxZ) / 2;     // 본채 깊이 중앙에 나란히
        for (const sx of [-1, 1]) {
          const sat = proto.clone();
          sat.scale.setScalar(scale);
          sat.position.set(sx * sxOff, 0, satCz);
          sat.name = `sat-${A.role}-${sx > 0 ? 'e' : 'w'}`;
          grp.add(sat);
        }
      }
    }

    const finalGrp = finalize(grp);
    areaHandles.push({
      role: A.role,
      group: finalGrp,
      hall,
      center: { x: 0, z: cz },
      W: A.W,
      D: A.D,
      focusSemantic,
    });
    southFace = northFace;   // 다음 일곽은 이 북면에서 시작(담 공유)
  }

  // ── 4) 측면 부속(동궁 +x / 궐내각사 -x) — attachTo 일곽 옆 ──
  for (const F of spec.flanks) {
    const target = spec.areas.find((a) => a.role === F.attachTo);
    if (!target) continue;
    // attachTo 일곽 중심 z 를 다시 계산(축선 스택 누적).
    let acc = southInner - spec.entryD;
    let fz = 0;
    for (const a of spec.areas) { const c = acc - a.D / 2; if (a.role === F.attachTo) { fz = c; break; } acc = c - a.D / 2; }
    const coreHalfW = target.W / 2;
    const fx = F.side * (coreHalfW + 2.5 + F.W / 2);
    const grp = new THREE.Group(); grp.name = `flank-${F.role}`; grp.userData.mats = M;
    const depth = 2.4, colH = 2.6;
    const { chd } = enclosure(grp, fx, fz, F.W, F.D, {
      depth, colH, sides: { south: true, southGap: 3.0, north: true, northGap: 0, east: true, west: true }, seed: seed ^ (F.side > 0 ? 0xa1 : 0xb2),
    });
    placeGate(grp, 'iljakmun', fx, fz + chd + depth / 2, { width: 1.9, seed: seed + 300 });
    if (F.subCells) {
      // 궐내각사: 작은 채 격자(2×2) — 저격식 소전. 1채만 짓고 clone(재질·지오 공유).
      // 격자 간격을 실측 처마 외연 + 이격으로 산정 — 종전 gx·0.7 고정은 좁은 x축에서 좌우 채가
      // 서로 관통했다(#97). 좁은 x축이 제약이라 두 열이 이격되는 최대 scale 을 역산해 앉힌다.
      const cellPreset = applyOv({ ...hallPreset('junggung', seed + 700), frontBays: 3, sideBays: 2, columnHeight: 2.9, bracketTiers: 1, podiumTiers: 1, podiumTierH: 0.5, mats: hallMats });
      const proto = buildBuilding(cellPreset);
      const pf = footprintHalf(proto);
      const gap = 1.4;
      const interiorHX = F.W / 2 - depth, interiorHZ = F.D / 2 - depth;
      // chx ≤ (interiorHX − 1.5·gap)/2 이면 두 열이 gap 이격 + 벽 gap 을 동시 만족.
      const scale = Math.min(0.66,
        (interiorHX - 1.5 * gap) / (2 * pf.x),
        (interiorHZ - 1.5 * gap) / (2 * pf.z));
      const chx = pf.x * scale, chz = pf.z * scale;
      const colOff = chx + gap / 2;                                  // 열 간(x) 이격
      const rowOff = Math.min(chz + gap / 2 + 0.8, interiorHZ - gap - chz);  // 행 간(z) 여유
      let ci = 0;
      for (const rz of [-1, 1]) for (const rx of [-1, 1]) {
        const cell = proto.clone();
        cell.scale.setScalar(scale);
        cell.position.set(fx + rx * colOff, 0, fz + rz * rowOff);
        cell.name = `${F.role}-cell${ci++}`;
        grp.add(cell);
      }
    } else {
      // 동궁: 소전 1채.
      const preset = applyOv({ ...hallPreset('chimjeon', seed + 500), frontBays: 3, sideBays: 3 });
      preset.mats = hallMats;   // #149 공유 재질셋
      placeHall(grp, preset, fx, fz - F.D / 2, depth, `hall-${F.role}`);
    }
    const finalGrp = finalize(grp);
    areaHandles.push({ role: F.role, group: finalGrp, hall: null, center: { x: fx, z: fz }, W: F.W, D: F.D });
  }

  // 진입부(궁장·광화문·흥례문·금천교)도 정적 — 병합해 추가.
  finalize(entry);

  // ── 5) 후원 여백(최북단) — 비건축(수목·화계는 adapter/env 소관). 여기선 여백만 확보. ──
  //   (마당 지면은 성토 패드가 담당. 후원엔 별도 지오 없음 — 여백이 문법의 일부.)

  // ── 6) 편집 승격 규약 노출 ──
  //   feature 오브젝트라 픽킹 불가였던 궁을, #48 편집 패널이 잡을 수 있게 필지형 메타 노출.
  root.userData.parcelLike = { id: 'palace', style: 'palace', tier };
  root.userData.palaceHandle = {
    tier, variant, seed,      // seed: 어댑터가 동일 궁을 presetOverrides 로 재생성할 때 필요(#93)
    regionW: W, regionD: D,
    areas: areaHandles,       // [{ role, group, hall, center, W, D }] — 일곽별 그룹(heroHandle 유사)
    focusSemantic: areaHandles.find((area) => area.role === 'jeongjeon')?.focusSemantic || null,
    dancheong: requestedDancheong,
  };

  lifecycle.set(root, {
    disposed: false,
    ownsPalette: !mats,
    palette: M,
    callerPaletteResources: mats ? collectPaletteResources(mats) : null,
  });

  return root;
}

/** Dispose one reusable palace compound without invalidating caller-provided materials. */
export function disposePalaceCompound(root) {
  const state = root && lifecycle.get(root);
  if (!state || state.disposed) return false;
  state.disposed = true;
  const resources = collectObjectResources(root);
  const paletteResources = collectPaletteResources(state.palette);
  for (const material of paletteResources.materials) resources.materials.add(material);
  for (const texture of paletteResources.textures) resources.textures.add(texture);
  if (!state.ownsPalette) {
    for (const material of state.callerPaletteResources.materials) resources.materials.delete(material);
    for (const texture of state.callerPaletteResources.textures) resources.textures.delete(texture);
  }
  disposeObjectResources(resources);
  return true;
}
