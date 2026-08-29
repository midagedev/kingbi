import * as G from '../core/math/geom2.js';

const DEFAULT_CELL_SIZE = 12;
const DEFAULT_EPSILON = 1e-5;

function quantize(value, epsilon) {
  return Math.round(value / epsilon);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function segmentCells(a, b, cellSize, epsilon) {
  // 0/-0 또는 아주 작은 음수가 셀 경계 양쪽으로 갈려 같은 접점을 못 만나는 일을 막는다.
  const minX = Math.floor((Math.min(a.x, b.x) - epsilon) / cellSize);
  const maxX = Math.floor((Math.max(a.x, b.x) + epsilon) / cellSize);
  const minZ = Math.floor((Math.min(a.z, b.z) - epsilon) / cellSize);
  const maxZ = Math.floor((Math.max(a.z, b.z) + epsilon) / cellSize);
  const cells = [];
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) cells.push(`${x}:${z}`);
  }
  return cells;
}

function segmentIntersection(a, b, c, d, epsilon) {
  const hit = G.segIntersect(a, b, c, d);
  if (hit) return hit;
  // segIntersect는 t=-4e-17 같은 수치 오차도 범위 밖으로 본다. 도로 분기는 자식 끝점이
  // 부모 선분 중간에 붙는 T가 대부분이므로 endpoint↔endpoint만 보던 예전 폴백으로는 부족하다.
  const endpointCandidates = [
    { point: a, t: 0, otherA: c, otherB: d, swap: false },
    { point: b, t: 1, otherA: c, otherB: d, swap: false },
    { point: c, t: 0, otherA: a, otherB: b, swap: true },
    { point: d, t: 1, otherA: a, otherB: b, swap: true },
  ];
  for (const candidate of endpointCandidates) {
    const nearest = G.distToSeg(candidate.point, candidate.otherA, candidate.otherB);
    if (nearest.d > epsilon) continue;
    const point = {
      x: (candidate.point.x + nearest.pt.x) * 0.5,
      z: (candidate.point.z + nearest.pt.z) * 0.5,
    };
    return candidate.swap
      ? { ...point, t: nearest.t, u: candidate.t }
      : { ...point, t: candidate.t, u: nearest.t };
  }
  return null;
}

function atRoadEndpoint(road, segment, t, epsilon) {
  return (segment === 0 && t <= epsilon)
    || (segment === road.pts.length - 2 && t >= 1 - epsilon);
}

/**
 * Build serializable, deterministic road-junction data without changing the
 * polylines. A spatial hash keeps the city-scale pass close to linear in the
 * number of road segments instead of comparing every segment pair.
 */
export function buildRoadJunctions(roads, {
  cellSize = DEFAULT_CELL_SIZE,
  epsilon = DEFAULT_EPSILON,
} = {}) {
  const cells = new Map();
  const groups = new Map();

  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    for (let segment = 0; segment < road.pts.length - 1; segment++) {
      const a = road.pts[segment], b = road.pts[segment + 1];
      if (G.dist2(a, b) <= epsilon * epsilon) continue;
      const keys = segmentCells(a, b, cellSize, epsilon);
      const candidates = new Map();
      for (const key of keys) {
        for (const candidate of cells.get(key) || []) {
          candidates.set(`${candidate.roadIndex}:${candidate.segment}`, candidate);
        }
      }

      for (const candidate of candidates.values()) {
        if (candidate.roadIndex === roadIndex) continue;
        const otherRoad = roads[candidate.roadIndex];
        const hit = segmentIntersection(a, b, candidate.a, candidate.b, epsilon);
        if (!hit) continue;
        const pointKey = `${quantize(hit.x, epsilon)}:${quantize(hit.z, epsilon)}`;
        let group = groups.get(pointKey);
        if (!group) {
          group = { x: hit.x, z: hit.z, count: 1, roads: new Map() };
          groups.set(pointKey, group);
        } else {
          group.x = (group.x * group.count + hit.x) / (group.count + 1);
          group.z = (group.z * group.count + hit.z) / (group.count + 1);
          group.count++;
        }
        const occurrences = [
          { road, roadIndex, segment, t: hit.t },
          {
            road: otherRoad,
            roadIndex: candidate.roadIndex,
            segment: candidate.segment,
            t: hit.u,
          },
        ];
        for (const occurrence of occurrences) {
          const previous = group.roads.get(occurrence.road.id);
          const endpoint = atRoadEndpoint(
            occurrence.road,
            occurrence.segment,
            occurrence.t,
            epsilon,
          );
          if (!previous || (endpoint && !previous.endpoint)) {
            group.roads.set(occurrence.road.id, {
              roadId: occurrence.road.id,
              segment: occurrence.segment,
              t: occurrence.t,
              endpoint,
            });
          }
        }
      }

      const indexed = { roadIndex, segment, a, b };
      for (const key of keys) {
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, bucket = []);
        bucket.push(indexed);
      }
    }
  }

  const ordered = [...groups.values()]
    .filter((group) => group.roads.size > 1)
    .sort((a, b) => a.x - b.x || a.z - b.z
      || compareText([...a.roads.keys()].join('|'), [...b.roads.keys()].join('|')));

  return ordered.map((group, index) => {
    const connections = [...group.roads.values()]
      .sort((a, b) => compareText(a.roadId, b.roadId))
      .map(({ endpoint: _endpoint, ...connection }) => connection);
    const hasEndpoint = [...group.roads.values()].some((item) => item.endpoint);
    return {
      id: `junction-${String(index).padStart(3, '0')}`,
      kind: hasEndpoint ? 'connection' : 'crossing',
      point: { x: group.x, z: group.z },
      connections,
    };
  });
}

// Keep forward junction records and road back-references as one transaction.
// Planning passes that append an exterior district road can safely rebuild the
// topology without duplicating the bookkeeping previously embedded in roads.js.
export function attachRoadJunctions(roads, options) {
  for (const road of roads) road.junctionIds = [];
  const junctions = buildRoadJunctions(roads, options);
  const roadById = new Map(roads.map((road) => [road.id, road]));
  for (const junction of junctions) {
    for (const connection of junction.connections) {
      roadById.get(connection.roadId)?.junctionIds.push(junction.id);
    }
  }
  return junctions;
}

export function polylineSelfIntersections(pts, epsilon = DEFAULT_EPSILON) {
  const intersections = [];
  for (let a = 0; a < pts.length - 1; a++) {
    for (let b = a + 2; b < pts.length - 1; b++) {
      const hit = G.segIntersect(pts[a], pts[a + 1], pts[b], pts[b + 1]);
      if (!hit) continue;
      const adjacentClosure = a === 0 && b === pts.length - 2
        && G.dist2(pts[0], pts.at(-1)) <= epsilon * epsilon;
      if (!adjacentClosure
        && hit.t > epsilon && hit.t < 1 - epsilon
        && hit.u > epsilon && hit.u < 1 - epsilon) {
        intersections.push({ a, b, point: { x: hit.x, z: hit.z } });
      }
    }
  }
  return intersections;
}

export function maxPolylineTurn(pts, epsilon = DEFAULT_EPSILON) {
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const incoming = G.sub(pts[i], pts[i - 1]);
    const outgoing = G.sub(pts[i + 1], pts[i]);
    if (G.len(incoming) <= epsilon || G.len(outgoing) <= epsilon) continue;
    const cosine = Math.max(-1, Math.min(1, G.dot(G.norm(incoming), G.norm(outgoing))));
    max = Math.max(max, Math.acos(cosine));
  }
  return max;
}
