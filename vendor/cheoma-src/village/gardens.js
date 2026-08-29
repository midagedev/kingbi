import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { bakeSphericalNormals, FOLIAGE_PROFILE, foliageLeafMass } from '../core/foliage-geometry.js';
import { parcelMatrix } from './instancing.js';
import { YARD_SPECIES } from './variants.js';
import { buildParcelLanternGeo, getLanternMaterials, lanternStyleFor } from '../layout/props.js';
import { disposeObjectTree } from '../core/three-resources.js';
import * as G from '../core/math/geom2.js';
import { guardianCanopyRadius, planGuardianTrees } from './guardian-plan.js';
import { parcelWorldPoint } from './parcel-contract.js';
import {
  createVegetationSpatial,
  yardCanopyBlocked,
  yardTreeCandidates,
} from './vegetation-spatial.js';
import {
  yardGwaeseokPosition,
  yardHardObstacles,
  yardHwagyePosition,
  yardSeokjiPosition,
  yardTreeIntersectsHardObstacle,
} from './yard-layout.js';
import { yardLifeRecordsToHardObstacles } from './yard-life-plan.js';

// 마당 과실수 · 반가 정원 · 마을 보호수(당산나무) — 태스크 #41 (docs Q4·Q5, R-G1/R-G2/R-T1).
//   buildVillageFlora(plan, site, seed, { yardLifeRecords })
//     → { group, setSeason(name), guardianAnchors, yardTreeAnchors, drawCalls }
//
// 고증 요지:
//   · 마당 중앙은 비운다(困 자 금기 — 작업 공간). 과실수는 뒤안·담 모퉁이(집 벽에서 떨어져)에만.
//   · 반가는 뒤안 화계(꽃계단)+사랑마당 괴석·석지, 여염은 과실수 1~2, 민촌은 텃밭(나무 0~1).
//   · 마을엔 신격 노거수(당산나무=느티나무 우세)가 동구/중심에 1주 이상 — 일반 수목의 3~5배
//     우산형 수관, 밑동 돌단·금줄·평상. 필수 역할과 충돌 없는 위치는 guardian-plan이 먼저 확정한다.
//
// 성능: 전 필지 과실수·정원·보호수를 재질(레이어)별 정적 병합 → 드로우콜 ~5(수백 그루라도 상수).
//   레이어: wood(줄기·가지·평상·금줄) / leaf(잎, 계절 틴트·겨울 나목) / blossom(봄 꽃) /
//           fruit(가을 열매) / stone(돌단·화계·괴석·석지). blossom·fruit·leaf 는 계절로 가시성 토글.

const TAU = Math.PI * 2;
const M4 = () => new THREE.Matrix4();
const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);

// 룩 복원 Phase 3.5(docs/tree-look.md §5) — 잎덩이는 등축구가 아니라 불규칙 붓점 덩이(원리 ①)로 굽고,
//   수관 매스 중심에서 구체 노멀을 전사해 수묵 모드의 캐노피 내부 폴리곤 필선을 없앤다(§3.3).
//   ★ 최대 XZ 반경 rr·최대 |y| 0.85rr 은 구 ico(rr) 와 같게 유지한다(foliageLeafMass 가 XZ 를
//     정규화한다) — 마당 나무 수용 판정이
//     프로토 footprint 반경(yardTreeCanopyRadius)을 쓰므로 반경이 바뀌면 배치 결정이 달라진다.
function leafLump(rr, phase, profile = FOLIAGE_PROFILE.broad) {
  // inward: 모든 정점이 구 ico(rr) 반경 안에 머문다 → 프로토 footprint 반경이 커지지 않는다.
  //   마당 나무 수용 판정이 이 반경을 쓰므로(yardTreeCanopyRadius) 필수다.
  return foliageLeafMass({
    radius: rr, up: rr * 0.85, down: rr * 0.85, profile, jitter: 0.18, phase, spin: phase * 0.7,
    inward: true,
  });
}
// 담장이 있는 작은 필지의 과실수는 수고는 유지하고 수관만 전정된 비율로 심는다.
// x/z만 줄여 꽃·열매가 읽히는 높이와 바닥 접지는 보존한다.
const YARD_CROWN_SCALE = Object.freeze({ min: 0.45, max: 0.75, heroMin: 0.55, heroMax: 0.8 });

const WOOD = 0x6b5333, WOOD_DK = 0x533f28, STRAW = 0xccb473, HANJI = 0xeee6d6;
const STONE = 0x8f877b, STONE_WARM = 0x9c917f, STONE_DK = 0x6e675b, WATER_DK = 0x35454e, PLANK = 0x8a6b45;

// 계절별 잎색 곱틴트(재질 color × baked 잎 vertexColor). 여름=중립, 가을=금갈, 봄=신록.
//   겨울은 잎 메시 자체를 숨겨 나목(줄기·가지만) — 앱 계절 enum(3종)엔 없고 하네스 확장용.
const LEAF_TINT = {
  spring: [1.05, 1.20, 0.72],
  summer: [1.0, 1.0, 1.0],
  autumn: [1.55, 1.05, 0.48],
  winter: [1.0, 1.0, 1.0],
};

// 파트에 균일 vertex color + 병합 정규화(non-indexed, uv 제거). 매 호출 새 지오 반환.
function tint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, arr = new Float32Array(n * 3), c = linCol(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
// 신규 지오(tint 결과)를 월드변환 후 레이어 배열에 적재.
function bake(arr, geo, wm) { geo.applyMatrix4(wm); arr.push(geo); }
// 프로토 지오(재사용)를 clone → 월드변환 → 적재.
function stamp(arr, proto, wm) { if (!proto) return; const g = proto.clone(); g.applyMatrix4(wm); arr.push(g); }

function horizontalFootprint(geometries) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, radius2 = 0;
  for (const geometry of geometries) {
    const positions = geometry?.getAttribute('position');
    if (!positions) continue;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), z = positions.getZ(i);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      radius2 = Math.max(radius2, x * x + z * z);
    }
  }
  return { minX, maxX, minZ, maxZ, radius: Math.sqrt(radius2) };
}

// ───────────────────────── 과실수 프로토 ─────────────────────────
// 종별 시그니처: 감=주황 열매(가을), 대추=붉은 열매, 살구=연분홍 꽃(봄), 매화=성근 가지에 흰꽃(봄),
//   석류=붉은 열매, 모과=노란 열매. 로우폴리(ico detail 0). 겨울 나목 대비로 가지 3~4개.
const FRUIT_INFO = {
  persimmon:   { H: 4.3, r0: 0.27, greens: [0x577830, 0x4e6d34, 0x5f7d3a], clumpR: 1.75, clumps: 4, spread: 1.6, squashY: 0.82, accent: 'fruit',   accentCol: 0xe8721c, season: 'autumn', dots: 14, dotR: 0.17 },
  jujube:      { H: 3.9, r0: 0.20, greens: [0x5a7238, 0x647c40, 0x53702f], clumpR: 1.30, clumps: 4, spread: 1.3, squashY: 1.00, accent: 'fruit',   accentCol: 0x8f2d1e, season: 'autumn', dots: 18, dotR: 0.09 },
  apricot:     { H: 4.0, r0: 0.23, greens: [0x64794a, 0x5a7541, 0x6d824f], clumpR: 1.60, clumps: 4, spread: 1.4, squashY: 0.92, accent: 'blossom', accentCol: 0xf3c6d0, season: 'spring', dots: 26, dotR: 0.16 },
  plum:        { H: 3.5, r0: 0.20, greens: [0x5a7541, 0x536f3c], clumpR: 1.25, clumps: 3, spread: 1.7, squashY: 0.78, accent: 'blossom', accentCol: 0xf8ecf0, season: 'spring', dots: 30, dotR: 0.13 },
  pomegranate: { H: 3.5, r0: 0.19, greens: [0x506a30, 0x5c7434, 0x486128], clumpR: 1.35, clumps: 4, spread: 1.25, squashY: 0.96, accent: 'fruit',  accentCol: 0xb42f22, season: 'autumn', dots: 9,  dotR: 0.15 },
  quince:      { H: 4.1, r0: 0.22, greens: [0x556f34, 0x60793a], clumpR: 1.40, clumps: 4, spread: 1.2, squashY: 1.05, accent: 'fruit',   accentCol: 0xd9b13a, season: 'autumn', dots: 8,  dotR: 0.19 },
};

function makeFruitProto(species, seed) {
  const I = FRUIT_INFO[species];
  const rng = makeRng(seed);
  const wood = [], leaf = [], accent = [];
  const H = I.H;
  // 줄기(2단, 살짝 굽음)
  const t0 = new THREE.CylinderGeometry(I.r0 * 0.78, I.r0, H * 0.44, 6); t0.translate(0, H * 0.22, 0);
  wood.push(tint(t0, WOOD));
  const t1 = new THREE.CylinderGeometry(I.r0 * 0.5, I.r0 * 0.78, H * 0.3, 6);
  t1.translate(0, H * 0.15, 0); t1.rotateZ(rng.range(-0.12, 0.12)); t1.translate(0, H * 0.44, 0);
  wood.push(tint(t1, WOOD));
  // 가지 3~4(나목 실루엣 확보): 수관 밑에서 바깥·위로.
  const nB = rng.int(3, 4), branchY = H * 0.5;
  for (let k = 0; k < nB; k++) {
    const len = H * rng.range(0.28, 0.4), ang = k / nB * TAU + rng.range(-0.3, 0.3), tilt = rng.range(0.5, 0.85);
    const b = new THREE.CylinderGeometry(0.04, 0.08, len, 5); b.translate(0, len / 2, 0);
    const m = M4().makeTranslation(0, branchY, 0).multiply(M4().makeRotationY(ang)).multiply(M4().makeRotationZ(-tilt));
    b.applyMatrix4(m); wood.push(tint(b, WOOD_DK));
  }
  // 수관(잎 덩어리)
  const crownY = H * 0.68;
  for (let i = 0; i < I.clumps; i++) {
    const rr = I.clumpR * rng.range(0.82, 1.15);
    const ang = i / I.clumps * TAU + rng.range(-0.4, 0.4);
    const sp = i === 0 ? 0 : rng.range(I.spread * 0.5, I.spread);
    const by = crownY + rng.range(-0.3, 0.6) + (i === 0 ? 0.35 : 0);
    const g = leafLump(rr, i * 0.9);
    g.applyMatrix4(M4().makeTranslation(Math.cos(ang) * sp, by, Math.sin(ang) * sp).multiply(M4().makeScale(1.15, I.squashY, 1.15)));
    leaf.push(tint(g, rng.pick(I.greens)));
  }
  // 시그니처(열매/꽃) — 수관 표면 분포. 계절로 가시성 토글.
  const spreadR = I.clumpR * 0.7 + I.spread * 0.7;
  for (let i = 0; i < I.dots; i++) {
    const a = rng() * TAU, rad = Math.sqrt(rng()) * spreadR;
    const py = crownY + rng.range(-0.6, 0.9);
    const d = ico(I.dotR * rng.range(0.85, 1.15), 0);
    d.translate(Math.cos(a) * rad, py, Math.sin(a) * rad);
    accent.push(tint(d, I.accentCol));
  }
  const mergedWood = mergeGeometries(wood, false);
  const mergedLeaf = bakeSphericalNormals(mergeGeometries(leaf, false));
  const mergedAccent = accent.length ? mergeGeometries(accent, false) : null;
  return {
    wood: mergedWood,
    leaf: mergedLeaf,
    accent: mergedAccent,
    footprint: horizontalFootprint([mergedWood, mergedLeaf, mergedAccent]),
    season: I.season,
  };
}

// ───────────────────────── 보호수(당산나무) 프로토 ─────────────────────────
// 느티나무: 굵은 줄기 낮게 갈라짐 + 넓고 평평한 우산형 수관(수관폭 ~24m). 은행: 좁고 곧게 선 부채형.
//   금줄(새끼줄+한지)은 줄기 둘레에 프로토 단계에서 감아 나무 스케일과 함께 앉는다.
function makeGuardianProto(kind, seed) {
  const rng = makeRng(seed);
  const wood = [], leaf = [];
  const ginkgo = kind === 'ginkgo';
  const H = ginkgo ? 15 : 13.5;
  const greens = ginkgo ? [0x5c7233, 0x647a38, 0x546a2e] : [0x3f5a2a, 0x47632f, 0x395226];
  // 뿌리 두둑 + 줄기(굵고 낮게 갈라짐)
  const flare = new THREE.CylinderGeometry(1.05, 1.5, 0.9, 9); flare.translate(0, 0.45, 0);
  wood.push(tint(flare, WOOD_DK));
  const trunk = new THREE.CylinderGeometry(ginkgo ? 0.5 : 0.6, 0.98, H * 0.32, 9);
  trunk.translate(0, H * 0.16 + 0.4, 0); wood.push(tint(trunk, WOOD));
  // 주지(가지) — 갈라져 위·바깥으로
  const forkY = H * 0.30, nL = ginkgo ? 4 : 5;
  for (let k = 0; k < nL; k++) {
    const len = rng.range(ginkgo ? 4.5 : 4.8, ginkgo ? 6 : 6.8), ang = k / nL * TAU + rng.range(-0.2, 0.2);
    const tilt = ginkgo ? rng.range(0.28, 0.5) : rng.range(0.55, 0.85);
    const b = new THREE.CylinderGeometry(0.16, 0.42, len, 6); b.translate(0, len / 2, 0);
    b.applyMatrix4(M4().makeTranslation(0, forkY, 0).multiply(M4().makeRotationY(ang)).multiply(M4().makeRotationZ(-tilt)));
    wood.push(tint(b, WOOD));
  }
  // 우산형 수관 — 넓게 퍼지고 평평, 가장자리 처짐.
  const crownY = H * (ginkgo ? 0.82 : 0.76), blobs = ginkgo ? 8 : 12;
  for (let i = 0; i < blobs; i++) {
    const rr = rng.range(ginkgo ? 2.2 : 2.8, ginkgo ? 3.2 : 4.1);
    const ang = i / blobs * TAU + rng.range(-0.3, 0.3);
    const sp = i === 0 ? 0 : rng.range(ginkgo ? 2.0 : 3.4, ginkgo ? 5.2 : 8.6);
    const by = crownY + rng.range(-1.3, 1.1) - sp * (ginkgo ? 0.05 : 0.14);
    const g = leafLump(rr, i * 0.7);
    g.applyMatrix4(M4().makeTranslation(Math.cos(ang) * sp, by, Math.sin(ang) * sp).multiply(M4().makeScale(ginkgo ? 1.0 : 1.28, ginkgo ? 0.95 : 0.6, ginkgo ? 1.0 : 1.28)));
    leaf.push(tint(g, rng.pick(greens)));
  }
  // 금줄(새끼줄 띠 + 한지 술) — 줄기 둘레 y≈1.7
  const ring = new THREE.TorusGeometry(1.02, 0.075, 6, 16); ring.rotateX(Math.PI / 2); ring.translate(0, 1.7, 0);
  wood.push(tint(ring, STRAW));
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU, p = new THREE.BoxGeometry(0.05, 0.24, 0.02);
    p.translate(Math.cos(a) * 1.02, 1.55, Math.sin(a) * 1.02);
    wood.push(tint(p, HANJI));
  }
  return { wood: mergeGeometries(wood, false), leaf: bakeSphericalNormals(mergeGeometries(leaf, false)) };
}

// ───────────────────────── 정원 점경물 (반가) ─────────────────────────
// 화계(꽃계단): 뒤안 축대에 돌단 2~3단 + 상록 관목 + 봄 꽃. stone/leaf/blossom 레이어에 적재.
function bakeHwagye(L, wm, rng) {
  for (let c = 0; c < 3; c++) {
    const w = 2.6 - c * 0.55, box = new THREE.BoxGeometry(w, 0.32, 0.55);
    box.translate(0, 0.16 + c * 0.3, -c * 0.26);
    bake(L.stone, tint(box, c % 2 ? STONE_WARM : STONE), wm.clone());
  }
  // 관목(여름에도 초록) 2 + 봄 꽃 무리
  for (let i = 0; i < 2; i++) {
    const b = ico(0.34, 0); b.applyMatrix4(M4().makeTranslation((i - 0.5) * 1.2, 1.15, -0.15).multiply(M4().makeScale(1, 0.8, 1)));
    bake(L.leaf, tint(b, 0x4a6a30), wm.clone());
  }
  for (let i = 0; i < 12; i++) {
    const d = ico(0.09, 0); d.translate((rng() - 0.5) * 2.2, 0.9 + rng() * 0.7, (rng() - 0.6) * 0.6);
    bake(L.blossom, tint(d, rng.pick([0xe8b6c6, 0xf0e7d2, 0xd98b8b, 0xe6cf6b])), wm.clone());
  }
}
// 괴석(태호석풍 곧추선 바위) — 받침 + 구멍뚫린 듯 각진 3단 스택.
function bakeGwaeseok(L, wm, rng) {
  const base = new THREE.BoxGeometry(0.8, 0.16, 0.8); base.translate(0, 0.08, 0);
  bake(L.stone, tint(base, STONE), wm.clone());
  for (let k = 0; k < 3; k++) {
    const r = 0.44 - k * 0.08, g = ico(r, 0);
    g.applyMatrix4(M4().makeTranslation((rng() - 0.5) * 0.2, 0.42 + k * 0.5, (rng() - 0.5) * 0.2)
      .multiply(M4().makeRotationY(rng() * TAU)).multiply(M4().makeScale(0.82, 1.5, 0.82)));
    bake(L.stone, tint(g, STONE_DK), wm.clone());
  }
}
// 석지(석연지, 돌확 연못) — 돌 테 + 어두운 물면.
function bakeSeokji(L, wm) {
  const ring = new THREE.CylinderGeometry(0.5, 0.56, 0.4, 12, 1, true); ring.translate(0, 0.2, 0);
  bake(L.stone, tint(ring, STONE), wm.clone());
  const rim = new THREE.TorusGeometry(0.52, 0.05, 5, 12); rim.rotateX(Math.PI / 2); rim.translate(0, 0.4, 0);
  bake(L.stone, tint(rim, STONE_WARM), wm.clone());
  const water = new THREE.CylinderGeometry(0.46, 0.46, 0.02, 12); water.translate(0, 0.34, 0);
  bake(L.stone, tint(water, WATER_DK), wm.clone());
}

// ───────────────────────── 보호수 밑동 소품 ─────────────────────────
// 돌단(원형 석축단): 낮은 원형 켜쌓기 + 테두리 막돌.
function bakeDolran(L, wm, R, rng) {
  const ring = new THREE.CylinderGeometry(R, R * 1.06, 0.44, 16); ring.translate(0, 0.22, 0);
  bake(L.stone, tint(ring, STONE), wm.clone());
  const top = new THREE.CylinderGeometry(R * 0.9, R * 0.94, 0.12, 16); top.translate(0, 0.5, 0);
  bake(L.stone, tint(top, STONE_WARM), wm.clone());
  for (let i = 0; i < 11; i++) {
    const a = i / 11 * TAU, b = ico(0.3 * rng.range(0.8, 1.2), 0);
    b.applyMatrix4(M4().makeTranslation(Math.cos(a) * R, 0.44, Math.sin(a) * R).multiply(M4().makeScale(1, 0.8, 1)));
    bake(L.stone, tint(b, STONE_DK), wm.clone());
  }
}
// 평상(낮은 목제 마루): 상판 + 다리 4.
function bakePyeongsang(L, wm) {
  const top = new THREE.BoxGeometry(2.2, 0.14, 1.8); top.translate(0, 0.52, 0);
  bake(L.wood, tint(top, PLANK), wm.clone());
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.BoxGeometry(0.16, 0.5, 0.16); leg.translate(sx * 0.95, 0.25, sz * 0.75);
    bake(L.wood, tint(leg, WOOD_DK), wm.clone());
  }
}

// ───────────────────────── 배치: 마당 과실수 슬롯 ─────────────────────────
function yardTreeCanopyRadius(prototype, scale = 1) {
  return Math.max(0, prototype?.footprint?.radius || 0) * Math.max(0, scale);
}

function safeYardTreeSlot(parcel, point, footprint, spatial, hardObstacles, occupied) {
  if (yardTreeIntersectsHardObstacle(point, footprint, hardObstacles)) return false;
  if (yardCanopyBlocked(parcel, point, footprint.canopyRadius)) return false;
  const world = parcelWorldPoint(parcel, point);
  if (spatial.blocksYardCanopy(world.x, world.z, footprint.canopyRadius)) return false;
  return occupied.every((tree) =>
    G.dist(world, tree) > footprint.canopyRadius + tree.radius * 0.72);
}

// ───────────────────────── 최상위 ─────────────────────────
export function buildVillageFlora(plan, site, seed, { yardLifeRecords = [] } = {}) {
  const group = new THREE.Group(); group.name = 'village-flora';

  // 재질(마을 1벌 — 계절 틴트가 다른 마을에 새지 않게 호출마다 신규). flatShading 로우폴리.
  const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
  // 잎 재질만 flatShading 해제(구운 구체 노멀 유효화). 목재·석재는 패싯 질감이 대비축이라 유지.
  const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false });
  const blossomMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, flatShading: true });
  const fruitMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, flatShading: true });
  const stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true });

  // 프로토 캐시
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  const fruitProto = {}; for (const sp of YARD_SPECIES) fruitProto[sp] = makeFruitProto(sp, (seed ^ hash(sp)) >>> 0);
  const guardProto = { zelkova: makeGuardianProto('zelkova', (seed ^ 0x9e11) >>> 0), ginkgo: makeGuardianProto('ginkgo', (seed ^ 0x9e12) >>> 0) };
  const yardSpatial = createVegetationSpatial(plan, site);

  const L = { wood: [], leaf: [], blossom: [], fruit: [], stone: [], lantern: [] };
  const yardTreeAnchors = [], guardianAnchors = [], gardenAnchors = [];
  const occupiedYard = [];

  // 필지 등롱(#83): 발광 몸체→lantern 레이어(hanjiGlow glow 재질, 야간 adapter 램프), 프레임→wood 병합.
  //   parcel.lantern({gate,yard}, variants.js) 기반, 위치는 layout/props.js lanternLayout(rng 미소비 결정론).
  const bakeLanterns = (p, pm) => {
    const cfg = p.lantern;
    if (!cfg || (!cfg.gate && !cfg.yard)) return;
    const { glow, frame } = buildParcelLanternGeo(lanternStyleFor(p), p.seed, p.plotW, p.plotD, cfg);
    for (const g of glow) bake(L.lantern, g, pm.clone());
    for (const f of frame) bake(L.wood, tint(f, WOOD_DK), pm.clone());
  };

  const placeFruit = (sp, wm) => {
    const P = fruitProto[sp]; if (!P) return;
    stamp(L.wood, P.wood, wm); stamp(L.leaf, P.leaf, wm);
    if (P.accent) stamp(P.season === 'spring' ? L.blossom : L.fruit, P.accent, wm);
  };

  // ── 1) 필지별 마당 과실수 + 정원 ──
  for (const p of plan.parcels || []) {
    const pm = parcelMatrix(p);
    const trng = makeRng((p.seed ^ 0x7ee5) >>> 0);
    const ct = p.courtyardTree;
    bakeLanterns(p, pm);   // 전 필지(히어로 포함) 등롱 — trng 미소비(#89 앵커 불침해)
    if (p.hero) {
      // 종가 뒤안: 화계(중앙) + 괴석·석지(측) + 과실수 2(코너) — 뒷담 안쪽에 몰아 컴파운드 관통 회피.
      const hd = p.plotD / 2;
      const hwagyeX = trng.range(-1, 1);
      const hwagye = yardHwagyePosition(p, hwagyeX, true);
      bakeHwagye(L, pm.clone().multiply(M4().makeTranslation(hwagye.x, 0, hwagye.z)), trng);
      const side = trng() < 0.5 ? -1 : 1;
      const rock = yardGwaeseokPosition(p, side, true);
      const pond = yardSeokjiPosition(p, side, true);
      bakeGwaeseok(L, pm.clone().multiply(M4().makeTranslation(rock.x, 0, rock.z)), trng);
      bakeSeokji(L, pm.clone().multiply(M4().makeTranslation(pond.x, 0, pond.z)));
      const hardObstacles = yardHardObstacles(p, { exact: true, side, hwagyeX });
      const sps = (ct && ct.species) || ['plum', 'persimmon'];
      const slots = yardTreeCandidates(p, trng);
      for (let i = 0; i < sps.length; i++) {
        const spin = trng() * TAU;
        const scaleX = trng.range(YARD_CROWN_SCALE.heroMin, YARD_CROWN_SCALE.heroMax);
        const scaleZ = trng.range(YARD_CROWN_SCALE.heroMin, YARD_CROWN_SCALE.heroMax);
        const radius = yardTreeCanopyRadius(fruitProto[sps[i]], Math.max(scaleX, scaleZ));
        const footprint = {
          canopyRadius: radius,
          trunkRadius: FRUIT_INFO[sps[i]].r0 * Math.max(scaleX, scaleZ),
        };
        const slotIndex = slots.findIndex((point) =>
          safeYardTreeSlot(p, point, footprint, yardSpatial, hardObstacles, occupiedYard));
        if (slotIndex < 0) continue;
        const [point] = slots.splice(slotIndex, 1);
        const wm = pm.clone().multiply(M4().makeTranslation(point.x, 0, point.z))
          .multiply(M4().makeRotationY(spin)).multiply(M4().makeScale(scaleX, 1, scaleZ));
        placeFruit(sps[i], wm);
        const v = new THREE.Vector3(point.x, 0, point.z).applyMatrix4(pm);
        occupiedYard.push({ x: v.x, z: v.z, radius });
        yardTreeAnchors.push({
          x: v.x, y: v.y + 2.6, z: v.z,
          species: sps[i], radius, trunkRadius: footprint.trunkRadius, parcelId: p.id,
          gardenSide: side, hwagyeX,
        });
      }
      const gv = new THREE.Vector3(0, 0, -hd * 0.86).applyMatrix4(pm);
      const gc = new THREE.Vector3(0, 8.5, -hd - 4).applyMatrix4(pm);   // 뒷담 밖 높은 곳에서 뒤안을 내려다봄
      gardenAnchors.push({ x: gv.x, y: gv.y + 1.2, z: gv.z, cx: gc.x, cy: gc.y, cz: gc.z, hero: true });
      continue;
    }
    // 정규 필지: 과실수 슬롯
    // Reserve the union of every distinct seasonal slot. Spring/winter prefer
    // separate service edges and autumn owns an open work-yard slot, so dormant
    // geometry can never reveal a tree through the next visible household task.
    const hardObstacles = [
      ...yardHardObstacles(p),
      ...yardLifeRecordsToHardObstacles(yardLifeRecords, p.id),
    ];
    if (ct && ct.species && ct.species.length) {
      const slots = yardTreeCandidates(p, trng);
      for (const species of ct.species) {
        const spin = trng() * TAU, sc = trng.range(YARD_CROWN_SCALE.min, YARD_CROWN_SCALE.max);
        const radius = yardTreeCanopyRadius(fruitProto[species], sc);
        const footprint = { canopyRadius: radius, trunkRadius: FRUIT_INFO[species].r0 * sc };
        const slotIndex = slots.findIndex((slot) =>
          safeYardTreeSlot(p, slot, footprint, yardSpatial, hardObstacles, occupiedYard));
        if (slotIndex < 0) continue;
        const [s] = slots.splice(slotIndex, 1);
        const wm = pm.clone().multiply(M4().makeTranslation(s.x, 0, s.z)).multiply(M4().makeRotationY(spin)).multiply(M4().makeScale(sc, trng.range(0.9, 1.12), sc));
        placeFruit(species, wm);
        const v = new THREE.Vector3(s.x, 0, s.z).applyMatrix4(pm);
        occupiedYard.push({ x: v.x, z: v.z, radius });
        yardTreeAnchors.push({
          x: v.x, y: v.y + 2.4, z: v.z, species,
          radius, trunkRadius: footprint.trunkRadius,
          parcelId: p.id,
          accent: FRUIT_INFO[species].accent,
        });
      }
    }
    // 반가 정원 점경물(gardenLevel≥2): 괴석 + (≥3) 석지·화계. 뒤안 코너.
    const gl = p.gardenLevel || 0;
    if (gl >= 2) {
      const hw = p.plotW / 2, hd = p.plotD / 2, side = trng() < 0.5 ? -1 : 1;
      // 좁은·부정형 필지에서는 점경물이 앉을 자리가 없을 수 있다(yard-layout 이 null 반환).
      // 담 밖으로 밀려난 괴석 대신 아무것도 두지 않는다 — 마당 앵커도 함께 생략한다.
      const rock = yardGwaeseokPosition(p, side, false);
      if (rock) bakeGwaeseok(L, pm.clone().multiply(M4().makeTranslation(rock.x, 0, rock.z)), trng);
      if (gl >= 3) {
        const pond = yardSeokjiPosition(p, side, false);
        const hwagye = yardHwagyePosition(p, trng.range(-1, 1), false);
        if (pond) bakeSeokji(L, pm.clone().multiply(M4().makeTranslation(pond.x, 0, pond.z)));
        bakeHwagye(L, pm.clone().multiply(M4().makeTranslation(hwagye.x, 0, hwagye.z)), trng);
      }
      if (rock) {
        const gv = new THREE.Vector3(rock.x, 0, rock.z).applyMatrix4(pm);
        const gc = new THREE.Vector3(side * (hw + 7), 3.2, -hd * 0.5 + 1.5).applyMatrix4(pm); // 담 밖 측면 눈높이
        gardenAnchors.push({ x: gv.x, y: gv.y + 1.0, z: gv.z, cx: gc.x, cy: gc.y, cz: gc.z, hero: false });
      }
    }
  }

  // ── 2) 마을 보호수(당산나무) ──
  const guardianTrees = plan.features?.guardianTrees || planGuardianTrees(plan, site, seed);
  for (const gp of guardianTrees) {
    const y = site.heightAt(gp.x, gp.z);
    const wm = M4().makeTranslation(gp.x, y, gp.z).multiply(M4().makeRotationY(gp.spin)).multiply(M4().makeScale(gp.scale, gp.scale, gp.scale));
    const P = guardProto[gp.kind] || guardProto.zelkova;
    stamp(L.wood, P.wood, wm); stamp(L.leaf, P.leaf, wm);
    // 밑동 소품(스케일 무관 실물 크기): 돌단 + (props) 평상. 금줄은 프로토에 포함(나무와 함께 스케일).
    const prng = makeRng((Math.round(gp.x) * 73856093 ^ Math.round(gp.z) * 19349663) >>> 0);
    const propWm = M4().makeTranslation(gp.x, y, gp.z).multiply(M4().makeRotationY(gp.spin));
    bakeDolran(L, propWm, 2.6 + gp.scale * 0.4, prng);
    if (gp.props) bakePyeongsang(L, propWm.clone().multiply(M4().makeTranslation(3.4, 0, 0.6)));
    guardianAnchors.push({
      x: gp.x, y, z: gp.z,
      r: gp.radius || guardianCanopyRadius(gp.kind, gp.scale),
      h: 14 * gp.scale,
    });
  }

  // ── 병합 → 레이어 메시 ──
  const meshes = {};
  const mk = (arr, mat, name) => {
    if (!arr.length) return null;
    const m = new THREE.Mesh(mergeGeometries(arr, false), mat);
    m.name = name; m.castShadow = true; m.receiveShadow = true;
    group.add(m); meshes[name] = m; return m;
  };
  mk(L.wood, woodMat, 'flora-wood');
  mk(L.leaf, leafMat, 'flora-leaf');
  mk(L.stone, stoneMat, 'flora-stone');
  mk(L.blossom, blossomMat, 'flora-blossom');
  mk(L.fruit, fruitMat, 'flora-fruit');
  // 등롱 발광 몸체 — 공유 glow 재질(hanjiGlow, 야간 adapter 램프). 계절 토글 대상 아님(상시 가시).
  mk(L.lantern, getLanternMaterials().glow, 'flora-lantern');

  function setSeason(name) {
    const t = LEAF_TINT[name] || LEAF_TINT.summer;
    leafMat.color.setRGB(t[0], t[1], t[2]);
    if (meshes['flora-leaf']) meshes['flora-leaf'].visible = name !== 'winter';
    if (meshes['flora-blossom']) meshes['flora-blossom'].visible = name === 'spring';
    if (meshes['flora-fruit']) meshes['flora-fruit'].visible = name === 'autumn';
  }
  setSeason('summer');

  return {
    group, setSeason, guardianAnchors, yardTreeAnchors, gardenAnchors,
    drawCalls: Object.keys(meshes).length,
    dispose() { disposeObjectTree(group); group.clear(); },
  };
}
