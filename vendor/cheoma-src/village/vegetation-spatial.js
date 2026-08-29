import * as G from '../core/math/geom2.js';
import {
  canopyBlocksSolarAccess,
  circleIntersectsPolygon,
  localCanopyBlocksSolarAccess,
  parcelLocalPoint,
  parcelSolarAccessPolygon,
  parcelWorldPoint,
} from './parcel-contract.js';
import { parcelEffectiveRoofBounds } from './house-footprint.js';
import { planParcelFocus } from '../generators/shared/parcel-spatial.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallVegetationBlocked,
} from './citywall-contour.js';
import { STREAM_VEGETATION_BANK_CLEARANCE } from './stream-spatial.js';
import {
  TEMPLE_FOREST_MARGIN,
  TEMPLE_PATH_CLEARANCE,
  templeFootprint,
} from './temple-plan.js';
import { pavilionFootprint } from './pavilion-plan.js';
import {
  auxiliaryLocalFootprint,
  auxiliaryWorldFootprint,
} from './auxiliary-building-plan.js';

// Forest, near scatter, and future yard/guardian planners share this worker-safe
// footprint index. Obstacles are inserted into every grid cell touched by their
// own clearance; a canopy query visits only cells touched by the candidate circle.
// This replaces the old candidate × every-parcel/every-road scan without changing
// the public makeTreeMask(x, z) contract.
const DEFAULT_CELL_SIZE = 24;
const PARCEL_CLEARANCE = 3;
const ROAD_CLEARANCE = 3;
// 주거 focus 카메라가 서는 자리에서 가장 가까운 수관 표면까지의 최소 거리. 사람이 집을 바라보고
// 설 만한 빈 자리 하나에 해당한다. 위쪽으로 키우면 필지마다 숲에 공터가 생겨 원경 캐노피 매스가
// 얇아진다 — 실측으로 10m 는 수묵 모드의 농묵·여백 계약(`check-ink-app`: 상단 밝은 화소 9.3%→7.1%,
// 톤 스팬 98.8→92.9)을 깨뜨렸고 6m 는 통과한다(10.3%/97.2). 그러므로 이 값은 시야 확보의 최소치이며
// 룩 예산의 상한이다.
const FOCUS_EYE_CLEARANCE = 6;

function distToSegmentSquared(x, z, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const length2 = abx * abx + abz * abz;
  if (length2 < 1e-9) return (x - a.x) ** 2 + (z - a.z) ** 2;
  const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / length2));
  const qx = a.x + abx * t, qz = a.z + abz * t;
  return (x - qx) ** 2 + (z - qz) ** 2;
}

function boundsOfPoints(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function expandedBounds(bounds, amount) {
  return {
    minX: bounds.minX - amount,
    maxX: bounds.maxX + amount,
    minZ: bounds.minZ - amount,
    maxZ: bounds.maxZ + amount,
  };
}

function circleBounds(x, z, radius) {
  return { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
}

function solarBounds(parcel) {
  return boundsOfPoints(parcelSolarAccessPolygon(parcel));
}

function shuffled(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// 후면 담과 양 측면을 촘촘히 훑되 앞마당 중앙은 후보로 만들지 않는다. 전체 고정 후보를
// 먼저 섞고 shape로 거르므로 필지 모양에 따라 RNG 소비량이 달라지지 않는다.
export function yardTreeCandidates(parcel, rng) {
  const inset = 1.0;
  const halfW = Math.max(0, parcel.plotW * 0.5 - inset);
  const halfD = Math.max(0, parcel.plotD * 0.5 - inset);
  const back = [-1, -0.72, -0.42, -0.14, 0.14, 0.42, 0.72, 1]
    .map((factor) => ({ x: halfW * factor, z: -halfD }));
  const side = [];
  for (const sign of [-1, 1]) for (const factor of [-0.82, -0.58, -0.34, -0.1, 0.14, 0.38, 0.62, 0.82, 1]) {
    side.push({ x: sign * halfW, z: halfD * factor });
  }
  const poly = parcel.shape?.pts?.length
    ? G.offsetPoly(G.ensureCCW(parcel.shape.pts), -0.9)
    : null;
  return [...shuffled(back, rng), ...shuffled(side, rng)]
    .filter((point) => !poly || G.pointInPoly(point, poly));
}

function circleTouchesRect(point, radius, rect, clearance = 0) {
  const dx = point.x < rect.minX ? rect.minX - point.x : point.x > rect.maxX ? point.x - rect.maxX : 0;
  const dz = point.z < rect.minZ ? rect.minZ - point.z : point.z > rect.maxZ ? point.z - rect.maxZ : 0;
  return Math.hypot(dx, dz) <= radius + clearance;
}

function roofWorldBounds(parcel, rect) {
  return boundsOfPoints([
    parcelWorldPoint(parcel, { x: rect.minX, z: rect.minZ }),
    parcelWorldPoint(parcel, { x: rect.maxX, z: rect.minZ }),
    parcelWorldPoint(parcel, { x: rect.maxX, z: rect.maxZ }),
    parcelWorldPoint(parcel, { x: rect.minX, z: rect.maxZ }),
  ]);
}

// 마당나무처럼 owner 필지 안에 의도적으로 놓이는 수목은 마을 전체 mask 대신 이 좁은
// 계약을 쓴다. 실제 variant 처마, 남측 활동마당, 표준 포커스 시선을 같은 수관 반경으로 검사한다.
export function yardCanopyBlocked(parcel, localPoint, radius) {
  if (localCanopyBlocksSolarAccess(parcel, localPoint, radius)) return true;
  if (circleTouchesRect(localPoint, radius, parcelEffectiveRoofBounds(parcel), 0.35)) return true;
  const auxiliary = auxiliaryLocalFootprint(parcel.auxiliary);
  if (auxiliary.length && circleIntersectsPolygon(localPoint, radius, auxiliary)) return true;
  const focus = planParcelFocus(parcel);
  const camera = parcelLocalPoint(parcel, { x: focus.cameraX, z: focus.cameraZ });
  const target = parcelLocalPoint(parcel, { x: focus.worldX, z: focus.worldZ });
  const dx = camera.x - target.x, dz = camera.z - target.z;
  const distance = Math.hypot(dx, dz);
  const subjectNear = Math.min(distance, Math.max(focus.width, focus.depth) * 0.72);
  const end = distance > 1e-6
    ? { x: target.x + dx / distance * subjectNear, z: target.z + dz / distance * subjectNear }
    : target;
  return G.distToSeg(localPoint, target, end).d <= radius;
}

// Returns a compact query object rather than serializing corridor polygons into
// VillagePlan. Worker and sync paths rebuild the same index from the pure plan.
export function createVegetationSpatial(plan, site, { cellSize = DEFAULT_CELL_SIZE } = {}) {
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
  const columns = new Map();
  const obstacles = [];
  let cellCount = 0;

  const cellAt = (ix, iz, create = false) => {
    let column = columns.get(ix);
    if (!column && create) { column = new Map(); columns.set(ix, column); }
    if (!column) return null;
    let cell = column.get(iz);
    if (!cell && create) { cell = []; column.set(iz, cell); cellCount++; }
    return cell || null;
  };

  const insert = (bounds, blocks, commitOnly = false, yardRelevant = false, yardOnly = false) => {
    if (![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)) return;
    const obstacle = { seenAt: 0, commitOnly, yardRelevant, yardOnly, blocks };
    obstacles.push(obstacle);
    const minX = Math.floor(bounds.minX / size), maxX = Math.floor(bounds.maxX / size);
    const minZ = Math.floor(bounds.minZ / size), maxZ = Math.floor(bounds.maxZ / size);
    for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
      cellAt(ix, iz, true).push(obstacle);
    }
  };

  const palace = plan.features?.palace;
  const vegetationParcels = [
    ...(plan.parcels || []),
    ...(palace?.center ? [palace] : []),
  ];
  for (const parcel of vegetationParcels) {
    if (!parcel?.center) continue;
    // Preserve the established settlement clearing, now expanded by the actual
    // candidate canopy radius at the final placement check.
    const parcelRadius = Math.max(parcel.plotW || 0, parcel.plotD || 0) * 0.7 + PARCEL_CLEARANCE;
    insert(circleBounds(parcel.center.x, parcel.center.z, parcelRadius), (x, z, radius) => {
      const combined = parcelRadius + radius;
      return (x - parcel.center.x) ** 2 + (z - parcel.center.z) ** 2 < combined * combined;
    });

    // Keep the south-facing courtyard and daylight opening clear even beyond the
    // parcel's generic radius. The canonical test lives in parcel-contract.js.
    insert(solarBounds(parcel), (x, z, radius, point) =>
      canopyBlocksSolarAccess(parcel, point, radius), true, true);

    // 일반 forest clearing보다 좁은 실제 처마 footprint. 마당나무 query는 이것만 소비해
    // 자기 필지 안 배치를 허용하면서도 이웃집 처마까지 수관이 닿지 않게 한다.
    const roof = parcelEffectiveRoofBounds(parcel);
    insert(expandedBounds(roofWorldBounds(parcel, roof), 0.35), (x, z, radius, point) =>
      circleTouchesRect(parcelLocalPoint(parcel, point), radius, roof, 0.35), true, true, true);

    // The settlement-wide forest already clears the whole parcel. Yard and
    // neighbouring-yard canopies need the exact independent roof footprint so
    // a crown cannot pass through the physical all-LOD auxiliary layer.
    const auxiliary = auxiliaryWorldFootprint(parcel, parcel.auxiliary);
    if (auxiliary.length) {
      insert(boundsOfPoints(auxiliary), (x, z, radius, point) =>
        circleIntersectsPolygon(point, radius, auxiliary), true, true, true);
    }

    // 주거 근접 focus 카메라가 서는 자리는 숲이 비켜야 한다. 지형·건축 blocker 만 보는 시야 선택기는
    // 수목을 알지 못하므로, 사면 필지에서는 카메라가 그대로 수관 안에 설 수 있다 — 그러면 프레임 전체가
    // 저폴리 캐노피 한 장이 된다(capital/4 p23 실측: 피사체 43m, 가림 나무 6.9m, 오클루더 페이드는
    // 수관 중심이 카메라 뒤/화면 밖이라 발현하지 않는다). 카메라 위치는 `planParcelFocus` 가 주는
    // 순수 plan 파생값이므로 이 배제는 sync/worker 양쪽에서 같은 숲을 만든다.
    const focus = planParcelFocus(parcel);
    if (Number.isFinite(focus.cameraX) && Number.isFinite(focus.cameraZ)) {
      const eye = { x: focus.cameraX, z: focus.cameraZ };
      insert(circleBounds(eye.x, eye.z, FOCUS_EYE_CLEARANCE), (x, z, radius) => {
        const combined = FOCUS_EYE_CLEARANCE + radius;
        return (x - eye.x) ** 2 + (z - eye.z) ** 2 < combined * combined;
      });
    }
  }

  for (const road of (plan.roads || [])) {
    const points = road.pts || [];
    const clearance = (road.width || 0) * 0.5 + ROAD_CLEARANCE;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      insert(expandedBounds(boundsOfPoints([a, b]), clearance), (x, z, radius) => {
        const combined = clearance + radius;
        return distToSegmentSquared(x, z, a, b) < combined * combined;
      });
    }
  }

  if (site.stream?.pts?.length) {
    const clearance = Math.max(0, site.streamHalf || 0) + STREAM_VEGETATION_BANK_CLEARANCE;
    for (let i = 0; i < site.stream.pts.length - 1; i++) {
      const a = site.stream.pts[i], b = site.stream.pts[i + 1];
      insert(expandedBounds(boundsOfPoints([a, b]), clearance), (x, z, radius) => {
        const combined = clearance + radius;
        return distToSegmentSquared(x, z, a, b) < combined * combined;
      });
    }
  }

  for (const field of (plan.paddies || [])) {
    const poly = field.poly || [];
    if (poly.length < 3) continue;
    insert(boundsOfPoints(poly), (x, z, radius, point) => circleIntersectsPolygon(point, radius, poly));
  }

  const temple = plan.features?.temple;
  if (temple && Number.isFinite(temple.x) && Number.isFinite(temple.z)) {
    const footprint = templeFootprint(temple, TEMPLE_FOREST_MARGIN);
    insert(boundsOfPoints(footprint), (x, z, radius, point) =>
      circleIntersectsPolygon(point, radius, footprint));
    for (let index = 0; index < (temple.path?.length || 0) - 1; index++) {
      const a = temple.path[index], b = temple.path[index + 1];
      insert(
        expandedBounds(boundsOfPoints([a, b]), TEMPLE_PATH_CLEARANCE),
        (x, z, radius) => {
          const combined = TEMPLE_PATH_CLEARANCE + radius;
          return distToSegmentSquared(x, z, a, b) < combined * combined;
        },
      );
    }
  }

  const pavilion = plan.features?.pavilion;
  if (pavilion && Number.isFinite(pavilion.x) && Number.isFinite(pavilion.z)) {
    const footprint = pavilionFootprint(pavilion, 1);
    insert(boundsOfPoints(footprint), (x, z, radius, point) =>
      circleIntersectsPolygon(point, radius, footprint));
  }

  // 보호수는 plan 단계에서 이미 위치와 실제 수관 반경이 정해진다. 배경 숲과 근경 산포가
  // 그 자리를 선점하지 않도록 같은 원 footprint를 worker와 sync index에 예약한다.
  for (const guardian of (plan.features?.guardianTrees || [])) {
    if (!Number.isFinite(guardian.x) || !Number.isFinite(guardian.z)) continue;
    const guardianRadius = Math.max(0, guardian.radius || 0);
    insert(circleBounds(guardian.x, guardian.z, guardianRadius), (x, z, radius) => {
      const combined = guardianRadius + radius;
      return (x - guardian.x) ** 2 + (z - guardian.z) ** 2 < combined * combined;
    }, true, true);
  }

  const cityWall = plan.features?.cityWall || null;
  const point = { x: 0, z: 0 };
  let querySerial = 0;
  const query = (x, z, radius, includeCommitOnly, yardQuery = false) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return true;
    const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    point.x = x; point.z = z;
    if (cityWallVegetationBlocked(cityWall, point, {
      corridor: CITY_WALL_DIMENSIONS.vegetationClearance + r,
      gateMargin: CITY_WALL_DIMENSIONS.gateVegetationMargin + r,
      gateApproachMargin: r,
    })) return true;

    querySerial = (querySerial + 1) >>> 0;
    if (querySerial === 0) {
      for (const obstacle of obstacles) obstacle.seenAt = 0;
      querySerial = 1;
    }
    const minX = Math.floor((x - r) / size), maxX = Math.floor((x + r) / size);
    const minZ = Math.floor((z - r) / size), maxZ = Math.floor((z + r) / size);
    for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
      const cell = cellAt(ix, iz);
      if (!cell) continue;
      for (const obstacle of cell) {
        if (obstacle.seenAt === querySerial) continue;
        obstacle.seenAt = querySerial;
        if (yardQuery && !obstacle.yardRelevant) continue;
        if (!yardQuery && obstacle.yardOnly) continue;
        if (!includeCommitOnly && obstacle.commitOnly) continue;
        if (obstacle.blocks(x, z, r, point)) return true;
      }
    }
    return false;
  };
  const blocksAnchor = (x, z) => query(x, z, 0, false);
  const blocksCanopy = (x, z, radius = 0) => query(x, z, radius, true);
  const blocksYardCanopy = (x, z, radius = 0) => query(x, z, radius, true, true);

  return {
    blocksAnchor,
    blocksCanopy,
    blocksYardCanopy,
    stats: Object.freeze({ cellSize: size, cells: cellCount, obstacles: obstacles.length }),
  };
}

export function makeVegetationMask(plan, site, options) {
  const spatial = createVegetationSpatial(plan, site, options);
  // Two arguments retain the historical anchor mask. The new third argument is
  // deliberately the commit phase: all per-candidate RNG has already been drawn,
  // so new solar/guardian rejection cannot re-seed every later tree in the forest.
  function mask(x, z, radius) {
    return arguments.length < 3
      ? spatial.blocksAnchor(x, z)
      : spatial.blocksCanopy(x, z, radius);
  }
  mask.blocksAnchor = spatial.blocksAnchor;
  mask.blocksCanopy = spatial.blocksCanopy;
  mask.spatial = spatial;
  return mask;
}
