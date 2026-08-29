import * as G from '../core/math/geom2.js';
import { makeRng } from '../rng.js';
import { assignFittedVariationSequence } from './house-footprint.js';
import {
  attachParcelSpatialContract,
  canopyBlocksSolarAccess,
} from './parcel-contract.js';
import {
  PAVILION_ROOF_RADIUS,
  pavilionBlocksParcelFocus,
} from './pavilion-plan.js';
import { buildingBlocksSolarAccess } from './solar-access.js';
import { planParcelAuxiliary } from './auxiliary-building-plan.js';
import { yardHardObstacles } from './yard-layout.js';

// A focused-house rebuild may redraw its yard inside the already reserved lot,
// but it must never renegotiate neighbours, roads, streams, or solar access.
// The original parcel is therefore an immutable envelope: each rebuild derives a
// fresh inset polygon from that envelope instead of repeatedly shrinking the last
// result. This makes the operation deterministic, overlap-safe, and reversible by
// a whole-village reroll without introducing a second parcel planner at runtime.

const MIN_BOUNDARY_SCALE = 0.88;
const MAX_BOUNDARY_SCALE = 0.995;
// Focus "다시 짓기" may inset the yard a bit more aggressively so the wall ring
// and 마당 reading also change, without renegotiating the reserved envelope.
const EXPLORE_MIN_BOUNDARY_SCALE = 0.80;
const EXPLORE_SEED_ATTEMPTS = 12;
// Focus rerolls should change the house silhouette (or at least two independent
// axes), not only a micro scale/tint nudge on the same form.
const EXPLORE_MIN_DISTANCE = 2;

function clonePoint(point) {
  return point ? { x: point.x, z: point.z } : point;
}

/**
 * How differently two residential variation states read at focus distance.
 * Returns 0 when only micro jitter would be visible (same form, scale, wall).
 */
export function residentialVariationDistance(a, b) {
  if (!a || !b) return Infinity;
  if ((a.kind || null) !== (b.kind || null)) return 4;
  let score = 0;
  if ((a.variant | 0) !== (b.variant | 0)) score += 3;
  if ((a.wallType || null) !== (b.wallType || null)) score += 1;
  if (!!a.aux !== !!b.aux) score += 1;
  const sx = Math.abs((a.sx || 1) - (b.sx || 1));
  const sy = Math.abs((a.sy || 1) - (b.sy || 1));
  const sz = Math.abs((a.sz || 1) - (b.sz || 1));
  if (sx + sy + sz >= 0.14) score += 1;
  else if (sx + sy + sz >= 0.07) score += 0.5;
  const thatch = Math.abs((a.thatchAge ?? 0.5) - (b.thatchAge ?? 0.5));
  if (thatch >= 0.22) score += 0.5;
  return score;
}

function snapshotVariation(parcel) {
  if (!parcel) return null;
  return {
    kind: parcel.kind,
    variant: parcel.variant | 0,
    wallType: parcel.wallType || null,
    aux: !!parcel.aux,
    sx: parcel.sx,
    sy: parcel.sy,
    sz: parcel.sz,
    thatchAge: parcel.thatchAge,
  };
}

function cloneShape(shape) {
  if (!shape) return shape;
  return {
    ...shape,
    pts: (shape.pts || []).map(clonePoint),
    roles: shape.roles ? shape.roles.slice() : undefined,
    // A rebuilt inset wall is independent. Keeping an old shared-edge flag would
    // omit a wall segment even though the neighbouring wall remains on the outer
    // envelope.
    edges: shape.edges?.map((edge) => ({ ...edge, share: false })),
  };
}

export function captureParcelRebuildEnvelope(parcel) {
  return {
    ...parcel,
    center: clonePoint(parcel.center),
    frontDir: clonePoint(parcel.frontDir),
    shape: cloneShape(parcel.shape),
    poly: parcel.poly?.map(clonePoint),
    solarAccess: parcel.solarAccess ? { ...parcel.solarAccess } : null,
    access: parcel.access ? {
      ...parcel.access,
      roadPoint: clonePoint(parcel.access.roadPoint),
      gatePoint: clonePoint(parcel.access.gatePoint),
      gateLocalPoint: clonePoint(parcel.access.gateLocalPoint),
    } : null,
  };
}

function insetShape(shape, scaleX, scaleZ) {
  const points = shape?.pts || [];
  if (points.length < 3) return cloneShape(shape);
  const center = G.polyCentroid(points);
  const next = cloneShape(shape);
  next.pts = points.map((point) => ({
    x: center.x + (point.x - center.x) * scaleX,
    z: center.z + (point.z - center.z) * scaleZ,
  }));
  return next;
}

export function planParcelRebuild(
  envelope,
  rebuildSeed,
  {
    char01 = 0.5,
    tuning = {},
    attempts = 16,
    pavilion = null,
    site = null,
    solarPeers = [],
    // Product focus "다시 짓기": flatten form repertoire, raise continuous
    // jitter, and prefer a candidate that is not a near-duplicate of the house
    // currently on the lot. Village placement and ordinary rebuild never set this.
    exploreReroll = false,
    previous = null,
  } = {},
) {
  if (!envelope?.center || !envelope?.shape?.pts?.length) return null;
  const explore = !!exploreReroll && !envelope.hero;
  const exploreTuning = explore
    ? { ...tuning, exploreForms: true, diversityK: Math.max(tuning.diversityK ?? 1, 1.7) }
    : tuning;
  // Distinctness against the focused house is an explore-only product dial.
  // Ordinary rebuild/slider paths never pass previous, and must not start
  // multi-seed search when a caller accidentally does.
  const previousSnap = explore && previous ? snapshotVariation(previous) : null;
  const minBoundary = explore ? EXPLORE_MIN_BOUNDARY_SCALE : MIN_BOUNDARY_SCALE;
  const seedAttempts = previousSnap ? EXPLORE_SEED_ATTEMPTS : 1;
  const baseSeed = Number.isFinite(rebuildSeed) ? rebuildSeed >>> 0 : 0;

  let fallback = null;
  for (let seedAttempt = 0; seedAttempt < seedAttempts; seedAttempt++) {
    const seed = (baseSeed + Math.imul(seedAttempt, 0x9e3779b9)) >>> 0;
    const rng = makeRng((seed ^ 0x504c4f54) >>> 0);
    const boundaryX = rng.range(minBoundary, MAX_BOUNDARY_SCALE);
    const boundaryZ = rng.range(minBoundary, MAX_BOUNDARY_SCALE);
    // If an unusually broad house variant cannot fit the first inset, expand the
    // boundary monotonically toward the immutable envelope. If its height/roof
    // still shadows a neighbour, advance through a fixed sequence of derived
    // variation seeds; this remains deterministic and never mutates the peers.
    const boundaryAttempts = envelope.hero ? 1 : 5;
    for (let variationAttempt = 0; variationAttempt < 6; variationAttempt++) {
      const variationSeed = ((seed ^ 0x484f5553) + Math.imul(variationAttempt, 0x9e3779b1)) >>> 0;
      for (let boundaryAttempt = 0; boundaryAttempt < boundaryAttempts; boundaryAttempt++) {
        const candidate = captureParcelRebuildEnvelope(envelope);
        if (!candidate.hero) {
          const t = boundaryAttempt / Math.max(1, boundaryAttempts - 1);
          const scaleX = boundaryX + (1 - boundaryX) * t;
          const scaleZ = boundaryZ + (1 - boundaryZ) * t;
          candidate.plotW = envelope.plotW * scaleX;
          candidate.plotD = envelope.plotD * scaleZ;
          candidate.shape = insetShape(envelope.shape, scaleX, scaleZ);
          attachParcelSpatialContract(
            candidate,
            envelope.access?.roadId || null,
            envelope.access?.roadPoint || null,
          );
        }
        candidate.rebuildSeed = seed;
        delete candidate.editRoofBounds;
        delete candidate.editBuildingBounds;
        if (!assignFittedVariationSequence(candidate, char01, exploreTuning, {
          baseSeed: variationSeed,
          attempts,
        })) continue;
        candidate.auxRequested = !!candidate.aux;
        // Runtime rebuilds may adjust the wall envelope and therefore the pure focus
        // framing. The village pavilion is a full-height building with broad eaves,
        // not a point prop: keep both the daylight opening and the camera frame clear
        // under the same contract used by initial village planning.
        // If the *reserved envelope* was already under the pavilion (pavilion is planned
        // after parcels and can land in a residual solar gap), do not make rebuild
        // impossible — only reject candidates that *newly* conflict.
        const envelopePavilionBlocked = !!(pavilion && (
          canopyBlocksSolarAccess(envelope, pavilion, pavilion.radius || PAVILION_ROOF_RADIUS)
          || pavilionBlocksParcelFocus(envelope, pavilion)
        ));
        if (pavilion && !envelopePavilionBlocked && (
          canopyBlocksSolarAccess(candidate, pavilion, pavilion.radius || PAVILION_ROOF_RADIUS)
          || pavilionBlocksParcelFocus(candidate, pavilion)
        )) continue;
        if (site && solarPeers.some((peer) => peer && peer.id !== candidate.id && (
          buildingBlocksSolarAccess(candidate, peer, site)
          // A palace owns a precinct-scale vegetation opening, not one residential
          // window target. It can shadow the rebuilt house, but the house must not
          // be rejected for entering that deliberately broad palace corridor.
          || (peer.kind !== 'palace' && buildingBlocksSolarAccess(peer, candidate, site))
        ))) continue;
        const auxiliary = planParcelAuxiliary(candidate, {
          site,
          peers: solarPeers,
          hardObstacles: yardHardObstacles({
            ...candidate,
            auxiliary: null,
          }),
        });
        candidate.auxiliary = auxiliary;
        if (!auxiliary) candidate.aux = false;
        const distance = previousSnap
          ? residentialVariationDistance(previousSnap, candidate)
          : Infinity;
        if (!fallback) {
          fallback = candidate;
        } else if (previousSnap
          && distance > residentialVariationDistance(previousSnap, fallback)) {
          fallback = candidate;
        }
        // Prefer a visibly different house when exploring; keep the best legal
        // fit if the lot has no strong alternative in the attempt budget.
        if (!previousSnap || distance >= EXPLORE_MIN_DISTANCE) {
          return candidate;
        }
      }
    }
  }
  return fallback;
}

export function parcelRebuildIssues(envelope, candidate) {
  const issues = [];
  if (!envelope || !candidate) return ['missing parcel rebuild input'];
  if (candidate.kind !== envelope.kind) issues.push('social house type changed');
  if (candidate.frontDir?.x !== envelope.frontDir?.x
    || candidate.frontDir?.z !== envelope.frontDir?.z) issues.push('south-facing frame changed');
  if (candidate.plotW > envelope.plotW + 1e-8 || candidate.plotD > envelope.plotD + 1e-8) {
    issues.push('parcel escaped reserved dimensions');
  }
  const outer = envelope.poly || [];
  for (const point of candidate.poly || []) {
    if (!G.pointInPoly(point, outer)
      && !outer.some((a, index) => G.distToSeg(point, a, outer[(index + 1) % outer.length]).d < 1e-7)) {
      issues.push('parcel escaped reserved polygon');
      break;
    }
  }
  if (!candidate.access && envelope.access) issues.push('road access lost');
  if (!candidate.solarAccess) issues.push('solar access lost');
  return issues;
}
