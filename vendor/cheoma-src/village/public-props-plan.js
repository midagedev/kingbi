import * as G from '../core/math/geom2.js';
import {
  CITY_WALL_DIMENSIONS,
  cityWallContainsPolygon,
  worldEdgeClearance,
} from './citywall-contour.js';
import { circleIntersectsPolygon } from './parcel-contract.js';
import { pavilionFootprint } from './pavilion-plan.js';
import {
  GOLDEN_ANGLE,
  radialPlacementCandidates,
  terrainRelief,
} from './placement-search.js';
import { createRoadSpatialIndex } from './road-spatial.js';
import { circleBlocksSolarAccess } from './solar-access.js';
import { streamClearanceAt } from './stream-spatial.js';
import { circleBlocksParcelFocusFrame } from './view-clearance.js';

const TAU = Math.PI * 2;
const SEARCH_STEP = 2.5;

// Renderer dimensions reduced to conservative planning cylinders. Low objects
// remain available as foreground detail; only objects tall enough to cover doors
// or eaves reserve focus-frame width.
export const PUBLIC_PROP_OBSTRUCTIONS = Object.freeze({
  'jangseung-pair': Object.freeze({ radius: 1.2, height: 3.0, viewRadius: 1.2 }),
  sotdae: Object.freeze({ radius: 0.35, height: 4.0, viewRadius: 0.35 }),
  well: Object.freeze({ radius: 1.0, height: 2.4, viewRadius: 1.0 }),
  jangdokdae: Object.freeze({ radius: 1.7, height: 1.5, viewRadius: 0 }),
  haystack: Object.freeze({ radius: 1.15, height: 2.0, viewRadius: 1.15 }),
  'mortar-pestle': Object.freeze({ radius: 1.1, height: 1.3, viewRadius: 0 }),
});

export function publicPropObstruction(prop) {
  const spec = PUBLIC_PROP_OBSTRUCTIONS[prop?.name];
  if (!spec) return null;
  const scale = Number.isFinite(prop.scale) ? Math.max(0, prop.scale) : 1;
  return {
    x: prop.x,
    z: prop.z,
    radius: spec.radius * scale,
    height: spec.height * scale,
    viewRadius: spec.viewRadius * scale,
  };
}

function circlePolygon(point, radius, segments = 12) {
  return Array.from({ length: segments }, (_, index) => {
    const angle = index / segments * TAU;
    return { x: point.x + Math.cos(angle) * radius, z: point.z + Math.sin(angle) * radius };
  });
}

function preferredPublicProps(features, site, scale, rng, char01) {
  const C = site.center;
  const southGate = features.cityWall?.gates.find((gate) => gate.name === 'south') || null;
  const E = southGate || site.entrance;
  const toC = southGate
    ? { x: -southGate.dirX, z: -southGate.dirZ }
    : G.norm(G.sub(C, E));
  const perp = G.perpL(toC);
  let entrancePerp = perp;
  let jangseungOffset = 5, sotdaeOffset = 8, forecourtInset = 0;
  if (southGate) {
    const structureHalf = (southGate.width
      + CITY_WALL_DIMENSIONS.gateExtraWidth * (southGate.scale || 1)) * 0.5;
    jangseungOffset = structureHalf + 4;
    sotdaeOffset = structureHalf + 8;
    forecourtInset = CITY_WALL_DIMENSIONS.gateDepth * (southGate.scale || 1) * 0.5 + 3;
    if (site.stream) {
      const bankScore = (sign) => Math.min(...[jangseungOffset, sotdaeOffset].map((offset) => {
        const point = G.add(E, G.add(G.mul(entrancePerp, offset * sign), G.mul(toC, forecourtInset)));
        return Math.abs(point.z - site.streamZat(point.x)) - site.streamHalf;
      }));
      if (bankScore(-1) > bankScore(1)) entrancePerp = G.mul(entrancePerp, -1);
    }
  }
  const props = [
    {
      name: 'jangseung-pair',
      x: E.x + entrancePerp.x * jangseungOffset + toC.x * forecourtInset,
      z: E.z + entrancePerp.z * jangseungOffset + toC.z * forecourtInset,
      rot: Math.atan2(toC.x, toC.z), scale: 1.0, seed: 21,
    },
    {
      name: 'sotdae',
      x: E.x + entrancePerp.x * sotdaeOffset + toC.x * forecourtInset,
      z: E.z + entrancePerp.z * sotdaeOffset + toC.z * forecourtInset,
      rot: 0, scale: 1.0, seed: 22,
    },
    { name: 'well', x: C.x + perp.x * 9, z: C.z + toC.z * 7, rot: 0, scale: 1.0, seed: 23 },
  ];
  if (scale !== 'hamlet') {
    props.push({ name: 'jangdokdae', x: C.x - perp.x * 10, z: C.z - site.R * 0.05, rot: rng.range(0, 6.28), scale: 1.0, seed: 24 });
  }
  if (char01 < 0.34) {
    props.push(
      { name: 'haystack', x: C.x + perp.x * 14, z: C.z + toC.z * 12, rot: rng.range(0, 6.28), scale: 1.1, seed: 25 },
      { name: 'mortar-pestle', x: C.x + perp.x * 11, z: C.z + toC.z * 15, rot: rng.range(0, 6.28), scale: 1.0, seed: 26 },
    );
  } else if (char01 >= 0.66) {
    props.push(
      { name: 'jangdokdae', x: C.x + perp.x * 12, z: C.z - site.R * 0.02, rot: rng.range(0, 6.28), scale: 1.0, seed: 27 },
      { name: 'well', x: C.x - perp.x * 12, z: C.z + toC.z * 5, rot: 0, scale: 1.0, seed: 28 },
    );
  }
  return props;
}

export function planPublicProps({
  features,
  site,
  scale,
  rng,
  char01 = 0.5,
  parcels = [],
  occupied = [],
  reservedCircles = [],
  roads = [],
  pavilion = null,
}) {
  const preferred = preferredPublicProps(features, site, scale, rng, char01);
  const accepted = [];
  const roadSpatial = createRoadSpatialIndex(roads);
  const pavilionPoly = pavilion ? pavilionFootprint(pavilion, 0.5) : [];
  const maxRadius = Math.max(30, site.R * 0.28);

  for (const prop of preferred) {
    const spec = publicPropObstruction(prop);
    if (!spec) continue;
    const phase = Math.atan2(prop.z - site.center.z, prop.x - site.center.x)
      + (prop.seed % 11) * GOLDEN_ANGLE;
    const clearAt = (point) => {
      const obstacle = { ...spec, x: point.x, z: point.z };
      const footprint = circlePolygon(point, obstacle.radius);
      if (site.edge && worldEdgeClearance(site.edge, point) < obstacle.radius + 2) return false;
      if (features.cityWall && !cityWallContainsPolygon(features.cityWall, footprint, 1)) return false;
      if (streamClearanceAt(site, point) < obstacle.radius + 0.8) return false;
      if (roadSpatial.withinRoadClearance(point, null, obstacle.radius + 0.35)) return false;
      if (occupied.some((polygon) => circleIntersectsPolygon(point, obstacle.radius + 0.35, polygon))) return false;
      if (pavilionPoly.length && circleIntersectsPolygon(point, obstacle.radius + 0.35, pavilionPoly)) return false;
      if (reservedCircles.some((circle) => G.dist(point, circle)
        < obstacle.radius + Math.max(0, circle.radius || 0) + 0.8)) return false;
      if (accepted.some((other) => {
        const otherSpec = publicPropObstruction(other);
        return otherSpec && G.dist(point, other) < obstacle.radius + otherSpec.radius + 0.5;
      })) return false;
      for (const parcel of parcels) {
        if (circleBlocksSolarAccess(parcel, obstacle, site)) return false;
        if (obstacle.viewRadius > 0
          && circleBlocksParcelFocusFrame(parcel, point, obstacle.viewRadius, 0.3)) return false;
      }
      return terrainRelief(site, point, obstacle.radius * 0.8, 4) <= 0.8;
    };
    const point = radialPlacementCandidates(prop, {
      phase,
      step: SEARCH_STEP,
      arcStep: SEARCH_STEP * 1.25,
      maxRadius,
    }).find(clearAt);
    if (!point) throw new Error(`public-props-plan could not place ${prop.name} for ${scale}`);
    accepted.push({ ...prop, x: point.x, z: point.z });
  }
  return accepted;
}
