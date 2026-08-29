import { deepFreeze, normalizeStableSeed } from '../core/stable-seed.js';
import { hashString, makeRng } from '../rng.js';

export const MUD_WALL_SURFACE_SCHEMA_VERSION = 1;

// World-metre authoring bounds. Counts grow with the exposed wall area but stop
// here, so one unusually long parcel edge cannot become an unbounded geometry
// multiplier. `depth` is always an inward-only envelope: a renderer must keep
// every detail at or inside the structural wall faces at ±thickness / 2.
export const MUD_WALL_SURFACE_LIMITS = deepFreeze({
  targetLiftHeight: 0.5,
  maxLifts: 6,
  maxJoints: 5,
  fibreDensityPerSquareMetre: 0.65,
  maxFibresPerFace: 18,
  maxDampPointsPerFace: 9,
  maxDetailDepth: 0.012,
  maxJointDrift: 0.014,
});

const SIDES = Object.freeze([-1, 1]);
const EPSILON = 1e-8;

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const stableMetric = (value) => Number(value).toFixed(9);

function positiveFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  if (!(value > 0)) throw new RangeError(`${label} must be positive`);
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function surfaceRng(seed, length, height, footHeight) {
  return makeRng(hashString([
    'mud-wall-surface-v1',
    normalizeStableSeed(seed),
    stableMetric(length),
    stableMetric(height),
    stableMetric(footHeight),
  ].join('|')));
}

function planLifts(bodyBottom, bodyTop, rng) {
  const bodyHeight = bodyTop - bodyBottom;
  const liftCount = clamp(
    Math.round(bodyHeight / MUD_WALL_SURFACE_LIMITS.targetLiftHeight),
    1,
    MUD_WALL_SURFACE_LIMITS.maxLifts,
  );
  const weights = Array.from({ length: liftCount }, () => rng.range(0.9, 1.1));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const lifts = [];
  const joints = [];
  let bottom = bodyBottom;
  for (let index = 0; index < liftCount; index++) {
    const top = index === liftCount - 1
      ? bodyTop
      : bottom + bodyHeight * weights[index] / weightSum;
    lifts.push({
      id: `lift-${index + 1}`,
      bottom,
      top,
      colorK: rng.range(0.975, 1.015),
    });
    if (index < liftCount - 1) {
      joints.push({
        id: `joint-${index + 1}`,
        y: top,
        width: rng.range(0.038, 0.064),
        depth: rng.range(0.0015, 0.0038),
        colorK: rng.range(0.93, 0.975),
        tilt: rng.range(-0.012, 0.012),
        wave: rng.range(0.003, 0.008),
        phase: rng.range(0, Math.PI * 2),
      });
    }
    bottom = top;
  }
  return { lifts, joints };
}

function planFibres(length, bodyBottom, bodyTop, rng) {
  const bodyHeight = bodyTop - bodyBottom;
  if (length < 0.32 || bodyHeight < 0.24) return [];
  const perFace = Math.min(
    MUD_WALL_SURFACE_LIMITS.maxFibresPerFace,
    Math.max(0, Math.round(
      length * bodyHeight * MUD_WALL_SURFACE_LIMITS.fibreDensityPerSquareMetre,
    )),
  );
  const fibres = [];
  for (const side of SIDES) {
    for (let index = 0; index < perFace; index++) {
      const angle = rng.range(-Math.PI * 0.34, Math.PI * 0.34);
      const fibreLength = Math.min(
        rng.range(0.055, 0.13),
        length * 0.28,
        bodyHeight * 0.32,
      );
      const width = Math.min(rng.range(0.006, 0.011), fibreLength * 0.18);
      const halfX = Math.abs(Math.cos(angle)) * fibreLength * 0.5 + width;
      const halfY = Math.abs(Math.sin(angle)) * fibreLength * 0.5 + width;
      const xLimit = Math.max(0, length * 0.5 - halfX - 0.012);
      const yMin = bodyBottom + halfY + 0.018;
      const yMax = bodyTop - halfY - 0.018;
      if (xLimit <= 0 || yMax <= yMin) continue;
      fibres.push({
        id: `fibre-${side < 0 ? 'back' : 'front'}-${index + 1}`,
        side,
        x: rng.range(-xLimit, xLimit),
        y: rng.range(yMin, yMax),
        length: fibreLength,
        width,
        angle,
        depth: rng.range(0.003, 0.007),
        colorK: rng.range(0.72, 0.88),
      });
    }
  }
  return fibres;
}

function planDamp(length, bodyBottom, bodyTop, rng) {
  const bodyHeight = bodyTop - bodyBottom;
  if (length < 0.32 || bodyHeight < 0.2) return [];
  const pointCount = Math.min(
    MUD_WALL_SURFACE_LIMITS.maxDampPointsPerFace,
    Math.max(3, Math.ceil(length / 1.4) + 1),
  );
  const nominalRise = Math.min(0.25, bodyHeight * 0.24);
  return SIDES.map((side) => {
    const points = Array.from({ length: pointCount }, (_, index) => {
      const x = -length * 0.5 + length * index / (pointCount - 1);
      const edgeWeight = index === 0 || index === pointCount - 1 ? 0.9 : 1;
      const rise = nominalRise * edgeWeight * rng.range(0.68, 1.12);
      return {
        x,
        y: Math.min(bodyTop - 0.025, bodyBottom + rise),
      };
    });
    return {
      id: `damp-${side < 0 ? 'back' : 'front'}`,
      side,
      baseY: bodyBottom,
      colorK: rng.range(0.76, 0.86),
      depth: rng.range(0.0015, 0.003),
      points,
    };
  });
}

/**
 * Plans close-range packed-earth detail in a wall run's local +X/+Y plane.
 *
 * `height` is the exposed earthen body's top, while `footHeight` is its bottom
 * above any stone footing. Face records use `side` only; the renderer owns wall
 * thickness and places side -1/+1 at its two structural faces. Every positive
 * `depth` is measured inward from that face, never outward, preserving the
 * wall-layout footprint used by planning, picking, and solar-access checks.
 *
 * The result is immutable, JSON-safe, Three/DOM-free, and depends only on the
 * four inputs. Consumers should derive a unique stable seed for each structural
 * run rather than consume a shared ambient RNG.
 */
export function planMudWallSurface({
  length,
  height,
  footHeight = 0,
  seed = 0,
} = {}) {
  const spanLength = positiveFinite(length, 'mud-wall length');
  const bodyTop = positiveFinite(height, 'mud-wall height');
  const bodyBottom = finite(footHeight, 'mud-wall footHeight');
  if (bodyBottom < 0 || bodyBottom >= bodyTop) {
    throw new RangeError('mud-wall footHeight must be at least zero and below height');
  }
  const normalizedSeed = normalizeStableSeed(seed);
  const rng = surfaceRng(normalizedSeed, spanLength, bodyTop, bodyBottom);
  const { lifts, joints } = planLifts(bodyBottom, bodyTop, rng);
  const fibres = planFibres(spanLength, bodyBottom, bodyTop, rng);
  const damp = planDamp(spanLength, bodyBottom, bodyTop, rng);
  return deepFreeze({
    schema: MUD_WALL_SURFACE_SCHEMA_VERSION,
    seed: normalizedSeed,
    bounds: {
      length: spanLength,
      bodyBottom,
      bodyTop,
    },
    lifts,
    joints,
    fibres,
    damp,
  });
}

function assertIdSet(records, prefix, label) {
  const ids = new Set();
  for (const record of records) {
    if (typeof record?.id !== 'string' || !record.id.startsWith(prefix) || ids.has(record.id)) {
      throw new RangeError(`${label} must have unique ${prefix} IDs`);
    }
    ids.add(record.id);
  }
}

function assertColorK(value, label) {
  const colorK = finite(value, label);
  if (colorK <= 0 || colorK > 1.1) throw new RangeError(`${label} must be in (0, 1.1]`);
}

function assertDepth(value, label) {
  const depth = finite(value, label);
  if (depth < 0 || depth > MUD_WALL_SURFACE_LIMITS.maxDetailDepth) {
    throw new RangeError(`${label} must be inward and at most maxDetailDepth`);
  }
}

function assertSide(side, label) {
  if (side !== -1 && side !== 1) throw new RangeError(`${label} must be -1 or 1`);
}

/**
 * Rejects malformed or unbounded renderer-boundary data and returns `plan`
 * unchanged on success. This deliberately checks geometry envelopes rather
 * than object identity/frozen state, so JSON round-tripped plans remain valid.
 */
export function validateMudWallSurfacePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('mud-wall surface plan must be an object');
  if (plan.schema !== MUD_WALL_SURFACE_SCHEMA_VERSION) {
    throw new RangeError(`mud-wall surface schema must be ${MUD_WALL_SURFACE_SCHEMA_VERSION}`);
  }
  const length = positiveFinite(plan.bounds?.length, 'mud-wall bounds.length');
  const bodyBottom = finite(plan.bounds?.bodyBottom, 'mud-wall bounds.bodyBottom');
  const bodyTop = positiveFinite(plan.bounds?.bodyTop, 'mud-wall bounds.bodyTop');
  if (bodyBottom < 0 || bodyBottom >= bodyTop) {
    throw new RangeError('mud-wall bounds must contain a positive exposed body');
  }
  const collections = ['lifts', 'joints', 'fibres', 'damp'];
  for (const key of collections) {
    if (!Array.isArray(plan[key])) throw new TypeError(`mud-wall ${key} must be an array`);
  }
  if (plan.lifts.length < 1 || plan.lifts.length > MUD_WALL_SURFACE_LIMITS.maxLifts) {
    throw new RangeError('mud-wall lift count is out of bounds');
  }
  if (plan.joints.length !== plan.lifts.length - 1
    || plan.joints.length > MUD_WALL_SURFACE_LIMITS.maxJoints) {
    throw new RangeError('mud-wall joint count must match adjacent lifts');
  }
  assertIdSet(plan.lifts, 'lift-', 'mud-wall lifts');
  assertIdSet(plan.joints, 'joint-', 'mud-wall joints');
  assertIdSet(plan.fibres, 'fibre-', 'mud-wall fibres');
  assertIdSet(plan.damp, 'damp-', 'mud-wall damp profiles');

  let cursor = bodyBottom;
  for (const [index, lift] of plan.lifts.entries()) {
    finite(lift.bottom, `mud-wall lifts[${index}].bottom`);
    finite(lift.top, `mud-wall lifts[${index}].top`);
    if (Math.abs(lift.bottom - cursor) > EPSILON || !(lift.top > lift.bottom)
      || lift.top > bodyTop + EPSILON) {
      throw new RangeError('mud-wall lifts must partition the exposed body without gaps');
    }
    assertColorK(lift.colorK, `mud-wall lifts[${index}].colorK`);
    cursor = lift.top;
  }
  if (Math.abs(cursor - bodyTop) > EPSILON) {
    throw new RangeError('mud-wall lifts must end at bodyTop');
  }
  for (const [index, joint] of plan.joints.entries()) {
    const y = finite(joint.y, `mud-wall joints[${index}].y`);
    const width = positiveFinite(joint.width, `mud-wall joints[${index}].width`);
    const tilt = finite(joint.tilt, `mud-wall joints[${index}].tilt`);
    const wave = finite(joint.wave, `mud-wall joints[${index}].wave`);
    finite(joint.phase, `mud-wall joints[${index}].phase`);
    const drift = Math.abs(tilt) * 0.5 + Math.abs(wave);
    if (Math.abs(y - plan.lifts[index].top) > EPSILON
      || drift > MUD_WALL_SURFACE_LIMITS.maxJointDrift
      || y - width * 0.5 - drift < bodyBottom
      || y + width * 0.5 + drift > bodyTop) {
      throw new RangeError('mud-wall joint must remain on its adjacent lift boundary');
    }
    assertDepth(joint.depth, `mud-wall joints[${index}].depth`);
    assertColorK(joint.colorK, `mud-wall joints[${index}].colorK`);
  }

  const fibreCounts = new Map([[-1, 0], [1, 0]]);
  for (const [index, fibre] of plan.fibres.entries()) {
    const label = `mud-wall fibres[${index}]`;
    assertSide(fibre.side, `${label}.side`);
    fibreCounts.set(fibre.side, fibreCounts.get(fibre.side) + 1);
    const x = finite(fibre.x, `${label}.x`);
    const y = finite(fibre.y, `${label}.y`);
    const fibreLength = positiveFinite(fibre.length, `${label}.length`);
    const width = positiveFinite(fibre.width, `${label}.width`);
    const angle = finite(fibre.angle, `${label}.angle`);
    const halfX = Math.abs(Math.cos(angle)) * fibreLength * 0.5 + width;
    const halfY = Math.abs(Math.sin(angle)) * fibreLength * 0.5 + width;
    if (Math.abs(x) + halfX > length * 0.5 + EPSILON
      || y - halfY < bodyBottom - EPSILON || y + halfY > bodyTop + EPSILON) {
      throw new RangeError(`${label} exceeds the exposed body`);
    }
    assertDepth(fibre.depth, `${label}.depth`);
    assertColorK(fibre.colorK, `${label}.colorK`);
  }
  if ([...fibreCounts.values()].some(
    (count) => count > MUD_WALL_SURFACE_LIMITS.maxFibresPerFace,
  )) {
    throw new RangeError('mud-wall fibre count exceeds its per-face bound');
  }

  if (plan.damp.length !== 0 && plan.damp.length !== SIDES.length) {
    throw new RangeError('mud-wall damp profiles must cover both faces or neither');
  }
  const dampSides = new Set(plan.damp.map((record) => record?.side));
  if (plan.damp.length && SIDES.some((side) => !dampSides.has(side))) {
    throw new RangeError('mud-wall damp profiles must contain each face exactly once');
  }
  for (const [index, damp] of plan.damp.entries()) {
    const label = `mud-wall damp[${index}]`;
    assertSide(damp.side, `${label}.side`);
    if (finite(damp.baseY, `${label}.baseY`) !== bodyBottom) {
      throw new RangeError(`${label}.baseY must equal bodyBottom`);
    }
    if (!Array.isArray(damp.points) || damp.points.length < 3
      || damp.points.length > MUD_WALL_SURFACE_LIMITS.maxDampPointsPerFace) {
      throw new RangeError(`${label}.points count is out of bounds`);
    }
    let previousX = -Infinity;
    for (const [pointIndex, point] of damp.points.entries()) {
      const x = finite(point?.x, `${label}.points[${pointIndex}].x`);
      const y = finite(point?.y, `${label}.points[${pointIndex}].y`);
      if (x <= previousX || x < -length * 0.5 - EPSILON || x > length * 0.5 + EPSILON
        || y <= bodyBottom || y >= bodyTop) {
        throw new RangeError(`${label}.points must rise within the body in increasing x order`);
      }
      previousX = x;
    }
    assertDepth(damp.depth, `${label}.depth`);
    assertColorK(damp.colorK, `${label}.colorK`);
  }
  return plan;
}
