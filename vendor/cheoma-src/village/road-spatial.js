import * as G from '../core/math/geom2.js';

// 필지 후보가 가장 가까운 길을 찾거나 다른 길의 회랑을 검사할 때 모든 도로·선분을
// 다시 훑지 않도록 하는 순수 uniform grid. 선분 bbox만 등록하고 query 반경이 닿는 셀만
// 방문하므로 결과는 brute-force와 같고 한양의 반복 비용만 줄어든다.
const DEFAULT_CELL_SIZE = 24;

export function createRoadSpatialIndex(roads, { cellSize = DEFAULT_CELL_SIZE } = {}) {
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
  const columns = new Map();
  const segments = [];
  let cellCount = 0;

  const cellAt = (ix, iz, create = false) => {
    let column = columns.get(ix);
    if (!column && create) { column = new Map(); columns.set(ix, column); }
    if (!column) return null;
    let cell = column.get(iz);
    if (!cell && create) { cell = []; column.set(iz, cell); cellCount++; }
    return cell || null;
  };

  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    for (let segment = 0; segment < road.pts.length - 1; segment++) {
      const a = road.pts[segment], b = road.pts[segment + 1];
      if (G.dist2(a, b) < 1e-12) continue;
      const entry = {
        road,
        roadIndex,
        segment,
        ordinal: segments.length,
        a,
        b,
        seenAt: 0,
      };
      segments.push(entry);
      const minX = Math.floor(Math.min(a.x, b.x) / size);
      const maxX = Math.floor(Math.max(a.x, b.x) / size);
      const minZ = Math.floor(Math.min(a.z, b.z) / size);
      const maxZ = Math.floor(Math.max(a.z, b.z) / size);
      for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
        cellAt(ix, iz, true).push(entry);
      }
    }
  }

  let querySerial = 0;
  const visit = (point, radius, callback) => {
    querySerial = (querySerial + 1) >>> 0;
    if (querySerial === 0) {
      for (const segment of segments) segment.seenAt = 0;
      querySerial = 1;
    }
    const minX = Math.floor((point.x - radius) / size);
    const maxX = Math.floor((point.x + radius) / size);
    const minZ = Math.floor((point.z - radius) / size);
    const maxZ = Math.floor((point.z + radius) / size);
    for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
      const cell = cellAt(ix, iz);
      if (!cell) continue;
      for (const segment of cell) {
        if (segment.seenAt === querySerial) continue;
        segment.seenAt = querySerial;
        if (callback(segment) === false) return false;
      }
    }
    return true;
  };

  const maxHalfWidth = roads.reduce((max, road) => Math.max(max, (road.width || 0) * 0.5), 0);

  function nearest(point, maxDistance) {
    const limit = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : 0;
    let best = { d: Infinity, pt: null, tan: { x: 1, z: 0 }, seg: 0, t: 0, road: null };
    let bestOrdinal = Infinity;
    visit(point, limit, (segment) => {
      const result = G.distToSeg(point, segment.a, segment.b);
      if (result.d > limit) return;
      if (result.d < best.d || (result.d === best.d && segment.ordinal < bestOrdinal)) {
        best = {
          d: result.d,
          pt: result.pt,
          tan: G.norm(G.sub(segment.b, segment.a)),
          seg: segment.segment,
          t: result.t,
          road: segment.road,
        };
        bestOrdinal = segment.ordinal;
      }
    });
    return best;
  }

  function withinRoadClearance(point, ownRoad = null, margin = 0) {
    const extra = Math.max(0, Number.isFinite(margin) ? margin : 0);
    let blocked = false;
    visit(point, maxHalfWidth + extra, (segment) => {
      if (segment.road === ownRoad) return;
      const clearance = (segment.road.width || 0) * 0.5 + extra;
      if (G.distToSeg(point, segment.a, segment.b).d < clearance) {
        blocked = true;
        return false;
      }
    });
    return blocked;
  }

  function intersectsRoadCorridor(poly, margin = 0, onlyRoad = null) {
    if (!poly?.length) return false;
    const bounds = G.boundsOfPts(poly);
    const center = {
      x: (bounds.minX + bounds.maxX) * 0.5,
      z: (bounds.minZ + bounds.maxZ) * 0.5,
    };
    const extra = Math.max(0, Number.isFinite(margin) ? margin : 0);
    const radius = Math.max(bounds.w, bounds.d) * 0.5 + maxHalfWidth + extra;
    let blocked = false;
    visit(center, radius, (segment) => {
      if (onlyRoad && segment.road !== onlyRoad) return;
      const clearance = (segment.road.width || 0) * 0.5 + extra;
      if (G.segmentPolygonDistance(segment.a, segment.b, poly) < clearance) {
        blocked = true;
        return false;
      }
    });
    return blocked;
  }

  return Object.freeze({
    nearest,
    withinRoadClearance,
    intersectsRoadCorridor,
    stats: Object.freeze({ cellSize: size, cells: cellCount, segments: segments.length }),
  });
}
