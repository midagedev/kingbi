// 고샅 topology — measure-only analysis of wall-to-wall gaps between independent
// parcels. R-P2 (docs/village-walls-parcels.md): each lot keeps its own wall ring;
// the gap between rings is the alley (고샅). When boundaries close inside
// `shareDist`, the higher-index parcel omits its facing edge so only one wall
// remains (visual single-boundary, not a legal party wall).
//
// This module never places or mutates parcels. Placement continues to own
// `gapWidth` / `assignEdgeShare` in parcels.js; here we only classify and
// summarise the resulting geometry so gates can assert historical / product
// bands without worker-golden or placement churn.

import * as G from '../core/math/geom2.js';
import { VILLAGE_SOLID_WALL_THICKNESS } from './wall-contract.js';

// Mirrors parcels.js R-P2 thresholds (SHARE_DIST / ALLEY_DIST) and the documented
// product clamp on gapWidth. The check harness source-guards those private
// constants so analysis and placement cannot drift silently.
export const GOSAT_TOPOLOGY = Object.freeze({
  // Historical 소로-class alley width (docs R-P2).
  historicalMin: 1.0,
  historicalMax: 3.4,
  // Product gapWidth clamp (parcels.js gapWidth): seed noise around the
  // historical centre may land slightly outside 1.0–3.4.
  productClampMin: 0.7,
  productClampMax: 3.9,
  // Boundary clearance below which edge.share may omit the higher-index wall.
  shareDist: 1.15,
  // Boundary clearance below which a non-front edge is treated as alley/neighbour
  // (lower heightK). Beyond this the edge is open / distant.
  alleyDist: 3.8,
});

const EPSILON = 1e-9;

/**
 * Exact minimum clearance between two closed parcel boundary polygons.
 * Overlap / containment returns 0. Empty inputs return Infinity.
 */
export function parcelBoundaryClearance(polyA, polyB) {
  if (!polyA?.length || !polyB?.length) return Infinity;
  let distance = Infinity;
  for (let i = 0; i < polyA.length; i++) {
    distance = Math.min(
      distance,
      G.segmentPolygonDistance(polyA[i], polyA[(i + 1) % polyA.length], polyB),
    );
    if (distance <= EPSILON) return 0;
  }
  return distance;
}

/** Half-thickness of a solid masonry wall body, or 0 for open/brush/hedge. */
export function solidWallHalfThickness(wallType) {
  const thickness = VILLAGE_SOLID_WALL_THICKNESS[wallType];
  return Number.isFinite(thickness) ? thickness * 0.5 : 0;
}

/**
 * Wall-face gap for two solid dual walls centred on their parcel boundaries.
 * Non-solid styles contribute 0 thickness (no body). Shared single-wall cases
 * are classified separately — do not treat a near-zero poly gap as a dual face.
 */
export function wallFaceClearance(boundaryClearance, wallTypeA, wallTypeB) {
  if (!Number.isFinite(boundaryClearance)) return Infinity;
  return boundaryClearance
    - solidWallHalfThickness(wallTypeA)
    - solidWallHalfThickness(wallTypeB);
}

/**
 * Classify a measured boundary clearance into the R-P2 bands.
 * - `share`: close enough for single-boundary wall omission (< shareDist)
 * - `alley`: 고샅 dual-wall band [shareDist, alleyDist)
 * - `open`: farther than alleyDist (not a neighbour alley pair)
 */
export function classifyGosatGap(clearance, {
  shareDist = GOSAT_TOPOLOGY.shareDist,
  alleyDist = GOSAT_TOPOLOGY.alleyDist,
} = {}) {
  if (!Number.isFinite(clearance)) return 'open';
  if (clearance < shareDist) return 'share';
  if (clearance < alleyDist) return 'alley';
  return 'open';
}

function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.z);
}

function parcelBounds(poly, pad = 0) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const point of poly) {
    if (!finitePoint(point)) continue;
    minX = Math.min(minX, point.x);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxZ = Math.max(maxZ, point.z);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    minX: minX - pad,
    minZ: minZ - pad,
    maxX: maxX + pad,
    maxZ: maxZ + pad,
  };
}

function boundsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX
    && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * Stable quantiles for a numeric sample. Returns null when empty.
 * Keys: n, min, p10, p25, median, p75, p90, max, mean.
 */
export function gapQuantiles(values) {
  if (!values?.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p) => {
    const index = (sorted.length - 1) * p;
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (hi - index) + sorted[hi] * (index - lo);
  };
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    n: sorted.length,
    min: sorted[0],
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function neighbourCandidates(parcels, maxDist) {
  const records = [];
  for (let index = 0; index < parcels.length; index++) {
    const parcel = parcels[index];
    const poly = parcel?.poly;
    if (!poly || poly.length < 3) continue;
    const bounds = parcelBounds(poly, maxDist);
    if (!bounds) continue;
    records.push({ index, parcel, poly, bounds });
  }

  const pairs = [];
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    for (let j = i + 1; j < records.length; j++) {
      const b = records[j];
      if (!boundsOverlap(a.bounds, b.bounds)) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * Measure neighbour gaps for a planned parcel list.
 *
 * Options:
 * - `shareDist` / `alleyDist` — override classification thresholds
 * - `includeOpen` — keep pairs classified `open` (default false; only neighbour
 *   band pairs with clearance < alleyDist are returned)
 *
 * Returns a JSON-safe plain object (not frozen) so callers may aggregate freely.
 */
export function analyzeGosatTopology(parcels, {
  shareDist = GOSAT_TOPOLOGY.shareDist,
  alleyDist = GOSAT_TOPOLOGY.alleyDist,
  includeOpen = false,
} = {}) {
  const list = Array.isArray(parcels) ? parcels : [];
  const candidates = neighbourCandidates(list, alleyDist);
  const pairs = [];

  for (const [a, b] of candidates) {
    const clearance = parcelBoundaryClearance(a.poly, b.poly);
    const kind = classifyGosatGap(clearance, { shareDist, alleyDist });
    if (!includeOpen && kind === 'open') continue;

    const halfA = solidWallHalfThickness(a.parcel.wallType);
    const halfB = solidWallHalfThickness(b.parcel.wallType);
    const dualSolid = halfA > 0 && halfB > 0;
    const face = dualSolid
      ? wallFaceClearance(clearance, a.parcel.wallType, b.parcel.wallType)
      : null;

    pairs.push({
      aId: a.parcel.id ?? a.index,
      bId: b.parcel.id ?? b.index,
      aIndex: a.index,
      bIndex: b.index,
      clearance,
      kind,
      dualSolid,
      wallFaceClearance: face,
      aWallType: a.parcel.wallType ?? null,
      bWallType: b.parcel.wallType ?? null,
      aHero: !!a.parcel.hero,
      bHero: !!b.parcel.hero,
    });
  }

  pairs.sort((left, right) => {
    if (left.clearance !== right.clearance) return left.clearance - right.clearance;
    if (left.aIndex !== right.aIndex) return left.aIndex - right.aIndex;
    return left.bIndex - right.bIndex;
  });

  return summarizeGosatPairs(pairs, { shareDist, alleyDist });
}

/**
 * Build quantile / fraction summary over an already-measured pair list.
 */
export function summarizeGosatPairs(pairs, {
  shareDist = GOSAT_TOPOLOGY.shareDist,
  alleyDist = GOSAT_TOPOLOGY.alleyDist,
  historicalMin = GOSAT_TOPOLOGY.historicalMin,
  historicalMax = GOSAT_TOPOLOGY.historicalMax,
} = {}) {
  const share = [];
  const alley = [];
  const open = [];
  const dualFace = [];
  let dualSolidAlley = 0;

  for (const pair of pairs) {
    if (pair.kind === 'share') share.push(pair.clearance);
    else if (pair.kind === 'alley') {
      alley.push(pair.clearance);
      if (pair.dualSolid && Number.isFinite(pair.wallFaceClearance)) {
        dualSolidAlley += 1;
        dualFace.push(pair.wallFaceClearance);
      }
    } else open.push(pair.clearance);
  }

  const alleyInHistorical = alley.filter(
    (gap) => gap + EPSILON >= historicalMin && gap - EPSILON <= historicalMax,
  ).length;

  return {
    shareDist,
    alleyDist,
    historicalMin,
    historicalMax,
    pairCount: pairs.length,
    shareCount: share.length,
    alleyCount: alley.length,
    openCount: open.length,
    dualSolidAlleyCount: dualSolidAlley,
    share: gapQuantiles(share),
    alley: gapQuantiles(alley),
    open: gapQuantiles(open),
    dualSolidWallFace: gapQuantiles(dualFace),
    alleyHistoricalFraction: alley.length
      ? alleyInHistorical / alley.length
      : null,
    pairs,
  };
}

/**
 * Midpoint-to-neighbour distance used by parcels.assignEdgeShare for one edge.
 * Returns { nearest, nearIndex } over the provided parcel list (same rules:
 * non-hero parcels with poly only).
 */
export function edgeNeighbourClearance(parcel, edgeIndex, parcels) {
  const poly = parcel?.poly;
  if (!poly || poly.length < 3) return { nearest: Infinity, nearIndex: -1 };
  const a = poly[edgeIndex];
  const b = poly[(edgeIndex + 1) % poly.length];
  if (!finitePoint(a) || !finitePoint(b)) return { nearest: Infinity, nearIndex: -1 };
  const mid = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
  let nearest = Infinity;
  let nearIndex = -1;
  for (let index = 0; index < parcels.length; index++) {
    const other = parcels[index];
    if (other === parcel || other?.hero || !other?.poly || other.poly.length < 3) continue;
    for (let k = 0; k < other.poly.length; k++) {
      const d = G.distToSeg(
        mid,
        other.poly[k],
        other.poly[(k + 1) % other.poly.length],
      ).d;
      if (d < nearest) {
        nearest = d;
        nearIndex = index;
      }
    }
  }
  return { nearest, nearIndex };
}

/**
 * Validate plan-owned edge.share flags against measured midpoint clearance.
 * Gate edges and front roles must never share. A share flag requires the edge
 * midpoint to sit inside shareDist of some other non-hero parcel.
 */
export function inspectEdgeShareFlags(parcels, {
  shareDist = GOSAT_TOPOLOGY.shareDist,
} = {}) {
  const list = Array.isArray(parcels) ? parcels : [];
  const issues = [];
  let shareFlags = 0;
  let consistent = 0;

  for (let index = 0; index < list.length; index++) {
    const parcel = list[index];
    const edges = parcel?.shape?.edges;
    if (!edges?.length || !parcel.poly) continue;
    const gateEdge = Number.isInteger(parcel.access?.gateEdge)
      ? parcel.access.gateEdge
      : -1;

    for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
      const edge = edges[edgeIndex];
      if (!edge) continue;
      if (edge.share) {
        shareFlags += 1;
        if (edge.gate || edgeIndex === gateEdge || edge.role === 'front') {
          issues.push({
            type: 'gate-or-front-share',
            parcelId: parcel.id ?? index,
            edgeIndex,
            role: edge.role ?? null,
          });
          continue;
        }
        const { nearest } = edgeNeighbourClearance(parcel, edgeIndex, list);
        if (nearest < shareDist) consistent += 1;
        else {
          issues.push({
            type: 'share-without-neighbour',
            parcelId: parcel.id ?? index,
            edgeIndex,
            nearest,
            shareDist,
          });
        }
      }
    }
  }

  return {
    shareFlags,
    consistentShareFlags: consistent,
    issues,
  };
}
