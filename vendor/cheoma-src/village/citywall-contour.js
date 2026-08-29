import * as G from '../core/math/geom2.js';
import { terrainMeshHeightAt } from './terrain-grid.js';

// 한양 성곽의 순수 평면 계약. 좌표는 village 공통 규약(+z=남)을 따른다.
// plan·roads·parcels·forest·renderer가 같은 contour와 치수를 소비하므로 성문, 길, 식생,
// 렌더 메시가 서로 다른 원을 재구성하지 않는다. DOM/THREE 비의존이라 외부 생성 엔진에서도 재사용 가능하다.

const TAU = Math.PI * 2;
const WALL_SCALE = 1.12;
const CORE_MARGIN = 10;
const EDGE_INSET = 14;
const TARGET_SEGMENT = 7.5;
const MITER_LIMIT = 2.4;
const GATE_ANGLE_STEPS = 80;
const JONGNO_STEPS = 48;
const TERRAIN_WARP_INSET = 6;

// 외딴집은 성곽을 둘러야 할 취락이 아니다. 초락 이상은 각 tier 도로를 성문에 정렬하고, 그보다 작은
// 유효 입력은 예외 대신 경고와 함께 성곽을 생략한다(plan.js).
export const CITY_WALL_MIN_SITE_R = 74;

// 계획·렌더·검증이 함께 쓰는 물리 치수. bodyHeight-foundationSink=지상 노출 높이(5.4m)는 유지한다.
export const CITY_WALL_DIMENSIONS = Object.freeze({
  thickness: 2.6,
  foundationSink: 2.5,
  bodyHeight: 7.9,
  capHeight: 0.9,
  maxSegmentLength: 3,
  maxTerrainError: 0.4,
  maxSubdivisionDepth: 5,
  gateDepth: 8.5,
  gateExtraWidth: 11,
  gateFoundationSink: 0.6,
  gateArchClearance: 4.4,
  gateLintelHeight: 1.2,
  gateTerrainReveal: 0.5,
  gateTerrainSampleSafety: 0.5,
  gateMaxPierHeight: 18.5,
  gateStreamClearance: 3,
  gateRoadClearance: 0.4,
  majorGateMinOpening: 18,
  maxGateOpening: 26,
  vegetationClearance: 10,
  gateVegetationMargin: 10,
  gateApproachLength: 44,
  gateApproachClearance: 3,
  roadEdgeMargin: 3,
});

const wrapAngle = (angle) => {
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
};

const angularDistance = (a, b) => {
  let d = Math.abs(wrapAngle(a) - wrapAngle(b));
  if (d > Math.PI) d = TAU - d;
  return d;
};

const directionAt = (angle) => ({ x: Math.sin(angle), z: Math.cos(angle) });

export function worldEdgeClearance(edge, point) {
  if (!edge?.edgeRadiusAt) return Infinity;
  const dx = point.x - edge.cx, dz = point.z - edge.cz;
  return edge.edgeRadiusAt(Math.atan2(dz, dx)) - Math.hypot(dx, dz);
}

export function worldEdgeContainsPolygon(edge, poly, inset = 0) {
  return poly.every((point) => worldEdgeClearance(edge, point) >= inset);
}

function rayEdgeLimit(site, angle) {
  const { edge, center: C } = site;
  if (!edge?.edgeRadiusAt) return site.terrainR || site.R;
  const dir = directionAt(angle);
  const centerOffset = Math.hypot(C.x - edge.cx, C.z - edge.cz);
  const far = edge.radius * (1 + Math.abs(edge.amp || 0)) + centerOffset + 32;
  const step = Math.max(2, site.R / 128);
  let inside = 0;
  for (let r = step; r <= far + step; r += step) {
    const p = { x: C.x + dir.x * r, z: C.z + dir.z * r };
    if (worldEdgeClearance(edge, p) >= 0) { inside = r; continue; }
    let lo = inside, hi = r;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) * 0.5;
      const q = { x: C.x + dir.x * mid, z: C.z + dir.z * mid };
      if (worldEdgeClearance(edge, q) >= 0) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  return far;
}

function rayCircleLimit(center, direction, radius) {
  const projection = center.x * direction.x + center.z * direction.z;
  const discriminant = projection * projection
    - (center.x * center.x + center.z * center.z - radius * radius);
  if (discriminant < 0) return -Infinity;
  return -projection + Math.sqrt(discriminant);
}

// terrain 외곽의 유기적 warp는 정규 grid 좌표를 움직인다. 성벽·가장 넓은 성문의 전체 footprint가
// 그 밴드에 닿지 않게 중심선을 제한하면 renderer의 해석 높이와 실제 terrain 삼각형이 일치한다.
function rayTerrainGridLimit(site, angle) {
  const scale = 1;
  const gateHalfWidth = (CITY_WALL_DIMENSIONS.maxGateOpening
    + CITY_WALL_DIMENSIONS.gateExtraWidth * scale) * 0.5;
  const gateHalfDepth = CITY_WALL_DIMENSIONS.gateDepth * scale * 0.5;
  const footprintReserve = Math.hypot(gateHalfWidth, gateHalfDepth) + 1;
  const terrainR = site.terrainR || site.R;
  const safeRadius = terrainR - TERRAIN_WARP_INSET - footprintReserve;
  return rayCircleLimit(site.center, directionAt(angle), safeRadius);
}

function coreRadius(center, corePolys) {
  let radius = 0;
  for (const poly of corePolys) for (const p of poly || []) radius = Math.max(radius, G.dist(center, p));
  return radius;
}

function sampleCountFor(site) {
  const estimate = TAU * site.bowlR * WALL_SCALE / TARGET_SEGMENT;
  return Math.min(256, Math.max(96, Math.round(estimate / 4) * 4));
}

export function cityWallRadiusAt(spec, angle) {
  const n = spec.radii.length;
  const u = wrapAngle(angle) / TAU * n;
  const i = Math.floor(u) % n, t = u - Math.floor(u);
  return spec.radii[i] * (1 - t) + spec.radii[(i + 1) % n] * t;
}

export function pointOnCityWall(spec, angle) {
  const a = wrapAngle(angle), r = cityWallRadiusAt(spec, a);
  const dir = directionAt(a);
  return { x: spec.cx + dir.x * r, z: spec.cz + dir.z * r };
}

export function normalOnCityWall(spec, angle) {
  const eps = TAU / spec.radii.length * 0.25;
  const before = pointOnCityWall(spec, angle - eps);
  const after = pointOnCityWall(spec, angle + eps);
  const tangent = G.norm(G.sub(after, before));
  let normal = G.perpR(tangent); // angle 증가는 남→동→북: 시계방향이므로 오른쪽이 바깥.
  const point = pointOnCityWall(spec, angle);
  const radial = G.sub(point, { x: spec.cx, z: spec.cz });
  if (G.dot(normal, radial) < 0) normal = G.mul(normal, -1);
  return normal;
}

// 양수=성 안쪽, 0=중심선, 음수=바깥. 극좌표 contour의 방사 여유이며 모든 배치 계약이 같은 값을 쓴다.
export function cityWallClearance(spec, point) {
  const dx = point.x - spec.cx, dz = point.z - spec.cz;
  const angle = Math.atan2(dx, dz); // +z=0, +x=π/2
  return cityWallRadiusAt(spec, angle) - Math.hypot(dx, dz);
}

export function cityWallContainsPolygon(spec, poly, inset = 0) {
  return poly.every((point) => cityWallClearance(spec, point) >= inset);
}

export function cityWallOutsidePolygon(spec, poly, gap = 0) {
  return poly.every((point) => cityWallClearance(spec, point) <= -gap);
}

// 점을 같은 방사선 위에서 성 안으로 당긴다. 도로의 유기 굽이가 오목한 성곽을 넘을 때 사용하며,
// 이미 안전한 점은 객체까지 그대로 반환해 불필요한 계획 데이터 변화를 피한다.
export function clampPointInsideCityWall(spec, point, inset = 0) {
  if (!spec || cityWallClearance(spec, point) >= inset) return point;
  const dx = point.x - spec.cx, dz = point.z - spec.cz;
  const angle = Math.atan2(dx, dz);
  const radius = Math.max(0, cityWallRadiusAt(spec, angle) - inset);
  const dir = directionAt(angle);
  return { x: spec.cx + dir.x * radius, z: spec.cz + dir.z * radius };
}

export function clampPointOutsideCityWall(spec, point, gap = 0) {
  if (!spec || cityWallClearance(spec, point) <= -gap) return point;
  const dx = point.x - spec.cx, dz = point.z - spec.cz;
  const angle = Math.atan2(dx, dz);
  const radius = cityWallRadiusAt(spec, angle) + gap;
  return {
    x: spec.cx + Math.sin(angle) * radius,
    z: spec.cz + Math.cos(angle) * radius,
  };
}

export function cityGateFootprint(gate, {
  depth,
  extraWidth,
} = {}) {
  const scale = gate.scale || 1;
  depth ??= CITY_WALL_DIMENSIONS.gateDepth * scale;
  extraWidth ??= CITY_WALL_DIMENSIONS.gateExtraWidth * scale;
  const halfW = (gate.width + extraWidth) * 0.5;
  const halfD = depth * 0.5;
  const localX = { x: gate.dirZ, z: -gate.dirX };
  return [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD],
  ].map(([sx, sz]) => ({
    x: gate.x + localX.x * sx + gate.dirX * sz,
    z: gate.z + localX.z * sx + gate.dirZ * sz,
  }));
}

export function cityGateLocalPoint(gate, localX, localZ) {
  const tangent = { x: gate.dirZ, z: -gate.dirX };
  return {
    x: gate.x + tangent.x * localX + gate.dirX * localZ,
    z: gate.z + tangent.z * localX + gate.dirZ * localZ,
  };
}

export function cityGateApproachFootprint(gate, {
  length = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1)
    + CITY_WALL_DIMENSIONS.gateApproachClearance,
  halfWidth = gate.width * 0.5 + CITY_WALL_DIMENSIONS.gateVegetationMargin,
} = {}) {
  return [
    cityGateLocalPoint(gate, -halfWidth, -length),
    cityGateLocalPoint(gate, halfWidth, -length),
    cityGateLocalPoint(gate, halfWidth, length),
    cityGateLocalPoint(gate, -halfWidth, length),
  ];
}

// 성문 전체(통로+육축)와 물가 사이의 최소 평면 여유. 하천 골은 낮고 평평해 높이 점수만 쓰면
// 오히려 최적 후보로 선택되므로, 물 메시와 겹치는 문을 계획 단계에서 명시적으로 제외한다.
export function cityGateStreamClearance(gate, site, {
  widthSamples = 17,
  depthSamples = 13,
} = {}) {
  if (!site.stream) return Infinity;
  const scale = gate.scale || 1;
  const halfW = (gate.width + CITY_WALL_DIMENSIONS.gateExtraWidth * scale) * 0.5;
  const halfD = CITY_WALL_DIMENSIONS.gateDepth * scale * 0.5;
  let clearance = Infinity;
  for (let ix = 0; ix < widthSamples; ix++) {
    const localX = -halfW + 2 * halfW * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
    for (let iz = 0; iz < depthSamples; iz++) {
      const localZ = -halfD + 2 * halfD * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
      const point = cityGateLocalPoint(gate, localX, localZ);
      clearance = Math.min(clearance,
        Math.abs(point.z - site.streamZat(point.x)) - site.streamHalf);
    }
  }
  return clearance;
}

// 문 육축은 평평하므로 모서리만이 아니라 내부 격자까지 훑어 최저/최고 지반을 계약으로 만든다.
export function cityGateTerrainProfile(gate, site, {
  depth,
  extraWidth,
  widthSamples = 9,
  depthSamples = 7,
} = {}) {
  const scale = gate.scale || 1;
  depth ??= CITY_WALL_DIMENSIONS.gateDepth * scale;
  extraWidth ??= CITY_WALL_DIMENSIONS.gateExtraWidth * scale;
  const halfW = (gate.width + extraWidth) * 0.5;
  const halfD = depth * 0.5;
  const localX = { x: gate.dirZ, z: -gate.dirX };
  let min = Infinity, max = -Infinity;
  const samples = [];
  for (let ix = 0; ix < widthSamples; ix++) {
    const sx = -halfW + (2 * halfW) * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
    for (let iz = 0; iz < depthSamples; iz++) {
      const sz = -halfD + (2 * halfD) * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
      const x = gate.x + localX.x * sx + gate.dirX * sz;
      const z = gate.z + localX.z * sx + gate.dirZ * sz;
      const y = terrainMeshHeightAt(site, x, z);
      min = Math.min(min, y); max = Math.max(max, y);
      samples.push({ x, z, y });
    }
  }
  return { min, max, drop: max - min, samples };
}

// 한쪽 육축 footprint의 내부 최저점을 촘촘히 찾는다. 모서리 4점만 보면 비선형 산세의 내부 골을 놓쳐
// 긴 pier가 공중에 뜰 수 있으므로 renderer가 이 순수 profile을 직접 소비한다.
export function cityGatePierTerrainProfile(gate, site, side, {
  pierWidth = 5.5 * (gate.scale || 1),
  depth = CITY_WALL_DIMENSIONS.gateDepth * (gate.scale || 1),
  widthSamples = 17,
  depthSamples = 13,
} = {}) {
  const centerX = side * (gate.width * 0.5 + pierWidth * 0.5);
  let min = Infinity, max = -Infinity;
  const samples = [];
  for (let ix = 0; ix < widthSamples; ix++) {
    const localX = centerX - pierWidth * 0.5
      + pierWidth * (widthSamples === 1 ? 0.5 : ix / (widthSamples - 1));
    for (let iz = 0; iz < depthSamples; iz++) {
      const localZ = -depth * 0.5
        + depth * (depthSamples === 1 ? 0.5 : iz / (depthSamples - 1));
      const point = cityGateLocalPoint(gate, localX, localZ);
      const y = terrainMeshHeightAt(site, point.x, point.z);
      min = Math.min(min, y); max = Math.max(max, y);
      samples.push({ ...point, y });
    }
  }
  return { min, max, drop: max - min, centerX, pierWidth, depth, samples };
}

// 평탄화하지 않은 산문 계약: 기존 지형의 길은 그대로 통과시키고, 좌우 육축은 각자 지반까지 내린다.
// 문 높이는 통행면의 유효고로 정하고 높은 쪽 지반에는 최소 노출만 남긴다. 전체 footprint 최고점에
// 고정 성벽 높이를 더하면 경사 seed에서 20m가 넘는 절벽 탑이 되므로, 실제 도로와 지반이라는 두 제약만 쓴다.
export function cityGateStructureProfile(gate, site) {
  const scale = gate.scale || 1;
  const roadTerrain = cityGateTerrainProfile(gate, site, { extraWidth: 0 });
  const piers = [-1, 1].map((side) => cityGatePierTerrainProfile(gate, site, side));
  const terrainMin = Math.min(roadTerrain.min, ...piers.map((pier) => pier.min));
  const terrainMax = Math.max(roadTerrain.max, ...piers.map((pier) => pier.max));
  const terrain = {
    min: terrainMin,
    max: terrainMax,
    drop: terrainMax - terrainMin,
    samples: [...roadTerrain.samples, ...piers.flatMap((pier) => pier.samples)],
  };
  const lintelHeight = CITY_WALL_DIMENSIONS.gateLintelHeight * scale;
  const pierTerrainMax = Math.max(...piers.map((pier) => pier.max));
  const baseTopY = Math.max(
    roadTerrain.max + (CITY_WALL_DIMENSIONS.gateArchClearance
      + CITY_WALL_DIMENSIONS.gateTerrainSampleSafety) * scale + lintelHeight,
    pierTerrainMax + CITY_WALL_DIMENSIONS.gateTerrainReveal * scale,
  );
  const foundationSink = CITY_WALL_DIMENSIONS.gateFoundationSink * scale;
  const maxPierHeight = Math.max(...piers.map((pier) => baseTopY - (pier.min - foundationSink)));
  return {
    terrain,
    roadTerrain,
    piers,
    baseHeight: baseTopY - terrain.max,
    baseTopY,
    lintelHeight,
    maxPierHeight,
    archBottomY: roadTerrain.min - CITY_WALL_DIMENSIONS.gateTerrainSampleSafety * scale,
    // buildGate의 상인방 하단과 동일하며 통행면 최고점 위 유효고를 보장한다.
    archTopY: baseTopY - lintelHeight,
  };
}

// 성벽 몸체뿐 아니라 성문 지붕·진입 시야까지 나무와 바위에서 비운다. worker와 sync가 이 순수 판정을 공유한다.
export function cityWallVegetationBlocked(spec, point, {
  corridor = CITY_WALL_DIMENSIONS.vegetationClearance,
  gateMargin = CITY_WALL_DIMENSIONS.gateVegetationMargin,
  gateApproachMargin = 0,
} = {}) {
  if (!spec) return false;
  if (Math.abs(cityWallClearance(spec, point)) < corridor) return true;
  return spec.gates.some((gate) => {
    const radius = gate.width * 0.5 + gateMargin;
    if (G.dist2(gate, point) < radius ** 2) return true;
    const delta = G.sub(point, gate);
    const along = Math.abs(delta.x * gate.dirX + delta.z * gate.dirZ);
    const across = Math.abs(delta.x * gate.dirZ - delta.z * gate.dirX);
    const approach = CITY_WALL_DIMENSIONS.gateApproachLength * Math.max(0.6, gate.scale || 1)
      + CITY_WALL_DIMENSIONS.gateApproachClearance + gateApproachMargin;
    return along < approach && across < radius;
  });
}

function crossingAtZ(spec, z, lo, hi, preferred) {
  const roots = [];
  const steps = 160;
  let a = lo, fa = pointOnCityWall(spec, a).z - z;
  for (let i = 1; i <= steps; i++) {
    const b = lo + (hi - lo) * i / steps;
    const fb = pointOnCityWall(spec, b).z - z;
    if (Math.abs(fa) < 1e-9) roots.push(a);
    if (fa * fb < 0 || Math.abs(fb) < 1e-9) {
      let left = a, right = b, fLeft = fa;
      for (let k = 0; k < 42; k++) {
        const mid = (left + right) * 0.5;
        const fm = pointOnCityWall(spec, mid).z - z;
        if (fLeft * fm <= 0) right = mid;
        else { left = mid; fLeft = fm; }
      }
      roots.push((left + right) * 0.5);
    }
    a = b; fa = fb;
  }
  if (!roots.length) return null;
  roots.sort((a0, a1) => angularDistance(a0, preferred) - angularDistance(a1, preferred));
  return roots[0];
}

function makeGate(spec, name, angle, width, scaleMultiplier = 1, minWidth = 0) {
  const scale = (spec.gateScale || 1) * scaleMultiplier;
  width = Math.max(width * scale, minWidth);
  const point = pointOnCityWall(spec, angle);
  const normal = normalOnCityWall(spec, angle);
  const eps = TAU / spec.radii.length * 0.125;
  const speed = G.dist(pointOnCityWall(spec, angle - eps), pointOnCityWall(spec, angle + eps)) / (eps * 2);
  const openingHalf = width * 0.5 + 4 * scale;
  return {
    name, angle: wrapAngle(angle), width, scale, openingHalf,
    halfAngle: openingHalf / Math.max(1, speed),
    x: point.x, z: point.z, dirX: normal.x, dirZ: normal.z,
  };
}

function gateFitsWorld(gate, site) {
  return cityGateFootprint(gate).every((point) => worldEdgeClearance(site.edge, point) >= 0);
}

function minimumGateGapAngle(spec) {
  return Math.max(2, 3 * (spec.gateScale || 1)) / Math.max(1, spec.meanRadius);
}

function gatesHaveRoom(spec, a, b) {
  return angularDistance(a.angle, b.angle) - a.halfAngle - b.halfAngle >= minimumGateGapAngle(spec);
}

function bestGateNear(spec, site, name, center, span, width, anglePenalty, avoid = [], scaleMultipliers = [1]) {
  const steps = GATE_ANGLE_STEPS;
  const heightLimit = CITY_WALL_DIMENSIONS.gateMaxPierHeight;
  let fallback = null;
  for (const scaleMultiplier of scaleMultipliers) {
    let best = null;
    for (let i = 0; i <= steps; i++) {
      const angle = center - span + span * 2 * i / steps;
      const gate = makeGate(spec, name, angle, width, scaleMultiplier);
      if (!gateFitsWorld(gate, site)) continue;
      if (avoid.some((other) => !gatesHaveRoom(spec, gate, other))) continue;
      const streamDeficit = site.R >= 250
        ? Math.max(0, CITY_WALL_DIMENSIONS.gateStreamClearance - cityGateStreamClearance(gate, site))
        : 0;
      const structure = cityGateStructureProfile(gate, site);
      const excess = Math.max(0, structure.maxPierHeight - heightLimit);
      const score = structure.maxPierHeight + excess * 100
        + streamDeficit * 1000
        + angularDistance(angle, center) * anglePenalty;
      if (!best || score < best.score) best = {
        gate, score, maxHeight: structure.maxPierHeight, streamDeficit,
      };
    }
    if (!best) continue;
    if (!fallback || best.score < fallback.score) fallback = best;
    if (best.maxHeight <= heightLimit && best.streamDeficit <= 0) return best.gate;
  }
  if (!fallback) throw new Error(`city wall cannot place ${name} gate`);
  return fallback.gate;
}

function bestJongnoGates(spec, site, southGate) {
  const southExtent = pointOnCityWall(spec, 0).z - spec.cz;
  const desiredDelta = Math.min(site.R * 0.42, southExtent * 0.68);
  const desiredZ = spec.cz + Math.max(0, desiredDelta);
  // 종로 T는 궁 정문(C.z+0.11R)보다 남쪽이어야 주작대로의 북→남 위계가 뒤집히지 않는다.
  // 완만한 후보를 찾더라도 이 도시 문법 하한은 넘지 않고, 남는 경사는 문 크기 적응으로 흡수한다.
  const minZ = spec.cz + site.R * 0.13;
  const heightLimit = CITY_WALL_DIMENSIONS.gateMaxPierHeight;
  const minOpening = site.R >= 250 ? CITY_WALL_DIMENSIONS.majorGateMinOpening : 0;
  let fallback = null;
  // 평탄한 축이 있으면 사대문의 원래 위계를 지킨다. 전 크기 후보가 모두 한계를 넘는 seed에서만
  // 동·서문을 함께 한 단계씩 줄여 비대칭이나 우연한 절벽 구조를 만들지 않는다.
  for (const scaleMultiplier of [1, 0.9, 0.8, 0.72, 0.64, 0.56]) {
    let best = null;
    for (let i = 0; i <= JONGNO_STEPS; i++) {
      const z = minZ + (desiredZ - minZ) * i / JONGNO_STEPS;
      // 대로 폭과 양측 보행 여유가 T 지점에 들어가는 축만 후보로 삼는다.
      if (cityWallClearance(spec, { x: spec.cx, z }) < Math.min(18, spec.meanRadius * 0.22)) continue;
      const eastAngle = crossingAtZ(spec, z, 0, Math.PI, Math.PI / 2);
      const westAngle = crossingAtZ(spec, z, Math.PI, TAU, Math.PI * 1.5);
      if (eastAngle == null || westAngle == null) continue;
      const east = makeGate(spec, 'east', eastAngle, 18, scaleMultiplier, minOpening);
      const west = makeGate(spec, 'west', westAngle, 18, scaleMultiplier, minOpening);
      if (!gateFitsWorld(east, site) || !gateFitsWorld(west, site)) continue;
      if (!gatesHaveRoom(spec, east, west)
        || !gatesHaveRoom(spec, east, southGate)
        || !gatesHaveRoom(spec, west, southGate)) continue;
      const eastStructure = cityGateStructureProfile(east, site);
      const westStructure = cityGateStructureProfile(west, site);
      const streamDeficit = site.R >= 250 ? Math.max(
        0,
        CITY_WALL_DIMENSIONS.gateStreamClearance - cityGateStreamClearance(east, site),
        CITY_WALL_DIMENSIONS.gateStreamClearance - cityGateStreamClearance(west, site),
      ) : 0;
      const maxHeight = Math.max(eastStructure.maxPierHeight, westStructure.maxPierHeight);
      const excess = Math.max(0, maxHeight - heightLimit);
      const score = maxHeight + excess * 100
        + streamDeficit * 1000
        + (eastStructure.maxPierHeight + westStructure.maxPierHeight) * 0.12
        + Math.abs(z - desiredZ) * 0.01;
      if (!best || score < best.score) best = { east, west, z, score, maxHeight, streamDeficit };
    }
    if (!best) continue;
    if (!fallback || best.score < fallback.score) fallback = best;
    if (best.maxHeight <= heightLimit && best.streamDeficit <= 0) return best;
  }
  if (!fallback) throw new Error('city wall cannot place Jongno gates');
  return fallback;
}

function validateGateSpacing(spec) {
  const gates = [...spec.gates].sort((a, b) => a.angle - b.angle);
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i], b = gates[(i + 1) % gates.length];
    if (!gatesHaveRoom(spec, a, b)) throw new Error(`city wall gates overlap: ${a.name}/${b.name}`);
  }
}

export function planCityWall(site, seed, corePolys = []) {
  const n = sampleCountFor(site);
  const C = site.center;
  const minRadius = coreRadius(C, corePolys) + CORE_MARGIN;
  const radii = new Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const angle = i / n * TAU;
    const dir = directionAt(angle);
    const standardTheta = Math.atan2(dir.z, dir.x);
    const bowlRadius = site.bowlRadiusAt ? site.bowlRadiusAt(standardTheta) : site.bowlR;
    const desired = Math.max(minRadius, bowlRadius * WALL_SCALE);
    const radius = Math.min(
      desired,
      rayEdgeLimit(site, angle) - EDGE_INSET,
      rayTerrainGridLimit(site, angle),
    );
    if (!Number.isFinite(radius) || radius < minRadius - 1e-7) {
      throw new Error(`city wall cannot fit at angle ${angle.toFixed(3)}`);
    }
    radii[i] = radius;
    sum += radius;
  }

  const spec = {
    version: 3,
    seed: seed >>> 0,
    cx: C.x,
    cz: C.z,
    radii,
    meanRadius: sum / n,
    gateScale: Math.min(1, Math.max(0.52, (sum / n) / 120)),
    edgeInset: EDGE_INSET,
    axes: {},
    gates: [],
  };
  // 물길과 급사면을 피해 남쪽 산록의 실제 마른 통과점을 찾는다. ±40°는 여전히 남쪽 반구이면서
  // 특정 seed의 개울이 정남 전 구간을 따라갈 때 물 위 문을 강제하지 않는 최소 탐색 폭이다.
  // 남문은 도시의 주축이므로 마른 후보들 사이에서는 몇 m 낮은 육축보다 정남 접근성을 우선한다.
  const south = bestGateNear(spec, site, 'south', 0, 0.7, 26, 18);
  const jongno = bestJongnoGates(spec, site, south);
  // 북악 정면 급사면을 억지로 관통하지 않고 좌·우 어깨의 고른 안부까지 탐색한다. 실제 숙정문도
  // 정북 축선보다 산세를 따른 위치가 중요하므로 북쪽 반구 안에서 ±69°를 허용한다.
  // 산문은 평지의 대문보다 작아도 자연스럽다. 먼저 온전한 크기를 찾고, 완만한 자리가 전혀 없는
  // seed에서만 단계적으로 작은 postern을 허용해 지형을 20m 석탑으로 덮는 것보다 산세를 따른다.
  const north = bestGateNear(spec, site, 'north', Math.PI, 1.2, 15, 2,
    [south, jongno.east, jongno.west], [1, 0.88, 0.76, 0.64, 0.56]);
  spec.axes.jongnoZ = jongno.z;
  spec.gates = [south, jongno.east, north, jongno.west];
  validateGateSpacing(spec);

  for (const poly of corePolys) {
    if (!cityWallContainsPolygon(spec, poly, CORE_MARGIN * 0.5)) {
      throw new Error('city wall does not contain its reserved core');
    }
  }
  return spec;
}

export function cityWallAngleInGate(spec, angle) {
  const a = wrapAngle(angle);
  return spec.gates.some((gate) => angularDistance(a, gate.angle) < gate.halfAngle - 1e-10);
}

function wallBreakAngles(spec) {
  const n = spec.radii.length;
  const angles = Array.from({ length: n }, (_, i) => i / n * TAU);
  for (const gate of spec.gates) {
    angles.push(wrapAngle(gate.angle - gate.halfAngle));
    angles.push(wrapAngle(gate.angle + gate.halfAngle));
  }
  angles.sort((a, b) => a - b);
  const unique = angles.filter((a, i) => i === 0 || Math.abs(a - angles[i - 1]) > 1e-9);
  unique.push(TAU);
  return unique;
}

function sharedMiter(a, b) {
  const sum = G.add(a, b);
  if (G.len(sum) < 1e-5) return b;
  const bisector = G.norm(sum);
  const denom = Math.max(1 / MITER_LIMIT, Math.abs(G.dot(bisector, a)));
  return G.mul(bisector, Math.min(MITER_LIMIT, 1 / denom));
}

function footprint(segment, half) {
  return [
    G.add(segment.p0, G.mul(segment.startOffset, -half)),
    G.add(segment.p0, G.mul(segment.startOffset, half)),
    G.add(segment.p1, G.mul(segment.endOffset, half)),
    G.add(segment.p1, G.mul(segment.endOffset, -half)),
  ];
}

// 렌더러와 회귀 게이트가 함께 쓰는 지형 밀착 세그먼트. 인접 chord는 shared miter를 사용해 양쪽
// footprint 정점을 정확히 공유한다. 문 개구부 경계만 end-cap을 남기고 내부 수직 이음판은 렌더에서 생략한다.
export function sampleCityWallSegments(spec, site, {
  thickness = CITY_WALL_DIMENSIONS.thickness,
  maxLength = CITY_WALL_DIMENSIONS.maxSegmentLength,
  maxTerrainError = CITY_WALL_DIMENSIONS.maxTerrainError,
  maxDepth = CITY_WALL_DIMENSIONS.maxSubdivisionDepth,
} = {}) {
  const segments = [];

  const append = (a0, a1, depth) => {
    const midAngle = (a0 + a1) * 0.5;
    if (cityWallAngleInGate(spec, midAngle)) return;
    const p0 = pointOnCityWall(spec, a0), p1 = pointOnCityWall(spec, a1);
    const pm = pointOnCityWall(spec, midAngle);
    const length = G.dist(p0, p1);
    const h0 = terrainMeshHeightAt(site, p0.x, p0.z);
    const h1 = terrainMeshHeightAt(site, p1.x, p1.z);
    const hm = terrainMeshHeightAt(site, pm.x, pm.z);
    const terrainError = Math.abs(hm - (h0 + h1) * 0.5);
    if (depth < maxDepth && (length > maxLength || terrainError > maxTerrainError)) {
      append(a0, midAngle, depth + 1);
      append(midAngle, a1, depth + 1);
      return;
    }

    const tangent = G.norm(G.sub(p1, p0));
    let normal = G.perpR(tangent);
    const radial = G.sub(G.lerp(p0, p1, 0.5), { x: spec.cx, z: spec.cz });
    if (G.dot(normal, radial) < 0) normal = G.mul(normal, -1);
    segments.push({
      angle0: a0, angle1: a1, p0, p1, length, normal,
      thickness,
      startOffset: normal, endOffset: normal,
      joinedStart: false, joinedEnd: false,
      terrainError,
    });
  };

  const angles = wallBreakAngles(spec);
  for (let i = 0; i < angles.length - 1; i++) append(angles[i], angles[i + 1], 0);

  // 결과 배열의 이웃이 같은 angle을 공유할 때만 실제 연속 run이다. 문 구멍을 건너뛴 이웃은 각도가 다르다.
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i], b = segments[i + 1];
    if (Math.abs(a.angle1 - b.angle0) > 1e-9) continue;
    const miter = sharedMiter(a.normal, b.normal);
    a.endOffset = miter; b.startOffset = miter;
    a.joinedEnd = true; b.joinedStart = true;
  }
  // angle 0이 성문 구멍이 아니면 TAU→0도 같은 폐곡선 run이다. 선형 배열 끝이라고 end-cap을 두면
  // 남문이 정남에서 비켜난 씨앗에만 미세한 V 틈이 생긴다.
  if (segments.length > 1 && !cityWallAngleInGate(spec, 0)) {
    const last = segments[segments.length - 1], first = segments[0];
    if (Math.abs(last.angle1 - TAU) <= 1e-9 && Math.abs(first.angle0) <= 1e-9) {
      const miter = sharedMiter(last.normal, first.normal);
      last.endOffset = miter; first.startOffset = miter;
      last.joinedEnd = true; first.joinedStart = true;
    }
  }

  const half = thickness * 0.5;
  for (const segment of segments) {
    segment.corners = footprint(segment, half);
    segment.ground = segment.corners.map((p) => terrainMeshHeightAt(site, p.x, p.z));
  }
  return segments;
}

// renderer의 좁은 여장 footprint도 몸체와 동일한 miter를 재사용한다.
export function cityWallSegmentFootprint(segment, thickness) {
  const corners = footprint(segment, thickness * 0.5);
  return { corners };
}

// 좁은 여장 리본의 밑변을 넓은 몸체 윗면의 양쪽 edge에서 선형보간한다. 여장 footprint에서
// 지형을 다시 샘플하면 폭 차이만큼 높이가 달라져 몸체와 여장 사이에 수평 틈이 생긴다.
export function cityWallSegmentCapProfile(
  segment,
  thickness = (segment.thickness || CITY_WALL_DIMENSIONS.thickness) * 0.7,
) {
  const bodyThickness = segment.thickness || CITY_WALL_DIMENSIONS.thickness;
  const ratio = Math.max(0, Math.min(1, thickness / bodyThickness));
  const innerMix = (1 - ratio) * 0.5;
  const topOffset = CITY_WALL_DIMENSIONS.bodyHeight - CITY_WALL_DIMENSIONS.foundationSink;
  const startY = (t) => segment.ground[0] + (segment.ground[1] - segment.ground[0]) * t + topOffset;
  const endY = (t) => segment.ground[3] + (segment.ground[2] - segment.ground[3]) * t + topOffset;
  return {
    corners: footprint(segment, thickness * 0.5),
    baseY: [
      startY(innerMix),
      startY(1 - innerMix),
      endY(1 - innerMix),
      endY(innerMix),
    ],
  };
}
