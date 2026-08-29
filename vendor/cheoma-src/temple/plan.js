import { makeRng } from '../rng.js';
import {
  applyTempleEntrySequence,
  templeBuildingIsOpenPassUnder,
  templeEntrySequenceIssues,
} from './entry-sequence.js';
import {
  templeHallEaveFootprint,
  templeRoleArchitecture,
} from './role-hierarchy.js';

// Framework- and renderer-free Korean temple compound planner.
// Local coordinates follow the repository convention: +z is south/entrance,
// -z is north/backdrop. Every renderer and village adapter consumes this data;
// none of them may infer a second layout from the variant name.

export const TEMPLE_VARIANTS = Object.freeze(['compact', 'courtyard', 'extended']);
export const TEMPLE_PLAN_SCHEMA_VERSION = 2;

export const TEMPLE_VARIANT_SPECS = Object.freeze({
  compact: Object.freeze({ min: 22, max: 30, width: 26, depth: 28, minHalls: 1, maxHalls: 2 }),
  courtyard: Object.freeze({ min: 36, max: 48, width: 42, depth: 46, minHalls: 3, maxHalls: 4 }),
  extended: Object.freeze({ min: 52, max: 72, width: 64, depth: 68, minHalls: 5, maxHalls: 7 }),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const round = (value, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const point = (x, z) => ({ x: round(x), z: round(z) });
const rect = (cx, cz, width, depth) => [
  point(cx - width / 2, cz + depth / 2),
  point(cx + width / 2, cz + depth / 2),
  point(cx + width / 2, cz - depth / 2),
  point(cx - width / 2, cz - depth / 2),
];

// siteR 임계는 SCALE_ANCHORS 명명 tier 중점과 동기(solo·hamlet=compact,
// village·town=courtyard, capital·hanyang=extended).
export function templeVariantForSite(siteR) {
  if (siteR < 143) return 'compact';
  if (siteR < 260) return 'courtyard';
  return 'extended';
}

export function templeVariantsForSize(size) {
  const limit = finite(size, TEMPLE_VARIANT_SPECS.compact.max);
  return TEMPLE_VARIANTS.filter((variant) => TEMPLE_VARIANT_SPECS[variant].min <= limit);
}

export function templeCompoundDefaultsForSite(siteR, seed = 1) {
  const variant = templeVariantForSite(siteR);
  const spec = TEMPLE_VARIANT_SPECS[variant];
  let size;
  if (variant === 'compact') size = clamp(siteR * 0.30, spec.min, spec.max - 2);
  else if (variant === 'courtyard') size = clamp(38 + (siteR - 101) * 0.07, spec.min, spec.max);
  else size = clamp(56 + (siteR - 213) * 0.045, spec.min, spec.max);
  // Slightly rectangular precincts read as authored sites while the maximum
  // dimension remains the single reservation scalar used by legacy consumers.
  const rng = makeRng((seed ^ 0x12a7c0) >>> 0);
  const width = clamp(size * (0.92 + rng() * 0.05), spec.min, spec.max);
  const depth = clamp(size, spec.min, spec.max);
  return { variant, width: round(width), depth: round(depth) };
}

function withHallArchitecture(building, seed) {
  const architecture = templeRoleArchitecture(building.role, { seed, id: building.id });
  const eave = templeHallEaveFootprint({
    architecture,
    frontBays: building.frontBays,
    sideBays: building.sideBays,
    scale: building.scale,
    yaw: building.yaw,
    position: building.position,
  });
  return {
    ...building,
    formality: architecture.formality,
    architecturalRank: architecture.architecturalRank,
    architectureId: architecture.id,
    roofGrammar: architecture.roofGrammar,
    bracketGrammar: architecture.bracketGrammar,
    eaveGrammar: architecture.eaveGrammar,
    massingGrammar: architecture.massingGrammar,
    eaveFootprint: {
      localWidth: round(eave.localWidth),
      localDepth: round(eave.localDepth),
      width: round(eave.width),
      depth: round(eave.depth),
      polygon: eave.polygon.map((corner) => point(corner.x, corner.z)),
    },
    // Compatibility consumers use the already-oriented AABB. It is derived
    // from the same actual eave rectangle rather than a hand-authored plot box.
    footprint: { width: round(eave.width), depth: round(eave.depth) },
  };
}

function hall(id, role, x, z, {
  yaw = 0, frontBays = 3, sideBays = 2, scale = 0.8,
  seed = 1,
} = {}) {
  return withHallArchitecture({
    id,
    role,
    style: 'temple',
    position: point(x, z),
    yaw: round(yaw, 6),
    frontBays,
    sideBays,
    scale: round(scale),
  }, seed);
}

const PLAN_ARRAY_FIELDS = Object.freeze([
  'courtyards', 'enclosures', 'buildings', 'gates', 'props', 'paths',
]);

function assertPlanCollections(plan) {
  for (const field of PLAN_ARRAY_FIELDS) {
    if (!Array.isArray(plan[field])) throw new TypeError(`TemplePlan.${field} must be an array`);
  }
}

function completeHallArchitecture(building) {
  const finiteFields = (object, fields) => fields.every((field) => Number.isFinite(object?.[field]));
  return Number.isInteger(building?.architecturalRank)
    && typeof building.architectureId === 'string' && building.architectureId.length > 0
    && typeof building.formality === 'string' && building.formality.length > 0
    && typeof building.roofGrammar?.family === 'string'
    && typeof building.roofGrammar?.type === 'string'
    && finiteFields(building.roofGrammar, [
      'pitch', 'profileCurve', 'ridgeHeight', 'gableOverhang', 'cornerLift', 'planCurve',
    ])
    && typeof building.bracketGrammar?.family === 'string'
    && Number.isInteger(building.bracketGrammar?.tiers)
    && Number.isInteger(building.bracketGrammar?.interBrackets)
    && Number.isFinite(building.bracketGrammar?.scale)
    && typeof building.bracketGrammar?.density === 'string'
    && finiteFields(building.eaveGrammar, ['overhang', 'drop'])
    && Number.isInteger(building.eaveGrammar?.layers)
    && finiteFields(building.massingGrammar, ['columnHeight', 'podiumTierHeight'])
    && Number.isInteger(building.massingGrammar?.podiumTiers);
}

function expectedHallEave(building) {
  return templeHallEaveFootprint({
    architecture: {
      roofGrammar: building.roofGrammar,
      eaveGrammar: building.eaveGrammar,
    },
    frontBays: building.frontBays,
    sideBays: building.sideBays,
    scale: building.scale,
    yaw: building.yaw,
    position: building.position,
  });
}

function hallEaveMatches(building, tolerance = 0.002) {
  const polygon = building.eaveFootprint?.polygon;
  if (polygon?.length !== 4) return false;
  const expected = expectedHallEave(building);
  return expected.polygon.every((corner, index) => (
    Math.hypot(corner.x - polygon[index].x, corner.z - polygon[index].z) <= tolerance
  ))
    && Math.abs(expected.width - building.eaveFootprint.width) <= tolerance
    && Math.abs(expected.depth - building.eaveFootprint.depth) <= tolerance
    && Math.abs(expected.width - building.footprint?.width) <= tolerance
    && Math.abs(expected.depth - building.footprint?.depth) <= tolerance;
}

/**
 * Normalize the pure TemplePlan input boundary.
 *
 * Schema v1 did not own hall architecture. Its deterministic upgrade is the
 * only compatibility layer allowed to recover grammar from a role; renderers
 * and all v2 consumers receive the complete plan-owned grammar.
 */
export function normalizeTemplePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('TemplePlan must be an object');
  }
  if (!Number.isInteger(plan.schemaVersion)) {
    throw new TypeError('TemplePlan.schemaVersion is required');
  }
  if (!Number.isInteger(plan.seed) || plan.seed < 0 || plan.seed > 0xffffffff) {
    throw new TypeError('TemplePlan.seed must be an unsigned 32-bit integer');
  }
  if (plan.schemaVersion !== 1 && plan.schemaVersion !== TEMPLE_PLAN_SCHEMA_VERSION) {
    throw new RangeError(
      `unsupported TemplePlan schemaVersion ${plan.schemaVersion}; expected 1 or ${TEMPLE_PLAN_SCHEMA_VERSION}`,
    );
  }
  assertPlanCollections(plan);
  if (plan.schemaVersion === 1) {
    return normalizeTemplePlan({
      ...plan,
      schemaVersion: TEMPLE_PLAN_SCHEMA_VERSION,
      buildings: plan.buildings.map((building) => withHallArchitecture({ ...building }, plan.seed)),
    });
  }
  for (const building of plan.buildings) {
    if (!completeHallArchitecture(building)) {
      throw new TypeError(`TemplePlan v2 building ${building?.id || '<unknown>'} has incomplete architecture`);
    }
    if (!hallEaveMatches(building)) {
      throw new TypeError(`TemplePlan v2 building ${building.id} has a stale eave footprint`);
    }
  }
  // Entry sequence is plan-owned. Recover it on the same object so v2 stays an
  // identity pass when already complete, and older pure payloads still gain the
  // gate | stair-apron | pass-under | court contract without a schema bump.
  if (!plan.entrySequence) {
    applyTempleEntrySequence(plan, { profile: plan.settings?.entryProfile });
  }
  return plan;
}

function prop(id, role, kind, x, z, {
  yaw = 0, scale = 1, radius = 0.8, heightClass = 'low', stories,
} = {}) {
  return {
    id, role, kind, position: point(x, z), yaw: round(yaw, 6),
    scale: round(scale), radius: round(radius), heightClass,
    ...(stories ? { stories } : {}),
  };
}

function commonPlan(seed, variant, width, depth, settings) {
  const halfW = width / 2, halfD = depth / 2;
  return {
    schemaVersion: TEMPLE_PLAN_SCHEMA_VERSION,
    seed,
    variant,
    width: round(width),
    depth: round(depth),
    axis: { front: point(0, 1), bend: round(settings.axisBend), offsetX: 0 },
    boundary: rect(0, 0, width, depth),
    courtyards: [],
    enclosures: [{
      id: 'outer-precinct', role: 'precinct-wall', polygon: rect(0, 0, width, depth),
      height: variant === 'compact' ? 1.75 : 2.05,
      gateId: 'south-gate',
    }],
    buildings: [],
    gates: [{
      id: 'south-gate', role: 'entry-gate', type: variant === 'compact' ? 'iljakmun' : 'soseuldaemun',
      position: point(0, halfD), yaw: 0, width: variant === 'compact' ? 2.2 : 3.0,
    }],
    props: [],
    paths: [],
    solarAccess: null,
    settings,
    bounds: { minX: round(-halfW), maxX: round(halfW), minZ: round(-halfD), maxZ: round(halfD) },
  };
}

function planCompact(plan) {
  const { width, depth, settings } = plan;
  const mainZ = -depth * 0.27;
  plan.courtyards.push({
    id: 'worship-court', role: 'worship',
    polygon: rect(0, 1.5,
      Math.min(width - 2, (width - 3) * settings.courtScale),
      Math.min(depth - 3, (depth - 4) * settings.courtScale)),
    level: 0,
  });
  const candidates = [
    hall('main-hall', 'main-hall', 0, mainZ, {
      frontBays: 3, sideBays: 2, scale: 0.82, seed: plan.seed,
    }),
    hall('west-yosa', 'yosa', -width * 0.35, 2.5, {
      yaw: -Math.PI / 2, frontBays: 3, sideBays: 2, scale: 0.66,
      seed: plan.seed,
    }),
  ];
  plan.buildings = candidates.slice(0, settings.hallCount);
  if (settings.stoneLanterns > 0) {
    plan.props.push(prop('main-lantern', 'worship-lantern', 'stone-lantern', 2.1, mainZ + 5.2, { scale: 0.92, radius: 0.55 }));
  }
  plan.paths.push({
    id: 'entry-path', role: 'entry', width: 1.35,
    points: [point(0, depth / 2 - 0.8), point(0, mainZ + 3.3)],
  });
  plan.solarAccess = {
    role: 'main-hall', origin: point(0, mainZ + 3.5),
    halfWidth: 5.6, southZ: round(depth / 2),
  };
}

function pagodaMode(settings, variant, seed) {
  if (settings.pagoda !== 'auto') return settings.pagoda;
  if (variant === 'compact') return 'none';
  if (variant === 'extended') return 'pair';
  return ((seed ^ 0x70a9) & 1) ? 'pair' : 'single';
}

function addCourtProps(plan, mainZ, axisX, spread) {
  const mode = pagodaMode(plan.settings, plan.variant, plan.seed);
  const propZ = mainZ + (plan.variant === 'extended' ? 15 : 17);
  if (mode === 'single') {
    plan.props.push(prop('central-pagoda', 'worship-pagoda', 'pagoda', axisX + spread, propZ, {
      scale: plan.variant === 'extended' ? 1.05 : 0.92, radius: 1.35, heightClass: 'tall', stories: 3,
    }));
  } else if (mode === 'pair') {
    for (const side of [-1, 1]) {
      plan.props.push(prop(`pagoda-${side < 0 ? 'west' : 'east'}`, 'worship-pagoda', 'pagoda', axisX + side * spread, propZ, {
        scale: plan.variant === 'extended' ? 1.02 : 0.88,
        radius: 1.3, heightClass: 'tall', stories: 3,
      }));
    }
  }
  const lanternCount = plan.settings.stoneLanterns;
  for (let index = 0; index < lanternCount; index++) {
    const side = lanternCount === 1 ? 1 : (index ? 1 : -1);
    plan.props.push(prop(
      lanternCount === 1 ? 'main-lantern' : `main-lantern-${side < 0 ? 'west' : 'east'}`,
      'worship-lantern', 'stone-lantern', axisX + side * 2.4, mainZ + 7.5,
      { scale: 1, radius: 0.55 },
    ));
  }
}

function planCourtyard(plan) {
  const { width, depth, settings } = plan;
  const axisX = round(settings.axisBend * width * 0.035);
  const mainZ = -depth * 0.31;
  plan.axis.offsetX = axisX;
  plan.courtyards.push({
    id: 'worship-court', role: 'worship',
    polygon: rect(axisX, -2,
      Math.min(width - 3, (width - 5) * settings.courtScale),
      Math.min(depth - 5, (depth - 8) * settings.courtScale)),
    level: 0,
  });
  const candidates = [
    hall('main-hall', 'main-hall', axisX, mainZ, {
      frontBays: 3, sideBays: 3, scale: 0.9, seed: plan.seed,
    }),
    hall('west-yosa', 'yosa', -width * 0.37, -1, {
      yaw: -Math.PI / 2, scale: 0.72, seed: plan.seed,
    }),
    hall('east-seonbang', 'seonbang', width * 0.37, -1, {
      yaw: Math.PI / 2, scale: 0.72, seed: plan.seed,
    }),
    hall('bell-pavilion', 'bell-pavilion', width * 0.34, depth * 0.29, {
      frontBays: 3, sideBays: 2, scale: 0.62, seed: plan.seed,
    }),
  ];
  plan.buildings = candidates.slice(0, settings.hallCount)
    .filter((building) => building.role !== 'bell-pavilion' || settings.includeBellPavilion);
  // A narrow courtyard needs a slightly wider pagoda offset than a simple
  // width ratio gives it. Keep the tower and its visual mass entirely outside
  // the main hall's south-light/camera lane at the 36m lower bound.
  addCourtProps(plan, mainZ, axisX, Math.max(width * 0.20, 8.3));
  if (settings.includeDanggan) {
    plan.props.push(prop('entry-danggan', 'entry-marker', 'danggan', axisX - 8.2, depth / 2 - 6.2, {
      scale: 0.92, radius: 0.9, heightClass: 'tall',
    }));
  }
  plan.paths.push({
    id: 'entry-path', role: 'entry', width: 1.5,
    points: [point(0, depth / 2 - 1), point(axisX * 0.45, 7), point(axisX, mainZ + 4.8)],
  });
  plan.solarAccess = {
    role: 'main-hall', origin: point(axisX, mainZ + 4.8),
    halfWidth: 6.1, southZ: round(depth / 2),
  };
}

function planExtended(plan) {
  const { width, depth, settings } = plan;
  const axisX = round(settings.axisBend * width * 0.055);
  const mainZ = -depth * 0.34;
  const sideX = width * 0.32;
  plan.axis.offsetX = axisX;
  plan.courtyards.push(
    { id: 'entry-court', role: 'entry', polygon: rect(0, depth * 0.23, width - 5, Math.min(depth * 0.37, depth * 0.32 * settings.courtScale)), level: 0 },
    { id: 'worship-court', role: 'worship', polygon: rect(axisX, -depth * 0.17, width - 9, Math.min(depth * 0.61, depth * 0.55 * settings.courtScale)), level: 0 },
  );
  // Keep the inner gate and both path segments on the exact south wall. The
  // enclosure is centered at -0.22d with 0.52d depth, hence its south edge is
  // +0.04d. Duplicating this as a visual offset leaves a conspicuous closed-wall
  // strip across the processional axis.
  const innerSouth = depth * 0.04;
  plan.enclosures.push({
    id: 'inner-precinct', role: 'worship-wall',
    polygon: rect(axisX, -depth * 0.22, width - 7, depth * 0.52),
    height: 1.8, gateId: 'inner-gate',
  });
  plan.gates.push({
    id: 'inner-gate', role: 'court-gate', type: 'iljakmun',
    position: point(axisX, innerSouth), yaw: 0, width: 2.4,
  });
  const candidates = [
    hall('main-hall', 'main-hall', axisX, mainZ, {
      frontBays: 5, sideBays: 3, scale: 0.9, seed: plan.seed,
    }),
    hall('west-subsidiary', 'subsidiary-hall', axisX - sideX, mainZ + 0.5, {
      scale: 0.78, seed: plan.seed,
    }),
    hall('east-subsidiary', 'subsidiary-hall', axisX + sideX, mainZ + 0.5, {
      scale: 0.78, seed: plan.seed,
    }),
    hall('west-yosa', 'yosa', -width * 0.40, -depth * 0.06, {
      yaw: -Math.PI / 2, scale: 0.72, seed: plan.seed,
    }),
    hall('east-seonbang', 'seonbang', width * 0.40, -depth * 0.06, {
      yaw: Math.PI / 2, scale: 0.72, seed: plan.seed,
    }),
    hall('lecture-hall', 'lecture-hall', -width * 0.35, depth * 0.24, {
      scale: 0.68, seed: plan.seed,
    }),
    hall('bell-pavilion', 'bell-pavilion', width * 0.35, depth * 0.24, {
      scale: 0.68, seed: plan.seed,
    }),
  ];
  plan.buildings = candidates.slice(0, settings.hallCount)
    .filter((building) => building.role !== 'bell-pavilion' || settings.includeBellPavilion);
  addCourtProps(plan, mainZ, axisX, width * 0.24);
  if (settings.includeDanggan) {
    plan.props.push(prop('entry-danggan', 'entry-marker', 'danggan', -14, depth / 2 - 6, {
      scale: 1, radius: 0.9, heightClass: 'tall',
    }));
  }
  if (settings.includeBudo) {
    plan.props.push(prop('outer-budo', 'memorial-budo', 'budo', -width / 2 + 3.1, -depth / 2 + 4.2, {
      scale: 0.92, radius: 0.65,
    }));
  }
  plan.paths.push(
    { id: 'entry-path', role: 'entry', width: 1.7, points: [point(0, depth / 2 - 1), point(0, innerSouth + 1)] },
    { id: 'worship-path', role: 'worship', width: 1.45, points: [point(axisX, innerSouth - 1), point(axisX, mainZ + 5.2)] },
  );
  plan.solarAccess = {
    role: 'main-hall', origin: point(axisX, mainZ + 5.1),
    halfWidth: 9.7, southZ: round(depth / 2),
  };
}

export function planTempleCompound(options = {}) {
  const seed = (finite(options.seed, 1) >>> 0);
  const variant = TEMPLE_VARIANTS.includes(options.variant) ? options.variant : 'compact';
  const spec = TEMPLE_VARIANT_SPECS[variant];
  const width = clamp(finite(options.width, spec.width), spec.min, spec.max);
  const depth = clamp(finite(options.depth, spec.depth), spec.min, spec.max);
  const rng = makeRng((seed ^ 0x7e6d1e) >>> 0);
  const entryProfile = options.entryProfile === 'mountain' || options.profile === 'mountain'
    ? 'mountain'
    : 'flat';
  const settings = {
    hallCount: clamp(Math.round(finite(options.hallCount, spec.maxHalls)), spec.minHalls, spec.maxHalls),
    axisBend: round(clamp(finite(options.axisBend, rng.range(-0.55, 0.55)), -1, 1)),
    courtScale: round(clamp(finite(options.courtScale, 1), 0.82, 1.18)),
    includeBellPavilion: options.includeBellPavilion !== false,
    pagoda: ['auto', 'none', 'single', 'pair'].includes(options.pagoda) ? options.pagoda : 'auto',
    stoneLanterns: clamp(Math.round(finite(options.stoneLanterns, variant === 'extended' ? 2 : 1)), 0, 2),
    includeDanggan: options.includeDanggan ?? (variant !== 'compact'),
    includeBudo: options.includeBudo ?? (variant === 'extended'),
    entryProfile,
  };
  // The 22m solo precinct is a deliberate hermitage: its optional yosa only
  // appears once the wall has enough lateral breathing room.
  if (variant === 'compact' && Math.min(width, depth) < 25) settings.hallCount = 1;
  const plan = commonPlan(seed, variant, width, depth, settings);
  if (variant === 'compact') planCompact(plan);
  else if (variant === 'courtyard') planCourtyard(plan);
  else planExtended(plan);
  // Gate | stair-apron | pass-under | court is owned here so village adapters
  // and editors cannot invent a second processional grammar.
  applyTempleEntrySequence(plan, { profile: entryProfile });
  return plan;
}

function buildingPolygon(building) {
  if (building.eaveFootprint?.polygon?.length === 4) return building.eaveFootprint.polygon;
  const width = building.footprint?.width || 0;
  const depth = building.footprint?.depth || 0;
  return rect(building.position.x, building.position.z, width, depth);
}

function polygonBounds(polygon) {
  const xs = polygon.map((corner) => corner.x);
  const zs = polygon.map((corner) => corner.z);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

const boxesOverlap = (a, b, gap = 0) => a.minX < b.maxX + gap && a.maxX > b.minX - gap
  && a.minZ < b.maxZ + gap && a.maxZ > b.minZ - gap;

function polygonAxes(polygon) {
  return polygon.map((corner, index) => {
    const next = polygon[(index + 1) % polygon.length];
    const dx = next.x - corner.x;
    const dz = next.z - corner.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: -dz / length, z: dx / length };
  });
}

function projection(polygon, axis) {
  const values = polygon.map((corner) => corner.x * axis.x + corner.z * axis.z);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function polygonsOverlap(a, b, gap = 0) {
  for (const axis of [...polygonAxes(a), ...polygonAxes(b)]) {
    const pa = projection(a, axis);
    const pb = projection(b, axis);
    if (pa.max + gap <= pb.min || pb.max + gap <= pa.min) return false;
  }
  return true;
}

function pointInPolygon(pointValue, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.z > pointValue.z) !== (b.z > pointValue.z))
      && pointValue.x < (b.x - a.x) * (pointValue.z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointSegmentDistance(pointValue, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const denom = dx * dx + dz * dz;
  const t = denom > 1e-12
    ? clamp(((pointValue.x - a.x) * dx + (pointValue.z - a.z) * dz) / denom, 0, 1)
    : 0;
  return Math.hypot(pointValue.x - (a.x + dx * t), pointValue.z - (a.z + dz * t));
}

function circleIntersectsPolygon(center, radius, polygon) {
  if (pointInPolygon(center, polygon)) return true;
  return polygon.some((corner, index) =>
    pointSegmentDistance(center, corner, polygon[(index + 1) % polygon.length]) <= radius);
}

// Lightweight invariant helper used by Node gates and downstream consumers.
// It deliberately checks semantic safety (bounds, overlaps, south-light lane)
// without importing THREE or the village geometry package.
export function templePlanIssues(plan) {
  const issues = [];
  const bounds = plan.bounds;
  const buildings = plan.buildings.map((building) => {
    const polygon = buildingPolygon(building);
    return { building, polygon, box: polygonBounds(polygon) };
  });
  for (const { building, polygon, box } of buildings) {
    if (!completeHallArchitecture(building)) {
      issues.push(`${building.id}: architectural hierarchy is incomplete`);
    } else if (!hallEaveMatches(building)) {
      issues.push(`${building.id}: eave footprint drifted from architecture`);
    }
    if (box.minX < bounds.minX + 0.6 || box.maxX > bounds.maxX - 0.6
      || box.minZ < bounds.minZ + 0.6 || box.maxZ > bounds.maxZ - 0.6) {
      issues.push(`${building.id}: footprint leaves precinct`);
    }
  }
  for (let i = 0; i < buildings.length; i++) for (let j = i + 1; j < buildings.length; j++) {
    if (boxesOverlap(buildings[i].box, buildings[j].box, 0.45)
      && polygonsOverlap(buildings[i].polygon, buildings[j].polygon, 0.45)) {
      issues.push(`${buildings[i].building.id}/${buildings[j].building.id}: building eaves overlap`);
    }
  }
  for (const item of plan.props) {
    if (item.position.x - item.radius < bounds.minX || item.position.x + item.radius > bounds.maxX
      || item.position.z - item.radius < bounds.minZ || item.position.z + item.radius > bounds.maxZ) {
      issues.push(`${item.id}: prop leaves precinct`);
    }
    for (const { building, box, polygon } of buildings) {
      if (item.position.x + item.radius > box.minX && item.position.x - item.radius < box.maxX
        && item.position.z + item.radius > box.minZ && item.position.z - item.radius < box.maxZ
        && circleIntersectsPolygon(item.position, item.radius, polygon)) {
        issues.push(`${item.id}/${building.id}: prop overlaps building eave`);
      }
    }
  }
  const solar = plan.solarAccess;
  if (solar) {
    const lane = {
      minX: solar.origin.x - solar.halfWidth, maxX: solar.origin.x + solar.halfWidth,
      minZ: solar.origin.z, maxZ: solar.southZ,
    };
    const lanePolygon = rect(
      solar.origin.x,
      (solar.origin.z + solar.southZ) / 2,
      solar.halfWidth * 2,
      solar.southZ - solar.origin.z,
    );
    for (const { building, box, polygon } of buildings) {
      // Open lower corridors (누하) keep the processional axis and winter sun.
      if (templeBuildingIsOpenPassUnder(building)) continue;
      if (building.role !== solar.role && boxesOverlap(lane, box)
        && polygonsOverlap(lanePolygon, polygon)) {
        issues.push(`${building.id}: blocks main-hall south-light lane`);
      }
    }
    for (const item of plan.props) {
      if (item.heightClass !== 'tall') continue;
      const box = {
        minX: item.position.x - item.radius, maxX: item.position.x + item.radius,
        minZ: item.position.z - item.radius, maxZ: item.position.z + item.radius,
      };
      if (boxesOverlap(lane, box)) issues.push(`${item.id}: blocks main-hall south-light lane`);
    }
  }
  for (const issue of templeEntrySequenceIssues(plan)) issues.push(issue);
  return issues;
}
