import * as G from '../core/math/geom2.js';
import {
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallOutsidePolygon,
  worldEdgeClearance,
  worldEdgeContainsPolygon,
} from './citywall-contour.js';
import { parcelWorldPoint } from './parcel-contract.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import {
  planTempleCompound,
  templeCompoundDefaultsForSite,
} from '../temple/plan.js';

// Pure, worker-safe temple site contract. Planning owns the compound footprint and
// approach centerline so the renderer, forest mask, and regression gates cannot
// silently invent different clearances.
export const TEMPLE_COMPOUND_SIZE = 33;
export const TEMPLE_MIN_COMPOUND_SIZE = 22;
export const TEMPLE_MAX_COMPOUND_SIZE = 72;
export const TEMPLE_PATH_WIDTH = 2.5;
export const TEMPLE_PATH_CLEARANCE = 4;
export const TEMPLE_PAD_LIFT = 0.06;
export const TEMPLE_MAX_RELIEF = 9;
// Keep only a narrow construction margin around the real rotated precinct. Canopy
// radius is added separately by the vegetation commit query; placement does not
// invent a decorative circular clearing or require a surrounding forest.
export const TEMPLE_FOREST_MARGIN = 0.6;

const PATH_SPACING = 2.5;
const FOOTPRINT_SAMPLES = 4;
const MAX_ROAD_CONNECTORS = 28;

const round = (value, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

function templeFrontDir(site, x, z) {
  const toCenter = G.norm({ x: site.center.x - x, z: site.center.z - z });
  return G.norm({ x: toCenter.x * 0.5, z: Math.max(0.5, toCenter.z) });
}

export function templeCompoundSize(temple) {
  return Math.max(templeCompoundWidth(temple), templeCompoundDepth(temple));
}

export function templeCompoundWidth(temple) {
  return temple?.compoundWidth || temple?.compound?.width || temple?.compoundSize || TEMPLE_COMPOUND_SIZE;
}

export function templeCompoundDepth(temple) {
  return temple?.compoundDepth || temple?.compound?.depth || temple?.compoundSize || TEMPLE_COMPOUND_SIZE;
}

export function templeFootprint(temple, margin = 0) {
  const halfWidth = templeCompoundWidth(temple) * 0.5 + Math.max(0, margin);
  const halfDepth = templeCompoundDepth(temple) * 0.5 + Math.max(0, margin);
  const frame = {
    center: { x: temple.x, z: temple.z },
    frontDir: temple.frontDir || { x: 0, z: 1 },
  };
  return [
    { x: halfWidth, z: halfDepth }, { x: -halfWidth, z: halfDepth },
    { x: -halfWidth, z: -halfDepth }, { x: halfWidth, z: -halfDepth },
  ].map((point) => parcelWorldPoint(frame, point));
}

function footprintRelief(site, temple) {
  let min = Infinity, max = -Infinity;
  const width = templeCompoundWidth(temple);
  const depth = templeCompoundDepth(temple);
  const halfWidth = width * 0.5;
  const halfDepth = depth * 0.5;
  const frame = { center: temple, frontDir: temple.frontDir };
  for (let row = 0; row <= FOOTPRINT_SAMPLES; row++) {
    for (let column = 0; column <= FOOTPRINT_SAMPLES; column++) {
      const point = parcelWorldPoint(frame, {
        x: -halfWidth + width * column / FOOTPRINT_SAMPLES,
        z: -halfDepth + depth * row / FOOTPRINT_SAMPLES,
      });
      const height = site.heightAt(point.x, point.z);
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
  }
  return { min, max, drop: max - min };
}

function terrainSetting(site, temple, groundY) {
  const front = temple.frontDir;
  const back = G.mul(front, -1);
  const left = G.perpL(front);
  const inner = templeCompoundSize(temple) * 0.5 + 8;
  const outer = Math.max(inner + 8, Math.min(site.R * 0.22, 58));
  const directions = [
    { name: 'front', dir: front },
    { name: 'frontLeft', dir: G.norm(G.add(front, left)) },
    { name: 'left', dir: left },
    { name: 'backLeft', dir: G.norm(G.add(back, left)) },
    { name: 'back', dir: back },
    { name: 'backRight', dir: G.norm(G.sub(back, left)) },
    { name: 'right', dir: G.mul(left, -1) },
    { name: 'frontRight', dir: G.norm(G.sub(front, left)) },
  ];
  const samples = directions.map(({ name, dir }) => {
    const near = G.add(temple, G.mul(dir, inner));
    const far = G.add(temple, G.mul(dir, outer));
    const nearY = site.heightAt(near.x, near.z);
    const farY = site.heightAt(far.x, far.z);
    return {
      name,
      rise: Math.max(nearY, farY) - groundY,
      hill: Math.max(site.hillAt(near.x, near.z), site.hillAt(far.x, far.z)),
    };
  });
  const byName = Object.fromEntries(samples.map((sample) => [sample.name, sample]));
  const shelterNames = ['left', 'backLeft', 'back', 'backRight', 'right'];
  const shelter = shelterNames.reduce((sum, name) => sum + Math.max(0, byName[name].rise), 0)
    / shelterNames.length;
  const ringMeanRise = samples.reduce((sum, sample) => sum + sample.rise, 0) / samples.length;
  const enclosure = shelterNames.filter((name) => byName[name].rise >= Math.max(2, site.Hmax * 0.04)).length;
  const mountainProximity = Math.max(...shelterNames.map((name) => byName[name].hill));
  const frontRise = Math.max(byName.front.rise, byName.frontLeft.rise, byName.frontRight.rise);
  const backdrop = Math.max(...shelterNames.map((name) => byName[name].rise));
  return { shelter, ringMeanRise, enclosure, mountainProximity, frontRise, backdrop };
}

function buildRoadSegments(roads) {
  const segments = [];
  let ordinal = 0;
  for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
    const road = roads[roadIndex];
    for (let segment = 0; segment < (road.pts?.length || 0) - 1; segment++) {
      segments.push({
        a: road.pts[segment],
        b: road.pts[segment + 1],
        road,
        ordinal: ordinal++,
      });
    }
  }
  return segments;
}

function nearestRoadConnectors(point, segments) {
  const connectors = segments.map((segment) => {
    const projection = G.distToSeg(point, segment.a, segment.b);
    return {
      point: projection.pt,
      distance: projection.d,
      road: segment.road,
      ordinal: segment.ordinal,
      source: 'road',
    };
  });
  connectors.sort((a, b) => a.distance - b.distance || a.ordinal - b.ordinal);
  return connectors.slice(0, MAX_ROAD_CONNECTORS);
}

function buildCityGateConnectors(segments, cityWall) {
  if (!cityWall?.gates?.length) return [];
  const connectors = [];
  for (const gate of cityWall.gates) {
    if (gate.name === 'north') continue; // 숙정문은 의도적으로 도로가 없는 산문이다.
    const nearest = nearestRoadConnectors(gate, segments)[0] || null;
    if (nearest) nearest.gateDistance = G.dist(nearest.point, gate);
    if (!nearest || nearest.gateDistance > Math.max(3, nearest.road.width || 0)) continue;
    connectors.push({
      ...nearest,
      point: { x: gate.x, z: gate.z },
      source: 'gate',
      gate,
    });
  }
  return connectors;
}

function cityGateConnectors(point, network) {
  return network.gates
    .map((connector) => ({ ...connector, distance: G.dist(point, connector.point) }))
    .sort((a, b) => a.distance - b.distance || a.gate.name.localeCompare(b.gate.name));
}

function nearestRoadDistance(point, network, siteRadius) {
  // The shared grid returns the exact nearest segment once a radius contains a
  // hit. Expanding locally avoids candidate × every-road scans in large cities.
  const limit = siteRadius * 2;
  for (let radius = 24; radius < limit; radius *= 2) {
    const nearest = network.spatial.nearest(point, radius);
    if (Number.isFinite(nearest.d)) return nearest.d;
  }
  return network.spatial.nearest(point, limit).d;
}

function cubicPath(start, frontDir, connector, bend, spacing = PATH_SPACING) {
  const end = connector.point;
  const distance = G.dist(start, end);
  if (distance < 1e-6) return [start, end];
  const chord = G.norm(G.sub(end, start));
  const normal = G.perpL(chord);
  const startAdvance = Math.min(14, distance * 0.28);
  const endAdvance = Math.min(16, distance * 0.24);
  const c1 = G.add(G.add(start, G.mul(frontDir, startAdvance)), G.mul(normal, bend));
  const c2 = connector.gate
    ? G.add(connector.point, G.mul({ x: connector.gate.dirX, z: connector.gate.dirZ }, endAdvance))
    : G.add(G.sub(end, G.mul(chord, endAdvance)), G.mul(normal, bend * 0.45));
  const steps = Math.max(2, Math.ceil(distance / spacing));
  const points = [];
  for (let index = 0; index <= steps; index++) {
    const t = index / steps, u = 1 - t;
    points.push({
      x: u ** 3 * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x,
      z: u ** 3 * start.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t ** 3 * end.z,
    });
  }
  return points;
}

function pathClears(path, {
  occupied,
  paddies,
  site,
  cityWall,
  wallSide,
  connector,
  ignoredPolygon = null,
}) {
  const edgeMargin = TEMPLE_PATH_WIDTH * 0.5 + 0.4;
  if (site.edge && path.some((point) => worldEdgeClearance(site.edge, point) < edgeMargin)) return false;
  const terrainR = site.terrainR || site.R;
  if (path.some((point) => Math.hypot(point.x, point.z) > terrainR - edgeMargin - 4)) return false;
  for (const polygon of occupied) {
    if (polygon === ignoredPolygon || !polygon?.length) continue;
    if (G.polylinePolygonDistance(path, polygon) < TEMPLE_PATH_CLEARANCE) return false;
  }
  for (const field of paddies) {
    if (field.poly?.length && G.polylinePolygonDistance(path, field.poly) < edgeMargin) return false;
  }
  if (cityWall) {
    if (wallSide === 'outside') {
      if (connector.source !== 'gate') return false;
      for (let index = 0; index < path.length - 1; index++) {
        if (cityWallClearance(cityWall, path[index]) > -edgeMargin) return false;
      }
    } else {
      if (connector.source !== 'road') return false;
      if (path.some((point) => cityWallClearance(cityWall, point) < edgeMargin)) return false;
    }
  }
  return true;
}

function bendSchedule(seed, distance) {
  const sign = ((seed ^ 0x51a7) & 1) ? 1 : -1;
  const amount = Math.min(12, Math.max(3, distance * 0.08));
  return [0, sign * amount, -sign * amount, sign * amount * 1.8, -sign * amount * 1.8];
}

function tryConnectors(start, frontDir, connectors, context, seed) {
  for (const connector of connectors) {
    for (const bend of bendSchedule(seed, connector.distance)) {
      const path = cubicPath(start, frontDir, connector, bend);
      if (pathClears(path, { ...context, connector })) return { path, connector };
    }
  }
  return null;
}

function nearestParcelConnector(start, parcels) {
  let nearest = null;
  for (const parcel of parcels) {
    const poly = parcel.poly || [];
    for (let edge = 0; edge < poly.length; edge++) {
      const projection = G.distToSeg(start, poly[edge], poly[(edge + 1) % poly.length]);
      if (!nearest || projection.d < nearest.distance) {
        nearest = {
          point: projection.pt,
          distance: projection.d,
          source: 'parcel',
          parcel,
        };
      }
    }
  }
  return nearest;
}

function planApproach(temple, { network, parcels, occupied, paddies, site, cityWall, seed }) {
  const start = parcelWorldPoint({ center: temple, frontDir: temple.frontDir }, {
    x: 0,
    z: templeCompoundDepth(temple) * 0.5,
  });
  const context = { occupied, paddies, site, cityWall, wallSide: temple.wallSide };
  const primary = cityWall && temple.wallSide === 'outside'
    ? cityGateConnectors(start, network)
    : nearestRoadConnectors(start, network.segments);
  const connected = tryConnectors(start, temple.frontDir, primary, context, seed);
  if (connected) return { ...connected, source: connected.connector.source };

  if (!network.segments.length) {
    const parcelConnector = nearestParcelConnector(start, parcels);
    if (parcelConnector) {
      for (const bend of bendSchedule(seed, parcelConnector.distance)) {
        const path = cubicPath(start, temple.frontDir, parcelConnector, bend);
        if (pathClears(path, {
          ...context,
          connector: parcelConnector,
          ignoredPolygon: parcelConnector.parcel.poly,
        })) return { path, connector: parcelConnector, source: 'parcel' };
      }
    }
  }

  const centerConnector = {
    point: { x: site.center.x, z: site.center.z },
    distance: G.dist(start, site.center),
    source: 'center',
  };
  const path = cubicPath(start, temple.frontDir, centerConnector, bendSchedule(seed, centerConnector.distance)[0]);
  return pathClears(path, { ...context, connector: centerConnector })
    ? { path, connector: centerConnector, source: 'center' }
    : null;
}

function accessDistance(point, network, cityWall, wallSide) {
  if (cityWall && wallSide === 'outside') {
    let distance = Infinity;
    for (const connector of network.gates) distance = Math.min(distance, G.dist(point, connector.point));
    return Number.isFinite(distance) ? distance : G.dist(point, { x: 0, z: 0 });
  }
  const distance = nearestRoadDistance(point, network, network.siteRadius);
  return Number.isFinite(distance) ? distance : G.dist(point, { x: 0, z: 0 });
}

function candidateMode(drop, radiusRatio, setting) {
  const enclosed = setting.enclosure >= 2 && setting.mountainProximity >= 0.24;
  // Flatness outranks a picturesque mountain frame. Radius and enclosure remain
  // soft score terms, never a reason to prefer a steeper shelf over a flat site.
  if (drop <= 5) return 'basin-bench';
  if (enclosed && radiusRatio >= 0.34 && radiusRatio <= 0.82) return 'foothill-bench';
  return 'gentle-slope';
}

function collectCandidates(site, seed, occupied, cityWall, network, compound) {
  const preferredSide = ((seed ^ 0x7e11) & 1) ? 1 : -1;
  const sides = [preferredSide, -preferredSide];
  const reliefCap = Math.min(8, Math.max(4, (site.Hmax || 68) * 0.08));
  const candidates = [];
  const radialStep = Math.max(2.4, site.R * 0.012);
  const compoundWidth = compound.width;
  const compoundDepth = compound.depth;
  const compoundSize = Math.max(compoundWidth, compoundDepth);
  // Temples may occupy a valley floor, streamside bench, gentle footslope, or an
  // urban precinct. Scan broadly around the basin margin, treating terrain
  // enclosure as a bonus rather than requiring a mountain-monastery setting.
  const angleMax = 0.90;
  for (let sideIndex = 0; sideIndex < sides.length; sideIndex++) {
    const side = sides[sideIndex];
    for (let angleIndex = 0; angleIndex < 28; angleIndex++) {
      const angleFraction = 0.12 + (angleMax - 0.12) * angleIndex / 27;
      const angle = angleFraction * Math.PI;
      const direction = { x: side * Math.sin(angle), z: -Math.cos(angle) };
      for (let radius = site.R * 0.30; radius <= site.R * 0.94; radius += radialStep) {
        const point = {
          x: site.center.x + direction.x * radius,
          z: site.center.z + direction.z * radius,
        };
        const frontDir = templeFrontDir(site, point.x, point.z);
        const temple = { ...point, frontDir, compoundSize, compoundWidth, compoundDepth, compound };
        const footprint = templeFootprint(temple, 2);
        if (site.edge && !worldEdgeContainsPolygon(site.edge, footprint, 4)) continue;
        const terrainR = site.terrainR || site.R;
        if (footprint.some((corner) => Math.hypot(corner.x, corner.z) > terrainR - 6)) continue;
        let wallSide = null;
        if (cityWall) {
          if (cityWallOutsidePolygon(cityWall, footprint, 4)) wallSide = 'outside';
          else if (cityWallContainsPolygon(cityWall, footprint, 4)) wallSide = 'inside';
          else continue;
        }
        if (occupied.some((polygon) => polygon?.length && G.polysOverlap(footprint, polygon))) continue;
        if (network.spatial.intersectsRoadCorridor(footprint, 2)) continue;
        if (site.stream
          && G.polylinePolygonDistance(site.stream.pts || [], footprint) < site.streamHalf + 4) continue;

        const groundY = site.heightAt(point.x, point.z);
        const elevationRatio = groundY / site.Hmax;
        if (elevationRatio < -0.04 || elevationRatio > 0.68) continue;
        const relief = footprintRelief(site, temple);
        if (relief.drop > TEMPLE_MAX_RELIEF) continue;
        const setting = terrainSetting(site, temple, groundY);
        if (setting.ringMeanRise < -site.Hmax * 0.08) continue; // 능선 마루·볼록 정상 배제
        const radiusRatio = radius / site.R;
        const mode = candidateMode(relief.drop, radiusRatio, setting);
        const approachStart = parcelWorldPoint({ center: temple, frontDir }, {
          x: 0,
          z: compoundDepth * 0.5,
        });
        const roadDistance = accessDistance(approachStart, network, cityWall, wallSide);
        const edgePenalty = Math.max(0, radiusRatio - 0.72) * 34;
        const sidePenalty = sideIndex * 0.35;
        const radiusPenalty = Math.abs(radiusRatio - 0.48) * 13;
        const frontBarrierPenalty = Math.max(0, setting.frontRise - setting.shelter * 0.8) * 0.25;
        const score = -relief.drop * 7.0
          + setting.shelter * 0.20
          + setting.ringMeanRise * 0.08
          + setting.enclosure * 0.5
          - roadDistance * 0.12
          - edgePenalty
          - radiusPenalty
          - frontBarrierPenalty
          - sidePenalty;
        candidates.push({
          ...temple,
          groundY,
          elevationRatio,
          relief,
          reliefCap,
          setting,
          radius,
          radiusRatio,
          angleFraction,
          roadDistance,
          mode,
          wallSide,
          score,
        });
      }
    }
  }
  const rank = { 'basin-bench': 0, 'foothill-bench': 1, 'gentle-slope': 2 };
  candidates.sort((a, b) => rank[a.mode] - rank[b.mode] || b.score - a.score);
  return candidates;
}

export function planTempleSite({
  site,
  seed,
  roads = [],
  parcels = [],
  occupied = parcels.map((parcel) => parcel.poly).filter(Boolean),
  paddies = [],
  cityWall = null,
  compoundOptions = null,
}) {
  const segments = buildRoadSegments(roads);
  const network = {
    segments,
    gates: buildCityGateConnectors(segments, cityWall),
    spatial: createRoadSpatialIndex(roads),
    siteRadius: site.R,
  };
  const compound = planTempleCompound({
    seed: (seed ^ 0x7e11) >>> 0,
    ...templeCompoundDefaultsForSite(site.R, seed),
    ...(compoundOptions || {}),
  });
  const candidates = collectCandidates(site, seed, occupied, cityWall, network, compound);
  let fallback = null;
  for (const candidate of candidates) {
    const approach = planApproach(candidate, {
      network,
      parcels,
      occupied,
      paddies,
      site,
      cityWall,
      seed,
    });
    if (!approach) continue;
    const resolved = { candidate, approach };
    if (approach.source === 'road' || approach.source === 'gate') {
      fallback = resolved;
      break;
    }
    fallback ||= resolved;
  }
  if (!fallback) {
    throw new Error(`temple-plan could not place a safe footprint for R=${site.R} seed=${seed}`);
  }
  const { candidate, approach } = fallback;
  const pathLength = G.polylineLength(approach.path);
  return {
    x: candidate.x,
    z: candidate.z,
    frontDir: candidate.frontDir,
    seed: (seed ^ 0x7e11) >>> 0,
    compoundSize: round(candidate.compoundSize),
    compoundWidth: round(candidate.compoundWidth),
    compoundDepth: round(candidate.compoundDepth),
    compound: candidate.compound,
    baseY: candidate.relief.max + TEMPLE_PAD_LIFT,
    path: approach.path,
    pathWidth: TEMPLE_PATH_WIDTH,
    placement: {
      mode: candidate.mode,
      elevationRatio: round(candidate.elevationRatio),
      footprintDrop: round(candidate.relief.drop),
      backdropRise: round(candidate.setting.backdrop),
      shelterRise: round(candidate.setting.shelter),
      ringMeanRise: round(candidate.setting.ringMeanRise),
      enclosure: candidate.setting.enclosure,
      mountainProximity: round(candidate.setting.mountainProximity),
      radiusRatio: round(candidate.radiusRatio),
      angleFraction: round(candidate.angleFraction),
      reliefCap: round(candidate.reliefCap),
      roadDistance: round(candidate.roadDistance),
      pathLength: round(pathLength),
      pathSource: approach.source,
      pathRoadId: approach.connector.road?.id || null,
      pathGate: approach.connector.gate?.name || null,
      candidateCount: candidates.length,
      wallSide: candidate.wallSide,
    },
  };
}

export function templeReservationPolygons(temple) {
  const reservations = [templeFootprint(temple, 2)];
  const halfWidth = TEMPLE_PATH_CLEARANCE;
  for (let index = 0; index < (temple.path?.length || 0) - 1; index++) {
    const a = temple.path[index], b = temple.path[index + 1];
    const tangent = G.norm(G.sub(b, a));
    if (G.len(tangent) < 1e-6) continue;
    const side = G.mul(G.perpL(tangent), halfWidth);
    const along = G.mul(tangent, 0.8);
    reservations.push([
      G.sub(G.add(a, side), along),
      G.sub(G.sub(a, side), along),
      G.add(G.sub(b, side), along),
      G.add(G.add(b, side), along),
    ]);
  }
  return reservations;
}
