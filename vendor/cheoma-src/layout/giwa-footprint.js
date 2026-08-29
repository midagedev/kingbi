// Regular tiled-house footprint grammar shared by the builder, village planner,
// impostor LOD, and editor readback.  Coordinates follow the village contract:
// local +z is the south/front courtyard side.  Polygons are clockwise because
// roof-skeleton derives its exterior normals from that winding.

export const GIWA_PLAN_SHAPES = Object.freeze(['single', 'l', 'u']);
export const GIWA_U_MIN_BAYS = 4;

export const GIWA_FOOTPRINT_BOUNDS = Object.freeze({
  bay: Object.freeze({ min: 1.8, max: 3.6 }),
  mainHalfW: Object.freeze({ min: 2.4, max: 12 }),
  mainHalfD: Object.freeze({ min: 1.6, max: 6 }),
  wingLen: Object.freeze({ min: 2.6, max: 12 }),
  wingW: Object.freeze({ min: 1.6, max: 8 }),
  columnRadius: Object.freeze({ min: 0.05, max: 0.4 }),
});

const GIWA_MIN = Object.freeze({ a: 2.4, b: 1.6, c: 2.6, w: 1.6 });
const GIWA_WING_MAX_K = 0.72;
const GIWA_DEFAULTS = Object.freeze({
  bay: 2.2,
  mainHalfW: GIWA_MIN.a,
  mainHalfD: GIWA_MIN.b,
  wingLen: GIWA_MIN.c,
  wingW: GIWA_MIN.w,
  columnRadius: 0.16,
});

function boundedFinite(value, fallback, { min, max }) {
  const numeric = Number(value);
  const candidate = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(min, Math.min(max, candidate));
}

export function normalizeGiwaPlan(shape = 'l', bays = 3) {
  const planShape = GIWA_PLAN_SHAPES.includes(shape) ? shape : 'l';
  const numericBays = Number(bays);
  const requested = Number.isFinite(numericBays) ? Math.round(numericBays) : 3;
  return {
    planShape,
    bays: Math.max(planShape === 'u' ? GIWA_U_MIN_BAYS : 3, Math.min(5, requested)),
  };
}

// One finite, bounded input frame feeds FULL geometry, impostors, fitting, and
// pure opening slots. Invalid numbers fall back deterministically; very large
// finite edits clamp here rather than producing a different planner footprint.
export function normalizeGiwaFootprint(P = {}) {
  const source = P && typeof P === 'object' ? P : {};
  return {
    ...normalizeGiwaPlan(source.planShape, source.bays),
    bay: boundedFinite(source.bay, GIWA_DEFAULTS.bay, GIWA_FOOTPRINT_BOUNDS.bay),
    mainHalfW: boundedFinite(
      source.mainHalfW,
      GIWA_DEFAULTS.mainHalfW,
      GIWA_FOOTPRINT_BOUNDS.mainHalfW,
    ),
    mainHalfD: boundedFinite(
      source.mainHalfD,
      GIWA_DEFAULTS.mainHalfD,
      GIWA_FOOTPRINT_BOUNDS.mainHalfD,
    ),
    wingLen: boundedFinite(
      source.wingLen,
      GIWA_DEFAULTS.wingLen,
      GIWA_FOOTPRINT_BOUNDS.wingLen,
    ),
    wingW: boundedFinite(source.wingW, GIWA_DEFAULTS.wingW, GIWA_FOOTPRINT_BOUNDS.wingW),
    columnRadius: boundedFinite(
      source.columnRadius,
      GIWA_DEFAULTS.columnRadius,
      GIWA_FOOTPRINT_BOUNDS.columnRadius,
    ),
  };
}

export function giwaFootprintMetrics(P = {}) {
  const shape = normalizeGiwaFootprint(P);
  // A declared bay count is a lower bound on the actual main range.  This keeps
  // a four-bay U legible even when an edit supplies a stale narrow mainHalfW.
  const a = Math.max(GIWA_MIN.a, shape.bays * shape.bay * 0.5, shape.mainHalfW);
  const b = Math.max(GIWA_MIN.b, shape.mainHalfD);
  const c = Math.max(GIWA_MIN.c, shape.wingLen);
  const w = Math.min(
    Math.max(GIWA_MIN.w, shape.wingW),
    GIWA_WING_MAX_K * a,
  );
  return {
    planShape: shape.planShape,
    bays: shape.bays,
    bay: shape.bay,
    columnRadius: shape.columnRadius,
    a,
    b,
    w,
    c,
  };
}

export function giwaFootprintPoints(P = {}) {
  const { planShape, a, b, w, c } = giwaFootprintMetrics(P);
  if (planShape === 'single') {
    return [
      { x: -a, z: b }, { x: a, z: b },
      { x: a, z: -b }, { x: -a, z: -b },
    ];
  }
  if (planShape === 'u') {
    return [
      { x: -a, z: b + c }, { x: -a + w, z: b + c },
      { x: -a + w, z: b }, { x: a - w, z: b },
      { x: a - w, z: b + c }, { x: a, z: b + c },
      { x: a, z: -b }, { x: -a, z: -b },
    ];
  }
  return [
    { x: -a, z: b }, { x: a - w, z: b }, { x: a - w, z: b + c },
    { x: a, z: b + c }, { x: a, z: -b }, { x: -a, z: -b },
  ];
}

// Courtyard-facing main range used for doors, daecheong, and toenmaru.
export function giwaFrontRange(P = {}) {
  const foot = giwaFootprintMetrics(P);
  if (foot.planShape === 'single') return { x0: -foot.a, x1: foot.a, z: foot.b };
  if (foot.planShape === 'u') return { x0: -foot.a + foot.w, x1: foot.a - foot.w, z: foot.b };
  return { x0: -foot.a, x1: foot.a - foot.w, z: foot.b };
}
