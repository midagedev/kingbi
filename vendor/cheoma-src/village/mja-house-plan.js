import { deepFreeze } from '../core/stable-seed.js';
import { hashString } from '../rng.js';
import * as G from '../core/math/geom2.js';
import { parcelLocalPoint } from './parcel-contract.js';
import {
  MJA_HOUSE_PLAN_LIMITS,
  MJA_HOUSE_PLAN_SCHEMA_VERSION,
  makeMjaWing,
  mjaPrimaryOpening,
  mjaRoofBounds,
} from './mja-house-plan-core.js';

export {
  MJA_HOUSE_PLAN_LIMITS,
  MJA_HOUSE_PLAN_SCHEMA_VERSION,
} from './mja-house-plan-core.js';
export { validateMjaHousePlan } from './mja-house-plan-contract.js';

const EPSILON = 1e-8;
const SOUTH = Object.freeze({ x: 0, z: 1 });

const finitePoint = (point) => Number.isFinite(point?.x) && Number.isFinite(point?.z);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function rectangle(minX, maxX, minZ, maxZ) {
  return [
    { x: minX, z: maxZ },
    { x: maxX, z: maxZ },
    { x: maxX, z: minZ },
    { x: minX, z: minZ },
  ];
}

function cleanPolygon(points) {
  const polygon = [];
  for (const point of points || []) {
    if (!finitePoint(point)) continue;
    const copy = { x: point.x, z: point.z };
    if (!polygon.length || G.dist2(polygon.at(-1), copy) > EPSILON * EPSILON) {
      polygon.push(copy);
    }
  }
  if (polygon.length > 2 && G.dist2(polygon[0], polygon.at(-1)) <= EPSILON * EPSILON) {
    polygon.pop();
  }
  return polygon;
}

function contextMetadata(value) {
  const rawValue = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (value.raw ?? value.label ?? value.id)
      : null;
  if (typeof rawValue !== 'string' || !rawValue.trim()) return null;
  const raw = rawValue.trim();
  const requestedId = value && typeof value === 'object' && typeof value.id === 'string'
    ? value.id.trim()
    : raw;
  const id = requestedId.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return id ? { id, raw } : null;
}

function normalizeContext(context) {
  if (context?.enabled !== true || context?.form !== 'mja') return null;
  const region = contextMetadata(context.region);
  const climate = contextMetadata(context.climate);
  const household = contextMetadata(context.household);
  return region && climate && household
    ? { enabled: true, form: 'mja', region, climate, household }
    : null;
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

function localRoadPoint(parcel) {
  const roadPoint = parcel?.access?.roadPoint;
  if (!finitePoint(roadPoint) || !finitePoint(parcel?.center) || !finitePoint(parcel?.frontDir)) {
    return null;
  }
  return parcelLocalPoint(parcel, roadPoint);
}

function fittedParcelFrame(parcel) {
  const polygon = cleanPolygon(parcel?.shape?.pts);
  const gate = parcel?.access?.gateLocalPoint;
  const road = localRoadPoint(parcel);
  const effectiveScale = Math.min(parcel?.sx, parcel?.sy, parcel?.sz);
  if (parcel?.kind !== 'giwa'
    || typeof parcel?.id !== 'string' || !parcel.id
    || polygon.length < 3
    || !finitePoint(parcel?.houseLocal)
    || !Number.isFinite(parcel?.houseFitFactor)
    || parcel.houseFitFactor < MJA_HOUSE_PLAN_LIMITS.minSourceFitFactor
    || !Number.isFinite(effectiveScale)
    || effectiveScale < MJA_HOUSE_PLAN_LIMITS.minSourceEffectiveScale
    || parcel?.access?.gateRole !== 'front'
    || !finitePoint(gate)
    || !finitePoint(road)) return null;
  const gateToRoad = G.norm(G.sub(road, gate));
  const maxZ = Math.max(...polygon.map((point) => point.z));
  if (gateToRoad.z < Math.SQRT1_2 || Math.abs(gate.z - maxZ) > 1e-6) return null;
  return {
    polygon,
    gate: { x: gate.x, z: gate.z },
    road,
    gateToRoad,
    effectiveScale,
  };
}

function wingSeed(parcel, role) {
  const source = Number.isFinite(parcel.seed) ? parcel.seed >>> 0 : hashString(parcel.id);
  return (source ^ hashString(`mja-wing-v2:${role}`)) >>> 0;
}

function sharedRoofParams() {
  return {
    roofType: 'skeleton',
    profileCurve: 0.5,
    doorWidthK: 0.88,
    windowWidthK: 0.48,
    doorHeightK: 1,
    windowHeightK: 1,
  };
}

function northBuilding(parcel, width, depth) {
  const bays = clamp(Math.round(width / 2.7), 3, 5);
  return {
    ...sharedRoofParams(),
    label: 'Korea · Opt-in courtyard house · north anchae',
    seed: wingSeed(parcel, 'north-anchae'),
    style: 'giwa',
    planShape: 'single',
    bays,
    mainHalfW: width * 0.5,
    mainHalfD: depth * 0.5,
    wingW: 1.6,
    wingLen: 2.6,
    bay: clamp(width / bays, 1.8, 3.6),
    columnHeight: 3,
    columnRadius: 0.16,
    entasis: 0.25,
    podiumTierH: 0.5,
    eaveOverhang: 0.85,
    riseScale: 0.8,
    cornerLift: 0.42,
    planCurve: 0.28,
    ridgeH: 0.38,
    doorCount: 2,
    windowCount: 3,
  };
}

function courtyardWingBuilding(parcel, width, depth) {
  const wingDepth = MJA_HOUSE_PLAN_LIMITS.wingDepth;
  return {
    ...sharedRoofParams(),
    label: 'Korea · Opt-in courtyard house · continuous wings and middle gate',
    seed: wingSeed(parcel, 'courtyard-wing'),
    style: 'giwa',
    planShape: 'u',
    bays: 5,
    mainHalfW: width * 0.5,
    mainHalfD: wingDepth * 0.5,
    wingW: wingDepth,
    wingLen: depth - wingDepth * 2,
    // Odd, aligned divisions put one structural bay on the compound centreline.
    bay: clamp(width / 7, 1.8, 3.6),
    columnHeight: 2.62,
    columnRadius: 0.15,
    entasis: 0.2,
    podiumTierH: 0.4,
    eaveOverhang: 0.68,
    riseScale: 0.68,
    cornerLift: 0.28,
    planCurve: 0.16,
    ridgeH: 0.32,
    doorCount: 3,
    windowCount: 4,
    throughPassage: {
      enabled: true,
      width: MJA_HOUSE_PLAN_LIMITS.gateWidth,
      height: MJA_HOUSE_PLAN_LIMITS.gateHeight,
      leafAngle: MJA_HOUSE_PLAN_LIMITS.gateLeafAngle,
    },
  };
}

function compoundGeometry(parcel, frame, width, depth) {
  const wingDepth = MJA_HOUSE_PLAN_LIMITS.wingDepth;
  const maxZ = frame.gate.z - MJA_HOUSE_PLAN_LIMITS.southSetback;
  const minZ = maxZ - depth;
  const centerX = frame.gate.x;
  const north = makeMjaWing(
    'north-anchae',
    // The north hall closes the open end between the two side wings; it does
    // not span over their full roof widths. This makes the two systems meet at
    // their corners instead of interpenetrating across an entire hip.
    northBuilding(parcel, width - wingDepth * 2, wingDepth),
    { x: centerX, z: minZ + wingDepth * 0.5 },
    0,
    'independent-paljak',
  );
  const courtyardWing = makeMjaWing(
    'courtyard-wing',
    courtyardWingBuilding(parcel, width, depth),
    { x: centerX, z: maxZ - wingDepth * 0.5 },
    Math.PI,
    'continuous-u',
  );
  const courtyard = {
    minX: centerX - width * 0.5 + wingDepth,
    maxX: centerX + width * 0.5 - wingDepth,
    minZ: minZ + wingDepth,
    maxZ: maxZ - wingDepth,
  };
  return {
    outer: {
      minX: centerX - width * 0.5,
      maxX: centerX + width * 0.5,
      minZ,
      maxZ,
      width,
      depth,
    },
    courtyard,
    wings: [north, courtyardWing],
    roofFootprints: [north.roofFootprint, courtyardWing.roofFootprint],
  };
}

function approachFits(frame, geometry) {
  const from = { x: frame.gate.x, z: geometry.outer.maxZ };
  const length = G.dist(from, frame.gate);
  const samples = Math.max(2, Math.ceil(length / 0.4));
  for (let index = 0; index < samples; index++) {
    if (!G.pointInPoly(G.lerp(from, frame.gate, index / samples), frame.polygon)) {
      return false;
    }
  }
  return true;
}

function fitCompound(parcel, frame) {
  const candidates = [];
  for (let width = MJA_HOUSE_PLAN_LIMITS.maxOuterWidth;
    width >= MJA_HOUSE_PLAN_LIMITS.minOuterWidth;
    width -= MJA_HOUSE_PLAN_LIMITS.dimensionStep) {
    for (let depth = MJA_HOUSE_PLAN_LIMITS.maxOuterDepth;
      depth >= MJA_HOUSE_PLAN_LIMITS.minOuterDepth;
      depth -= MJA_HOUSE_PLAN_LIMITS.dimensionStep) {
      candidates.push({ width, depth });
    }
  }
  candidates.sort((a, b) => b.width * b.depth - a.width * a.depth
    || b.width - a.width || b.depth - a.depth);
  for (const candidate of candidates) {
    const geometry = compoundGeometry(parcel, frame, candidate.width, candidate.depth);
    const courtyardWidth = geometry.courtyard.maxX - geometry.courtyard.minX;
    const courtyardDepth = geometry.courtyard.maxZ - geometry.courtyard.minZ;
    if (courtyardWidth < MJA_HOUSE_PLAN_LIMITS.minCourtyardWidth
      || courtyardDepth < MJA_HOUSE_PLAN_LIMITS.minCourtyardDepth
      || !geometry.roofFootprints.every((roof) => (
        polygonFits(roof, frame.polygon, MJA_HOUSE_PLAN_LIMITS.roofClearance)
      ))
      || !approachFits(frame, geometry)) continue;
    return geometry;
  }
  return null;
}

/**
 * Plan one explicitly opted-in enclosed house in parcel-local space.
 *
 * Context fields preserve a caller's historical rationale; physical fit,
 * stored south access, a usable courtyard, and winter solar clearance are the
 * only eligibility decisions. Default-off and unsupported inputs return null.
 */
export function planMjaHouse({ context, parcel } = {}) {
  const normalizedContext = normalizeContext(context);
  const frame = fittedParcelFrame(parcel);
  if (!normalizedContext || !frame) return null;
  const geometry = fitCompound(parcel, frame);
  if (!geometry) return null;
  const north = geometry.wings[0];
  const courtyardWing = geometry.wings[1];
  const primary = mjaPrimaryOpening(north);
  const courtyardWidth = geometry.courtyard.maxX - geometry.courtyard.minX;
  const courtyardDepth = geometry.courtyard.maxZ - geometry.courtyard.minZ;
  const southRoofTopY = courtyardWing.roofTopY;
  const shadowReach = Math.max(
    0,
    (southRoofTopY - MJA_HOUSE_PLAN_LIMITS.solarTargetLift)
      / Math.tan(MJA_HOUSE_PLAN_LIMITS.solarAltitude),
  );
  const solarMargin = courtyardDepth - shadowReach;
  if (solarMargin < MJA_HOUSE_PLAN_LIMITS.minSolarMargin) return null;
  const gateCenter = { x: frame.gate.x, y: 0, z: geometry.outer.maxZ };
  const plan = {
    schema: MJA_HOUSE_PLAN_SCHEMA_VERSION,
    kind: 'mja-banga',
    frame: {
      space: 'parcel-local',
      xAxis: 'east-right',
      zAxis: 'south-front',
      yDatum: 'parcel-base-relative',
      origin: {
        x: (geometry.outer.minX + geometry.outer.maxX) * 0.5,
        z: (geometry.outer.minZ + geometry.outer.maxZ) * 0.5,
      },
      front: { ...SOUTH },
    },
    context: normalizedContext,
    composition: {
      north: 'independent-paljak-anchae',
      south: 'continuous-u-wings-with-integrated-middle-gate',
      evidenceScope: 'samsan-principle-not-measured-reconstruction',
    },
    source: {
      parcelId: parcel.id,
      parcelSeed: Number.isFinite(parcel.seed) ? parcel.seed >>> 0 : hashString(parcel.id),
      parcelPolygon: frame.polygon.map((point) => ({ ...point })),
      sourceHouseLocal: { ...parcel.houseLocal },
      sourceFitFactor: parcel.houseFitFactor,
      sourceScale: { x: parcel.sx, y: parcel.sy, z: parcel.sz },
      rank: Number.isFinite(parcel.rank) ? parcel.rank : null,
      wealth: Number.isFinite(parcel.wealth) ? parcel.wealth : null,
    },
    bounds: {
      outer: { ...geometry.outer },
      roof: mjaRoofBounds(geometry.roofFootprints),
    },
    wings: geometry.wings,
    courtyard: {
      polygon: rectangle(
        geometry.courtyard.minX,
        geometry.courtyard.maxX,
        geometry.courtyard.minZ,
        geometry.courtyard.maxZ,
      ),
      center: {
        x: (geometry.courtyard.minX + geometry.courtyard.maxX) * 0.5,
        y: 0,
        z: (geometry.courtyard.minZ + geometry.courtyard.maxZ) * 0.5,
      },
      width: courtyardWidth,
      depth: courtyardDepth,
    },
    gate: {
      id: 'mja:gate:south',
      kind: 'integrated-middle-gate',
      wingId: courtyardWing.id,
      center: gateCenter,
      yaw: 0,
      outward: { ...SOUTH },
      width: MJA_HOUSE_PLAN_LIMITS.gateWidth,
      height: MJA_HOUSE_PLAN_LIMITS.gateHeight,
      heightKind: 'clear-opening',
      roofSystem: courtyardWing.roofSystem,
      roofTopY: courtyardWing.roofTopY,
      passage: rectangle(
        gateCenter.x - MJA_HOUSE_PLAN_LIMITS.gateWidth * 0.5,
        gateCenter.x + MJA_HOUSE_PLAN_LIMITS.gateWidth * 0.5,
        geometry.courtyard.maxZ,
        geometry.outer.maxZ,
      ),
      parcelGate: { ...frame.gate },
      roadPoint: { ...frame.road },
      roadAxis: { ...frame.gateToRoad },
      approach: {
        from: { x: gateCenter.x, z: gateCenter.z },
        to: { ...frame.gate },
        axis: { ...SOUTH },
        length: frame.gate.z - gateCenter.z,
      },
    },
    openings: [primary],
    primaryOpeningId: primary.id,
    solarTarget: {
      openingId: primary.id,
      point: {
        x: primary.center.x,
        y: MJA_HOUSE_PLAN_LIMITS.solarTargetLift,
        z: primary.center.z,
      },
      direction: { ...SOUTH },
      altitude: MJA_HOUSE_PLAN_LIMITS.solarAltitude,
      corridor: rectangle(
        primary.center.x - MJA_HOUSE_PLAN_LIMITS.solarHalfWidth,
        primary.center.x + MJA_HOUSE_PLAN_LIMITS.solarHalfWidth,
        primary.center.z,
        geometry.courtyard.maxZ,
      ),
      southRoofTopY,
      shadowReach,
      clearDepth: courtyardDepth,
      margin: solarMargin,
    },
  };
  return deepFreeze(plan);
}
