import * as THREE from 'three';
import { PRESETS } from '../params.js';
import { buildBuilding } from '../builder/index.js';
import {
  canonicalizeSharedMaterials,
  makeDancheongVariant,
  makeMaterials,
} from '../builder/palette.js';
import {
  resolveDancheong,
  resolveTempleRoleDancheong,
} from '../builder/dancheong.js';
import { buildFence } from '../layout/fence.js';
import { buildGate } from '../layout/gate.js';
import { buildProp } from '../props/index.js';
import {
  addMaterialResource,
  collectObjectResources,
  disposeObjectResources,
} from '../core/three-resources.js';
import { normalizeTemplePlan, planTempleCompound } from './plan.js';
import { templeHallBuilderParams } from './role-hierarchy.js';

const lifecycle = new WeakMap();

function collectPaletteResources(palette) {
  const materials = new Set();
  const textures = new Set();
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) addMaterialResource(value, materials, textures);
    else if (value?.isTexture) textures.add(value);
  }
  return { materials, textures };
}

function collectPalettesResources(palettes) {
  const resources = { materials: new Set(), textures: new Set() };
  for (const palette of palettes) {
    const current = collectPaletteResources(palette);
    for (const material of current.materials) resources.materials.add(material);
    for (const texture of current.textures) resources.textures.add(texture);
  }
  return resources;
}

function makeCourtMaterial(role) {
  return new THREE.MeshStandardMaterial({
    color: role === 'worship' ? 0xc2b69a : 0xb9ad91,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
}

function polygonMesh(polygon, material, y, name) {
  const shape = new THREE.Shape();
  polygon.forEach((p, index) => {
    if (index) shape.lineTo(p.x, -p.z);
    else shape.moveTo(p.x, -p.z);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

function hallPreset(spec, seed, mats) {
  const architecture = {
    architecturalRank: spec.architecturalRank,
    roofGrammar: spec.roofGrammar,
    bracketGrammar: spec.bracketGrammar,
    eaveGrammar: spec.eaveGrammar,
    massingGrammar: spec.massingGrammar,
  };
  const passUnder = spec.passUnder?.openLower
    ? {
      openLowerCorridor: true,
      passUnderWidth: spec.passUnder.corridorWidth,
      passUnderHeight: spec.passUnder.corridorHeight,
    }
    : null;
  return {
    ...PRESETS.temple,
    ...templeHallBuilderParams(architecture),
    seed,
    mats,
    frontBays: spec.frontBays,
    sideBays: spec.sideBays,
    // 누하: raised hall with an open lower corridor — no palace ornaments, same
    // temple palette, walls omitted so the processional axis walks through.
    ...(passUnder || {}),
  };
}

function buildHall(spec, seed, mats) {
  const building = buildBuilding(hallPreset(spec, seed, mats));
  building.name = `temple-${spec.id}`;
  // Mountain entry may lift a pass-under one apron step; flat stays on grade so
  // the open lower corridor reads as a true walk-under volume.
  const lift = Number.isFinite(spec.elevation) ? spec.elevation : 0;
  building.position.set(spec.position.x, lift, spec.position.z);
  building.rotation.y = spec.yaw || 0;
  building.scale.setScalar(spec.scale || 1);
  building.userData.templeId = spec.id;
  building.userData.templeRole = spec.role;
  building.userData.templeArchitecture = {
    id: spec.architectureId,
    architecturalRank: spec.architecturalRank,
    roofGrammar: spec.roofGrammar,
    bracketGrammar: spec.bracketGrammar,
    eaveGrammar: spec.eaveGrammar,
  };
  if (spec.passUnder?.openLower) {
    building.userData.templePassUnder = {
      openLower: true,
      corridorWidth: spec.passUnder.corridorWidth,
      corridorHeight: spec.passUnder.corridorHeight,
    };
  }
  return building;
}

function buildPaths(paths, material) {
  const group = new THREE.Group();
  group.name = 'temple-paths';
  for (const path of paths) {
    for (let index = 0; index < path.points.length - 1; index++) {
      const a = path.points[index], b = path.points[index + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-4) continue;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(length, 0.055, path.width),
        material,
      );
      mesh.name = `${path.id}-${index}`;
      mesh.position.set((a.x + b.x) * 0.5, 0.038, (a.z + b.z) * 0.5);
      mesh.rotation.y = Math.atan2(-dz, dx);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

function gateById(plan, id) {
  return plan.gates.find((gate) => gate.id === id) || null;
}

function buildEnclosures(plan, mats) {
  const group = new THREE.Group();
  group.name = 'temple-enclosures';
  for (const enclosure of plan.enclosures) {
    const gate = gateById(plan, enclosure.gateId);
    const openingWidth = gate
      ? (gate.type === 'soseuldaemun' ? Math.max(6.6, gate.width + 3.8) : gate.width + 0.5)
      : 0;
    const { group: fence } = buildFence({
      points: enclosure.polygon,
      closed: true,
      height: enclosure.height,
      thickness: 0.46,
      seed: (plan.seed ^ enclosure.id.length * 0x91) >>> 0,
      mats,
      wallStyle: 'toseok',
      openings: gate ? [{ seg: 0, center: 0.5, width: openingWidth }] : [],
    });
    fence.name = enclosure.id;
    group.add(fence);
  }
  for (const gateSpec of plan.gates) {
    const gate = buildGate(gateSpec.type, {
      mats,
      seed: (plan.seed ^ gateSpec.id.length * 0x271) >>> 0,
      width: gateSpec.width,
    });
    gate.name = `temple-${gateSpec.id}`;
    gate.position.set(gateSpec.position.x, 0, gateSpec.position.z);
    gate.rotation.y = gateSpec.yaw || 0;
    gate.userData.templeId = gateSpec.id;
    gate.userData.templeRole = gateSpec.role;
    group.add(gate);
  }
  return group;
}

/**
 * Assemble a renderer-independent TemplePlan into one local-space THREE group.
 * Caller-provided `mats` remain caller-owned; otherwise disposeTempleCompound()
 * releases the generated palette, derived materials, geometries, and textures.
 */
export function buildTempleCompound(planOrOptions = {}, { mats, dancheong } = {}) {
  const suppliedPlan = Object.hasOwn(planOrOptions || {}, 'schemaVersion')
    || Array.isArray(planOrOptions?.buildings);
  const sourcePlan = suppliedPlan ? planOrOptions : planTempleCompound(planOrOptions);
  const plan = normalizeTemplePlan(sourcePlan);
  const mainDancheong = resolveDancheong('temple', dancheong || mats?.dancheong || PRESETS.temple);
  const palette = mats || makeMaterials('temple', mainDancheong);
  const paletteByDancheong = new Map();
  const paletteKey = (config) => `${config.clarityBucket}:${config.splendorBucket}`;
  const paletteFor = (config) => {
    const key = paletteKey(config);
    if (!paletteByDancheong.has(key)) {
      const sameAsBase = palette.dancheong
        && paletteKey(palette.dancheong) === key;
      paletteByDancheong.set(key, sameAsBase ? palette : makeDancheongVariant(palette, config));
    }
    return paletteByDancheong.get(key);
  };
  const hallPalette = (spec) => paletteFor(resolveTempleRoleDancheong(mainDancheong, spec));
  const enclosurePalette = paletteFor(resolveTempleRoleDancheong(mainDancheong, {
    role: 'entry-gate', formality: 'domestic',
  }));
  const root = new THREE.Group();
  root.name = `temple-compound-${plan.variant}`;

  const courtMaterials = new Map();
  const courtMaterial = (role) => {
    if (!courtMaterials.has(role)) courtMaterials.set(role, makeCourtMaterial(role));
    return courtMaterials.get(role);
  };
  for (const court of plan.courtyards) {
    // Prefer plan-owned elevation (mountain apron tiers); fall back to level as
    // a coarse step only when elevation was never authored.
    const courtY = Number.isFinite(court.elevation)
      ? 0.018 + court.elevation
      : 0.018 + (court.level || 0) * 0.55;
    root.add(polygonMesh(court.polygon, courtMaterial(court.role), courtY, court.id));
  }

  const pathMaterial = new THREE.MeshStandardMaterial({ color: 0xaaa08d, roughness: 1, metalness: 0 });
  root.add(buildPaths(plan.paths, pathMaterial));
  root.add(buildEnclosures(plan, enclosurePalette));

  const buildings = new THREE.Group();
  buildings.name = 'temple-buildings';
  plan.buildings.forEach((spec, index) => {
    buildings.add(buildHall(spec, (plan.seed + 0x100 + index * 17) >>> 0, hallPalette(spec)));
  });
  root.add(buildings);

  const props = new THREE.Group();
  props.name = 'temple-props';
  plan.props.forEach((spec, index) => {
    const object = buildProp(spec.kind, {
      seed: (plan.seed + 0x700 + index * 31) >>> 0,
      scale: spec.scale,
      ...(spec.stories ? { stories: spec.stories } : {}),
    });
    object.name = `temple-${spec.id}`;
    object.position.set(spec.position.x, 0, spec.position.z);
    object.rotation.y = spec.yaw || 0;
    object.userData.templeId = spec.id;
    object.userData.templeRole = spec.role;
    props.add(object);
  });
  root.add(props);

  // Consolidate visually identical clones before village-level static merging.
  // The conservative signature skips shader-patched materials.
  canonicalizeSharedMaterials(root);
  root.userData.mats = palette;
  root.userData.templeSchemaVersion = plan.schemaVersion;
  root.userData.parcelLike = { id: 'temple', style: 'temple', variant: plan.variant };
  root.userData.templeHandle = {
    seed: plan.seed,
    variant: plan.variant,
    width: plan.width,
    depth: plan.depth,
    plan,
    dancheong: mainDancheong,
  };
  root.userData.dancheongPaletteCount = paletteByDancheong.size;
  lifecycle.set(root, {
    disposed: false,
    ownsPalette: !mats,
    callerPaletteResources: mats ? collectPaletteResources(mats) : null,
    // `palette` may not be selected by a sparse/custom plan (for example an
    // enclosure-only harness), but an internally-created base palette is still
    // owned by this compound and must be released with its role variants.
    allPaletteResources: collectPalettesResources([palette, ...paletteByDancheong.values()]),
  });
  return root;
}

export function disposeTempleCompound(root) {
  const state = root && lifecycle.get(root);
  if (!state || state.disposed) return false;
  state.disposed = true;
  const resources = collectObjectResources(root);
  for (const material of state.allPaletteResources.materials) resources.materials.add(material);
  for (const texture of state.allPaletteResources.textures) resources.textures.add(texture);
  if (!state.ownsPalette) {
    for (const material of state.callerPaletteResources.materials) resources.materials.delete(material);
    for (const texture of state.callerPaletteResources.textures) resources.textures.delete(texture);
  }
  disposeObjectResources(resources);
  return true;
}
