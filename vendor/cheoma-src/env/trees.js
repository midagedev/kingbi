import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { bakeSphericalNormals, canopyCenter, FOLIAGE_PROFILE, foliageLeafMass } from '../core/foliage-geometry.js';

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 수종 id — seasons.js 셰이더가 잎 색을 계절 목표로 이동시킬 때 참조한다.
// 0=소나무(상록, 계절 무시), 1=은행, 2=단풍, 3=활엽(잡목), 4=벚.
export const SPECIES = { pine: 0, ginkgo: 1, maple: 2, misc: 3, cherry: 4 };

// 파트 지오메트리에 균일 vertex color + 계절 태그(aFoliage 0|1, aSpecies)를 입힌다.
// IcosahedronGeometry(비인덱스)와 Cylinder/Cone(인덱스)이 섞이면 병합이 실패하므로
// 전부 비인덱스로 통일하고, 모든 파트가 동일 속성 세트를 갖도록 여기서 일괄 부여한다.
function tint(geo, hex, foliage = 0, species = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const fol = new Float32Array(n);
  const sp = new Float32Array(n);
  const c = linCol(hex);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    fol[i] = foliage; sp[i] = species;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  g.setAttribute('aFoliage', new THREE.Float32BufferAttribute(fol, 1));
  g.setAttribute('aSpecies', new THREE.Float32BufferAttribute(sp, 1));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

const M4 = () => new THREE.Matrix4();
const place = (geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rz = 0) => {
  const m = M4().makeRotationY(ry);
  if (rz) m.multiply(M4().makeRotationZ(rz));
  m.multiply(M4().makeScale(sx, sy, sz));
  const t = M4().makeTranslation(x, y, z);
  geo.applyMatrix4(t.multiply(m));
  return geo;
};

// 굽은 소나무 줄기: 짧은 원뿔대 세그먼트를 누적 경사로 쌓아 벤드를 만든다.
function bentTrunk(rng, height, r0, bend, bark) {
  const parts = [];
  const segs = 3;
  let y = 0, x = 0, ang = 0;
  const segLen = height / segs;
  for (let i = 0; i < segs; i++) {
    const rb = r0 * (1 - i / (segs + 1));
    const rt = r0 * (1 - (i + 1) / (segs + 1));
    const g = new THREE.CylinderGeometry(rt, rb, segLen, 6, 1);
    ang += bend * rng.range(0.4, 1.1) * (i === 0 ? 0.3 : 1);
    const cx = x + Math.sin(ang) * segLen * 0.5;
    const cy = y + Math.cos(ang) * segLen * 0.5;
    place(g, cx, cy, 0, 0, 1, 1, 1, -ang);
    parts.push(tint(g, bark));
    x += Math.sin(ang) * segLen;
    y += Math.cos(ang) * segLen;
  }
  return { parts, topX: x, topY: y };
}

// 룩 복원 Phase 3.5(docs/tree-look.md §5 단계 0·1) — 등축구·원뿔 어휘를 동양화 잎덩이로 교체한다.
//   잎덩이 여러 장을 하나의 수관 매스로 보고 그 중심에서 구체 노멀을 전사해야(§2.2) 덩이 경계의
//   노멀 불연속까지 사라지고, 수묵 모드의 캐노피 내부 폴리곤 필선이 셰이더 수정 없이 소멸한다(§3.3).
//   재질의 flatShading 해제가 전제다(§3.6-3).
function canopyParts(lumps, species) {
  const center = canopyCenter(lumps);
  return lumps.map((l) => tint(bakeSphericalNormals(foliageLeafMass(l), center), l.hex, 1, species));
}
// 층/뭉치 스펙 → 잎덩이 스펙(위치 기반 지터 + 값이 다른 녹). i 를 위상으로 써 층마다 다른 실루엣.
function foliageSpecs(specs, rng, greens, ox = 0, oy = 0) {
  return specs.map((s, i) => {
    const ang = (i / specs.length) * Math.PI * 2 + rng.range(-0.45, 0.45);
    const sp = s.spread ? s.spread * rng.range(0.85, 1.12) : 0;
    return {
      radius: s.radius, spin: ang * 0.5 + i, phase: i * 0.8 + 0.3, jitter: 0.2,
      profile: s.profile || FOLIAGE_PROFILE.broad,
      x: ox + s.axis * ox + Math.cos(ang) * sp, y: oy + s.dy, z: Math.sin(ang) * sp,
      up: s.up, down: s.down, lean: s.radius * 0.18,
      hex: greens[i % greens.length],
    };
  });
}

// 소나무(장송): 굽은 줄기 + 옆으로 벌어진 우산형 잎덩이 층(원리 ③ 층운형). (상록)
function makePineBroad(seed) {
  const rng = makeRng(seed);
  const H = 8;
  const { parts, topX, topY } = bentTrunk(rng, H * 0.72, 0.26, 0.16, 0x7c5334);
  // 상록 침엽 톤: 활엽의 따뜻한 초록과 구분되는 짙고 차가운 청록. 아래 그늘 → 위 수광 값 램프.
  const greens = [0x22331d, 0x2c4026, 0x35492d, 0x3e5533];
  const lumps = foliageSpecs([
    { radius: 2.45, dy: 0.70, spread: 0, up: 1.15, down: 1.45, axis: 0 },
    { radius: 1.95, dy: -0.15, spread: 2.35, up: 0.95, down: 1.30, axis: 0 },
    { radius: 1.70, dy: 0.30, spread: 2.80, up: 0.90, down: 1.20, axis: 0 },
    { radius: 1.45, dy: 1.00, spread: 1.85, up: 0.95, down: 1.15, axis: 0 },
  ], rng, greens, topX, topY);
  parts.push(...canopyParts(lumps, SPECIES.pine));
  return mergeGeometries(parts, false);
}

// 소나무(능선형): 기울어 자란 줄기 + 기울기를 따라 오르는 납작한 잎덩이 층. (상록)
function makePineTiered(seed) {
  const rng = makeRng(seed);
  const H = 8.5;
  const lean = rng.range(0.05, 0.16);
  const { parts, topX, topY } = bentTrunk(rng, H * 0.82, 0.22, lean, 0x81583a);
  const greens = [0x1f2f1a, 0x2c4026, 0x35492d, 0x3d5330];
  // 층 중심이 기울기 축(topX)을 따라 오르며 반경이 줄어든다 — 원뿔 스택이 아니라 벌어진 층.
  const lumps = foliageSpecs([
    { radius: 2.30, dy: -H * 0.34, spread: 0.55, up: 1.00, down: 1.30, axis: -0.7 },
    { radius: 1.95, dy: -H * 0.14, spread: 0.85, up: 0.92, down: 1.20, axis: -0.45 },
    { radius: 1.55, dy: H * 0.04, spread: 0.95, up: 0.85, down: 1.05, axis: -0.2 },
    { radius: 1.15, dy: H * 0.20, spread: 0.70, up: 0.85, down: 0.95, axis: 0 },
  ], rng, greens, topX, topY);
  parts.push(...canopyParts(lumps, SPECIES.pine));
  return mergeGeometries(parts, false);
}

// 낙엽 활엽수 일반형: 곧은 줄기 + 뭉친 타원 수관. species/색·수형으로 은행·단풍·잡목·벚를 만든다.
// 잎은 여름(baked) 초록으로, 계절 셰이더가 목표색으로 이동시킨다(수종별 phase 편차 포함).
function makeBroadleaf(seed, opts) {
  const {
    H, trunkHex, trunkR0, trunkR1, greens, species,
    clumps, clumpR, spread, squashY, crownBase,
  } = opts;
  const rng = makeRng(seed);
  const trunk = new THREE.CylinderGeometry(trunkR1, trunkR0, H * 0.6, 7, 1);
  place(trunk, 0, H * 0.3, 0);
  const parts = [tint(trunk, trunkHex)];
  // 등축구 클럼프 → 크기가 다른 비대칭 덩이 뭉치(원리 ①의 군집 리듬). 반경·높이 비율은 종별 authoring
  //   (clumpR·spread·squashY)을 그대로 소비해 수형 구분(은행 좁고 곧게 / 벚 낮고 퍼짐)을 보존한다.
  const lumps = [];
  for (let i = 0; i < clumps; i++) {
    const rr = clumpR * rng.range(0.82, 1.16) * 1.12;
    const ang = (i / clumps) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const sp = i === 0 ? 0 : rng.range(spread * 0.45, spread);
    const by = H * crownBase + rng.range(-0.3, 1.1) + (i === 0 ? 0.9 : 0);
    lumps.push({
      radius: rr, spin: i * 1.1 + ang * 0.4, phase: i * 0.85 + 0.4, jitter: 0.2,
      profile: FOLIAGE_PROFILE.broad, lean: rr * 0.16,
      x: Math.cos(ang) * sp, y: by, z: Math.sin(ang) * sp,
      up: rr * squashY * 0.86, down: rr * squashY * 0.86, hex: rng.pick(greens),
    });
  }
  parts.push(...canopyParts(lumps, species));
  return mergeGeometries(parts, false);
}

// 은행: 곧은 줄기 + 넓은 타원 수관.
function makeGinkgo(seed) {
  return makeBroadleaf(seed, {
    H: 9, trunkHex: 0x6f5a44, trunkR0: 0.32, trunkR1: 0.16,
    greens: [0x5c7a39, 0x647f3f, 0x556f34], species: SPECIES.ginkgo,
    clumps: 4, clumpR: 2.2, spread: 1.5, squashY: 0.95, crownBase: 0.62,
  });
}

// 단풍: 다소 낮고 둥근 조밀한 수관.
function makeMaple(seed) {
  return makeBroadleaf(seed, {
    H: 7.6, trunkHex: 0x715440, trunkR0: 0.3, trunkR1: 0.15,
    greens: [0x46652f, 0x4e6d34, 0x3d5a2a], species: SPECIES.maple,
    clumps: 5, clumpR: 1.95, spread: 1.35, squashY: 1.0, crownBase: 0.56,
  });
}

// 잡목(활엽): 크고 성근 수관.
function makeMisc(seed) {
  return makeBroadleaf(seed, {
    H: 9.4, trunkHex: 0x6b5540, trunkR0: 0.3, trunkR1: 0.15,
    greens: [0x5a7238, 0x647c40, 0x506a30], species: SPECIES.misc,
    clumps: 5, clumpR: 1.9, spread: 1.7, squashY: 0.9, crownBase: 0.6,
  });
}

// 벚: 낮고 옆으로 퍼지는 수관(봄에 연분홍 만개).
function makeCherry(seed) {
  return makeBroadleaf(seed, {
    H: 6.6, trunkHex: 0x5f4b3e, trunkR0: 0.29, trunkR1: 0.16,
    greens: [0x5a7541, 0x64794a, 0x53703c], species: SPECIES.cherry,
    clumps: 6, clumpR: 1.7, spread: 1.95, squashY: 0.8, crownBase: 0.52,
  });
}


// 절차 수목 배치. heightAt으로 표면에 앉히고, rejection sampling으로 최소거리 유지.
// 건물 반경(clearance) 밖, 전면 진입로는 비우고 뒤편 언덕을 밀도 높게.
// mask(x,z): true 면 그 자리(논·개울) 나무를 제외한다. rng 소비가 모두 끝난 뒤
//   push 직전에만 걸러 좌표·유형 시퀀스를 보존한다(기존 산수화 구도 불변).
export function buildTrees({ seed = 70707, clearance = 18, heightAt = () => 0, mask = null } = {}) {
  const group = new THREE.Group();
  group.name = 'trees';

  const protos = {
    pineBroad: makePineBroad(seed + 1),
    pineTiered: makePineTiered(seed + 2),
    ginkgo: makeGinkgo(seed + 3),
    maple: makeMaple(seed + 4),
    misc: makeMisc(seed + 5),
    cherry: makeCherry(seed + 6),
  };
  const mat = new THREE.MeshStandardMaterial({
    // flatShading 해제 — 프로토에 구운 구체 노멀을 살린다(docs/tree-look.md §3.6-3).
    vertexColors: true, roughness: 0.92, metalness: 0, flatShading: false,
  });

  const rng = makeRng(seed);
  const innerR = clearance + 3;
  const outerR = 88;
  const minDist = 6.5;
  const target = 92;
  const pts = [];
  const chosen = { pineBroad: [], pineTiered: [], ginkgo: [], maple: [], misc: [], cherry: [] };

  let attempts = 0;
  while (pts.length < target && attempts < 6000) {
    attempts++;
    // 건물 가까이에 더 밀집 (지수 편향)
    const rr = innerR + (outerR - innerR) * Math.pow(rng(), 1.5);
    const th = rng.range(0, Math.PI * 2);
    const x = Math.cos(th) * rr, z = Math.sin(th) * rr;
    // 전면 진입로(+z, 중앙) 비움 + 뒤편(-z) 밀도 가중
    if (z > clearance && Math.abs(x) < 16) continue;
    const backBias = 0.4 + 0.6 * smoothstep(30, -90, z);
    if (rng() > backBias) continue;
    let ok = true;
    for (const p of pts) {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < minDist * minDist) { ok = false; break; }
    }
    if (!ok) continue;
    pts.push({ x, z });

    // 유형 선택: 소나무 위주(상록), 은행·단풍·잡목·벚가 가을·봄의 색 방점.
    // 은행 band(roll>=0.82)와 rng 소비 순서는 기존과 동일하게 유지 → 나무 배치 좌표가
    // 기존 산수화 구도와 완전히 일치한다(신규 수종은 소나무 band 에서만 갈라낸다).
    const roll = rng();
    let type;
    if (roll < 0.30) type = 'pineTiered';
    else if (roll < 0.44) type = 'pineBroad';
    else if (roll < 0.62) type = 'maple';
    else if (roll < 0.72) type = 'misc';
    else if (roll < 0.82) type = 'cherry';
    else type = 'ginkgo';

    const y = heightAt(x, z);
    const s = rng.range(0.85, 1.5) * (type === 'ginkgo' ? 1.15 : 1);
    const ry = rng.range(0, Math.PI * 2);
    // 소비 순서 보존: 기존과 동일하게 은행만 tilt rng 를 건너뛴다. tilt 는 소나무에만 적용
    // (활엽수는 곧게 서도록), 값 소비는 동일해 좌표가 어긋나지 않는다.
    const tiltRaw = type === 'ginkgo' ? 0 : rng.range(-0.06, 0.06);
    const tilt = (type === 'pineBroad' || type === 'pineTiered') ? tiltRaw : 0;
    const m = M4().makeTranslation(x, y, z);
    m.multiply(M4().makeRotationY(ry));
    if (tilt) m.multiply(M4().makeRotationZ(tilt));
    m.multiply(M4().makeScale(s, s * rng.range(0.95, 1.12), s));
    // 논·개울 위 나무만 제외(rng 은 이미 다 소비됨 → 나머지 좌표/유형 시퀀스 불변).
    if (mask && mask(x, z)) continue;
    chosen[type].push(m);
  }

  for (const [type, mats] of Object.entries(chosen)) {
    if (!mats.length) continue;
    const inst = new THREE.InstancedMesh(protos[type], mat, mats.length);
    inst.name = type;
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = false;
    group.add(inst);
  }

  return { group, count: pts.length, material: mat };
}
