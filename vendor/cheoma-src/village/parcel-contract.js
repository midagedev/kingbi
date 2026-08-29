import * as G from '../core/math/geom2.js';

// 필지의 좌향·대문 접근·앞마당 일조를 한 곳에서 정의하는 순수 공간 계약.
// 좌표는 마을 공통 규약(+z=남쪽, 필지 로컬 +z=앞)을 따른다. 렌더러나 THREE에
// 의존하지 않아 plan, worker, 식생 배치와 빠른 Node 회귀 검사가 같은 판정을 쓴다.

const PI = Math.PI;
const SOUTH_ARC = PI / 4;             // 길 유도 기본각(jitter 전) 최대 ±45°: 남·남동·남서 군집
const ROAD_INFLUENCE = 0.55;          // 길은 좌향을 유도하되 지세축을 덮지 않는다

export const SOUTH = Object.freeze({ x: 0, z: 1 });

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function wrapAngle(angle) {
  while (angle > PI) angle -= PI * 2;
  while (angle < -PI) angle += PI * 2;
  return angle;
}

export function directionFromFacing(angle) {
  return { x: Math.sin(angle), z: Math.cos(angle) };
}

// 전통마을의 좌향은 남향 선호만으로 고정되지 않고 산·물·열린 들이 만드는 지세축을
// 우선했다. 길을 향한 방향은 그 축 주위의 남동/남서 군집을 고르는 보조 신호로만 쓴다.
// jitter는 호출부의 parcel 전용 RNG가 만든 값이라 후보 실패와 무관하게 결정론적이다.
export function terrainAlignedFacing(roadDir, landformDir = SOUTH, jitter = 0) {
  const road = G.norm(roadDir || landformDir);
  const axis = G.norm(landformDir || SOUTH);
  const axisAngle = Math.atan2(axis.x, axis.z);
  const roadAngle = Math.atan2(road.x, road.z);
  const relative = wrapAngle(roadAngle - axisAngle);
  const guided = clamp(relative * ROAD_INFLUENCE, -SOUTH_ARC, SOUTH_ARC);
  return directionFromFacing(axisAngle + guided + jitter);
}

export function parcelLocalPoint(parcel, point) {
  const dx = point.x - parcel.center.x, dz = point.z - parcel.center.z;
  const front = G.norm(parcel.frontDir || SOUTH);
  const right = { x: front.z, z: -front.x };
  return { x: G.dot({ x: dx, z: dz }, right), z: G.dot({ x: dx, z: dz }, front) };
}

export function parcelWorldPoint(parcel, point) {
  const front = G.norm(parcel.frontDir || SOUTH);
  const right = { x: front.z, z: -front.x };
  return {
    x: parcel.center.x + right.x * point.x + front.x * point.z,
    z: parcel.center.z + right.z * point.x + front.z * point.z,
  };
}

export function parcelWorldPolygon(parcel) {
  const points = parcel.shape?.pts;
  if (!points?.length) return [];
  return points.map((point) => parcelWorldPoint(parcel, point));
}

export function circleIntersectsPolygon(point, radius, polygon) {
  if (!polygon?.length) return false;
  if (G.pointInPoly(point, polygon)) return true;
  const limit = Math.max(0, radius);
  for (let i = 0; i < polygon.length; i++) {
    if (G.distToSeg(point, polygon[i], polygon[(i + 1) % polygon.length]).d <= limit) return true;
  }
  return false;
}

// 집 원점의 기본 위치. fit 전에는 역사적으로 써 온 뒤안 배치를 유지하고, fit 뒤에는
// house-footprint.js가 저장한 하나의 로컬 이동값을 모든 표현(FULL/MID/FAR)이 읽는다.
// `preferred*`를 별도로 둔 것은 fit을 여러 번 실행해도 이전 결과를 입력으로 삼지 않게 하기 위함이다.
export function preferredParcelHouseTranslation(parcel) {
  const inset = parcel.kind === 'giwa' ? 5.2 : 3.4;
  return {
    x: 0,
    z: -(parcel.plotD || 10) * 0.5 + inset * (parcel.structureScale || 1),
  };
}

export function parcelHouseTranslation(parcel) {
  const local = parcel.houseLocal;
  if (Number.isFinite(local?.x) && Number.isFinite(local?.z)) {
    return { x: local.x, z: local.z };
  }
  return preferredParcelHouseTranslation(parcel);
}

// 오래된 소비자가 z 한 축만 읽는 동안의 호환 계약. 새 공간 코드는 반드시
// parcelHouseTranslation()을 사용해 부정형 필지에서 생기는 좌우 보정도 보존한다.
export function parcelHouseBack(parcel) {
  return parcelHouseTranslation(parcel).z;
}

export function rectangularParcelShape(plotW, plotD) {
  const halfW = plotW * 0.5, halfD = plotD * 0.5;
  return {
    pts: [
      { x: halfW, z: halfD }, { x: -halfW, z: halfD },
      { x: -halfW, z: -halfD }, { x: halfW, z: -halfD },
    ],
    roles: ['front', 'left', 'back', 'right'],
  };
}

// 일반 주거의 앞마당 중앙은 작업·접객·의례와 채광을 위해 비워 둔다. corridor는
// 본채 앞에서 대문을 지나 필지 밖 남측 수관까지 이어진다. 수목 판정은 아래의 원-사각
// 거리 검사로 canopy 반경까지 포함하므로 trunk만 비우고 가지가 다시 덮는 오류가 없다.
export function parcelSolarAccess(parcel) {
  const plotW = parcel.plotW || 10, plotD = parcel.plotD || 10;
  const localStart = -plotD * 0.12;
  const localEnd = plotD * 0.5 + Math.max(9, plotW * 0.52);
  return {
    localStart,
    localEnd,
    halfWidth: Math.max(3.1, plotW * 0.31),
  };
}

export function parcelSolarAccessPolygon(parcel) {
  const corridor = parcel.solarAccess || parcelSolarAccess(parcel);
  return [
    parcelWorldPoint(parcel, { x: -corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(parcel, { x: corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(parcel, { x: corridor.halfWidth, z: corridor.localEnd }),
    parcelWorldPoint(parcel, { x: -corridor.halfWidth, z: corridor.localEnd }),
  ];
}

export function localCanopyBlocksSolarAccess(parcel, point, radius = 0) {
  const corridor = parcel.solarAccess || parcelSolarAccess(parcel);
  const dx = Math.max(0, Math.abs(point.x) - corridor.halfWidth);
  const dz = point.z < corridor.localStart
    ? corridor.localStart - point.z
    : point.z > corridor.localEnd ? point.z - corridor.localEnd : 0;
  return Math.hypot(dx, dz) <= Math.max(0, radius);
}

export function canopyBlocksSolarAccess(parcel, point, radius = 0) {
  return localCanopyBlocksSolarAccess(parcel, parcelLocalPoint(parcel, point), radius);
}

// 대문과 자신을 낳은 길의 접점을 plan 데이터에 남긴다. 이를 실제 보행 path로 가장하지
// 않는다. 필지 사이의 충돌 없는 고샅 경로는 별도의 topology 문제이며 직선 하나를 저장하면
// 담과 이웃집을 관통하기 쉽다. 이 계약은 좌향·접근 거리의 검증 가능한 최소 사실만 보존한다.
// 최대 tile gate 반폭(1.5m) + 문기둥/모서리 여유(0.2m). wall builder와 같은 값이라
// 렌더 단계에서 gate center를 다시 움직이지 않는다.
const GATE_CORNER_CLEARANCE = 1.7;
const MIN_GATE_EDGE_LENGTH = GATE_CORNER_CLEARANCE * 2 + 0.4;

function nearestGateEdge(parcel, roadPoint) {
  const local = parcel.shape?.pts || [];
  const world = parcel.poly || parcelWorldPolygon(parcel);
  const lengths = world.map((point, edge) => G.dist(point, world[(edge + 1) % world.length]));
  const hasFullGateEdge = lengths.some((length) => length >= MIN_GATE_EDGE_LENGTH);
  let best = null;
  for (let edge = 0; edge < world.length; edge++) {
    const a = world[edge], b = world[(edge + 1) % world.length];
    const length = lengths[edge];
    if (length <= 1e-6) continue;
    if (hasFullGateEdge && length < MIN_GATE_EDGE_LENGTH) continue;
    const projected = G.distToSeg(roadPoint, a, b);
    const insetT = Math.min(0.45, GATE_CORNER_CLEARANCE / length);
    const t = clamp(projected.t, insetT, 1 - insetT);
    const gatePoint = G.lerp(a, b, t);
    const distance = G.dist(gatePoint, roadPoint);
    if (!best || distance < best.distance - 1e-9
      || (Math.abs(distance - best.distance) <= 1e-9 && edge < best.gateEdge)) {
      best = {
        gateEdge: edge,
        gateT: t,
        gateRole: parcel.shape?.roles?.[edge] || null,
        gatePoint,
        gateLocalPoint: local.length ? G.lerp(local[edge], local[(edge + 1) % local.length], t) : null,
        distance,
      };
    }
  }
  return best;
}

export function parcelRoadAccess(parcel, roadId, roadPoint) {
  if (!roadId || !roadPoint) return null;
  const gate = nearestGateEdge(parcel, roadPoint);
  if (!gate) return null;
  return { roadId, roadPoint: { ...roadPoint }, ...gate };
}

export function attachParcelSpatialContract(parcel, roadId = null, roadPoint = null) {
  parcel.poly = parcelWorldPolygon(parcel);
  parcel.solarAccess = parcelSolarAccess(parcel);
  parcel.access = parcelRoadAccess(parcel, roadId, roadPoint);
  return parcel;
}
