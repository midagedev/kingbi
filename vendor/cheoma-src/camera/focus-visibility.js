// Deterministic, renderer-free safety pass for residential focus cameras.
//
// Parcel planning owns the south-facing axis. This module never invents a new
// target or lens policy: it only tries the authored angle plus two bounded steps
// inside that parcel's reserved solar opening, compensating the short dolly
// within the residential telephoto range. Stable planned detail anchors may aim
// those steps toward the opposite opening edge without consuming generation RNG.
// The result is suitable for ordinary focus and hero reveal endpoints.

import { fovForDollyScale } from './optics.js';

const SAMPLE_U = Object.freeze([0.08, 0.5, 0.92]);
const SAMPLE_Y = Object.freeze([0.16, 0.54, 0.92]);
const ARCHITECTURAL_HYSTERESIS = 1 / (SAMPLE_U.length * SAMPLE_Y.length);
const GRID_CELL = 24;
const EPS = 1e-9;

export const VILLAGE_FOCUS_TERRAIN_CLEARANCE = 1;
export const VILLAGE_FOCUS_CAMERA_CLEARANCE = 1.2;
export const VILLAGE_FOCUS_TELEPHOTO_FOV_MAX = 30;

const copyPoint = (point) => ({ x: point.x, y: point.y, z: point.z });
const copyBounds = (bounds) => ({ min: copyPoint(bounds.min), max: copyPoint(bounds.max) });
const copyVolume = (volume) => volume ? ({
  center: copyPoint(volume.center), half: copyPoint(volume.half), rotationY: volume.rotationY || 0,
}) : null;
const key = (x, z) => `${x},${z}`;
const cell = (value, size) => Math.floor(value / size);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

function framingAtCandidate(framing, axisYaw, azimuth, scale) {
  const dx = framing.position.x - framing.target.x;
  const dy = framing.position.y - framing.target.y;
  const dz = framing.position.z - framing.target.z;
  const horizontal = Math.hypot(dx, dz);
  const position = {
    x: framing.target.x + horizontal * scale * Math.sin(axisYaw + azimuth),
    y: framing.target.y + dy * scale,
    z: framing.target.z + horizontal * scale * Math.cos(axisYaw + azimuth),
  };
  return {
    position,
    target: copyPoint(framing.target),
    fov: fovForDollyScale(framing.fov, scale),
    // referenceFov is the authored screen-equivalent lens. Keeping it fixed
    // makes LOD, particles, and zoom bounds invariant under this safety dolly.
    referenceFov: framing.referenceFov,
  };
}

function scaleFramingDistance(framing, scale) {
  const safeScale = clamp(scale, 0, 1);
  return {
    position: {
      x: framing.target.x + (framing.position.x - framing.target.x) * safeScale,
      y: framing.target.y + (framing.position.y - framing.target.y) * safeScale,
      z: framing.target.z + (framing.position.z - framing.target.z) * safeScale,
    },
    target: copyPoint(framing.target),
    fov: fovForDollyScale(framing.fov, safeScale),
    referenceFov: framing.referenceFov,
  };
}

function pointInsideBounds(point, bounds, padding = 0) {
  return point.x >= bounds.min.x - padding && point.x <= bounds.max.x + padding
    && point.y >= bounds.min.y - padding && point.y <= bounds.max.y + padding
    && point.z >= bounds.min.z - padding && point.z <= bounds.max.z + padding;
}

function toVolumeLocal(point, volume) {
  const dx = point.x - volume.center.x;
  const dy = point.y - volume.center.y;
  const dz = point.z - volume.center.z;
  const cos = Math.cos(volume.rotationY);
  const sin = Math.sin(volume.rotationY);
  return { x: cos * dx - sin * dz, y: dy, z: sin * dx + cos * dz };
}

function fromVolumeLocal(point, volume) {
  const cos = Math.cos(volume.rotationY);
  const sin = Math.sin(volume.rotationY);
  return {
    x: volume.center.x + cos * point.x + sin * point.z,
    y: volume.center.y + point.y,
    z: volume.center.z - sin * point.x + cos * point.z,
  };
}

function volumeBounds(volume) {
  return {
    min: { x: -volume.half.x, y: -volume.half.y, z: -volume.half.z },
    max: { x: volume.half.x, y: volume.half.y, z: volume.half.z },
  };
}

function pointInsideVolume(point, blocker, padding = 0) {
  if (!blocker.volume) return pointInsideBounds(point, blocker.bounds, padding);
  return pointInsideBounds(toVolumeLocal(point, blocker.volume), volumeBounds(blocker.volume), padding);
}

// Return the entry fraction on camera→sample, or null when the segment misses.
function segmentBoundsEntry(start, end, bounds, padding = 0) {
  let near = 0;
  let far = 1;
  for (const axis of ['x', 'y', 'z']) {
    const delta = end[axis] - start[axis];
    const min = bounds.min[axis] - padding;
    const max = bounds.max[axis] + padding;
    if (Math.abs(delta) < EPS) {
      if (start[axis] < min || start[axis] > max) return null;
      continue;
    }
    let a = (min - start[axis]) / delta;
    let b = (max - start[axis]) / delta;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  return far >= 0 && near < 1 - EPS ? Math.max(0, near) : null;
}

function segmentBlockerEntry(start, end, blocker, padding = 0) {
  if (!blocker.volume) return segmentBoundsEntry(start, end, blocker.bounds, padding);
  return segmentBoundsEntry(
    toVolumeLocal(start, blocker.volume),
    toVolumeLocal(end, blocker.volume),
    volumeBounds(blocker.volume),
    padding,
  );
}

function subjectSamples(camera, bounds) {
  const center = {
    x: (bounds.min.x + bounds.max.x) * 0.5,
    y: (bounds.min.y + bounds.max.y) * 0.5,
    z: (bounds.min.z + bounds.max.z) * 0.5,
  };
  const dx = camera.x - center.x;
  const dz = camera.z - center.z;
  const samples = [];
  if (Math.abs(dx) > Math.abs(dz)) {
    const x = dx < 0 ? bounds.min.x : bounds.max.x;
    for (const yK of SAMPLE_Y) for (const zK of SAMPLE_U) {
      samples.push({
        x,
        y: bounds.min.y + (bounds.max.y - bounds.min.y) * yK,
        z: bounds.min.z + (bounds.max.z - bounds.min.z) * zK,
      });
    }
  } else {
    const z = dz < 0 ? bounds.min.z : bounds.max.z;
    for (const yK of SAMPLE_Y) for (const xK of SAMPLE_U) {
      samples.push({
        x: bounds.min.x + (bounds.max.x - bounds.min.x) * xK,
        y: bounds.min.y + (bounds.max.y - bounds.min.y) * yK,
        z,
      });
    }
  }
  return samples;
}

function subjectVolumeSamples(camera, volume) {
  const localCamera = toVolumeLocal(camera, volume);
  const samples = [];
  if (Math.abs(localCamera.x) > Math.abs(localCamera.z)) {
    const x = localCamera.x < 0 ? -volume.half.x : volume.half.x;
    for (const yK of SAMPLE_Y) for (const zK of SAMPLE_U) {
      samples.push(fromVolumeLocal({
        x,
        y: -volume.half.y + volume.half.y * 2 * yK,
        z: -volume.half.z + volume.half.z * 2 * zK,
      }, volume));
    }
  } else {
    const z = localCamera.z < 0 ? -volume.half.z : volume.half.z;
    for (const yK of SAMPLE_Y) for (const xK of SAMPLE_U) {
      samples.push(fromVolumeLocal({
        x: -volume.half.x + volume.half.x * 2 * xK,
        y: -volume.half.y + volume.half.y * 2 * yK,
        z,
      }, volume));
    }
  }
  return samples;
}

// The same nine points define both object visibility and the focus-only terrain
// cutaway. Keeping one sampler prevents the near plane from preserving a centre
// ray while clipping a roof corner that the visibility selector considered part
// of the subject.
export function sampleFocusSubjectSurface(camera, bounds, volume = null) {
  return volume
    ? subjectVolumeSamples(camera, volume)
    : subjectSamples(camera, bounds);
}

function scoreCandidate(framing, subjectBounds, subjectVolume, blockers) {
  const camera = framing.position;
  const containing = blockers.filter((blocker) => pointInsideVolume(camera, blocker, 0.2));
  if (containing.length) {
    return { visibleRatio: 0, occlusionRatio: 1, blockers: containing.map((item) => item.id), cameraBlocked: true };
  }
  const samples = sampleFocusSubjectSurface(camera, subjectBounds, subjectVolume);
  const blockedBy = new Set();
  let visible = 0;
  for (const sample of samples) {
    let first = null;
    for (const blocker of blockers) {
      const entry = segmentBlockerEntry(camera, sample, blocker, 0.08);
      if (entry != null && (!first || entry < first.entry)) first = { entry, id: blocker.id };
    }
    if (first) blockedBy.add(first.id);
    else visible++;
  }
  const visibleRatio = visible / samples.length;
  return {
    visibleRatio,
    occlusionRatio: 1 - visibleRatio,
    blockers: [...blockedBy].sort(),
    cameraBlocked: false,
  };
}

function validDetailAnchors(anchors) {
  if (!Array.isArray(anchors)) return [];
  return anchors.flatMap((anchor, index) => {
    const point = anchor?.point;
    if (![point?.x, point?.y, point?.z].every(Number.isFinite)) return [];
    return [{
      id: String(anchor.id ?? `detail:${index}`),
      point: copyPoint(point),
    }];
  });
}

function detailAnchorBounds(anchors) {
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const { point } of anchors) {
    for (const axis of ['x', 'y', 'z']) {
      bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
    }
  }
  return bounds;
}

function scoreDetailAnchors(framing, anchors, blockers) {
  const blockedBy = new Set();
  let visible = 0;
  for (const anchor of anchors) {
    let first = null;
    for (const blocker of blockers) {
      const entry = segmentBlockerEntry(framing.position, anchor.point, blocker, 0.08);
      if (entry != null && (!first || entry < first.entry)) {
        first = { entry, id: blocker.id };
      }
    }
    if (first) blockedBy.add(first.id);
    else visible++;
  }
  return {
    detailCount: anchors.length,
    detailVisibleCount: visible,
    detailVisibleRatio: anchors.length ? visible / anchors.length : 0,
    detailBlockers: [...blockedBy].sort(),
  };
}

export function createFocusVisibilityIndex(items, cellSize = GRID_CELL) {
  const cells = new Map();
  for (const item of items) {
    const bounds = copyBounds(item.bounds);
    const entry = { id: item.id, bounds, volume: copyVolume(item.volume) };
    const minX = cell(bounds.min.x, cellSize);
    const maxX = cell(bounds.max.x, cellSize);
    const minZ = cell(bounds.min.z, cellSize);
    const maxZ = cell(bounds.max.z, cellSize);
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const bucketKey = key(x, z);
      const bucket = cells.get(bucketKey);
      if (bucket) bucket.push(entry);
      else cells.set(bucketKey, [entry]);
    }
  }
  return Object.freeze({ cells, cellSize });
}

function queryBlockers(index, subjectId, framings, subjectBounds) {
  const xValues = [subjectBounds.min.x, subjectBounds.max.x, ...framings.map((item) => item.position.x)];
  const zValues = [subjectBounds.min.z, subjectBounds.max.z, ...framings.map((item) => item.position.z)];
  const minX = cell(Math.min(...xValues), index.cellSize);
  const maxX = cell(Math.max(...xValues), index.cellSize);
  const minZ = cell(Math.min(...zValues), index.cellSize);
  const maxZ = cell(Math.max(...zValues), index.cellSize);
  const found = new Map();
  for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
    for (const item of index.cells.get(key(x, z)) || []) {
      if (item.id !== subjectId) found.set(item.id, item);
    }
  }
  return [...found.values()];
}

export function selectSafeFocusEndpoint({
  subjectId,
  framing,
  subjectBounds,
  subjectVolume = null,
  index,
  detailIndex = index,
  axisYaw = 0,
  azimuthMin = -14 * Math.PI / 180,
  azimuthMax = 14 * Math.PI / 180,
  constrainEndpoint = null,
  telephotoFovMax = VILLAGE_FOCUS_TELEPHOTO_FOV_MAX,
  detailAnchors = [],
}) {
  const details = validDetailAnchors(detailAnchors);
  const dx = framing.position.x - framing.target.x;
  const dz = framing.position.z - framing.target.z;
  const baseAzimuth = clamp(normalizeAngle(Math.atan2(dx, dz) - axisYaw), azimuthMin, azimuthMax);
  const centre = clamp(0, azimuthMin, azimuthMax);
  const meanDetailDirection = details.reduce((sum, anchor) => ({
    x: sum.x + anchor.point.x - framing.target.x,
    z: sum.z + anchor.point.z - framing.target.z,
  }), { x: 0, z: 0 });
  const detailAzimuth = details.length
    && Math.hypot(meanDetailDirection.x, meanDetailDirection.z) > EPS
    ? clamp(
      normalizeAngle(Math.atan2(meanDetailDirection.x, meanDetailDirection.z) - axisYaw),
      azimuthMin,
      azimuthMax,
    )
    : centre;
  // Keep exactly three bounded samples. With no authored detail, retain the
  // established move toward the solar-opening centre. Stable detail anchors may
  // instead request the opposite edge of that same opening, allowing a low yard
  // object behind the fitted roof to become first-surface visible.
  const definitions = [
    { azimuth: baseAzimuth, scale: 1 },
    { azimuth: (baseAzimuth + detailAzimuth) * 0.5, scale: 0.9 },
    { azimuth: detailAzimuth, scale: 0.8 },
  ].filter((value, index, list) => list.findIndex((other) => (
    Math.abs(other.azimuth - value.azimuth) < EPS && Math.abs(other.scale - value.scale) < EPS
  )) === index);
  const requestedFramings = definitions.map(({ azimuth, scale }) => (
    framingAtCandidate(framing, axisYaw, azimuth, scale)
  ));
  const constraints = requestedFramings.map((candidate) => {
    const result = constrainEndpoint?.(candidate);
    if (!result) return { scale: 1, blocked: false };
    const scale = Number.isFinite(result.scale) ? clamp(result.scale, 0, 1) : 0;
    return { ...result, scale, blocked: result.blocked === true || scale <= EPS };
  });
  const candidateFramings = requestedFramings.map((candidate, index) => (
    scaleFramingDistance(candidate, constraints[index].scale)
  ));
  const blockers = queryBlockers(index, subjectId, candidateFramings, subjectBounds);
  // A selected house is the subject for its 3×3 architectural surface rays, but
  // its fitted roof is a first-surface blocker for low yard details. Query the
  // the detail index without excluding subjectId only for these detail rays.
  // Product callers extend that immutable grid with renderer-free wall/gate
  // runs; pure consumers may keep the architectural index as the default.
  const detailBlockers = details.length
    ? queryBlockers(detailIndex, null, candidateFramings, detailAnchorBounds(details))
    : [];
  const candidates = definitions.map(({ azimuth, scale: requestedScale }, index) => {
    const candidateFraming = candidateFramings[index];
    const constraint = constraints[index];
    const objectScore = scoreCandidate(candidateFraming, subjectBounds, subjectVolume, blockers);
    const detailScore = scoreDetailAnchors(candidateFraming, details, detailBlockers);
    const scale = requestedScale * constraint.scale;
    return {
      azimuth,
      requestedScale,
      scale,
      framing: candidateFraming,
      terrainScale: constraint.scale,
      terrainLimited: constraint.limited === true || constraint.scale < 1 - EPS,
      terrainBlocked: constraint.blocked,
      telephotoPreserved: !constrainEndpoint
        || candidateFraming.fov <= telephotoFovMax + EPS,
      terrainMinClearance: constraint.minClearance ?? null,
      terrainEndpointClearance: constraint.endpointClearance ?? null,
      ...objectScore,
      ...detailScore,
      cameraBlocked: objectScore.cameraBlocked || constraint.blocked,
    };
  });
  // Architecture remains the primary safety signal. Stable planned detail
  // anchors may choose only among candidates inside the existing one-of-nine
  // architectural sample hysteresis; they can never rescue a broadly occluded
  // house or a camera inside a blocker.
  const base = candidates[0];
  if (constrainEndpoint && candidates.every((candidate) => candidate.terrainBlocked)) {
    throw new RangeError(`No target-connected terrain-safe focus endpoint for ${subjectId}`);
  }
  const usable = candidates.filter((candidate) => !candidate.cameraBlocked);
  let selected = usable[0] || base;
  if (details.length && usable.length) {
    const bestArchitecturalRatio = Math.max(...usable.map((candidate) => candidate.visibleRatio));
    const detailEligible = usable.filter((candidate) => (
      candidate.visibleRatio >= bestArchitecturalRatio - ARCHITECTURAL_HYSTERESIS - EPS
    ));
    [selected] = detailEligible;
    for (const candidate of detailEligible.slice(1)) {
      if (candidate.detailVisibleRatio > selected.detailVisibleRatio + EPS
        || (Math.abs(candidate.detailVisibleRatio - selected.detailVisibleRatio) <= EPS
          && (candidate.visibleRatio > selected.visibleRatio + EPS
            || (Math.abs(candidate.visibleRatio - selected.visibleRatio) <= EPS
              && candidate.scale > selected.scale + EPS)))) selected = candidate;
    }
  } else {
    for (const candidate of usable.slice(1)) {
      if (candidate.visibleRatio > selected.visibleRatio + EPS
        || (Math.abs(candidate.visibleRatio - selected.visibleRatio) <= EPS
          && candidate.scale > selected.scale + EPS)) selected = candidate;
    }
  }
  // The authored endpoint only wins the one-sample hysteresis tie when it is
  // itself usable. Falling back into a roof merely because it had the authored
  // azimuth turns a visibility preference into a hard camera collision.
  if (!details.length
    && !base.cameraBlocked
    && base.scale >= selected.scale - EPS
    && selected.visibleRatio < base.visibleRatio + ARCHITECTURAL_HYSTERESIS - EPS) selected = base;
  return {
    framing: selected.framing,
    azimuth: selected.azimuth,
    scale: selected.scale,
    requestedScale: selected.requestedScale,
    terrainScale: selected.terrainScale,
    terrainLimited: selected.terrainLimited,
    telephotoPreserved: selected.telephotoPreserved,
    terrainMinClearance: selected.terrainMinClearance,
    terrainEndpointClearance: selected.terrainEndpointClearance,
    baseAzimuth,
    visibleRatio: selected.visibleRatio,
    occlusionRatio: selected.occlusionRatio,
    baseVisibleRatio: base.visibleRatio,
    baseOcclusionRatio: base.occlusionRatio,
    detailCount: selected.detailCount,
    detailVisibleCount: selected.detailVisibleCount,
    detailVisibleRatio: selected.detailVisibleRatio,
    baseDetailVisibleCount: base.detailVisibleCount,
    baseDetailVisibleRatio: base.detailVisibleRatio,
    detailBlockers: selected.detailBlockers,
    baseDetailBlockers: base.detailBlockers,
    blockers: selected.blockers,
    baseBlockers: base.blockers,
    candidates: candidates.map((candidate) => ({
      azimuth: candidate.azimuth,
      scale: candidate.scale,
      requestedScale: candidate.requestedScale,
      terrainScale: candidate.terrainScale,
      terrainLimited: candidate.terrainLimited,
      terrainBlocked: candidate.terrainBlocked,
      telephotoPreserved: candidate.telephotoPreserved,
      terrainMinClearance: candidate.terrainMinClearance,
      terrainEndpointClearance: candidate.terrainEndpointClearance,
      visibleRatio: candidate.visibleRatio,
      occlusionRatio: candidate.occlusionRatio,
      detailCount: candidate.detailCount,
      detailVisibleCount: candidate.detailVisibleCount,
      detailVisibleRatio: candidate.detailVisibleRatio,
      detailBlockers: candidate.detailBlockers,
      cameraBlocked: candidate.cameraBlocked,
      blockers: candidate.blockers,
    })),
  };
}
