import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';

// Lightweight Three adapter for the renderer-free roadside-drainage plan.
//
// The plan is already in the world frame: run point y is the authoritative bed
// elevation, surfaceY is the exact terrain under it, and y + depth is its lip.
// Crossing center.y is the top of the deck,
// while yaw aligns local +Z with the gate-to-road travel axis. This module does
// not resample terrain, choose placements, or consume global RNG.

export const DRAINAGE_MATERIAL_ROLES = Object.freeze(['ground']);

const lifecycleByRoot = new WeakMap();
const EPSILON = 1e-8;
// Triangles per planned slab after long-axis subdivision (BoxGeometry w:3 h:1 s:2).
export const DRAINAGE_CROSSING_SLAB_TRIANGLES = 44;

function linearColor(hex) {
  const color = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return Object.freeze([color.r, color.g, color.b]);
}

const DITCH_COLORS = Object.freeze({
  outer: linearColor(0x9a865f),
  lip: linearColor(0x88795d),
  bed: linearColor(0x706858),
});

// 건넘돌 색: 종전 top 0x918b7d 는 주변 흙보다 밝은 창백한 회백색이라 현대 프리캐스트
//   콘크리트 판으로 읽혔다(docs/architectural-authenticity.md §7.4-9). 국립민속박물관
//   「디딤돌」은 잘 다듬은 화강 장대석·판석을 **위상이 높은 건축**에 배정하고, 살림집에는
//   "적당한 크기의 자연석을 약간만 다듬어" 쓴다고 서술한다. 그 위계에 맞춰 노면 흙보다
//   어둡고 온기가 남은 화강 자연석 톤으로 내리되, 재질·텍스처는 그대로 둔다.
//   실측 조정: 종전 top 은 렌더 휘도 143.8 로 같은 프레임의 노면 127.1 보다 **밝았다**(=판).
//   단순히 어둡게만 내리면(0x726b5e, 휘도 94.3) 노면과 색온도가 같아져 젖은 흙으로 읽혔으므로,
//   화강암 쪽으로 g≥r 인 냉중성 회색을 쓰고 휘도는 노면보다 한 단계만 낮춘다.
const CROSSING_COLORS = Object.freeze({
  top: linearColor(0x716c60),
  side: linearColor(0x5c574d),
  bottom: linearColor(0x46423a),
});

// 돌 하나 안에서의 색 얼룩 폭과 돌끼리의 톤 차. 텍스처가 금지된 계약(docs/drainage.md §4)
//   안에서 "균일한 격자"를 깨는 유일한 수단이 vertex color 이므로, 면 색을 꼭짓점 단위로
//   흔든다. 두 값 모두 배수이고 1.0 을 중심으로 대칭이다.
const CROSSING_VERTEX_MOTTLE = 0.05;
const CROSSING_SLAB_SHADE_SPREAD = 0.3;
// 자연석 윤곽: 꼭짓점을 **안쪽으로만** 당겨 계획이 준 span·width·thickness 봉투를 넘지
//   않는다(대문 통과 폭과 도랑 바닥 관통 금지 계약 보존). 상면은 ±로 기울여 다듬돌의
//   완전 평행 상면을 없앤다.
const CROSSING_END_INSET = 0.02;
const CROSSING_EDGE_INSET = 0.13;
const CROSSING_TOP_TILT = 0.1;
// 긴 두 축의 분할 수. 완전한 육면체는 변마다 직선이 하나뿐이라 꼭짓점만 흔들어도 장변이
//   서로 평행한 다듬돌로 남는다(§7.4-9 재판정에서 실측 확인). 중간 꼭짓점이 있어야 윤곽이
//   꺾인다. 판석 하나가 12 → 44 삼각형(quad = ±x 2·2 + ±y 6·2 + ±z 3·2 = 22)이 되고 crossing 당
//   36 → 132 다. mesh·재질·텍스처·드로우콜·프로그램 델타는 0 이며 hanyang 최대 40 crossing 에서
//   전체 삼각형 증가는 +3,840(씬 2,336만 대비 0.016%)이다.
const CROSSING_SLAB_SEGMENTS = Object.freeze({ width: 3, span: 2 });
// 돌 자기 중심 회전 상한(rad). 안쪽 inset 이 이미 폭의 19% 를 비워 두므로 이 각도에서
//   회전한 모서리도 계획 봉투 안에 남는다.
const CROSSING_SLAB_YAW = 0.045;

function requireFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function requirePositive(value, label) {
  const resolved = requireFinite(value, label);
  if (resolved <= 0) throw new RangeError(`${label} must be positive`);
  return resolved;
}

function validatePoint(point, label) {
  if (!point || typeof point !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  requireFinite(point.x, `${label}.x`);
  requireFinite(point.y, `${label}.y`);
  requireFinite(point.z, `${label}.z`);
  requireFinite(point.surfaceY, `${label}.surfaceY`);
  requireFinite(point.depth, `${label}.depth`);
  if (point.depth <= 0) throw new RangeError(`${label}.depth must be positive`);
  if (point.y <= point.surfaceY) {
    throw new RangeError(`${label}.y must remain above its terrain surface`);
  }
}

function validateRun(run, index) {
  const label = `drainage runs[${index}]`;
  if (!run || typeof run !== 'object') throw new TypeError(`${label} must be an object`);
  requirePositive(run.width, `${label}.width`);
  requirePositive(run.bedWidth, `${label}.bedWidth`);
  if (run.bedWidth >= run.width) {
    throw new RangeError(`${label}.bedWidth must be smaller than width`);
  }
  if (!Array.isArray(run.points) || run.points.length < 2) {
    throw new RangeError(`${label}.points must contain at least two points`);
  }
  run.points.forEach((point, pointIndex) => validatePoint(
    point,
    `${label}.points[${pointIndex}]`,
  ));
  for (let pointIndex = 1; pointIndex < run.points.length; pointIndex++) {
    const previous = run.points[pointIndex - 1];
    const point = run.points[pointIndex];
    if (Math.hypot(point.x - previous.x, point.z - previous.z) <= EPSILON) {
      throw new RangeError(`${label}.points must not contain consecutive duplicate positions`);
    }
  }
}

function validateCrossing(crossing, index) {
  const label = `drainage crossings[${index}]`;
  if (!crossing || typeof crossing !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  if (crossing.kind !== 'stone-slab') {
    throw new RangeError(`${label}.kind must be stone-slab`);
  }
  const center = crossing.center;
  if (!center || typeof center !== 'object') {
    throw new TypeError(`${label}.center must be an object`);
  }
  requireFinite(center.x, `${label}.center.x`);
  requireFinite(center.y, `${label}.center.y`);
  requireFinite(center.z, `${label}.center.z`);
  requireFinite(crossing.yaw, `${label}.yaw`);
  requirePositive(crossing.span, `${label}.span`);
  requirePositive(crossing.width, `${label}.width`);
  requirePositive(crossing.thickness, `${label}.thickness`);
  // Layout is plan-owned (count, size, embed seating). Geometry only presents.
  if (!Array.isArray(crossing.slabs) || crossing.slabs.length < 2 || crossing.slabs.length > 3) {
    throw new RangeError(`${label}.slabs must plan 2–3 stones`);
  }
  crossing.slabs.forEach((slab, slabIndex) => {
    const slabLabel = `${label}.slabs[${slabIndex}]`;
    if (!slab || typeof slab !== 'object') {
      throw new TypeError(`${slabLabel} must be an object`);
    }
    requireFinite(slab.x, `${slabLabel}.x`);
    requireFinite(slab.z, `${slabLabel}.z`);
    requireFinite(slab.top, `${slabLabel}.top`);
    requirePositive(slab.span, `${slabLabel}.span`);
    requirePositive(slab.width, `${slabLabel}.width`);
    requirePositive(slab.thickness, `${slabLabel}.thickness`);
  });
}

function validateGeometryInput(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('drainage plan must be an object');
  }
  if (!Array.isArray(plan.runs)) throw new TypeError('drainage plan.runs must be an array');
  if (!Array.isArray(plan.crossings)) {
    throw new TypeError('drainage plan.crossings must be an array');
  }
  plan.runs.forEach(validateRun);
  plan.crossings.forEach(validateCrossing);
}

function pointFrame(points, index) {
  const current = points[index];
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  let tx = next.x - previous.x;
  let tz = next.z - previous.z;
  let length = Math.hypot(tx, tz);
  if (length <= EPSILON && index > 0) {
    tx = current.x - previous.x;
    tz = current.z - previous.z;
    length = Math.hypot(tx, tz);
  }
  if (length <= EPSILON && index + 1 < points.length) {
    tx = next.x - current.x;
    tz = next.z - current.z;
    length = Math.hypot(tx, tz);
  }
  if (length <= EPSILON) {
    throw new RangeError('drainage run contains a zero-length local frame');
  }
  // geom2 perpL: +1 is the left side of the plan's road start-to-end frame.
  return { nx: -tz / length, nz: tx / length };
}

function pushColor(colors, color) {
  colors.push(color[0], color[1], color[2]);
}

function buildDitchGeometry(runs) {
  if (!runs.length) return null;
  const positions = [];
  const colors = [];
  const indices = [];

  for (const run of runs) {
    const baseVertex = positions.length / 3;
    const halfWidth = run.width * 0.5;
    const halfBed = run.bedWidth * 0.5;
    const halfLip = (halfWidth + halfBed) * 0.5;
    const offsets = [-halfWidth, -halfLip, -halfBed, halfBed, halfLip, halfWidth];
    for (let pointIndex = 0; pointIndex < run.points.length; pointIndex++) {
      const point = run.points[pointIndex];
      const { nx, nz } = pointFrame(run.points, pointIndex);
      // The outer rails return to the same shallow raised bed plane instead of
      // ending as vertical ribbons. One-metre plan sampling follows exact terrain
      // triangle changes closely enough to keep this blend above the shared mesh.
      const outerY = point.y;
      const heights = [
        outerY,
        point.y + point.depth,
        point.y,
        point.y,
        point.y + point.depth,
        outerY,
      ];
      const railColors = [
        DITCH_COLORS.outer,
        DITCH_COLORS.lip,
        DITCH_COLORS.bed,
        DITCH_COLORS.bed,
        DITCH_COLORS.lip,
        DITCH_COLORS.outer,
      ];
      for (let rail = 0; rail < offsets.length; rail++) {
        positions.push(
          point.x + nx * offsets[rail],
          heights[rail],
          point.z + nz * offsets[rail],
        );
        pushColor(colors, railColors[rail]);
      }
    }

    // The cross-section advances from -perpL to +perpL. This winding keeps the
    // open earth channel front-facing toward +Y without a double-sided material.
    for (let pointIndex = 0; pointIndex < run.points.length - 1; pointIndex++) {
      const row = baseVertex + pointIndex * offsets.length;
      const nextRow = row + offsets.length;
      for (let rail = 0; rail < offsets.length - 1; rail++) {
        const a = row + rail;
        const b = nextRow + rail;
        const c = nextRow + rail + 1;
        const d = row + rail + 1;
        indices.push(a, c, b, a, d, c);
      }
    }
  }

  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function stableUnit(seed, channel) {
  const text = `${seed ?? 'crossing'}:${channel}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

function applyCrossingColors(geometry, shade = 1, seed = 'crossing') {
  const normals = geometry.getAttribute('normal');
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(normals.count * 3);
  for (let index = 0; index < normals.count; index++) {
    const ny = normals.getY(index);
    const color = ny > 0.5
      ? CROSSING_COLORS.top
      : (ny < -0.5 ? CROSSING_COLORS.bottom : CROSSING_COLORS.side);
    // 얼룩은 꼭짓점 좌표에서 파생하므로 같은 꼭짓점을 공유하는 인접 면이 같은 값을 받고,
    // 돌 하나 안에서 평면적인 단색이 사라진다. 텍스처·재질 델타 0.
    const key = `${positions.getX(index).toFixed(4)}`
      + `,${positions.getY(index).toFixed(4)}`
      + `,${positions.getZ(index).toFixed(4)}`;
    const mottle = 1 + (stableUnit(seed, `mottle-${key}`) * 2 - 1) * CROSSING_VERTEX_MOTTLE;
    const scale = shade * mottle;
    colors[index * 3] = Math.min(1, color[0] * scale);
    colors[index * 3 + 1] = Math.min(1, color[1] * scale);
    colors[index * 3 + 2] = Math.min(1, color[2] * scale);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Pull a slab box toward an irregular natural-stone block.
 *
 * A perfect hexahedron has exactly one straight edge per side, so a corner-only
 * jitter still reads as a machined slab: the long edges stay straight and
 * mutually parallel, which is precisely the "다듬은 판석·장대석" hierarchy the
 * source reserves for high-status architecture. Subdividing the long axes gives
 * mid-edge vertices to break, at the cost of triangles alone (see the plan-level
 * comment on CROSSING_SLAB_SEGMENTS).
 *
 * A BoxGeometry keeps one vertex per (position, face), so the same offset keyed
 * by rounded position keeps the hull closed. Every horizontal offset is inward
 * along the axis the vertex is extremal in, so the plan's span/width footprint
 * and the gate clearance it was solved against stay exactly as authored.
 */
function shapeCrossingSlab(geometry, slab, seed) {
  const positions = geometry.getAttribute('position');
  const halfWidth = slab.width * 0.5;
  const halfSpan = slab.span * 0.5;
  // 짧은 두 끝(±x)은 조금만 당긴다 — 여기서 크게 당기면 돌이 뾰족한 쐐기·잎사귀 모양이
  //   된다(실측 확인). 긴 변(±z)의 중간 꼭짓점을 넉넉히 당겨야 장변의 직선성이 깨진다.
  const insetX = halfWidth * CROSSING_END_INSET;
  const insetZ = halfSpan * CROSSING_EDGE_INSET;
  const rim = 1e-6;
  // 상면은 **평면으로** 기울인다. 꼭짓점마다 독립적으로 흔들면 세분된 면이 부드럽게 보간돼
  //   돌이 아니라 휘어진 판으로 읽혔다. 한 쌍의 기울기만 주면 면이 평평하게 유지된다.
  const tiltX = (stableUnit(seed, 'tilt-x') * 2 - 1) * slab.thickness * CROSSING_TOP_TILT;
  const tiltZ = (stableUnit(seed, 'tilt-z') * 2 - 1) * slab.thickness * CROSSING_TOP_TILT;
  const offsets = new Map();
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const up = y > 0;
    const key = `${x.toFixed(5)},${z.toFixed(5)},${up ? 'u' : 'd'}`;
    let offset = offsets.get(key);
    if (!offset) {
      const onXRim = Math.abs(Math.abs(x) - halfWidth) < rim;
      const onZRim = Math.abs(Math.abs(z) - halfSpan) < rim;
      offset = {
        x: onXRim ? -Math.sign(x) * insetX * stableUnit(seed, `rim-x-${key}`) : 0,
        z: onZRim ? -Math.sign(z) * insetZ * stableUnit(seed, `rim-z-${key}`) : 0,
        // 하면을 올리면 얇은 돌이 지면 위로 떠 보이므로 상면만 기울인다.
        y: up ? tiltX * (x / halfWidth) + tiltZ * (z / halfSpan) : 0,
      };
      offsets.set(key, offset);
    }
    positions.setXYZ(index, x + offset.x, y + offset.y, z + offset.z);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function makeCrossingGeometries(crossing) {
  // Count, size, thickness, and seating come from the pure plan (issue #217).
  // This adapter only adds presentation: natural-stone silhouette, mottle shade,
  // and a micro self-yaw that stays inside the planned envelope.
  return crossing.slabs.map((slab, index) => {
    const slabSeed = `${crossing.id}:slab-${index}`;
    const shade = 1 - CROSSING_SLAB_SHADE_SPREAD * 0.5
      + stableUnit(crossing.id, `shade-${index}`) * CROSSING_SLAB_SHADE_SPREAD;
    const yaw = (stableUnit(crossing.id, `yaw-${index}`) * 2 - 1) * CROSSING_SLAB_YAW;
    const geometry = applyCrossingColors(
      shapeCrossingSlab(
        new THREE.BoxGeometry(
          slab.width, slab.thickness, slab.span,
          CROSSING_SLAB_SEGMENTS.width, 1, CROSSING_SLAB_SEGMENTS.span,
        ),
        slab,
        slabSeed,
      ),
      shade,
      slabSeed,
    );
    // 자연석은 서로 평행하게 놓이지 않는다. 돌 자기 중심에서만 아주 작게 틀어
    // 통과축·접지면·계획 봉투는 그대로 두고 기계 가공된 정렬만 없앤다.
    geometry.rotateY(yaw);
    // center.y is the plan's nominal deck top; slab.top is the planned seating
    // offset so stones can sit unevenly without the renderer inventing height.
    geometry.translate(slab.x, slab.top - slab.thickness * 0.5, slab.z);
    geometry.rotateY(crossing.yaw);
    geometry.translate(
      crossing.center.x,
      crossing.center.y,
      crossing.center.z,
    );
    return geometry;
  });
}

function buildCrossingGeometry(crossings) {
  if (!crossings.length) return null;
  const sources = [];
  try {
    for (const crossing of crossings) {
      sources.push(...makeCrossingGeometries(crossing));
    }
  } catch (error) {
    for (const geometry of sources) geometry.dispose();
    throw error;
  }
  const geometry = mergeOwnedGeometries(sources, 'Drainage crossing geometries');
  if (!geometry) throw new Error('Drainage crossing geometry merge returned null');
  geometry.clearGroups();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createDefaultMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.98,
    metalness: 0,
  });
  material.name = 'roadside-drainage-ground';
  material.userData = {
    ...material.userData,
    role: 'ground',
    snowSurface: true,
    drainageOwned: true,
  };
  return material;
}

function resolveMaterial(materials) {
  if (materials == null) {
    const material = createDefaultMaterial();
    return { material, owned: true };
  }
  const material = materials.ground;
  if (!material?.isMeshStandardMaterial) {
    throw new TypeError('drainage materials.ground must be a MeshStandardMaterial');
  }
  if (material.vertexColors !== true) {
    throw new RangeError('drainage materials.ground must enable vertexColors');
  }
  return { material, owned: false };
}

function makePhysicalMesh(geometry, material, name) {
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function finiteGeometryBounds(geometry) {
  const box = geometry?.boundingBox;
  return !!box && [
    box.min.x, box.min.y, box.min.z,
    box.max.x, box.max.y, box.max.z,
  ].every(Number.isFinite);
}

/**
 * Build at most two physical, world-space meshes from a roadside-drainage plan.
 *
 * `materials.ground` is borrowed when supplied and must have vertexColors=true.
 * With no material input, the adapter owns one texture-free standard material.
 * In both cases the result owns only its geometries plus any default material.
 */
export function buildDrainage(plan, { materials = null } = {}) {
  validateGeometryInput(plan);
  const root = new THREE.Group();
  root.name = 'roadside-drainage-ground';
  const geometries = new Set();
  const ownedMaterials = new Set();

  try {
    const ditchGeometry = buildDitchGeometry(plan.runs);
    if (ditchGeometry) geometries.add(ditchGeometry);
    const crossingGeometry = buildCrossingGeometry(plan.crossings);
    if (crossingGeometry) geometries.add(crossingGeometry);
    const resolved = geometries.size ? resolveMaterial(materials) : null;
    if (resolved?.owned) ownedMaterials.add(resolved.material);

    for (const [geometry, name] of [
      [ditchGeometry, 'road-drainage-ground'],
      [crossingGeometry, 'road-drainage-stone-crossings'],
    ]) {
      if (!geometry) continue;
      if (!finiteGeometryBounds(geometry)) {
        throw new RangeError(`${name} produced non-finite bounds`);
      }
      root.add(makePhysicalMesh(geometry, resolved.material, name));
    }

    root.userData.drainage = {
      schema: plan.schema,
      runCount: plan.runs.length,
      crossingCount: plan.crossings.length,
      meshCount: root.children.length,
      materialOwnership: resolved
        ? (resolved.owned ? 'renderer' : 'caller')
        : 'none',
      geometryOwnership: 'renderer',
    };
    lifecycleByRoot.set(root, {
      disposed: false,
      geometries,
      ownedMaterials,
    });
    return root;
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    root.clear();
    throw error;
  }
}

/**
 * Dispose renderer-owned resources exactly once. Detaching the root from its
 * scene remains the caller's responsibility; borrowed materials are untouched.
 */
export function disposeDrainage(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;
  for (const geometry of lifecycle.geometries) geometry.dispose();
  for (const material of lifecycle.ownedMaterials) material.dispose();
  lifecycle.geometries.clear();
  lifecycle.ownedMaterials.clear();
  root.clear();
  root.visible = false;
  root.userData.drainage = null;
  return true;
}
