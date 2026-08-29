import * as G from '../core/math/geom2.js';
import { giwaFootprintPoints } from '../layout/giwa-footprint.js';
import { giwaRoofEnvelope } from '../layout/giwa-roof-envelope.js';
import {
  MJA_HOUSE_PLAN_LIMITS,
  MJA_HOUSE_PLAN_SCHEMA_VERSION,
  mjaPrimaryOpening,
  mjaRoofBounds,
  transformMjaPoints,
} from './mja-house-plan-core.js';

const EPSILON = 1e-8;
const REQUIRED_ROLES = Object.freeze(['north-anchae', 'courtyard-wing']);

function rectangle(minX, maxX, minZ, maxZ) {
  return [
    { x: minX, z: maxZ },
    { x: maxX, z: maxZ },
    { x: maxX, z: minZ },
    { x: minX, z: minZ },
  ];
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function assertPoint(point, label, withY = false) {
  finite(point?.x, `${label}.x`);
  finite(point?.z, `${label}.z`);
  if (withY) finite(point?.y, `${label}.y`);
}

function assertPolygon(polygon, label) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new TypeError(`${label} must be a polygon`);
  }
  polygon.forEach((point, index) => assertPoint(point, `${label}[${index}]`));
}

function equalNumber(actual, expected, label) {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new RangeError(`${label} drifted from its derived value`);
  }
}

function equalPoint(actual, expected, label, withY = false) {
  assertPoint(actual, label, withY);
  equalNumber(actual.x, expected.x, `${label}.x`);
  equalNumber(actual.z, expected.z, `${label}.z`);
  if (withY) equalNumber(actual.y, expected.y, `${label}.y`);
}

function equalPolygon(actual, expected, label) {
  assertPolygon(actual, label);
  if (actual.length !== expected.length) throw new RangeError(`${label} length drifted`);
  actual.forEach((point, index) => equalPoint(point, expected[index], `${label}[${index}]`));
}

function pointPolygonClearance(point, polygon) {
  if (!G.pointInPoly(point, polygon)) return -Infinity;
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index++) {
    distance = Math.min(
      distance,
      G.distToSeg(point, polygon[index], polygon[(index + 1) % polygon.length]).d,
    );
  }
  return distance;
}

function polygonFits(inner, outer, clearance) {
  return inner.every((point) => (
    pointPolygonClearance(point, outer) >= clearance - EPSILON
  ));
}

function validateWing(wing, role) {
  if (wing?.id !== `mja:wing:${role}` || wing.role !== role) {
    throw new RangeError(`mja wing role ${role} is missing`);
  }
  const expectedRoofSystem = role === 'north-anchae' ? 'independent-paljak' : 'continuous-u';
  if (wing.roofSystem !== expectedRoofSystem) throw new RangeError(`${role} roof system is invalid`);
  const localFootprint = giwaFootprintPoints(wing.building);
  equalPolygon(
    wing.footprint,
    transformMjaPoints(localFootprint, wing.center, wing.yaw),
    `${role}.footprint`,
  );
  const envelope = giwaRoofEnvelope(localFootprint, {
    ...wing.building,
    eaveY: wing.building.podiumTierH + wing.building.columnHeight + 0.35,
  });
  equalPolygon(
    wing.roofFootprint,
    transformMjaPoints(envelope.footprint, wing.center, wing.yaw),
    `${role}.roofFootprint`,
  );
  equalNumber(wing.roofTopY, envelope.topY, `${role}.roofTopY`);
  if (role === 'north-anchae' && wing.building.planShape !== 'single') {
    throw new RangeError('north anchae must remain a single paljak bar');
  }
  if (role === 'courtyard-wing'
    && (wing.building.planShape !== 'u'
      || wing.building.throughPassage?.enabled !== true
      || wing.building.throughPassage.width !== MJA_HOUSE_PLAN_LIMITS.gateWidth
      || wing.building.throughPassage.height !== MJA_HOUSE_PLAN_LIMITS.gateHeight
      || wing.building.throughPassage.leafAngle !== MJA_HOUSE_PLAN_LIMITS.gateLeafAngle)) {
    throw new RangeError('courtyard wing must own the integrated middle gate');
  }
}

export function validateMjaHousePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('mja house plan must be an object');
  if (plan.schema !== MJA_HOUSE_PLAN_SCHEMA_VERSION || plan.kind !== 'mja-banga') {
    throw new RangeError(`mja house schema must be ${MJA_HOUSE_PLAN_SCHEMA_VERSION}`);
  }
  if (plan.frame?.space !== 'parcel-local'
    || plan.frame?.xAxis !== 'east-right'
    || plan.frame?.zAxis !== 'south-front'
    || plan.frame?.yDatum !== 'parcel-base-relative'
    || plan.frame?.front?.x !== 0 || plan.frame?.front?.z !== 1) {
    throw new RangeError('mja house frame is unsupported');
  }
  if (plan.composition?.north !== 'independent-paljak-anchae'
    || plan.composition?.south !== 'continuous-u-wings-with-integrated-middle-gate') {
    throw new RangeError('mja composition contract is unsupported');
  }
  for (const field of ['region', 'climate', 'household']) {
    if (typeof plan.context?.[field]?.id !== 'string' || !plan.context[field].id
      || typeof plan.context[field].raw !== 'string' || !plan.context[field].raw) {
      throw new TypeError(`mja context.${field} must preserve id and raw text`);
    }
  }
  if (plan.context?.enabled !== true || plan.context?.form !== 'mja') {
    throw new RangeError('mja context must be explicitly enabled');
  }
  if (!Array.isArray(plan.wings) || plan.wings.length !== MJA_HOUSE_PLAN_LIMITS.maxWings) {
    throw new RangeError('mja house must expose exactly two roof systems');
  }
  REQUIRED_ROLES.forEach((role, index) => validateWing(plan.wings[index], role));
  const [north, courtyardWing] = plan.wings;
  if (!Array.isArray(plan.openings) || plan.openings.length !== 1) {
    throw new RangeError('mja house must expose one authoritative focus opening');
  }
  const expectedOpening = mjaPrimaryOpening(north);
  const primary = plan.openings[0];
  if (plan.primaryOpeningId !== expectedOpening.id
    || primary.id !== expectedOpening.id
    || primary.wingId !== north.id
    || primary.role !== 'primary'
    || primary.kind !== 'door'
    || primary.sourceOpeningId !== expectedOpening.sourceOpeningId) {
    throw new RangeError('mja primary opening identity is invalid');
  }
  equalPoint(primary.center, expectedOpening.center, 'mja primary opening center', true);
  equalPoint(primary.tangent, expectedOpening.tangent, 'mja primary opening tangent');
  equalPoint(primary.outward, expectedOpening.outward, 'mja primary opening outward');
  equalNumber(primary.bottomY, expectedOpening.bottomY, 'mja primary opening bottom');
  equalNumber(primary.width, expectedOpening.width, 'mja primary opening width');
  equalNumber(primary.height, expectedOpening.height, 'mja primary opening height');

  const outer = plan.bounds?.outer;
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ', 'width', 'depth']) {
    finite(outer?.[key], `mja bounds.outer.${key}`);
  }
  equalNumber(outer.width, outer.maxX - outer.minX, 'mja outer width');
  equalNumber(outer.depth, outer.maxZ - outer.minZ, 'mja outer depth');
  if (outer.width < MJA_HOUSE_PLAN_LIMITS.minOuterWidth
    || outer.width > MJA_HOUSE_PLAN_LIMITS.maxOuterWidth
    || outer.depth < MJA_HOUSE_PLAN_LIMITS.minOuterDepth
    || outer.depth > MJA_HOUSE_PLAN_LIMITS.maxOuterDepth) {
    throw new RangeError('mja outer bounds are unsupported');
  }
  const expectedRoofBounds = mjaRoofBounds(plan.wings.map((wing) => wing.roofFootprint));
  for (const key of ['minX', 'maxX', 'minZ', 'maxZ']) {
    equalNumber(plan.bounds?.roof?.[key], expectedRoofBounds[key], `mja roof bounds.${key}`);
  }
  assertPolygon(plan.source?.parcelPolygon, 'mja source parcel');
  for (const wing of plan.wings) {
    if (!polygonFits(
      wing.roofFootprint,
      plan.source.parcelPolygon,
      MJA_HOUSE_PLAN_LIMITS.roofClearance,
    )) throw new RangeError('mja roof left its fitted parcel');
  }

  const expectedCourtyard = {
    minX: outer.minX + MJA_HOUSE_PLAN_LIMITS.wingDepth,
    maxX: outer.maxX - MJA_HOUSE_PLAN_LIMITS.wingDepth,
    minZ: outer.minZ + MJA_HOUSE_PLAN_LIMITS.wingDepth,
    maxZ: outer.maxZ - MJA_HOUSE_PLAN_LIMITS.wingDepth,
  };
  equalPolygon(plan.courtyard?.polygon, rectangle(
    expectedCourtyard.minX,
    expectedCourtyard.maxX,
    expectedCourtyard.minZ,
    expectedCourtyard.maxZ,
  ), 'mja courtyard');
  equalNumber(plan.courtyard.width, expectedCourtyard.maxX - expectedCourtyard.minX,
    'mja courtyard width');
  equalNumber(plan.courtyard.depth, expectedCourtyard.maxZ - expectedCourtyard.minZ,
    'mja courtyard depth');
  equalPoint(plan.courtyard.center, {
    x: (expectedCourtyard.minX + expectedCourtyard.maxX) * 0.5,
    y: 0,
    z: (expectedCourtyard.minZ + expectedCourtyard.maxZ) * 0.5,
  }, 'mja courtyard center', true);
  equalNumber(north.building.mainHalfW * 2, plan.courtyard.width,
    'mja north anchae width');
  equalNumber(north.building.mainHalfD * 2, MJA_HOUSE_PLAN_LIMITS.wingDepth,
    'mja north anchae depth');
  equalPoint(north.center, {
    x: plan.frame.origin.x,
    z: outer.minZ + MJA_HOUSE_PLAN_LIMITS.wingDepth * 0.5,
  }, 'mja north anchae center');
  equalNumber(north.yaw, 0, 'mja north anchae yaw');
  equalNumber(courtyardWing.building.mainHalfW * 2, outer.width,
    'mja courtyard wing width');
  equalNumber(courtyardWing.building.mainHalfD * 2, MJA_HOUSE_PLAN_LIMITS.wingDepth,
    'mja courtyard wing depth');
  equalNumber(courtyardWing.building.wingW, MJA_HOUSE_PLAN_LIMITS.wingDepth,
    'mja courtyard side-wing width');
  equalNumber(courtyardWing.building.wingLen, plan.courtyard.depth,
    'mja courtyard side-wing length');
  equalPoint(courtyardWing.center, {
    x: plan.frame.origin.x,
    z: outer.maxZ - MJA_HOUSE_PLAN_LIMITS.wingDepth * 0.5,
  }, 'mja courtyard wing center');
  equalNumber(courtyardWing.yaw, Math.PI, 'mja courtyard wing yaw');

  if (plan.gate?.id !== 'mja:gate:south'
    || plan.gate.kind !== 'integrated-middle-gate'
    || plan.gate.wingId !== courtyardWing.id
    || plan.gate.roofSystem !== courtyardWing.roofSystem
    || plan.gate.width !== MJA_HOUSE_PLAN_LIMITS.gateWidth
    || plan.gate.height !== MJA_HOUSE_PLAN_LIMITS.gateHeight
    || plan.gate.heightKind !== 'clear-opening'
    || plan.gate.yaw !== 0
    || plan.gate.outward?.x !== 0
    || plan.gate.outward?.z !== 1) {
    throw new RangeError('mja integrated middle gate is invalid');
  }
  equalPoint(plan.gate.center, { x: plan.frame.origin.x, y: 0, z: outer.maxZ },
    'mja gate center', true);
  assertPoint(plan.gate.parcelGate, 'mja parcel gate');
  assertPoint(plan.gate.roadPoint, 'mja road point');
  assertPoint(plan.gate.roadAxis, 'mja road axis');
  if (Math.abs(plan.gate.center.x - plan.gate.parcelGate.x) > EPSILON
    || plan.gate.parcelGate.z <= plan.gate.center.z) {
    throw new RangeError('mja middle gate must retain its south parcel access');
  }
  const expectedRoadAxis = G.norm(G.sub(plan.gate.roadPoint, plan.gate.parcelGate));
  equalPoint(plan.gate.roadAxis, expectedRoadAxis, 'mja road axis');
  if (plan.gate.roadAxis.z < Math.SQRT1_2) {
    throw new RangeError('mja road approach must remain south-facing');
  }
  equalNumber(plan.gate.roofTopY, courtyardWing.roofTopY, 'mja gate roof top');
  equalPolygon(plan.gate.passage, rectangle(
    plan.gate.center.x - plan.gate.width * 0.5,
    plan.gate.center.x + plan.gate.width * 0.5,
    expectedCourtyard.maxZ,
    outer.maxZ,
  ), 'mja gate passage');
  equalPoint(plan.gate.approach?.from, plan.gate.center, 'mja gate approach.from');
  equalPoint(plan.gate.approach?.to, plan.gate.parcelGate, 'mja gate approach.to');
  equalPoint(plan.gate.approach?.axis, { x: 0, z: 1 }, 'mja gate approach.axis');
  equalNumber(
    plan.gate.approach?.length,
    G.dist(plan.gate.approach.from, plan.gate.approach.to),
    'mja gate approach.length',
  );

  equalPoint(plan.solarTarget?.point, {
    x: primary.center.x,
    y: MJA_HOUSE_PLAN_LIMITS.solarTargetLift,
    z: primary.center.z,
  }, 'mja solar target', true);
  equalPolygon(plan.solarTarget?.corridor, rectangle(
    primary.center.x - MJA_HOUSE_PLAN_LIMITS.solarHalfWidth,
    primary.center.x + MJA_HOUSE_PLAN_LIMITS.solarHalfWidth,
    primary.center.z,
    expectedCourtyard.maxZ,
  ), 'mja solar corridor');
  if (plan.solarTarget.openingId !== primary.id
    || plan.solarTarget.direction?.x !== 0 || plan.solarTarget.direction?.z !== 1
    || plan.solarTarget.altitude !== MJA_HOUSE_PLAN_LIMITS.solarAltitude) {
    throw new RangeError('mja winter solar target is invalid');
  }
  equalNumber(plan.solarTarget.southRoofTopY, courtyardWing.roofTopY,
    'mja south roof top');
  const expectedReach = Math.max(
    0,
    (courtyardWing.roofTopY - MJA_HOUSE_PLAN_LIMITS.solarTargetLift)
      / Math.tan(MJA_HOUSE_PLAN_LIMITS.solarAltitude),
  );
  equalNumber(plan.solarTarget.shadowReach, expectedReach, 'mja solar shadow reach');
  equalNumber(plan.solarTarget.clearDepth, plan.courtyard.depth, 'mja solar clear depth');
  equalNumber(plan.solarTarget.margin, plan.courtyard.depth - expectedReach, 'mja solar margin');
  if (plan.solarTarget.margin < MJA_HOUSE_PLAN_LIMITS.minSolarMargin) {
    throw new RangeError('mja winter solar margin is too small');
  }
  return plan;
}
