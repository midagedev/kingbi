import * as G from '../core/math/geom2.js';
import {
  pavilionPlanningHeight,
  pavilionPlanningRoofRadius,
} from '../builder/pavilion-spec.js';
import {
  circleIntersectsPolygon,
} from './parcel-contract.js';
import {
  cityWallContainsPolygon,
  worldEdgeClearance,
} from './citywall-contour.js';
import { radialPlacementCandidates, terrainRelief } from './placement-search.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { circleBlocksSolarAccess } from './solar-access.js';
import { streamClearanceAt } from './stream-spatial.js';
import { circleBlocksParcelFocusFrame } from './view-clearance.js';

const TAU = Math.PI * 2;
const SEARCH_STEP = 4;

// Planning and rendering consume one physical default spec. The radius rounds the
// scalloped eave outward rather than reserving only the column ring.
export const PAVILION_ROOF_RADIUS = pavilionPlanningRoofRadius();
export const PAVILION_HEIGHT = pavilionPlanningHeight();
export const PAVILION_PARCEL_CLEARANCE = 1;
export const PAVILION_ROAD_CLEARANCE = 0.6;
export const PAVILION_STREAM_CLEARANCE = 2;
export const PAVILION_VIEW_CLEARANCE = 0.8;
export const PAVILION_MAX_RELIEF = 1.4;
export const PAVILION_GUARDIAN_CLEARANCE = 1;

export function pavilionFootprint(pavilion, margin = 0, segments = 16) {
  if (!pavilion || !Number.isFinite(pavilion.x) || !Number.isFinite(pavilion.z)) return [];
  const radius = Math.max(0, pavilion.radius || PAVILION_ROOF_RADIUS) + Math.max(0, margin);
  const count = Math.max(8, Math.round(segments));
  return Array.from({ length: count }, (_, index) => {
    const angle = index / count * TAU;
    return {
      x: pavilion.x + Math.cos(angle) * radius,
      z: pavilion.z + Math.sin(angle) * radius,
    };
  });
}

export function pavilionBlocksParcelFocus(parcel, pavilion, margin = PAVILION_VIEW_CLEARANCE) {
  return circleBlocksParcelFocusFrame(
    parcel,
    pavilion,
    pavilion?.radius || PAVILION_ROOF_RADIUS,
    margin,
  );
}

export function pavilionBlocksParcelSolarAccess(parcel, pavilion, site) {
  return circleBlocksSolarAccess(parcel, {
    ...pavilion,
    radius: pavilion?.radius || PAVILION_ROOF_RADIUS,
    height: PAVILION_HEIGHT,
  }, site);
}

export function pavilionTerrainRelief(site, point) {
  return terrainRelief(site, point, PAVILION_ROOF_RADIUS * 0.72, 8);
}

// A pavilion is a small building, not vegetation. It nevertheless consumes the same
// south-light corridor and the full house frame used by the focus camera.
// The nearest valid public clearing is selected after parcels are known, while the
// function remains pure/worker-safe and independent from THREE/rendering.
export function planPavilion({
  site,
  scale,
  roads = [],
  parcels = [],
  occupied = [],
  reservedCircles = [],
  cityWall = null,
  rotationJitter = 0,
}) {
  const center = site.center;
  const entrance = cityWall?.gates?.find((gate) => gate.name === 'south') || site.entrance;
  const axis = G.norm(G.sub(entrance, center));
  const lateral = G.perpL(axis);
  const entryPavilion = scale === 'hamlet' || scale === 'village';
  const preferred = entryPavilion
    ? G.add(entrance, G.add(G.mul(lateral, site.R * 0.10), G.mul(axis, site.R * 0.05)))
    : G.add(G.lerp(center, entrance, 0.30), G.mul(lateral, site.R * 0.06));
  const roadSpatial = createRoadSpatialIndex(roads);
  // The protected perspective-narrowing focus corridor is as long as the residential lens's
  // compensated dolly (view-clearance.js derives it from the actual camera endpoint, so it
  // follows VILLAGE_LENS.parcel without a constant here). Keep the same nearest-first search,
  // but let compact walled villages reach the first clearing beyond the former 0.68R cap
  // (the village/42 regression is at 0.72R).
  const maxRadius = Math.max(36, site.R * 0.75);

  const clearAt = (point) => {
    const footprint = pavilionFootprint({ ...point, radius: PAVILION_ROOF_RADIUS });
    if (site.edge && worldEdgeClearance(site.edge, point) < PAVILION_ROOF_RADIUS + 4) return false;
    if (cityWall && !cityWallContainsPolygon(cityWall, footprint, 3)) return false;
    if (streamClearanceAt(site, point) < PAVILION_ROOF_RADIUS + PAVILION_STREAM_CLEARANCE) return false;
    if (roadSpatial.intersectsRoadCorridor(footprint, PAVILION_ROAD_CLEARANCE)) return false;
    if (occupied.some((polygon) => circleIntersectsPolygon(
      point,
      PAVILION_ROOF_RADIUS + PAVILION_PARCEL_CLEARANCE,
      polygon,
    ))) return false;
    if (reservedCircles.some((circle) => G.dist(point, circle)
      < PAVILION_ROOF_RADIUS + circle.radius + PAVILION_GUARDIAN_CLEARANCE)) return false;
    for (const parcel of parcels) {
      if (pavilionBlocksParcelSolarAccess(parcel, point, site)) return false;
      if (pavilionBlocksParcelFocus(parcel, point)) return false;
    }
    return pavilionTerrainRelief(site, point) <= PAVILION_MAX_RELIEF;
  };

  const point = radialPlacementCandidates(preferred, {
    phase: Math.atan2(lateral.z, lateral.x),
    step: SEARCH_STEP,
    maxRadius,
  }).find(clearAt);
  if (!point) throw new Error(`pavilion-plan could not find a solar-safe clearing for ${scale}`);
  const road = roadSpatial.nearest(point, site.R * 2);
  const towardRoad = road.pt ? G.norm(G.sub(road.pt, point)) : axis;
  return {
    x: point.x,
    z: point.z,
    sides: 6,
    radius: PAVILION_ROOF_RADIUS,
    rot: G.facingY(towardRoad) + rotationJitter,
    placement: entryPavilion ? 'entrance' : 'civic',
    roadId: road.road?.id || null,
  };
}
