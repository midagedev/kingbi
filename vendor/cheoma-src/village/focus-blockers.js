import * as G from '../core/math/geom2.js';
import { makeRng } from '../rng.js';
import { parcelRotY } from '../generators/shared/parcel-spatial.js';
import { parcelEffectiveRoofBounds } from './house-footprint.js';
import { parcelWorldPoint } from './parcel-contract.js';
import { PAVILION_HEIGHT, PAVILION_ROOF_RADIUS } from './pavilion-plan.js';
import { publicPropObstruction } from './public-props-plan.js';
import { parcelGroundY, parcelRoofTopY } from './solar-access.js';
import { villageWallLayout } from './wall-contract.js';
import { yardHardObstacles } from './yard-layout.js';

// Pure, renderer-independent focus blockers. Ray-picking keeps its generous parcel
// box, while visibility and camera collision use the actual fitted roof envelope.
// This keeps FULL/MID/FAR, focus, rerolls, and public-object planning on one shape.

function volumeBounds(volume) {
  const cos = Math.abs(Math.cos(volume.rotationY || 0));
  const sin = Math.abs(Math.sin(volume.rotationY || 0));
  const halfX = cos * volume.half.x + sin * volume.half.z;
  const halfZ = sin * volume.half.x + cos * volume.half.z;
  return {
    min: {
      x: volume.center.x - halfX,
      y: volume.center.y - volume.half.y,
      z: volume.center.z - halfZ,
    },
    max: {
      x: volume.center.x + halfX,
      y: volume.center.y + volume.half.y,
      z: volume.center.z + halfZ,
    },
  };
}

function blocker(id, center, half, rotationY = 0) {
  const volume = { center, half, rotationY };
  return { id, volume, bounds: volumeBounds(volume) };
}

export function parcelFocusBlocker(parcel, site) {
  if (!parcel || (parcel.kind !== 'choga' && parcel.kind !== 'giwa')) return null;
  const roof = parcelEffectiveRoofBounds(parcel);
  if (![roof.minX, roof.maxX, roof.minZ, roof.maxZ].every(Number.isFinite)) return null;
  const rotationY = parcelRotY(parcel);
  const localX = (roof.minX + roof.maxX) * 0.5;
  const localZ = (roof.minZ + roof.maxZ) * 0.5;
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const baseY = parcelGroundY(parcel, site);
  const topY = parcelRoofTopY(parcel, site);
  return blocker(parcel.id, {
    x: parcel.center.x + localX * cos + localZ * sin,
    y: (baseY + topY) * 0.5,
    z: parcel.center.z - localX * sin + localZ * cos,
  }, {
    x: Math.max(0.05, (roof.maxX - roof.minX) * 0.5),
    y: Math.max(0.05, (topY - baseY) * 0.5),
    z: Math.max(0.05, (roof.maxZ - roof.minZ) * 0.5),
  }, rotationY);
}

const FOCUS_DETAIL_HEIGHT = Object.freeze({
  jangdok: 0.5,
  'yard-stack': 0.9,
  clothesline: 1.2,
  'vegetable-bed': 0.16,
  'open-garden': 0.16,
});

// Stable, renderer-free household-detail points for close camera composition.
// These are the same semantic centres consumed by walls.js; they deliberately
// omit conservative garden/auxiliary envelopes that may not own one exact
// rendered object. The camera may prefer a view where one point has a clear
// first surface, but it never traverses the focus overlay to discover geometry.
export function parcelFocusDetailAnchors(parcel, site) {
  if (!parcel || parcel.hero || (parcel.kind !== 'choga' && parcel.kind !== 'giwa')) return [];
  const baseY = parcelGroundY(parcel, site);
  return yardHardObstacles(parcel)
    .filter((item) => Number.isFinite(FOCUS_DETAIL_HEIGHT[item.kind])
      && Number.isFinite(item.x) && Number.isFinite(item.z))
    .map((item, index) => {
      const world = parcelWorldPoint(parcel, item);
      return Object.freeze({
        id: `yard-detail:${parcel.id}:${item.kind}:${index}`,
        point: Object.freeze({
          x: world.x,
          y: baseY + FOCUS_DETAIL_HEIGHT[item.kind],
          z: world.z,
        }),
      });
    });
}

function wallRunDepth(style, thickness) {
  if (style === 'hedge') return 1.48;
  if (style === 'brush') return 0.18;
  return Math.max(0.18, thickness + (style === 'tile' ? 0.32 : 0.12));
}

function wallRunBlocker(parcel, site, layout, edge, run, runIndex) {
  const a = parcelWorldPoint(parcel, run.a);
  const b = parcelWorldPoint(parcel, run.b);
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const bottomOffset = run.bottomOffset || 0;
  const height = edge.height + (run.topOffset || 0) - bottomOffset;
  if (length < 0.05 || height <= 0) return null;
  const baseY = parcelGroundY(parcel, site) + bottomOffset;
  return blocker(`wall:${parcel.id}:${edge.index}:${runIndex}`, {
    x: (a.x + b.x) * 0.5,
    y: baseY + height * 0.5,
    z: (a.z + b.z) * 0.5,
  }, {
    x: (length + (run.grow || 0)) * 0.5,
    y: height * 0.5,
    z: wallRunDepth(layout.style, layout.thickness) * 0.5,
  }, Math.atan2(-(b.z - a.z), b.x - a.x));
}

function gateFocusBlockers(parcel, site, layout) {
  const gate = layout.gate;
  if (!gate) return [];
  const a = layout.pts[gate.edge];
  const b = layout.pts[(gate.edge + 1) % layout.pts.length];
  const length = G.dist(a, b);
  if (length < 0.05) return [];
  const dx = (b.x - a.x) / length;
  const dz = (b.z - a.z) / length;
  const center = G.lerp(a, b, gate.centerT);
  const style = layout.style === 'brush' || layout.style === 'hedge'
    || layout.style === 'open' ? 'brush' : layout.style;
  const raise = style === 'tile' ? gate.height * 0.45 : style === 'brush' ? 0.15 : 0.2;
  const postHeight = gate.height + raise;
  const postRadius = style === 'brush' ? 0.09 : 0.13;
  const baseY = parcelGroundY(parcel, site);
  const rotationY = parcelRotY(parcel) + Math.atan2(-dz, dx);
  const postHalf = { x: postRadius * 1.1, y: postHeight * 0.5, z: postRadius * 1.1 };
  const result = [-1, 1].map((side) => {
    const local = {
      x: center.x + dx * gate.gap * 0.5 * side,
      z: center.z + dz * gate.gap * 0.5 * side,
    };
    const world = parcelWorldPoint(parcel, local);
    return blocker(`gate:${parcel.id}:post:${side}`, {
      x: world.x,
      y: baseY + postHeight * 0.5,
      z: world.z,
    }, postHalf, rotationY);
  });
  const worldCenter = parcelWorldPoint(parcel, center);
  result.push(blocker(`gate:${parcel.id}:lintel`, {
    x: worldCenter.x,
    y: baseY + postHeight - 0.18,
    z: worldCenter.z,
  }, {
    x: (gate.gap + 0.34) * 0.5,
    y: style === 'brush' ? 0.04 : 0.1,
    z: 0.1,
  }, rotationY));
  return result;
}

// Actual renderer-free wall runs and gate opening geometry for household-detail
// first-surface rays. This consumes the same layout contract and seed-local
// height decision as walls.js without touching global RNG or allocating Three
// resources. It is kept out of the architectural candidate score: walls decide
// whether a low yard detail is truly readable, not whether the house exists.
export function parcelWallFocusBlockers(parcel, site, char01 = 0.5) {
  if (!parcel?.shape || parcel.hero || !site) return [];
  const layout = villageWallLayout(parcel.shape, {
    style: parcel.wallType || 'stone',
    kind: parcel.kind,
    seed: parcel.seed,
    char01,
    aux: parcel.aux,
    auxRequested: parcel.auxRequested,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge,
    gateT: parcel.access?.gateT,
    parcel,
    site,
    baseY: parcel.baseY,
    wallHeightK: parcel.wallHeightK,
  }, makeRng(((parcel.seed | 0) ^ 0x51de) >>> 0));
  const runs = layout.edgeLayouts.flatMap((edge) => (
    edge.runs.map((run, runIndex) => wallRunBlocker(
      parcel,
      site,
      layout,
      edge,
      run,
      runIndex,
    )).filter(Boolean)
  ));
  return [...runs, ...gateFocusBlockers(parcel, site, layout)];
}

export function parcelAuxiliaryFocusBlocker(parcel, site) {
  const spec = parcel?.auxiliary;
  if (!spec || !Number.isFinite(spec.local?.x) || !Number.isFinite(spec.local?.z)
    || !Number.isFinite(spec.local?.yaw) || !Number.isFinite(spec.body?.width)
    || !Number.isFinite(spec.body?.depth) || !Number.isFinite(spec.roof?.overhang)
    || !Number.isFinite(spec.roofTopY)) return null;
  const baseY = parcelGroundY(parcel, site);
  const center = parcelWorldPoint(parcel, spec.local);
  return blocker(`auxiliary:${parcel.id}:${spec.id}`, {
    x: center.x,
    y: baseY + spec.roofTopY * 0.5,
    z: center.z,
  }, {
    x: spec.body.width * 0.5 + spec.roof.overhang,
    y: spec.roofTopY * 0.5,
    z: spec.body.depth * 0.5 + spec.roof.overhang,
  }, parcelRotY(parcel) + spec.local.yaw);
}

function circularFeatureBlocker(id, feature, radius, height, site) {
  if (!Number.isFinite(feature?.x) || !Number.isFinite(feature?.z)
    || !Number.isFinite(radius) || radius <= 0 || !Number.isFinite(height) || height <= 0) return null;
  const baseY = Number.isFinite(feature.baseY)
    ? feature.baseY
    : site.heightAt(feature.x, feature.z);
  return blocker(id, {
    x: feature.x,
    y: baseY + height * 0.5,
    z: feature.z,
  }, { x: radius, y: height * 0.5, z: radius });
}

function landmarkBlocker(id, feature, width, depth, height, site) {
  if (!Number.isFinite(feature?.x) || !Number.isFinite(feature?.z)
    || !Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || depth <= 0) return null;
  const baseY = Number.isFinite(feature.baseY)
    ? feature.baseY
    : site.heightAt(feature.x, feature.z);
  return blocker(id, {
    x: feature.x,
    y: baseY + height * 0.5,
    z: feature.z,
  }, { x: width * 0.5, y: height * 0.5, z: depth * 0.5 }, G.facingY(feature.frontDir || { x: 0, z: 1 }));
}

export function focusFeatureBlockers(plan, site) {
  if (!plan?.features || !site?.heightAt) return [];
  const features = plan.features;
  const result = [];
  const pavilion = circularFeatureBlocker(
    'feature:pavilion',
    features.pavilion,
    features.pavilion?.radius || PAVILION_ROOF_RADIUS,
    PAVILION_HEIGHT,
    site,
  );
  if (pavilion) result.push(pavilion);

  for (let index = 0; index < (features.props || []).length; index++) {
    const prop = features.props[index];
    const obstruction = publicPropObstruction(prop);
    const entry = obstruction && circularFeatureBlocker(
      `feature:prop:${index}:${prop.name}`,
      prop,
      obstruction.radius,
      obstruction.height,
      site,
    );
    if (entry) result.push(entry);
  }

  const palace = landmarkBlocker(
    'feature:palace',
    features.palace,
    features.palace?.plotW || 60,
    features.palace?.plotD || 90,
    20,
    site,
  );
  if (palace) result.push(palace);
  const temple = landmarkBlocker(
    'feature:temple',
    features.temple,
    (features.temple?.compoundWidth || features.temple?.compoundSize || 33) + 2,
    (features.temple?.compoundDepth || features.temple?.compoundSize || 33) + 2,
    18,
    site,
  );
  if (temple) result.push(temple);
  return result;
}

export function focusPlanningBlockers(plan, site) {
  return [
    ...(plan?.parcels || [])
      .map((parcel) => parcelAuxiliaryFocusBlocker(parcel, site))
      .filter(Boolean),
    ...focusFeatureBlockers(plan, site),
  ];
}
