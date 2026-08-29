import { deepFreeze } from '../core/stable-seed.js';
import { giwaFootprintPoints } from '../layout/giwa-footprint.js';
import { giwaRoofEnvelope } from '../layout/giwa-roof-envelope.js';
import { planResidentialOpenings } from '../layout/residential-openings.js';

export const MJA_HOUSE_PLAN_SCHEMA_VERSION = 1;

// Bounded product archetype, not a national dimension/frequency table.
export const MJA_HOUSE_PLAN_LIMITS = deepFreeze({
  minOuterWidth: 18,
  maxOuterWidth: 22,
  minOuterDepth: 18,
  maxOuterDepth: 18.5,
  dimensionStep: 0.5,
  wingDepth: 3.2,
  minCourtyardWidth: 10,
  minCourtyardDepth: 10,
  gateWidth: 2.4,
  gateHeight: 2.35,
  gateLeafAngle: 1.16,
  southSetback: 1.7,
  roofClearance: 0.3,
  minSourceFitFactor: 0.82,
  minSourceEffectiveScale: 0.76,
  solarAltitude: Math.PI / 6,
  solarTargetLift: 1.5,
  solarHalfWidth: 0.8,
  minSolarMargin: 0.75,
  maxWings: 2,
  maxOpenings: 1,
});

export function rotateMjaLocal(point, yaw) {
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return {
    x: cosine * point.x + sine * point.z,
    z: -sine * point.x + cosine * point.z,
  };
}

export function transformMjaPoints(points, center, yaw) {
  return points.map((point) => {
    const rotated = rotateMjaLocal(point, yaw);
    return { x: center.x + rotated.x, z: center.z + rotated.z };
  });
}

export function makeMjaWing(role, building, center, yaw, roofSystem) {
  const localFootprint = giwaFootprintPoints(building);
  const eaveY = building.podiumTierH + building.columnHeight + 0.35;
  const envelope = giwaRoofEnvelope(localFootprint, { ...building, eaveY });
  return {
    id: `mja:wing:${role}`,
    role,
    roofSystem,
    center: { x: center.x, z: center.z },
    yaw,
    footprint: transformMjaPoints(localFootprint, center, yaw),
    roofFootprint: transformMjaPoints(envelope.footprint, center, yaw),
    roofTopY: envelope.topY,
    building,
  };
}

export function mjaPrimaryOpening(north) {
  const residential = planResidentialOpenings('giwa', north.building, north.building.seed);
  const source = residential.openings.find((candidate) => (
    candidate.kind === 'door' && candidate.primary
  ));
  if (!source) throw new RangeError('mja north anchae has no primary opening');
  const offset = rotateMjaLocal(source.center, north.yaw);
  const tangent = rotateMjaLocal(source.tangent, north.yaw);
  const outward = rotateMjaLocal(source.outward, north.yaw);
  const bottomY = north.building.podiumTierH + 0.02;
  const height = 2.05 * source.heightK;
  return {
    id: 'mja:opening:primary',
    wingId: north.id,
    sourceOpeningId: source.id,
    kind: 'door',
    role: 'primary',
    center: {
      x: north.center.x + offset.x,
      y: bottomY + height * 0.5,
      z: north.center.z + offset.z,
    },
    bottomY,
    tangent,
    outward,
    width: source.width,
    height,
  };
}

export function mjaRoofBounds(roofFootprints) {
  const points = roofFootprints.flat();
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minZ: Math.min(bounds.minZ, point.z),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  });
}
