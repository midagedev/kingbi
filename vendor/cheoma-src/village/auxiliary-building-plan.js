import * as G from '../core/math/geom2.js';
import { deepFreeze } from '../core/stable-seed.js';
import { makeRng } from '../rng.js';
import {
  parcelLocalRoofRectangles,
} from './house-footprint.js';
import {
  parcelHouseTranslation,
  parcelSolarAccess,
  parcelWorldPoint,
} from './parcel-contract.js';

// A detached household outbuilding is planned once in parcel-local metres.
// Renderers may simplify its surfaces, but may not reconstruct its placement,
// dimensions, height, or roof role. The dedicated seed window deliberately
// leaves variants.js' established household RNG sequence untouched.
const AUXILIARY_SEED_SALT = 0x41555831;
const AUXILIARY_ROOF_OVERHANG = 0.28;
const AUXILIARY_ROOF_RISE = 0.6;
const AUXILIARY_MAX_YAW = 0.1;
const AUXILIARY_PARCEL_CLEARANCE = 0.18;
const AUXILIARY_ROOF_GAP = 0.22;
const AUXILIARY_PLACEMENT_PAD = 0.04;
const AUXILIARY_GATE_GAP = 0.82;
const AUXILIARY_HARD_GAP = 0.12;
const SOLAR_ALTITUDE = Math.PI / 6;
const SOLAR_TARGET_LIFT = 1.5;
const EPSILON = 1e-8;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rectangle(x, z, halfWidth, halfDepth) {
  return [
    { x: x - halfWidth, z: z - halfDepth },
    { x: x + halfWidth, z: z - halfDepth },
    { x: x + halfWidth, z: z + halfDepth },
    { x: x - halfWidth, z: z + halfDepth },
  ];
}

function rotatePoint(point, yaw, center) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    x: center.x + point.x * c + point.z * s,
    z: center.z - point.x * s + point.z * c,
  };
}

function roofFootprint(local, body, roof) {
  const halfWidth = body.width * 0.5 + roof.overhang;
  const halfDepth = body.depth * 0.5 + roof.overhang;
  return rectangle(0, 0, halfWidth, halfDepth)
    .map((point) => rotatePoint(point, local.yaw, local));
}

function roofPolygons(parcel) {
  const edited = parcel?.editRoofBounds;
  if ([edited?.minX, edited?.maxX, edited?.minZ, edited?.maxZ]
    .every(Number.isFinite)
    && edited.maxX > edited.minX
    && edited.maxZ > edited.minZ) {
    return [rectangle(
      (edited.minX + edited.maxX) * 0.5,
      (edited.minZ + edited.maxZ) * 0.5,
      (edited.maxX - edited.minX) * 0.5,
      (edited.maxZ - edited.minZ) * 0.5,
    )];
  }
  return parcelLocalRoofRectangles(parcel).map((roof) => rectangle(
    (roof.minX + roof.maxX) * 0.5,
    (roof.minZ + roof.maxZ) * 0.5,
    (roof.maxX - roof.minX) * 0.5,
    (roof.maxZ - roof.minZ) * 0.5,
  ));
}

function polygonDistance(a, b) {
  if (G.polysOverlap(a, b)) return 0;
  let distance = Infinity;
  for (let index = 0; index < a.length; index++) {
    distance = Math.min(
      distance,
      G.segmentPolygonDistance(a[index], a[(index + 1) % a.length], b),
    );
  }
  return distance;
}

function polygonInsideParcel(polygon, parcelPolygon, clearance) {
  if (!Array.isArray(parcelPolygon) || parcelPolygon.length < 3) return false;
  return polygon.every((point) => {
    if (!G.pointInPoly(point, parcelPolygon)) return false;
    for (let index = 0; index < parcelPolygon.length; index++) {
      if (G.distToSeg(
        point,
        parcelPolygon[index],
        parcelPolygon[(index + 1) % parcelPolygon.length],
      ).d < clearance - EPSILON) return false;
    }
    return true;
  });
}

function polygonIntersectsCircle(polygon, obstacle, gap) {
  const center = { x: obstacle.x, z: obstacle.z };
  if (G.pointInPoly(center, polygon)) return true;
  const limit = Math.max(0, finite(obstacle.radius)) + gap;
  for (let index = 0; index < polygon.length; index++) {
    if (G.distToSeg(
      center,
      polygon[index],
      polygon[(index + 1) % polygon.length],
    ).d <= limit) return true;
  }
  return false;
}

function obstaclePolygon(obstacle) {
  if (obstacle?.shape === 'polygon') {
    return (obstacle.points || obstacle.footprint || []).map((point) => ({
      x: point.x,
      z: point.z,
    }));
  }
  if (obstacle?.shape !== 'rect') return null;
  return rectangle(
    obstacle.x,
    obstacle.z,
    Math.max(0, finite(obstacle.halfWidth)),
    Math.max(0, finite(obstacle.halfDepth)),
  );
}

function intersectsHardObstacle(polygon, obstacles) {
  for (const obstacle of obstacles || []) {
    if (!obstacle || obstacle.kind === 'aux'
      || obstacle.kind === 'auxiliary-building') continue;
    if (obstacle.shape === 'circle') {
      if (polygonIntersectsCircle(polygon, obstacle, AUXILIARY_HARD_GAP)) return true;
      continue;
    }
    const other = obstaclePolygon(obstacle);
    if (other?.length >= 3
      && polygonDistance(polygon, other) <= AUXILIARY_HARD_GAP) return true;
  }
  return false;
}

function roofBounds(polygons) {
  const points = polygons.flat();
  if (!points.length) return null;
  return G.boundsOfPts(points);
}

function gateApproach(parcel, mainRoofBounds) {
  const house = parcelHouseTranslation(parcel);
  const start = { x: house.x, z: mainRoofBounds.maxZ + 0.15 };
  const stored = parcel.access?.gateLocalPoint;
  if (Number.isFinite(stored?.x) && Number.isFinite(stored?.z)) {
    return { start, gate: { x: stored.x, z: stored.z } };
  }
  const front = parcel.shape?.pts?.reduce(
    (best, point) => !best || point.z > best.z ? point : best,
    null,
  );
  return {
    start,
    gate: front ? { x: 0, z: front.z } : { x: 0, z: finite(parcel.plotD, 10) * 0.5 },
  };
}

function localSolarPolygon(parcel, roofTopY) {
  const access = parcel.solarAccess || parcelSolarAccess(parcel);
  const shadowLength = Math.max(
    0,
    (roofTopY - SOLAR_TARGET_LIFT) / Math.tan(SOLAR_ALTITUDE),
  );
  if (shadowLength <= EPSILON) return null;
  const localEnd = Math.min(access.localEnd, access.localStart + shadowLength);
  if (localEnd <= access.localStart + EPSILON) return null;
  return rectangle(
    0,
    (access.localStart + localEnd) * 0.5,
    access.halfWidth,
    (localEnd - access.localStart) * 0.5,
  );
}

function parcelGroundY(parcel, site) {
  if (Number.isFinite(parcel?.baseY)) return parcel.baseY;
  if (Number.isFinite(parcel?.padY)) return parcel.padY;
  if (site?.heightAt && Number.isFinite(parcel?.center?.x)
    && Number.isFinite(parcel?.center?.z)) {
    return site.heightAt(parcel.center.x, parcel.center.z);
  }
  return 0;
}

function peerSolarPolygon(peer, blockerTopY, site) {
  if (!peer?.solarAccess || peer.kind === 'palace') return null;
  const targetY = parcelGroundY(peer, site) + SOLAR_TARGET_LIFT;
  const shadowLength = Math.max(
    0,
    (blockerTopY - targetY) / Math.tan(SOLAR_ALTITUDE),
  );
  if (shadowLength <= EPSILON) return null;
  const access = peer.solarAccess;
  const localEnd = Math.min(access.localEnd, access.localStart + shadowLength);
  if (localEnd <= access.localStart + EPSILON) return null;
  return rectangle(
    0,
    (access.localStart + localEnd) * 0.5,
    access.halfWidth,
    (localEnd - access.localStart) * 0.5,
  ).map((point) => parcelWorldPoint(peer, point));
}

function blocksPeerSolar(parcel, footprint, roofTopY, site, peers) {
  if (!peers?.length) return false;
  const world = footprint.map((point) => parcelWorldPoint(parcel, point));
  const absoluteTop = parcelGroundY(parcel, site) + roofTopY;
  return peers.some((peer) => {
    if (!peer || peer === parcel || (parcel.id != null && peer.id === parcel.id)) return false;
    const corridor = peerSolarPolygon(peer, absoluteTop, site);
    return corridor?.length >= 3 && G.polysOverlap(world, corridor);
  });
}

function candidateCenters(parcel, mainBounds, halfWidth, halfDepth) {
  const parcelBounds = G.boundsOfPts(parcel.shape.pts);
  const edge = AUXILIARY_PARCEL_CLEARANCE;
  const left = parcelBounds.minX + edge + halfWidth;
  const right = parcelBounds.maxX - edge - halfWidth;
  const back = parcelBounds.minZ + edge + halfDepth;
  const front = parcelBounds.maxZ - edge - halfDepth;
  if (left > right || back > front) return [];

  const roofCenterX = (mainBounds.minX + mainBounds.maxX) * 0.5;
  const roofCenterZ = (mainBounds.minZ + mainBounds.maxZ) * 0.5;
  const sideZ = clamp(roofCenterZ, back, front);
  const rearQuarterLeft = clamp(
    roofCenterX - (mainBounds.maxX - mainBounds.minX) * 0.28,
    left,
    right,
  );
  const rearQuarterRight = clamp(
    roofCenterX + (mainBounds.maxX - mainBounds.minX) * 0.28,
    left,
    right,
  );
  const besideLeft = clamp(
    mainBounds.minX - AUXILIARY_ROOF_GAP - AUXILIARY_PLACEMENT_PAD - halfWidth,
    left,
    right,
  );
  const besideRight = clamp(
    mainBounds.maxX + AUXILIARY_ROOF_GAP + AUXILIARY_PLACEMENT_PAD + halfWidth,
    left,
    right,
  );
  const behind = clamp(
    mainBounds.minZ - AUXILIARY_ROOF_GAP - AUXILIARY_PLACEMENT_PAD - halfDepth,
    back,
    front,
  );

  const raw = [
    { x: besideRight, z: sideZ },
    { x: besideLeft, z: sideZ },
    { x: right, z: back },
    { x: left, z: back },
    { x: rearQuarterRight, z: behind },
    { x: rearQuarterLeft, z: behind },
    { x: right, z: clamp(mainBounds.minZ, back, front) },
    { x: left, z: clamp(mainBounds.minZ, back, front) },
  ];
  // Irregular lots often narrow at one nominal corner. A small fixed lattice
  // supplies interior alternatives without shrinking the authored building or
  // turning placement into an unbounded random search.
  for (const zT of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    for (const xT of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      raw.push({
        x: left + (right - left) * xT,
        z: back + (front - back) * zT,
      });
    }
  }
  const seen = new Set();
  return raw.filter((point) => {
    const key = `${point.x.toFixed(6)}:${point.z.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderedCandidates(centers, rng) {
  if (centers.length < 2) return centers;
  const preferRight = rng() >= 0.5;
  const ordered = centers.slice().sort((a, b) => {
    const sideA = preferRight ? -a.x : a.x;
    const sideB = preferRight ? -b.x : b.x;
    if (Math.abs(a.z - b.z) > EPSILON) return a.z - b.z;
    return sideA - sideB;
  });
  return ordered;
}

function validCandidate({
  parcel,
  footprint,
  mainRoofs,
  mainBounds,
  hardObstacles,
  site,
  peers,
  roofTopY,
}) {
  if (!polygonInsideParcel(
    footprint,
    parcel.shape?.pts,
    AUXILIARY_PARCEL_CLEARANCE,
  )) return false;
  if (mainRoofs.some((roof) => (
    polygonDistance(footprint, roof) <= AUXILIARY_ROOF_GAP
  ))) return false;
  const approach = gateApproach(parcel, mainBounds);
  if (G.segmentPolygonDistance(
    approach.start,
    approach.gate,
    footprint,
  ) <= AUXILIARY_GATE_GAP) return false;
  const ownSolar = localSolarPolygon(parcel, roofTopY);
  if (ownSolar && G.polysOverlap(footprint, ownSolar)) return false;
  if (intersectsHardObstacle(footprint, hardObstacles)) return false;
  if (blocksPeerSolar(parcel, footprint, roofTopY, site, peers)) return false;
  return true;
}

/**
 * Plans one detached storehouse/shed without renderer state.
 *
 * `hardObstacles` accepts the JSON-safe rect/circle/polygon records already used
 * by yard planning. Pass the records without any legacy inferred aux obstacle.
 * A requested outbuilding that cannot keep its full authored dimensions is
 * omitted rather than miniaturized or pushed outside the parcel.
 */
export function planParcelAuxiliary(
  parcel,
  {
    site = null,
    peers = [],
    hardObstacles = [],
    enabled = parcel?.aux,
    kind = parcel?.kind,
  } = {},
) {
  if (!enabled || !parcel || parcel.hero
    || !['giwa', 'choga'].includes(kind)
    || !Number.isFinite(parcel.plotW) || !Number.isFinite(parcel.plotD)
    || !Array.isArray(parcel.shape?.pts) || parcel.shape.pts.length < 3) return null;

  const width = Math.min(parcel.plotW * 0.3, 3.2);
  const depth = Math.min(parcel.plotD * 0.22, 2.6);
  if (!(width > 0 && depth > 0)) return null;

  const rng = makeRng(((finite(parcel.seed) >>> 0) ^ AUXILIARY_SEED_SALT) >>> 0);
  const body = {
    width,
    depth,
    height: 1.7 + rng() * 0.2,
  };
  const roof = {
    form: 'gable',
    covering: kind === 'giwa' ? 'tile' : 'thatch',
    overhang: AUXILIARY_ROOF_OVERHANG,
    rise: AUXILIARY_ROOF_RISE,
  };
  const roofTopY = body.height + roof.rise;
  const yaw = (rng() * 2 - 1) * AUXILIARY_MAX_YAW;
  const mainRoofs = roofPolygons(parcel);
  const mainBounds = roofBounds(mainRoofs);
  if (!mainBounds) return null;
  const halfWidth = body.width * 0.5 + roof.overhang;
  const halfDepth = body.depth * 0.5 + roof.overhang;
  const yawCos = Math.abs(Math.cos(yaw)), yawSin = Math.abs(Math.sin(yaw));
  const envelopeHalfWidth = halfWidth * yawCos + halfDepth * yawSin;
  const envelopeHalfDepth = halfWidth * yawSin + halfDepth * yawCos;
  const centers = orderedCandidates(
    candidateCenters(parcel, mainBounds, envelopeHalfWidth, envelopeHalfDepth),
    rng,
  );

  for (const center of centers) {
    const local = { x: center.x, z: center.z, yaw };
    const footprint = roofFootprint(local, body, roof);
    if (!validCandidate({
      parcel,
      footprint,
      mainRoofs,
      mainBounds,
      hardObstacles,
      site,
      peers,
      roofTopY,
    })) continue;
    return deepFreeze({
      id: 'aux-0',
      role: 'storehouse',
      local,
      body,
      roof,
      footprint,
      roofTopY,
    });
  }
  return null;
}

export function auxiliaryLocalFootprint(spec) {
  return spec?.footprint || Object.freeze([]);
}

export function auxiliaryWorldFootprint(parcel, spec = parcel?.auxiliary) {
  if (!parcel || !spec?.footprint) return [];
  return spec.footprint.map((point) => parcelWorldPoint(parcel, point));
}

export function auxiliaryObstructionPolygons(parcel, spec = parcel?.auxiliary) {
  const footprint = auxiliaryWorldFootprint(parcel, spec);
  return footprint.length >= 3 ? [footprint] : [];
}

export function auxiliarySolarObstruction(parcel, spec = parcel?.auxiliary, site = null) {
  if (!parcel || !spec) return null;
  const polygon = auxiliaryWorldFootprint(parcel, spec);
  if (polygon.length < 3 || !Number.isFinite(spec.roofTopY)) return null;
  return {
    polygon,
    roofTopY: parcelGroundY(parcel, site) + spec.roofTopY,
  };
}

export function auxiliaryHardObstacle(spec) {
  if (!spec?.footprint?.length) return null;
  return deepFreeze({
    kind: 'auxiliary-building',
    mode: 'canopy',
    shape: 'polygon',
    points: spec.footprint.map((point) => ({ x: point.x, z: point.z })),
  });
}
