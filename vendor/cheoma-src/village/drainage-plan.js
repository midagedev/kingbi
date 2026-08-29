import { deepFreeze } from '../core/stable-seed.js';
import { hashString, makeRng } from '../rng.js';
import * as G from '../core/math/geom2.js';
import { terrainMeshHeightAt } from './terrain-grid.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { streamClearanceAt } from './stream-spatial.js';

export const DRAINAGE_PLAN_SCHEMA_VERSION = 1;

// Product dimensions in world metres. This first version does not cut the shared
// terrain mesh: its visible bed sits just above the exact triangulated surface and
// shallow physical banks form the readable groove. The bounded upstream lift is
// only enough to bridge small grid undulations while keeping a downhill bed.
//
// Gate-crossing slab count, size, thickness, and deck height are plan-owned
// product choices for absolute visual authenticity (issue #217 / W4-2 residual).
// They are NOT historical measured dimensions — docs/drainage.md §2.4 / §3.4.
export const DRAINAGE_PLAN_LIMITS = deepFreeze({
  sampleSpacing: 1.0,
  shoulder: 0.22,
  width: 0.48,
  bedWidth: 0.14,
  depth: 0.04,
  bedClearance: 0.012,
  maxBedLift: 0.025,
  minimumGrade: 0.001,
  minimumOutletDrop: 0.05,
  obstacleClearance: 0.1,
  streamClearance: 0.3,
  minimumRunLength: 4.5,
  maxRunPoints: 96,
  maxRuns: 512,
  maxRunsPerRoadSide: 8,
  maxCrossings: 400,
  crossingSpan: 0.82,
  crossingWidth: 1.35,
  // Blockier than the retired 0.10 m plate so stones read as sunk mass, not
  // floating thin decks. Range is seed-local per slab; envelope thickness is max.
  // Capped so the stone may hang into the open channel without sinking far below
  // the visible bed into solid terrain (product bound, not a measured standard).
  crossingThicknessMin: 0.12,
  crossingThicknessMax: 0.17,
  // Nominal deck top sits just above the channel lip. Per-slab top jitter is
  // plan-owned so the renderer cannot invent a second landing plane.
  crossingLift: 0.006,
  crossingTopJitter: 0.008,
  // Stepping stones may occupy the open ditch volume; refuse only bottoms that
  // dig far under the bed plane into the shared terrain body.
  crossingBedEmbedMax: 0.05,
  crossingSlabCountMin: 2,
  crossingSlabCountMax: 3,
  crossingGapMax: 0.02,
});

const HANYANG_LEVELS = new Set(['daero', 'jungno', 'soro']);
const CAPITAL_LEVELS = new Set(['daero', 'jungno']);
const EPSILON = 1e-8;

const finitePoint = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.z);
const compareText = (a, b) => String(a).localeCompare(String(b));

function cleanPolyline(points) {
  const clean = [];
  for (const point of points || []) {
    if (!finitePoint(point)) continue;
    const copy = { x: point.x, z: point.z };
    if (!clean.length || G.dist2(clean.at(-1), copy) > EPSILON * EPSILON) clean.push(copy);
  }
  return clean;
}

function offsetPolyline(points, offset) {
  if (points.length < 2) return [];
  const tangents = [];
  for (let index = 0; index < points.length - 1; index++) {
    tangents.push(G.norm(G.sub(points[index + 1], points[index])));
  }
  return points.map((point, index) => {
    if (index === 0) return G.add(point, G.mul(G.perpL(tangents[0]), offset));
    if (index === points.length - 1) {
      return G.add(point, G.mul(G.perpL(tangents.at(-1)), offset));
    }
    const previousNormal = G.perpL(tangents[index - 1]);
    const nextNormal = G.perpL(tangents[index]);
    const bisector = G.norm(G.add(previousNormal, nextNormal));
    const denominator = Math.max(0.58, G.dot(bisector, previousNormal));
    return G.add(point, G.mul(bisector, offset / denominator));
  });
}

function samplePolyline(points, spacing) {
  if (points.length < 2) return [];
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative.at(-1) + G.dist(points[index - 1], points[index]));
  }
  const total = cumulative.at(-1);
  if (total < EPSILON) return [];
  const distances = [];
  for (let distance = 0; distance < total; distance += spacing) distances.push(distance);
  distances.push(total);
  const samples = [];
  let segment = 0;
  for (const distance of distances) {
    while (segment < points.length - 2 && cumulative[segment + 1] < distance) segment++;
    const length = cumulative[segment + 1] - cumulative[segment];
    const t = length > EPSILON ? (distance - cumulative[segment]) / length : 0;
    samples.push({ ...G.lerp(points[segment], points[segment + 1], t), sourceS: distance });
  }
  return samples;
}

function polygonIndex(polygons, margin) {
  const size = 24;
  const cells = new Map();
  const records = [];
  const key = (x, z) => `${x}:${z}`;
  for (const polygon of polygons) {
    const poly = (polygon || []).filter(finitePoint).map((point) => ({ x: point.x, z: point.z }));
    if (poly.length < 3) continue;
    const bounds = G.boundsOfPts(poly);
    const record = { poly, ordinal: records.length };
    records.push(record);
    const minX = Math.floor((bounds.minX - margin) / size);
    const maxX = Math.floor((bounds.maxX + margin) / size);
    const minZ = Math.floor((bounds.minZ - margin) / size);
    const maxZ = Math.floor((bounds.maxZ + margin) / size);
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const cellKey = key(x, z);
      let cell = cells.get(cellKey);
      if (!cell) cells.set(cellKey, cell = []);
      cell.push(record);
    }
  }
  let query = 0;
  const seen = new Uint32Array(records.length);
  return {
    blocksSegment(a, b) {
      query = (query + 1) >>> 0;
      if (query === 0) {
        seen.fill(0);
        query = 1;
      }
      const minX = Math.floor((Math.min(a.x, b.x) - margin) / size);
      const maxX = Math.floor((Math.max(a.x, b.x) + margin) / size);
      const minZ = Math.floor((Math.min(a.z, b.z) - margin) / size);
      const maxZ = Math.floor((Math.max(a.z, b.z) + margin) / size);
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        for (const record of cells.get(key(x, z)) || []) {
          if (seen[record.ordinal] === query) continue;
          seen[record.ordinal] = query;
          if (G.segmentPolygonDistance(a, b, record.poly) < margin) return true;
        }
      }
      return false;
    },
  };
}

function drainageSides(scale, road) {
  if (scale === 'hanyang' && HANYANG_LEVELS.has(road.level)) return [-1, 1];
  if (scale === 'capital' && CAPITAL_LEVELS.has(road.level)) return [-1, 1];
  return [];
}

function fitVisibleBed(points) {
  if (points.length < 2) return null;
  const first = points[0], last = points.at(-1);
  const flowDirection = last.terrainY < first.terrainY ? 1 : -1;
  const ordered = flowDirection === 1 ? points : [...points].reverse();
  const outletDrop = ordered[0].terrainY - ordered.at(-1).terrainY;
  if (outletDrop < Math.max(
    DRAINAGE_PLAN_LIMITS.minimumOutletDrop,
    DRAINAGE_PLAN_LIMITS.minimumGrade * G.polylineLength(ordered),
  )) return null;

  const bed = new Array(ordered.length);
  bed[ordered.length - 1] = ordered.at(-1).terrainY + DRAINAGE_PLAN_LIMITS.bedClearance;
  for (let index = ordered.length - 2; index >= 0; index--) {
    const distance = G.dist(ordered[index], ordered[index + 1]);
    const minimum = ordered[index].terrainY + DRAINAGE_PLAN_LIMITS.bedClearance;
    bed[index] = Math.max(minimum,
      bed[index + 1] + DRAINAGE_PLAN_LIMITS.minimumGrade * distance);
    if (bed[index] - minimum > DRAINAGE_PLAN_LIMITS.maxBedLift + EPSILON) return null;
  }
  const worldOrderBed = flowDirection === 1 ? bed : bed.reverse();
  return { flowDirection, bed: worldOrderBed };
}

function splitHydrologicRuns(points) {
  const runs = [];
  let cursor = 0;
  while (cursor < points.length - 1) {
    let end = Math.min(points.length, cursor + DRAINAGE_PLAN_LIMITS.maxRunPoints);
    let fitted = null;
    while (end - cursor >= 2) {
      const candidate = points.slice(cursor, end);
      if (G.polylineLength(candidate) >= DRAINAGE_PLAN_LIMITS.minimumRunLength) {
        fitted = fitVisibleBed(candidate);
        if (fitted) {
          runs.push({ points: candidate, ...fitted });
          // Consecutive bounded records share one endpoint so the physical
          // channel has no one-sample hole at maxRunPoints boundaries.
          cursor = end - 1;
          break;
        }
      }
      end--;
    }
    if (!fitted) cursor++;
  }
  return runs;
}

function candidateSequences(road, side, site, roadSpatial, obstacles) {
  const width = DRAINAGE_PLAN_LIMITS.width;
  const offset = road.width * 0.5 + DRAINAGE_PLAN_LIMITS.shoulder + width * 0.5;
  const samples = samplePolyline(
    offsetPolyline(cleanPolyline(road.pts), offset * side),
    DRAINAGE_PLAN_LIMITS.sampleSpacing,
  );
  if (samples.length < 2) return [];
  const ownClearance = road.width * 0.5 + DRAINAGE_PLAN_LIMITS.shoulder + width * 0.5;
  const pointValid = (point) => {
    if (G.distToPolyline(point, road.pts).d < ownClearance - 1e-5) return false;
    if (roadSpatial.withinRoadClearance(
      point,
      road,
      width * 0.5 + DRAINAGE_PLAN_LIMITS.obstacleClearance,
    )) return false;
    if (streamClearanceAt(site, point)
      < width * 0.5 + DRAINAGE_PLAN_LIMITS.streamClearance) return false;
    return !obstacles.blocksSegment(point, point);
  };
  const segmentValid = (a, b) => {
    const midpoint = G.lerp(a, b, 0.5);
    return pointValid(midpoint) && !obstacles.blocksSegment(a, b);
  };
  const sequences = [];
  let current = [];
  for (const point of samples) {
    const valid = pointValid(point) && (!current.length || segmentValid(current.at(-1), point));
    if (!valid) {
      if (current.length >= 2) sequences.push(current);
      current = [];
      continue;
    }
    current.push({
      x: point.x,
      z: point.z,
      terrainY: terrainMeshHeightAt(site, point.x, point.z),
    });
  }
  if (current.length >= 2) sequences.push(current);
  return sequences;
}

function makeRoadSideRuns(road, side, site, roadSpatial, obstacles) {
  const raw = candidateSequences(road, side, site, roadSpatial, obstacles);
  const fitted = raw.flatMap(splitHydrologicRuns)
    .slice(0, DRAINAGE_PLAN_LIMITS.maxRunsPerRoadSide);
  return fitted.map((run, runIndex) => {
    let s = 0;
    const points = run.points.map((point, index) => {
      if (index) s += G.dist(run.points[index - 1], point);
      return {
        x: point.x,
        y: run.bed[index],
        z: point.z,
        surfaceY: point.terrainY,
        s,
        depth: DRAINAGE_PLAN_LIMITS.depth,
      };
    });
    return {
      id: `drain:${road.id}:${side < 0 ? 'right' : 'left'}:${String(runIndex).padStart(2, '0')}`,
      roadId: road.id,
      roadLevel: road.level,
      side,
      runIndex,
      width: DRAINAGE_PLAN_LIMITS.width,
      bedWidth: DRAINAGE_PLAN_LIMITS.bedWidth,
      length: s,
      flowDirection: run.flowDirection,
      points,
    };
  });
}

function intersectionWithRun(gatePoint, roadPoint, run) {
  let best = null;
  for (let index = 0; index < run.points.length - 1; index++) {
    const a = run.points[index], b = run.points[index + 1];
    const hit = G.segIntersect(gatePoint, roadPoint, a, b);
    if (!hit) continue;
    const distance = G.dist(gatePoint, hit);
    if (!best || distance < best.distance) best = {
      x: hit.x,
      z: hit.z,
      segment: index,
      t: hit.u,
      distance,
    };
  }
  return best;
}

/**
 * Plan 2–3 seed-local stepping stones inside the gate-crossing envelope.
 *
 * Count, individual span/width/thickness, lateral offset, and top seating are
 * product-tuned for absolute visual authenticity (not historical measures).
 * Uses a local mulberry stream from the crossing id — never Math.random — so
 * worker/sync stay byte-stable. The renderer only shapes presentation
 * (natural-stone silhouette, mottle).
 */
function planCrossingSlabs(crossingId, envelopeSpan, envelopeWidth) {
  const rng = makeRng(hashString(`drainage-crossing|${crossingId}`));
  // ~1/3 of crossings get two stones; the rest three. Product sparseness only.
  const count = rng() < 0.34
    ? DRAINAGE_PLAN_LIMITS.crossingSlabCountMin
    : DRAINAGE_PLAN_LIMITS.crossingSlabCountMax;
  const gap = Math.min(DRAINAGE_PLAN_LIMITS.crossingGapMax, envelopeSpan * 0.025);
  const usableSpan = envelopeSpan - gap * (count - 1);
  if (usableSpan <= EPSILON) {
    throw new RangeError(`${crossingId} span is too short for planned slabs`);
  }
  // Uneven weights so one stone is clearly larger — equal thirds read as a
  // modern precast deck (authenticity §7.5b W4-2 residual).
  const weights = Array.from(
    { length: count },
    () => 0.45 + rng() * 1.15,
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const fullWidthIndex = Math.floor(rng() * count);
  let cursor = -envelopeSpan * 0.5;
  const slabs = [];
  for (let index = 0; index < count; index++) {
    const span = index === count - 1
      ? envelopeSpan * 0.5 - cursor
      : usableSpan * weights[index] / weightTotal;
    // Dominant stone nearly fills the lateral envelope; companions are narrower.
    const widthScale = index === fullWidthIndex
      ? 0.92 + rng() * 0.08
      : 0.62 + rng() * 0.32;
    const width = envelopeWidth * widthScale;
    const xFreedom = Math.max(0, (envelopeWidth - width) * 0.5);
    const x = index === fullWidthIndex
      ? (rng() * 2 - 1) * xFreedom * 0.4
      : (rng() * 2 - 1) * xFreedom;
    const thickness = DRAINAGE_PLAN_LIMITS.crossingThicknessMin
      + rng() * (DRAINAGE_PLAN_LIMITS.crossingThicknessMax
        - DRAINAGE_PLAN_LIMITS.crossingThicknessMin);
    const top = (rng() * 2 - 1) * DRAINAGE_PLAN_LIMITS.crossingTopJitter;
    slabs.push({
      x,
      z: cursor + span * 0.5,
      span,
      width,
      thickness,
      top,
    });
    cursor += span + gap;
  }
  return slabs;
}

function planCrossings(parcels, runs, site) {
  const runsByRoad = new Map();
  for (const run of runs) {
    let list = runsByRoad.get(run.roadId);
    if (!list) runsByRoad.set(run.roadId, list = []);
    list.push(run);
  }
  const crossings = [];
  const ordered = parcels.slice().sort((a, b) => compareText(a?.id, b?.id));
  for (const parcel of ordered) {
    if (crossings.length >= DRAINAGE_PLAN_LIMITS.maxCrossings) break;
    const access = parcel?.access;
    if (!parcel?.id || !finitePoint(access?.gatePoint) || !finitePoint(access?.roadPoint)) continue;
    if (G.dist(access.gatePoint, access.roadPoint) <= DRAINAGE_PLAN_LIMITS.crossingSpan) continue;
    let selected = null;
    for (const run of runsByRoad.get(access.roadId) || []) {
      const hit = intersectionWithRun(access.gatePoint, access.roadPoint, run);
      if (hit && (!selected || hit.distance < selected.hit.distance)) selected = { run, hit };
    }
    if (!selected) continue;
    const axis = G.norm(G.sub(access.roadPoint, access.gatePoint));
    const halfSpan = DRAINAGE_PLAN_LIMITS.crossingSpan * 0.5;
    if (selected.hit.distance <= halfSpan
      || access.distance - selected.hit.distance <= halfSpan) continue;
    const center = { x: selected.hit.x, z: selected.hit.z };
    const runA = selected.run.points[selected.hit.segment];
    const runB = selected.run.points[selected.hit.segment + 1];
    const bedY = runA.y + (runB.y - runA.y) * selected.hit.t;
    const deckY = bedY + DRAINAGE_PLAN_LIMITS.depth + DRAINAGE_PLAN_LIMITS.crossingLift;
    const id = `crossing:${parcel.id}`;
    const span = DRAINAGE_PLAN_LIMITS.crossingSpan;
    const width = DRAINAGE_PLAN_LIMITS.crossingWidth;
    const slabs = planCrossingSlabs(id, span, width);
    // Envelope thickness is the tallest planned stone — collision/export consumers
    // that only read the top-level field still get a safe outer bound.
    const thickness = slabs.reduce(
      (max, slab) => Math.max(max, slab.thickness),
      DRAINAGE_PLAN_LIMITS.crossingThicknessMin,
    );
    crossings.push({
      id,
      parcelId: parcel.id,
      roadId: access.roadId,
      runId: selected.run.id,
      kind: 'stone-slab',
      gatePoint: { x: access.gatePoint.x, z: access.gatePoint.z },
      roadPoint: { x: access.roadPoint.x, z: access.roadPoint.z },
      center: { x: center.x, y: deckY, z: center.z },
      yaw: Math.atan2(axis.x, axis.z),
      span,
      width,
      thickness,
      slabs,
    });
  }
  return crossings;
}

/**
 * Plans bounded physical roadside drainage without consuming plan RNG.
 *
 * Ordinary rural settlements intentionally emit no v1 drainage. Capital roads
 * are limited to one successful side per daero/jungno, while Hanyang's planned
 * daero/jungno/soro may retain both sides. Every surviving run has a real lower
 * endpoint, avoids existing spatial reservations, and preserves one immutable
 * world-space record for renderer, worker, and external-generator consumers.
 */
export function planRoadsideDrainage({
  roads = [],
  parcels = [],
  site,
  productionPolygons = [],
} = {}) {
  if (!site || typeof site !== 'object' || typeof site.heightAt !== 'function') {
    throw new TypeError('roadside drainage requires a site with heightAt');
  }
  const roadList = Array.isArray(roads) ? roads.filter((road) => (
    typeof road?.id === 'string'
    && Number.isFinite(road.width)
    && road.width > 0
    && cleanPolyline(road.pts).length >= 2
  )).slice().sort((a, b) => compareText(a.id, b.id)) : [];
  const parcelList = Array.isArray(parcels) ? parcels : [];
  const production = Array.isArray(productionPolygons) ? productionPolygons : [];
  const obstacleMargin = DRAINAGE_PLAN_LIMITS.width * 0.5
    + DRAINAGE_PLAN_LIMITS.obstacleClearance;
  const obstacles = polygonIndex([
    ...parcelList.map((parcel) => parcel?.poly),
    ...production.map((item) => item?.poly || item),
  ], obstacleMargin);
  const roadSpatial = createRoadSpatialIndex(roadList);

  const runs = [];
  for (const road of roadList) {
    const candidates = drainageSides(site.scale, road).map((side) => ({
      side,
      runs: makeRoadSideRuns(road, side, site, roadSpatial, obstacles),
    }));
    const selected = site.scale === 'capital'
      ? candidates.sort((a, b) => (
        b.runs.reduce((sum, run) => sum + run.length, 0)
        - a.runs.reduce((sum, run) => sum + run.length, 0)
        || b.side - a.side
      )).slice(0, 1)
      : candidates;
    for (const candidate of selected) {
      for (const run of candidate.runs) {
        if (runs.length >= DRAINAGE_PLAN_LIMITS.maxRuns) break;
        runs.push(run);
      }
    }
    if (runs.length >= DRAINAGE_PLAN_LIMITS.maxRuns) break;
  }
  const crossings = planCrossings(parcelList, runs, site);
  return deepFreeze({
    schema: DRAINAGE_PLAN_SCHEMA_VERSION,
    frame: {
      space: 'world',
      yDatum: 'absolute-visible-bed',
      pointOrder: 'road-start-to-end',
      side: '+1-left-of-road-tangent',
    },
    runs,
    crossings,
  });
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export function validateRoadsideDrainagePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('roadside drainage plan must be an object');
  if (plan.schema !== DRAINAGE_PLAN_SCHEMA_VERSION) {
    throw new RangeError(`roadside drainage schema must be ${DRAINAGE_PLAN_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(plan.runs) || !Array.isArray(plan.crossings)) {
    throw new TypeError('roadside drainage runs and crossings must be arrays');
  }
  if (plan.frame?.space !== 'world'
    || plan.frame?.yDatum !== 'absolute-visible-bed'
    || plan.frame?.pointOrder !== 'road-start-to-end'
    || plan.frame?.side !== '+1-left-of-road-tangent') {
    throw new RangeError('roadside drainage coordinate frame is unsupported');
  }
  if (plan.runs.length > DRAINAGE_PLAN_LIMITS.maxRuns
    || plan.crossings.length > DRAINAGE_PLAN_LIMITS.maxCrossings) {
    throw new RangeError('roadside drainage record count exceeds plan limits');
  }
  const runIds = new Set();
  const runById = new Map();
  const sideCounts = new Map();
  for (const run of plan.runs) {
    if (typeof run.id !== 'string' || !run.id || runIds.has(run.id)) {
      throw new RangeError('roadside drainage runs require unique stable IDs');
    }
    runIds.add(run.id);
    runById.set(run.id, run);
    const sideKey = `${run.roadId}|${run.side}`;
    sideCounts.set(sideKey, (sideCounts.get(sideKey) || 0) + 1);
    if (sideCounts.get(sideKey) > DRAINAGE_PLAN_LIMITS.maxRunsPerRoadSide) {
      throw new RangeError(`${run.roadId} side exceeds its run cap`);
    }
    if (run.side !== -1 && run.side !== 1) throw new RangeError(`${run.id} has invalid side`);
    if (run.flowDirection !== -1 && run.flowDirection !== 1) {
      throw new RangeError(`${run.id} has invalid flowDirection`);
    }
    if (run.width !== DRAINAGE_PLAN_LIMITS.width
      || run.bedWidth !== DRAINAGE_PLAN_LIMITS.bedWidth) {
      throw new RangeError(`${run.id} has an unsupported section`);
    }
    if (!Array.isArray(run.points) || run.points.length < 2
      || run.points.length > DRAINAGE_PLAN_LIMITS.maxRunPoints) {
      throw new RangeError(`${run.id} has an invalid point count`);
    }
    let length = 0;
    for (let index = 0; index < run.points.length; index++) {
      const point = run.points[index];
      finite(point.x, `${run.id} point.x`);
      finite(point.y, `${run.id} point.y`);
      finite(point.z, `${run.id} point.z`);
      finite(point.surfaceY, `${run.id} point.surfaceY`);
      finite(point.s, `${run.id} point.s`);
      if (point.depth !== DRAINAGE_PLAN_LIMITS.depth) {
        throw new RangeError(`${run.id} has an unsupported depth`);
      }
      const lift = point.y - point.surfaceY;
      if (lift + EPSILON < DRAINAGE_PLAN_LIMITS.bedClearance
        || lift > DRAINAGE_PLAN_LIMITS.bedClearance
          + DRAINAGE_PLAN_LIMITS.maxBedLift + EPSILON) {
        throw new RangeError(`${run.id} has an unsupported terrain lift`);
      }
      if (index) {
        length += G.dist(run.points[index - 1], point);
        if (Math.abs(point.s - length) > 1e-7) throw new RangeError(`${run.id} has invalid arclength`);
        const upstream = run.flowDirection === 1 ? run.points[index - 1] : point;
        const downstream = run.flowDirection === 1 ? point : run.points[index - 1];
        const drop = upstream.y - downstream.y;
        const minimum = G.dist(upstream, downstream) * DRAINAGE_PLAN_LIMITS.minimumGrade;
        if (drop + 1e-7 < minimum) throw new RangeError(`${run.id} does not flow downhill`);
      } else if (Math.abs(point.s) > EPSILON) {
        throw new RangeError(`${run.id} must start at s=0`);
      }
    }
    if (Math.abs(run.length - length) > 1e-7
      || length < DRAINAGE_PLAN_LIMITS.minimumRunLength) {
      throw new RangeError(`${run.id} has invalid length`);
    }
  }
  const crossingIds = new Set();
  for (const crossing of plan.crossings) {
    if (typeof crossing.id !== 'string' || !crossing.id || crossingIds.has(crossing.id)) {
      throw new RangeError('roadside crossings require unique stable IDs');
    }
    crossingIds.add(crossing.id);
    if (!runIds.has(crossing.runId) || crossing.kind !== 'stone-slab') {
      throw new RangeError(`${crossing.id} references an invalid run or kind`);
    }
    if (!finitePoint(crossing.gatePoint) || !finitePoint(crossing.roadPoint)
      || !finitePoint(crossing.center) || !Number.isFinite(crossing.center.y)) {
      throw new TypeError(`${crossing.id} has invalid points`);
    }
    const axis = G.norm(G.sub(crossing.roadPoint, crossing.gatePoint));
    const expectedYaw = Math.atan2(axis.x, axis.z);
    if (Math.abs(crossing.yaw - expectedYaw) > 1e-9
      || G.distToSeg(crossing.center, crossing.gatePoint, crossing.roadPoint).d > 1e-7) {
      throw new RangeError(`${crossing.id} is not aligned to parcel access`);
    }
    const run = runById.get(crossing.runId);
    const runHit = G.distToPolyline(crossing.center, run.points);
    const runA = run.points[runHit.seg], runB = run.points[runHit.seg + 1];
    const expectedDeckY = runA.y + (runB.y - runA.y) * runHit.t
      + DRAINAGE_PLAN_LIMITS.depth + DRAINAGE_PLAN_LIMITS.crossingLift;
    if (runHit.d > 1e-7 || Math.abs(crossing.center.y - expectedDeckY) > 1e-7) {
      throw new RangeError(`${crossing.id} does not clear its referenced ditch`);
    }
    if (crossing.span !== DRAINAGE_PLAN_LIMITS.crossingSpan
      || crossing.width !== DRAINAGE_PLAN_LIMITS.crossingWidth) {
      throw new RangeError(`${crossing.id} has an unsupported crossing envelope`);
    }
    if (!Array.isArray(crossing.slabs)
      || crossing.slabs.length < DRAINAGE_PLAN_LIMITS.crossingSlabCountMin
      || crossing.slabs.length > DRAINAGE_PLAN_LIMITS.crossingSlabCountMax) {
      throw new RangeError(`${crossing.id} must plan 2–3 stone slabs`);
    }
    let envelopeThickness = 0;
    const halfSpan = crossing.span * 0.5;
    for (let index = 0; index < crossing.slabs.length; index++) {
      const slab = crossing.slabs[index];
      const label = `${crossing.id}.slabs[${index}]`;
      finite(slab.x, `${label}.x`);
      finite(slab.z, `${label}.z`);
      finite(slab.top, `${label}.top`);
      if (!(slab.span > 0) || !(slab.width > 0) || !(slab.thickness > 0)) {
        throw new RangeError(`${label} requires positive span/width/thickness`);
      }
      if (slab.width > crossing.width + 1e-9
        || Math.abs(slab.x) + slab.width * 0.5 > crossing.width * 0.5 + 1e-7) {
        throw new RangeError(`${label} exceeds the lateral envelope`);
      }
      if (Math.abs(slab.z) + slab.span * 0.5 > halfSpan + 1e-7) {
        throw new RangeError(`${label} exceeds the travel-span envelope`);
      }
      if (slab.thickness + 1e-9 < DRAINAGE_PLAN_LIMITS.crossingThicknessMin
        || slab.thickness > DRAINAGE_PLAN_LIMITS.crossingThicknessMax + 1e-9) {
        throw new RangeError(`${label} thickness is outside the product range`);
      }
      if (Math.abs(slab.top) > DRAINAGE_PLAN_LIMITS.crossingTopJitter + 1e-9) {
        throw new RangeError(`${label} top leaves the planned seating band`);
      }
      // Tops stay near the lip via the lowered deck + jitter. Bottoms may hang
      // into the open channel; only far-below-bed embed is rejected.
      const bottomY = crossing.center.y + slab.top - slab.thickness * 0.5;
      const bedY = expectedDeckY - DRAINAGE_PLAN_LIMITS.depth
        - DRAINAGE_PLAN_LIMITS.crossingLift;
      if (bottomY < bedY - DRAINAGE_PLAN_LIMITS.crossingBedEmbedMax - 1e-7) {
        throw new RangeError(`${label} sinks too far below the ditch bed`);
      }
      if (index > 0) {
        const previous = crossing.slabs[index - 1];
        const gap = (slab.z - slab.span * 0.5) - (previous.z + previous.span * 0.5);
        if (gap < -1e-7 || gap > DRAINAGE_PLAN_LIMITS.crossingGapMax + 1e-7) {
          throw new RangeError(`${label} gap from previous slab is unsupported`);
        }
      }
      envelopeThickness = Math.max(envelopeThickness, slab.thickness);
    }
    const first = crossing.slabs[0];
    const last = crossing.slabs.at(-1);
    if (Math.abs((first.z - first.span * 0.5) + halfSpan) > 1e-7
      || Math.abs((last.z + last.span * 0.5) - halfSpan) > 1e-7) {
      throw new RangeError(`${crossing.id} slabs do not cover the travel span`);
    }
    if (Math.abs(crossing.thickness - envelopeThickness) > 1e-9) {
      throw new RangeError(`${crossing.id}.thickness must equal max planned slab thickness`);
    }
  }
  return plan;
}
