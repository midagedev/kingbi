// Pure village-plan to semantic-obstruction records. This layer owns plan and
// architectural contracts but has no index lifecycle, renderer, or query state.

import { PAVILION_DEFAULTS, pavilionPlanningRoofRadius } from '../../builder/pavilion-spec.js';
import { facingY } from '../../core/math/geom2.js';
import { parcelRotY } from '../../generators/shared/parcel-spatial.js';
import { planFenceRuns } from '../../layout/fence-plan.js';
import { parcelCompoundPlan } from '../../layout/parcel-compound-plan.js';
import { makeRng } from '../../rng.js';
import {
  CITY_WALL_DIMENSIONS,
  cityGateLocalPoint,
  cityGateStructureProfile,
  sampleCityWallSegments,
} from '../../village/citywall-contour.js';
import { publicPropObstruction } from '../../village/public-props-plan.js';
import { parcelHouseTranslation } from '../../village/parcel-contract.js';
import { impostorHouseSpec } from '../../village/impostor-spec.js';
import { palaceOuterPrecinctPlan } from '../../village/palace-precinct-plan.js';
import { villageWallLayout } from '../../village/wall-contract.js';
import { auxiliaryWorldFootprint } from '../../village/auxiliary-building-plan.js';
import {
  SEMANTIC_RAY_EPS,
  semanticCylinder,
  semanticPrism,
  semanticSegmentPrism,
  semanticSphere,
  triangulateSemanticPolygon,
} from './semantic-ray-index.js';

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

function transformedPoint(parcel, local, rotationY, houseLocal, sx, sz) {
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const x = houseLocal.x + local.x * sx;
  const z = houseLocal.z + local.z * sz;
  return {
    x: parcel.center.x + x * cos + z * sin,
    z: parcel.center.z - x * sin + z * cos,
  };
}

function parcelPoint(parcel, local) {
  const rotationY = parcelRotY(parcel);
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  return {
    x: parcel.center.x + local.x * cos + local.z * sin,
    z: parcel.center.z - local.x * sin + local.z * cos,
  };
}

function validBounds(bounds) {
  return bounds
    && Number.isFinite(bounds.minX) && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxY)
    && Number.isFinite(bounds.minZ) && Number.isFinite(bounds.maxZ)
    && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY && bounds.maxZ > bounds.minZ;
}

function localBoundsSolid(parcel, bounds, baseY) {
  return semanticPrism([
    { x: bounds.minX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.minZ },
    { x: bounds.maxX, z: bounds.maxZ }, { x: bounds.minX, z: bounds.maxZ },
  ].map((point) => parcelPoint(parcel, point)), baseY + bounds.minY, baseY + bounds.maxY);
}

function houseRecord(parcel, site) {
  if (!parcel?.center || (parcel.kind !== 'giwa' && parcel.kind !== 'choga')) return null;
  const baseY = Number.isFinite(parcel.baseY) ? parcel.baseY
    : Number.isFinite(parcel.padY) ? parcel.padY
      : (typeof site?.heightAt === 'function' ? site.heightAt(parcel.center.x, parcel.center.z) : 0);
  let solids;
  if (validBounds(parcel.editBuildingBounds)) {
    // The committed overlay publishes its parcel-local, pre-parcel-matrix bounds.
    // It supersedes the prototype impostor immediately, while baseY remains the
    // pad/world vertical translation owned by the parcel contract.
    solids = [localBoundsSolid(parcel, parcel.editBuildingBounds, baseY)];
  } else {
    const spec = impostorHouseSpec(parcel);
    const sx = finite(parcel.sx, 1), sy = finite(parcel.sy, 1), sz = finite(parcel.sz, 1);
    const rotationY = parcelRotY(parcel);
    const houseLocal = parcelHouseTranslation(parcel);
    const body = spec.body.polygon.map((point) =>
      transformedPoint(parcel, point, rotationY, houseLocal, sx, sz));
    const bodyTriangles = triangulateSemanticPolygon(body);
    if (bodyTriangles.length !== body.length - 2) {
      throw new Error(`door-occlusion could not triangulate parcel ${parcel.id}`);
    }
    solids = bodyTriangles.map((triangle) => semanticPrism(
      triangle,
      baseY + spec.body.y0 * sy,
      baseY + spec.body.y1 * sy,
    ));
    for (const roof of spec.roofs) {
      const corners = [
        { x: roof.x0, z: roof.z0 }, { x: roof.x1, z: roof.z0 },
        { x: roof.x1, z: roof.z1 }, { x: roof.x0, z: roof.z1 },
      ].map((point) => transformedPoint(parcel, point, rotationY, houseLocal, sx, sz));
      solids.push(semanticPrism(corners, baseY + roof.eaveY * sy, baseY + roof.ridgeY * sy));
    }
  }
  return {
    id: `parcel:${parcel.id}`,
    kind: 'house',
    parcelId: parcel.id,
    ownerId: parcel.id,
    excludeWithOwner: true,
    solids,
  };
}

function localRect(center, width, depth, yaw = 0) {
  const halfW = width * 0.5, halfD = depth * 0.5;
  return [
    { x: center.x - halfW, z: center.z - halfD },
    { x: center.x + halfW, z: center.z - halfD },
    { x: center.x + halfW, z: center.z + halfD },
    { x: center.x - halfW, z: center.z + halfD },
  ].map((point) => rotateLocalPoint(point, center, yaw));
}

function auxiliaryBuildingRecord(parcel, site) {
  const spec = parcel?.auxiliary;
  if (!spec || !Number.isFinite(spec.body?.width) || !Number.isFinite(spec.body?.depth)
    || !Number.isFinite(spec.body?.height) || !Number.isFinite(spec.roofTopY)) return null;
  const baseY = Number.isFinite(parcel.baseY) ? parcel.baseY
    : Number.isFinite(parcel.padY) ? parcel.padY
      : (typeof site?.heightAt === 'function'
          ? site.heightAt(parcel.center.x, parcel.center.z) : 0);
  const body = localRect(
    spec.local,
    spec.body.width,
    spec.body.depth,
    spec.local.yaw,
  ).map((point) => parcelPoint(parcel, point));
  const roof = auxiliaryWorldFootprint(parcel, spec);
  if (roof.length < 3) return null;
  return {
    id: `parcel:${parcel.id}:auxiliary:${spec.id}`,
    kind: 'auxiliary-building',
    parcelId: parcel.id,
    ownerId: parcel.id,
    // The selected parcel's main house is excluded so its own door surface can
    // win, but a detached building in the same yard remains a real first-surface
    // obstruction just like that parcel's wall.
    excludeWithOwner: false,
    solids: [
      semanticPrism(body, baseY, baseY + spec.body.height),
      semanticPrism(roof, baseY + spec.body.height, baseY + spec.roofTopY),
    ],
  };
}

function ownedRecord(id, kind, parcelId, solid) {
  return {
    id, kind, parcelId,
    ownerId: parcelId,
    excludeWithOwner: false,
    solids: [solid],
  };
}

function villageGateRecords(parcel, layout, baseY, prefix) {
  const records = [];
  const gate = layout.gate;
  if (!gate) return records;
  const n = layout.pts.length;
  const a = layout.pts[gate.edge];
  const b = layout.pts[(gate.edge + 1) % n];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (length <= SEMANTIC_RAY_EPS) return records;
  const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
  const center = {
    x: a.x + (b.x - a.x) * gate.centerT,
    z: a.z + (b.z - a.z) * gate.centerT,
  };
  const style = layout.style;
  const raise = style === 'tile' ? gate.height * 0.45 : style === 'brush' || style === 'open' ? 0.15 : 0.2;
  const postHeight = gate.height + raise;
  const postRadius = style === 'brush' || style === 'open' ? 0.09 : 0.13;
  for (const [side, sign] of [-1, 1].entries()) {
    const point = {
      x: center.x + dx * sign * gate.gap * 0.5,
      z: center.z + dz * sign * gate.gap * 0.5,
    };
    const world = parcelPoint(parcel, point);
    records.push(ownedRecord(
      `${prefix}:post:${side}`, 'parcel-gate', parcel.id,
      semanticCylinder(world.x, world.z, postRadius, baseY, baseY + postHeight),
    ));
  }
  const left = parcelPoint(parcel, {
    x: center.x - dx * (gate.gap + 0.34) * 0.5,
    z: center.z - dz * (gate.gap + 0.34) * 0.5,
  });
  const right = parcelPoint(parcel, {
    x: center.x + dx * (gate.gap + 0.34) * 0.5,
    z: center.z + dz * (gate.gap + 0.34) * 0.5,
  });
  const lintelH = style === 'brush' || style === 'open' ? 0.08 : 0.2;
  records.push(ownedRecord(
    `${prefix}:lintel`, 'parcel-gate', parcel.id,
    semanticSegmentPrism(left, right, 0.2, baseY + postHeight - 0.18 - lintelH * 0.5,
      baseY + postHeight - 0.18 + lintelH * 0.5),
  ));
  return records;
}

function villageWallRecords(parcel, site, char01) {
  const records = [];
  const style = parcel.wallType || 'stone';
  const baseY = Number.isFinite(parcel.baseY) ? parcel.baseY
    : Number.isFinite(parcel.padY) ? parcel.padY
      : (typeof site?.heightAt === 'function' ? site.heightAt(parcel.center.x, parcel.center.z) : 0);
  const layout = villageWallLayout(parcel.shape, {
    style,
    plotW: parcel.plotW,
    plotD: parcel.plotD,
    gateEdge: parcel.access?.gateEdge,
    gateT: parcel.access?.gateT,
    char01,
    wallHeightK: parcel.wallHeightK,
    parcel,
    site,
    baseY,
  }, makeRng((((parcel.seed | 0) || 7) ^ 0x51de) >>> 0));
  const prefix = `parcel:${parcel.id}:wall`;
  records.push(...villageGateRecords(parcel, layout, baseY, prefix));
  for (const edge of layout.edgeLayouts) {
    for (let spanIndex = 0; spanIndex < edge.runs.length; spanIndex++) {
      const run = edge.runs[spanIndex];
      const dx = run.b.x - run.a.x, dz = run.b.z - run.a.z;
      const length = Math.hypot(dx, dz) || 1;
      const grow = finite(run.grow, 0) * 0.5;
      const start = parcelPoint(parcel, {
        x: run.a.x - dx / length * grow,
        z: run.a.z - dz / length * grow,
      });
      const end = parcelPoint(parcel, {
        x: run.b.x + dx / length * grow,
        z: run.b.z + dz / length * grow,
      });
      const solid = semanticSegmentPrism(
        start,
        end,
        layout.thickness,
        baseY + (run.bottomOffset || 0),
        baseY + edge.height + (run.topOffset || 0),
      );
      if (solid) records.push(ownedRecord(
        `${prefix}:edge:${edge.index}:${spanIndex}`, 'parcel-wall', parcel.id, solid,
      ));
    }
  }
  for (let postIndex = 0; postIndex < layout.cornerPosts.length; postIndex++) {
    const post = layout.cornerPosts[postIndex];
    const width = post.thickness * 1.2;
    const point = parcelPoint(parcel, post.point);
    const postBaseY = baseY + (post.bottomOffset || 0);
    const solid = semanticPrism(localRect(point, width, width), postBaseY,
      postBaseY + (style === 'tile' ? post.height + 0.32 : post.height * 0.98));
    records.push(ownedRecord(
      `${prefix}:corner:${postIndex}`, 'parcel-wall', parcel.id, solid,
    ));
  }
  return records;
}

function localToWorld(frame, point) {
  const rotationY = facingY(frame.frontDir || { x: 0, z: 1 });
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  return {
    x: frame.x + point.x * cos + point.z * sin,
    z: frame.z - point.x * sin + point.z * cos,
  };
}

function rotateLocalPoint(point, center, rotationY) {
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  const x = point.x - center.x, z = point.z - center.z;
  return {
    x: center.x + x * cos + z * sin,
    z: center.z - x * sin + z * cos,
  };
}

function closedGateRecords({
  id,
  kind,
  parcelId = null,
  gate,
  baseY,
  worldPoint,
}) {
  const records = [];
  const center = gate.position || { x: 0, z: 0 };
  const yaw = gate.rotationY ?? gate.yaw ?? 0;
  const width = positive(gate.width, gate.type === 'soseuldaemun' ? 2.6 : 1.5);
  const add = (suffix, component, y0, y1) => {
    const points = localRect(component.center, component.width, component.depth, yaw).map(worldPoint);
    const record = {
      id: `${id}:${suffix}`,
      kind,
      parcelId,
      ownerId: parcelId,
      excludeWithOwner: false,
      solids: [semanticPrism(points, baseY + y0, baseY + y1)],
    };
    records.push(record);
  };
  if (gate.type === 'soseuldaemun') {
    const sideWidth = 1.9;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    for (const sign of [-1, 1]) {
      const offset = sign * (width * 0.5 + sideWidth * 0.5);
      add(`side:${sign < 0 ? 0 : 1}`, {
        center: {
          x: center.x + offset * cos,
          z: center.z - offset * sin,
        },
        width: sideWidth,
        depth: 0.5,
      }, 0, 2.5);
    }
    add('leaf', { center, width: Math.max(0.2, width - 0.1), depth: 0.12 }, 0.1, 2.95);
  } else {
    const top = gate.type === 'saripmun' ? 1.58 : 2.18;
    add('leaf', { center, width, depth: 0.12 }, gate.type === 'saripmun' ? 0.18 : 0.08, top);
  }
  return records;
}

function compoundFenceRecords({ id, kind, parcelId = null, compound, baseY, worldPoint }) {
  const records = [];
  const fence = compound.fence;
  const fencePlan = planFenceRuns(fence.points, { closed: true, openings: [fence.opening] });
  for (const segment of fencePlan.segments) {
    for (let spanIndex = 0; spanIndex < segment.runs.length; spanIndex++) {
      const span = segment.runs[spanIndex];
      const pointAt = (distance) => ({
        x: segment.a.x + segment.dx * distance / segment.length,
        z: segment.a.z + segment.dz * distance / segment.length,
      });
      const solid = semanticSegmentPrism(
        worldPoint(pointAt(span.start)), worldPoint(pointAt(span.end)),
        fence.thickness, baseY, baseY + fence.height,
      );
      if (!solid) continue;
      records.push({
        id: `${id}:wall:${segment.index}:${spanIndex}`,
        kind,
        parcelId,
        ownerId: parcelId,
        excludeWithOwner: false,
        solids: [solid],
      });
    }
  }
  records.push(...closedGateRecords({
    id: `${id}:gate`, kind: `${kind}-gate`, parcelId,
    gate: compound.gate, baseY, worldPoint,
  }));
  for (let wingIndex = 0; wingIndex < compound.wings.length; wingIndex++) {
    const wing = compound.wings[wingIndex];
    const solid = semanticSegmentPrism(
      worldPoint(wing.points[0]), worldPoint(wing.points[1]), wing.depth,
      baseY + wing.colH, baseY + wing.colH + 1.2,
    );
    if (!solid) continue;
    records.push({
      id: `${id}:wing:${wingIndex}`,
      kind: `${kind}-wing`,
      parcelId,
      ownerId: parcelId,
      excludeWithOwner: false,
      solids: [solid],
    });
  }
  return records;
}

function heroCompoundRecords(parcel, site) {
  const baseY = Number.isFinite(parcel.baseY) ? parcel.baseY
    : Number.isFinite(parcel.padY) ? parcel.padY
      : (typeof site?.heightAt === 'function' ? site.heightAt(parcel.center.x, parcel.center.z) : 0);
  const compound = parcelCompoundPlan({
    style: parcel.heroStyle || 'hanok',
    plotW: parcel.plotW,
    plotD: parcel.plotD,
  });
  return compoundFenceRecords({
    id: `parcel:${parcel.id}:compound`,
    kind: 'hero-enclosure',
    parcelId: parcel.id,
    compound,
    baseY,
    worldPoint: (point) => parcelPoint(parcel, point),
  });
}

export function buildVillageDoorParcelRecords(parcel, site, char01) {
  const house = houseRecord(parcel, site);
  if (!house) return [];
  return [
    house,
    auxiliaryBuildingRecord(parcel, site),
    ...(parcel.hero ? heroCompoundRecords(parcel, site) : villageWallRecords(parcel, site, char01)),
  ].filter(Boolean);
}

function cityWallRecords(spec, site) {
  if (!spec?.radii?.length || !Array.isArray(spec.gates)) return [];
  const records = [];
  const dimensions = CITY_WALL_DIMENSIONS;
  const segments = sampleCityWallSegments(spec, site, { thickness: dimensions.thickness });
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const minGround = Math.min(...segment.ground);
    const maxGround = Math.max(...segment.ground);
    records.push({
      id: `feature:city-wall:${index}`,
      kind: 'city-wall',
      parcelId: null,
      solids: [semanticPrism(
        segment.corners,
        minGround - dimensions.foundationSink,
        maxGround + dimensions.bodyHeight - dimensions.foundationSink + dimensions.capHeight,
      )],
    });
  }
  for (let gateIndex = 0; gateIndex < spec.gates.length; gateIndex++) {
    const gate = spec.gates[gateIndex];
    const scale = positive(gate.scale, 1);
    const depth = dimensions.gateDepth * scale;
    const pierWidth = 5.5 * scale;
    const structure = cityGateStructureProfile(gate, site);
    const half = gate.width * 0.5 + pierWidth * 0.5;
    for (const [index, sign] of [-1, 1].entries()) {
      const points = localRect({ x: sign * half, z: 0 }, pierWidth, depth)
        .map((point) => cityGateLocalPoint(gate, point.x, point.z));
      records.push({
        id: `feature:city-gate:${gate.name ?? gateIndex}:pier:${index}`,
        kind: 'city-gate-pier',
        parcelId: null,
        solids: [semanticPrism(
          points,
          structure.piers[index].min - dimensions.gateFoundationSink * scale,
          structure.baseTopY,
        )],
      });
    }
    const lintelPoints = localRect({ x: 0, z: 0 }, gate.width + pierWidth, depth)
      .map((point) => cityGateLocalPoint(gate, point.x, point.z));
    records.push({
      id: `feature:city-gate:${gate.name ?? gateIndex}:lintel`,
      kind: 'city-gate-lintel',
      parcelId: null,
      solids: [semanticPrism(
        lintelPoints,
        structure.archTopY - 0.12 * scale,
        structure.baseTopY,
      )],
    });
  }
  return records;
}

function featurePadY(feature, site, width, depth) {
  if (Number.isFinite(feature.baseY)) return feature.baseY;
  const frame = { x: feature.x, z: feature.z, frontDir: feature.frontDir };
  const samples = [{ x: feature.x, z: feature.z }];
  for (const point of localRect({ x: 0, z: 0 }, width + 4, depth + 4)) {
    samples.push(localToWorld(frame, point));
  }
  let minimum = Infinity, maximum = -Infinity;
  for (const point of samples) {
    const height = typeof site?.heightAt === 'function' ? site.heightAt(point.x, point.z) : 0;
    minimum = Math.min(minimum, height);
    maximum = Math.max(maximum, height);
  }
  return Math.min(maximum, minimum + 3.2) + 0.06;
}

function palaceRecords(palace, site) {
  if (!Number.isFinite(palace?.x) || !Number.isFinite(palace?.z)) return [];
  const minimumWidth = palace.tier === 'hanyang' ? 96 : palace.tier === 'capital' ? 60 : 0;
  const minimumDepth = palace.tier === 'hanyang' ? 150 : palace.tier === 'capital' ? 90 : 0;
  const width = Math.max(positive(palace.plotW, 40), minimumWidth);
  const depth = Math.max(positive(palace.plotD, 34), minimumDepth);
  const baseY = featurePadY(palace, site, width, depth);
  const frame = { x: palace.x, z: palace.z, frontDir: palace.frontDir };
  if (!palace.tier) {
    const compound = parcelCompoundPlan({ style: 'palace', plotW: width, plotD: depth });
    return compoundFenceRecords({
      id: 'feature:palace', kind: 'palace-enclosure', compound, baseY,
      worldPoint: (point) => localToWorld(frame, point),
    });
  }
  const precinct = palaceOuterPrecinctPlan(width, depth);
  return compoundFenceRecords({
    id: 'feature:palace',
    kind: 'palace-wall',
    compound: {
      fence: { ...precinct.wall, points: precinct.wall.points },
      gate: precinct.gate,
      wings: [],
    },
    baseY,
    worldPoint: (point) => localToWorld(frame, point),
  });
}

function pavilionRecord(pavilion, site) {
  if (!Number.isFinite(pavilion?.x) || !Number.isFinite(pavilion?.z)) return null;
  const plannedRoof = pavilionPlanningRoofRadius(PAVILION_DEFAULTS);
  const scale = positive(pavilion.radius, plannedRoof) / plannedRoof;
  const baseY = Number.isFinite(pavilion.baseY) ? pavilion.baseY
    : (typeof site?.heightAt === 'function' ? site.heightAt(pavilion.x, pavilion.z) : 0);
  const podRadius = (PAVILION_DEFAULTS.radius + 0.9) * scale;
  const postRing = PAVILION_DEFAULTS.radius * scale;
  const postRadius = 0.21 * scale;
  const podH = 0.5 * scale;
  const postH = PAVILION_DEFAULTS.postH * scale;
  const eaveY = baseY + podH + postH + 0.35 * scale;
  const roofRise = PAVILION_DEFAULTS.roofRise * scale;
  const apexY = eaveY + roofRise;
  const roofTop = apexY + PAVILION_DEFAULTS.finialAllowance * scale;
  const sides = Math.max(3, Math.round(pavilion.sides || 6));
  const phase = (pavilion.rot || 0) + (sides === 4 ? Math.PI / 4 : Math.PI / 6);
  const podium = [];
  for (let i = 0; i < sides; i++) {
    const angle = phase + i / sides * Math.PI * 2;
    podium.push({
      x: pavilion.x + Math.cos(angle) * podRadius,
      z: pavilion.z + Math.sin(angle) * podRadius,
    });
  }
  const solids = [semanticPrism(podium, baseY, baseY + podH)];
  for (let i = 0; i < sides; i++) {
    const angle = phase + i / sides * Math.PI * 2;
    solids.push(semanticCylinder(
      pavilion.x + Math.cos(angle) * postRing,
      pavilion.z + Math.sin(angle) * postRing,
      postRadius,
      baseY + podH,
      baseY + podH + postH,
    ));
  }
  // The roof is rotationally broad at its eaves but converges at the apex. A
  // single full-radius cylinder up to the finial would block empty high sky.
  // Four precomputed cylindrical slices preserve the requested scalar hot path
  // while following the visible roof envelope; the bottle finial stays narrow.
  const roofRadius = positive(pavilion.radius, plannedRoof);
  const roofSlices = 4;
  for (let i = 0; i < roofSlices; i++) {
    const y0 = eaveY + roofRise * i / roofSlices;
    const y1 = eaveY + roofRise * (i + 1) / roofSlices;
    solids.push(semanticCylinder(
      pavilion.x,
      pavilion.z,
      roofRadius * (1 - i / roofSlices),
      y0,
      y1,
    ));
  }
  solids.push(semanticCylinder(pavilion.x, pavilion.z, 0.45 * scale, apexY, roofTop));
  return { id: 'feature:pavilion', kind: 'pavilion', parcelId: null, solids };
}

function publicPropRecord(prop, index, site) {
  const obstruction = publicPropObstruction(prop);
  if (!obstruction || !Number.isFinite(prop.x) || !Number.isFinite(prop.z)) return null;
  const baseY = Number.isFinite(prop.baseY) ? prop.baseY
    : (typeof site?.heightAt === 'function' ? site.heightAt(prop.x, prop.z) : 0);
  return {
    id: `feature:prop:${index}:${prop.name}`,
    kind: 'public-prop',
    parcelId: null,
    solids: [semanticCylinder(prop.x, prop.z, obstruction.radius, baseY, baseY + obstruction.height)],
  };
}

function templeRecords(temple, site) {
  const records = [];
  if (!temple?.compound || !Number.isFinite(temple.x) || !Number.isFinite(temple.z)) return records;
  const buildings = temple.compound.buildings || [];
  const baseY = Number.isFinite(temple.baseY) ? temple.baseY
    : (typeof site?.heightAt === 'function' ? site.heightAt(temple.x, temple.z) : 0);
  for (const building of buildings) {
    const width = positive(building.footprint?.width, 0);
    const depth = positive(building.footprint?.depth, 0);
    if (!width || !depth) continue;
    // Keep every renderer-authored hall yaw, then compose the whole precinct's
    // frontDir. Never turn these into one courtyard-sized box: rays through the
    // worship court must remain clear.
    const halfW = width * 0.5, halfD = depth * 0.5;
    const center = building.position || { x: 0, z: 0 };
    const points = [
      { x: center.x - halfW, z: center.z - halfD },
      { x: center.x + halfW, z: center.z - halfD },
      { x: center.x + halfW, z: center.z + halfD },
      { x: center.x - halfW, z: center.z + halfD },
    ].map((point) => localToWorld(
      temple,
      rotateLocalPoint(point, center, building.yaw || 0),
    ));
    const height = (building.formality === 'pavilion' ? 8.5 : 10.5) * positive(building.scale, 1);
    records.push({
      id: `feature:temple:${building.id}`,
      kind: 'temple-building',
      parcelId: null,
      solids: [semanticPrism(points, baseY, baseY + height)],
    });
  }
  const gates = temple.compound.gates || [];
  for (let enclosureIndex = 0; enclosureIndex < (temple.compound.enclosures || []).length; enclosureIndex++) {
    const enclosure = temple.compound.enclosures[enclosureIndex];
    const points = enclosure.polygon || [];
    if (points.length < 3) continue;
    const gate = gates.find((candidate) => candidate.id === enclosure.gateId) || null;
    const openingWidth = gate
      ? gate.type === 'soseuldaemun' ? Math.max(6.6, gate.width + 3.8) : gate.width + 0.5
      : 0;
    const fencePlan = planFenceRuns(points, {
      closed: true,
      openings: gate ? [{ seg: 0, center: 0.5, width: openingWidth }] : [],
    });
    for (const segment of fencePlan.segments) {
      for (let spanIndex = 0; spanIndex < segment.runs.length; spanIndex++) {
        const span = segment.runs[spanIndex];
        const pointAt = (distance) => ({
          x: segment.a.x + segment.dx * distance / segment.length,
          z: segment.a.z + segment.dz * distance / segment.length,
        });
        const solid = semanticSegmentPrism(
          localToWorld(temple, pointAt(span.start)),
          localToWorld(temple, pointAt(span.end)),
          0.46, baseY, baseY + positive(enclosure.height, 1.8),
        );
        if (!solid) continue;
        records.push({
          id: `feature:temple:enclosure:${enclosure.id ?? enclosureIndex}:${segment.index}:${spanIndex}`,
          kind: 'temple-enclosure',
          parcelId: null,
          solids: [solid],
        });
      }
    }
  }
  for (let gateIndex = 0; gateIndex < gates.length; gateIndex++) {
    const gate = gates[gateIndex];
    records.push(...closedGateRecords({
      id: `feature:temple:gate:${gate.id ?? gateIndex}`,
      kind: 'temple-gate',
      gate,
      baseY,
      worldPoint: (point) => localToWorld(temple, point),
    }));
  }
  return records;
}

function sijeonRecord(shop, index, site) {
  // Break footprints reserve the market corridor but have no building mass to occlude.
  if (!shop || shop.kind === 'break') return null;
  if (!Array.isArray(shop?.poly) || shop.poly.length < 3) return null;
  const center = shop.center || { x: shop.x, z: shop.z };
  const baseY = Number.isFinite(shop.baseY) ? shop.baseY
    : (typeof site?.heightAt === 'function' ? site.heightAt(center.x, center.z) : 0);
  const triangles = triangulateSemanticPolygon(shop.poly);
  if (triangles.length !== shop.poly.length - 2) {
    throw new Error(`door-occlusion could not triangulate sijeon ${shop.id ?? index}`);
  }
  return {
    id: `feature:sijeon:${shop.id ?? index}`,
    kind: 'sijeon',
    parcelId: null,
    solids: triangles.map((triangle) => semanticPrism(triangle, baseY, baseY + 4.7)),
  };
}

function treeRecord(tree, index, role, site) {
  if (!Number.isFinite(tree?.x) || !Number.isFinite(tree?.z)) return null;
  const canopyRadius = positive(tree.canopyRadius, positive(tree.radius, positive(tree.r, 1.6)));
  const guardian = role === 'guardian-tree';
  const explicitHeight = positive(tree.h, positive(tree.height, 0));
  const explicitBase = Number.isFinite(tree.baseY) ? tree.baseY
    : guardian && Number.isFinite(tree.y) ? tree.y : NaN;
  const baseY = Number.isFinite(explicitBase) ? explicitBase
    : (typeof site?.heightAt === 'function' ? site.heightAt(tree.x, tree.z) : 0);
  const canopyY = Number.isFinite(tree.canopyY) ? tree.canopyY
    : !guardian && Number.isFinite(tree.y) ? tree.y
      : baseY + (explicitHeight || canopyRadius * 1.25) * 0.72;
  const trunkRadius = positive(tree.trunkRadius,
    guardian ? 0.72 * positive(tree.scale, 1) : Math.max(0.08, canopyRadius * 0.1));
  const trunkTop = Number.isFinite(tree.trunkTop) ? tree.trunkTop
    : Math.max(baseY + 1.5, canopyY);
  return {
    id: `${role}:${tree.parcelId ?? '-'}:${index}`,
    kind: role,
    parcelId: tree.parcelId ?? null,
    solids: [
      semanticCylinder(tree.x, tree.z, trunkRadius, baseY, trunkTop),
      semanticSphere(tree.x, canopyY, tree.z, canopyRadius, true),
    ],
  };
}


export function buildVillageDoorRecords(plan, site) {
  const records = [];
  const parcels = new Map();
  const char01 = typeof plan?.opts?.char01 === 'number' ? plan.opts.char01 : 0.5;
  for (const parcel of plan?.parcels || []) {
    const parcelSet = buildVillageDoorParcelRecords(parcel, site, char01);
    if (!parcelSet.length) continue;
    records.push(...parcelSet);
    parcels.set(parcel.id, parcelSet);
  }
  const pavilion = pavilionRecord(plan?.features?.pavilion, site);
  if (pavilion) records.push(pavilion);
  for (let i = 0; i < (plan?.features?.props || []).length; i++) {
    const record = publicPropRecord(plan.features.props[i], i, site);
    if (record) records.push(record);
  }
  records.push(...templeRecords(plan?.features?.temple, site));
  records.push(...palaceRecords(plan?.features?.palace, site));
  records.push(...cityWallRecords(plan?.features?.cityWall, site));
  for (let i = 0; i < (plan?.features?.sijeon || []).length; i++) {
    const record = sijeonRecord(plan.features.sijeon[i], i, site);
    if (record) records.push(record);
  }
  return { records, parcels, char01 };
}

export function buildVillageDoorTreeRecords(trees, role, site) {
  const records = [];
  if (!Array.isArray(trees)) return records;
  for (let i = 0; i < trees.length; i++) {
    const record = treeRecord(trees[i], i, role, site);
    if (record) records.push(record);
  }
  return records;
}
