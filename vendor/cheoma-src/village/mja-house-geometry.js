import * as THREE from 'three';
import { buildBuilding, disposeBuilding } from '../builder/index.js';
import { collectOpeningGlowAnchors } from '../builder/opening-glow-anchors.js';
import { makeMaterials } from '../builder/palette.js';
import { attachShadowDepthTextureLifecycle } from '../render/shadow-depth-texture-lifecycle.js';
import { validateMjaHousePlan } from './mja-house-plan.js';
import { mergeStatic } from './instancing.js';
import {
  addMaterialResource,
  collectObjectResources,
  disposeObjectResources,
} from '../core/three-resources.js';

const lifecycle = new WeakMap();

const PRIMARY_RUNTIME_NAMES = new Set([
  'opening-frame-details',
  'opening-hardware-details',
  'primary-opening-anchor',
  'primary-opening-panel',
  'primary-opening-leaf-details',
  'primary-opening-lower-panel',
  'primary-opening-fixed-lower-panels',
  'primary-door-rigid-frame',
  'primary-door-pivot',
]);
const AMBIENCE_ROOT_NAMES = new Set(['chimney', 'agungi']);

function collectPaletteResources(palette) {
  const resources = { materials: new Set(), textures: new Set() };
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) {
      addMaterialResource(value, resources.materials, resources.textures);
    } else if (value?.isTexture) {
      resources.textures.add(value);
    }
  }
  return resources;
}

function disposeBorrowingTree(root, paletteResources) {
  const resources = collectObjectResources(root);
  for (const material of paletteResources.materials) resources.materials.delete(material);
  for (const texture of paletteResources.textures) resources.textures.delete(texture);
  disposeObjectResources(resources);
}

function releaseSourceGeometries(root) {
  root?.traverse?.((object) => {
    if (!object.geometry?.dispose) return;
    object.geometry.dispose();
    // Keep the detached source tree only as the builder lifecycle's material
    // ownership ledger. Clearing the released geometry prevents a later
    // disposeBuilding() from dispatching a second dispose event.
    object.geometry = null;
  });
}

function disposeTreeGeometries(root) {
  const geometries = collectObjectResources(root).geometries;
  disposeObjectResources({
    geometries,
    materials: new Set(),
    textures: new Set(),
  });
}

function courtyardGeometry(polygon) {
  const shape = new THREE.Shape();
  polygon.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function buildCourtyard(plan, mats) {
  const mesh = new THREE.Mesh(courtyardGeometry(plan.courtyard.polygon), mats.ground);
  mesh.name = 'mja-inner-courtyard';
  mesh.position.y = Number.isFinite(plan.courtyard.y) ? plan.courtyard.y : 0.012;
  mesh.receiveShadow = true;
  return mesh;
}

function primaryWingId(plan) {
  return plan.openings.find((opening) => opening.id === plan.primaryOpeningId).wingId;
}

function namespaceWingOpeningRuntime(building, wingId) {
  building.traverse((object) => {
    if (!PRIMARY_RUNTIME_NAMES.has(object.name)) return;
    object.userData.mjaOriginalName = object.name;
    object.name = `mja-${wingId}-${object.name}`;
  });
}

function buildWing(wing, mats) {
  const building = buildBuilding({
    ...wing.building,
    mats,
  });
  building.name = `mja-wing-${wing.id}`;
  building.position.set(wing.center.x, Number(wing.center.y) || 0, wing.center.z);
  building.rotation.y = wing.yaw;
  building.userData.mjaWing = {
    id: wing.id,
    role: wing.role,
    footprint: wing.footprint,
    roofFootprint: wing.roofFootprint,
  };
  namespaceWingOpeningRuntime(building, wing.id);
  return building;
}

function createCompoundPrimaryAnchor(plan, authoritativeWingId) {
  const opening = plan.openings.find((candidate) => candidate.id === plan.primaryOpeningId);
  if (!opening) {
    throw new RangeError(`MJA primary opening not found: ${String(plan.primaryOpeningId)}`);
  }
  const center = opening.center;
  const tangent = opening.tangent;
  const outward = opening.outward;
  const x = new THREE.Vector3(tangent.x, 0, tangent.z).normalize();
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3(outward.x, 0, outward.z).normalize();
  const basis = new THREE.Matrix4().makeBasis(x, y, z);
  basis.setPosition(center.x, center.y, center.z);
  const anchor = new THREE.Group();
  anchor.name = 'primary-opening-anchor';
  anchor.applyMatrix4(basis);
  // Product DoF consumes this immutable focus centre. MJA door motion remains
  // intentionally static until an authored compound leaf can be isolated
  // without treating one standalone-wing leaf as the whole compound entrance.
  anchor.userData.openingDetailPlan = Object.freeze({
    id: opening.id,
    kind: opening.kind,
    style: 'giwa',
    primary: true,
    width: opening.width,
    height: opening.height,
    anchors: Object.freeze({
      focus: Object.freeze({ u: 0, y: 0, outward: 0 }),
    }),
    mjaStatic: true,
  });
  anchor.userData.mjaOpeningId = opening.id;
  anchor.userData.mjaWingId = authoritativeWingId;
  return anchor;
}

function ensureSinglePrimaryAnchor(root) {
  const anchors = [];
  root.traverse((object) => {
    if (object.name === 'primary-opening-anchor') anchors.push(object);
  });
  if (anchors.length !== 1) {
    throw new Error(`MJA compound must expose exactly one primary-opening-anchor, found ${anchors.length}`);
  }
  return anchors[0];
}

function detachAmbienceRoots(buildings, renderSource, root) {
  const ambience = new THREE.Group();
  ambience.name = 'mja-house-ambience-details';
  root.add(ambience);
  renderSource.updateWorldMatrix(true, true);
  for (const building of buildings) {
    const owned = [];
    building.traverse((object) => {
      if (AMBIENCE_ROOT_NAMES.has(object.name)) owned.push(object);
    });
    for (const object of owned) ambience.attach(object);
  }
  ambience.userData.asmChunked = true;
  return ambience;
}

/**
 * Assemble one renderer-free MJA plan into reusable local-space Three geometry.
 * A caller-supplied giwa palette remains caller-owned. When omitted, the root
 * owns one shared palette and disposeMjaHouse() releases it after every wing.
 */
export function buildMjaHouse(planInput, { mats } = {}) {
  const plan = validateMjaHousePlan(planInput);
  const palette = mats || makeMaterials('giwa');
  const paletteResources = collectPaletteResources(palette);
  const root = new THREE.Group();
  root.name = 'mja-house';
  const renderSource = new THREE.Group();
  renderSource.name = 'mja-house-render-source';
  const details = new THREE.Group();
  details.name = 'mja-house-details';
  const buildings = [];
  let ambience = null;
  let staticRender = null;

  try {
    details.add(buildCourtyard(plan, palette));
    renderSource.add(details);

    const authoritativeWingId = primaryWingId(plan);
    for (const wing of plan.wings) {
      const building = buildWing(wing, palette);
      buildings.push(building);
      renderSource.add(building);
    }

    // Retain the one renderer-authored wing anchor as a transform-only audit
    // object. The authoritative compound anchor remains the only object with
    // the public primary-opening-anchor name.
    renderSource.updateWorldMatrix(true, true);
    const authoredAnchor = renderSource.getObjectByName(
      `mja-${authoritativeWingId}-primary-opening-anchor`,
    );
    if (!authoredAnchor) throw new Error(`MJA authored primary anchor missing: ${authoritativeWingId}`);
    root.attach(authoredAnchor);
    // Chimney and hearth names are a real close-range ambience API. Keep these
    // two tiny subtrees physical and semantic; the large static envelope alone
    // is flattened.
    ambience = detachAmbienceRoots(buildings, renderSource, root);

    // Preserve authored window-light metadata before the hierarchy is flattened.
    root.userData.openingGlowAnchors = collectOpeningGlowAnchors(
      renderSource,
      { space: 'local' },
    );
    // Keep three semantic assembly/culling chunks: yard, north anchae, and the
    // one continuous ㄷ wing whose body owns the middle-gate passage. Exact
    // shadow-state partitioning avoids promoting intentionally unlit walls.
    staticRender = new THREE.Group();
    staticRender.name = 'mja-house-static';
    const sources = [
      ['courtyard', details],
      ...buildings.map((building, index) => [plan.wings[index].role, building]),
    ];
    for (const [role, source] of sources) {
      const chunk = mergeStatic([source], `mja-house-${role}`, {
        partitionShadowFlags: true,
        reattachShadowDepthTextureLifecycle: true,
      });
      chunk.userData.asmChunked = true;
      staticRender.add(chunk);
    }
    attachShadowDepthTextureLifecycle(staticRender);
    releaseSourceGeometries(renderSource);
    root.add(staticRender);
    root.add(createCompoundPrimaryAnchor(plan, authoritativeWingId));
    ensureSinglePrimaryAnchor(root);
    root.userData.mjaHouseHandle = {
      schema: plan.schema,
      kind: plan.kind,
      plan,
      primaryOpeningId: plan.primaryOpeningId,
      primaryWingId: authoritativeWingId,
      doorMotion: 'static',
    };
    root.userData.mjaDoorMotionExcluded = true;
    root.userData.materials = palette;
    lifecycle.set(root, {
      disposed: false,
      buildings,
      details,
      ambience,
      staticRender,
      paletteResources,
      ownsPalette: !mats,
    });
    return root;
  } catch (error) {
    if (staticRender) disposeTreeGeometries(staticRender);
    for (const building of buildings) disposeBuilding(building);
    disposeBorrowingTree(details, paletteResources);
    disposeBorrowingTree(ambience, paletteResources);
    if (!mats) {
      disposeObjectResources({
        geometries: new Set(),
        materials: paletteResources.materials,
        textures: paletteResources.textures,
      });
    }
    throw error;
  }
}

export function disposeMjaHouse(root) {
  const state = root && lifecycle.get(root);
  if (!state || state.disposed) return false;
  state.disposed = true;
  disposeTreeGeometries(state.staticRender);
  for (const building of state.buildings) disposeBuilding(building);
  disposeBorrowingTree(state.details, state.paletteResources);
  disposeBorrowingTree(state.ambience, state.paletteResources);
  if (state.ownsPalette) {
    disposeObjectResources({
      geometries: new Set(),
      materials: state.paletteResources.materials,
      textures: state.paletteResources.textures,
    });
  }
  return true;
}
