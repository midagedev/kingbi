import * as THREE from 'three';
import * as G from '../../core/math/geom2.js';
import { mergeStatic } from '../../village/instancing.js';
import {
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_SIGN_POLICY,
  isSijeonShop,
  planSijeonFacade,
} from '../../village/sijeon-plan.js';

// Three renderer for the renderer-free sijeon facade contract.
//
// The caller owns every material and the terrain sampler. This module owns only
// the geometries baked into its merged result, so a host can share one palette
// across a village or substitute another visual system without hidden textures,
// materials, site globals, or renderer RNG.

const lifecycleByRoot = new WeakMap();
const REQUIRED_MATERIALS = Object.freeze([
  'frame',
  'opening',
  'bench',
  'storage',
  'roof',
]);
const ROOF_THICKNESS = 0.14;
const BENCH_TOP_THICKNESS = 0.12;
const BENCH_LEG_WIDTH = 0.12;

function requireMaterial(materials, role) {
  const material = materials?.[role];
  if (!material?.isMaterial) {
    throw new TypeError(`sijeon materials.${role} must be a Three.js material`);
  }
  return material;
}

function resolveMaterials(materials) {
  return Object.fromEntries(REQUIRED_MATERIALS.map((role) => [
    role,
    requireMaterial(materials, role),
  ]));
}

function requireHeightAt(heightAt) {
  if (typeof heightAt !== 'function') {
    throw new TypeError('sijeon heightAt must be a function');
  }
  return heightAt;
}

function setPhysicalMesh(mesh, name) {
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addBox(group, unitBox, part, material, name = part.role) {
  const mesh = setPhysicalMesh(new THREE.Mesh(unitBox, material), name);
  mesh.position.set(part.center.x, part.center.y, part.center.z);
  mesh.scale.set(part.size.width, part.size.height, part.size.depth);
  group.add(mesh);
  return mesh;
}

function addDisplayBench(group, unitBox, part, material) {
  const bottomY = part.center.y - part.size.height / 2;
  const topHeight = Math.min(BENCH_TOP_THICKNESS, part.size.height * 0.28);
  const top = {
    ...part,
    center: {
      ...part.center,
      y: part.center.y + part.size.height / 2 - topHeight / 2,
    },
    size: { ...part.size, height: topHeight },
  };
  addBox(group, unitBox, top, material, `${part.role}-top`);

  const legHeight = Math.max(0, part.size.height - topHeight);
  const legWidth = Math.min(
    BENCH_LEG_WIDTH,
    part.size.width * 0.16,
  );
  const legInset = Math.max(0, part.size.width / 2 - legWidth * 1.35);
  for (const side of [-1, 1]) {
    addBox(group, unitBox, {
      role: part.role,
      center: {
        x: part.center.x + side * legInset,
        y: bottomY + legHeight / 2,
        z: part.center.z,
      },
      size: {
        width: legWidth,
        height: legHeight,
        depth: part.size.depth * 0.82,
      },
    }, material, `${part.role}-leg`);
  }
}

function addRoof(group, unitBox, facade, materials) {
  const { roof } = facade;
  const halfDepth = roof.depth / 2;
  const slopeLength = Math.hypot(halfDepth, roof.rise);
  const angle = Math.atan2(roof.rise, halfDepth);
  for (const side of [-1, 1]) {
    const slope = setPhysicalMesh(new THREE.Mesh(unitBox, materials.roof), 'gable-roof-slope');
    slope.position.set(
      roof.center.x,
      roof.center.y + roof.rise / 2,
      roof.center.z + side * roof.depth / 4,
    );
    slope.scale.set(roof.width, ROOF_THICKNESS, slopeLength);
    slope.rotation.x = side * angle;
    group.add(slope);
  }
}

function buildShopUnit(shop, materials, unitBox) {
  const facade = planSijeonFacade(shop);
  const unit = new THREE.Group();
  unit.name = `sijeon-${shop.id ?? 'shop'}`;
  const signs = Array.isArray(facade.signs) ? facade.signs : [];

  for (const column of facade.columns) {
    addBox(unit, unitBox, column, materials.frame);
  }
  for (const lintel of facade.lintels) {
    addBox(unit, unitBox, lintel, materials.frame);
  }
  for (const opening of facade.openings) {
    addBox(unit, unitBox, opening, materials.opening);
    // 판문 한 짝(plan 파생 순수값). 기존 frame 재질을 빌려 쓰므로 새 재질·텍스처·드로우콜이 없다.
    if (opening.panel) addBox(unit, unitBox, opening.panel, materials.frame);
  }
  for (const bench of facade.benches) {
    addDisplayBench(unit, unitBox, bench, materials.bench);
  }
  const signMaterial = materials[SIJEON_SIGN_POLICY.materialRole] || materials.frame;
  for (const sign of signs) {
    if (sign.emissive) throw new Error('sijeon marker boards must be non-emissive');
    addBox(unit, unitBox, sign, signMaterial, sign.role);
  }
  addBox(unit, unitBox, facade.storage, materials.storage);
  addRoof(unit, unitBox, facade, materials);
  unit.userData.sijeonSignCount = signs.length;
  return unit;
}

function disposeInputGeometries(root, additional = []) {
  const geometries = new Set(additional);
  root.traverse((object) => {
    if (object.geometry?.dispose) geometries.add(object.geometry);
  });
  for (const geometry of geometries) geometry.dispose();
}

/**
 * Build one low-draw sijeon row renderer.
 *
 * `materials` is a semantic, caller-owned set:
 * `{ frame, opening, bench, storage, roof }`.
 * `heightAt(x, z)` is also caller-owned and is the sole terrain dependency.
 *
 * The result borrows those materials and owns its merged geometries. Remove it
 * from the scene before calling disposeSijeon(); caller materials remain valid.
 */
export function buildSijeon(shops, { materials, heightAt } = {}) {
  if (!Array.isArray(shops)) throw new TypeError('sijeon shops must be an array');
  const resolvedMaterials = resolveMaterials(materials);
  const terrainHeightAt = requireHeightAt(heightAt);
  const source = new THREE.Group();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  try {
    const builtShops = [];
    let breakCount = 0;
    let signCount = 0;
    for (const shop of shops) {
      // Reserved break footprints stay in the plan as parcel blockers but own no
      // solid mass — that is the #218 row-break product read (not a missing mesh).
      if (!isSijeonShop(shop)) {
        breakCount++;
        continue;
      }
      const unit = buildShopUnit(
        shop,
        resolvedMaterials,
        unitBox,
      );
      const x = shop?.center?.x;
      const z = shop?.center?.z;
      const frontDir = shop?.frontDir;
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        throw new TypeError('sijeon shop center must contain finite x/z');
      }
      if (!Number.isFinite(frontDir?.x) || !Number.isFinite(frontDir?.z)) {
        throw new TypeError('sijeon shop frontDir must contain finite x/z');
      }
      if (Math.hypot(frontDir.x, frontDir.z) < 1e-9) {
        throw new RangeError('sijeon shop frontDir must be non-zero');
      }
      const y = terrainHeightAt(x, z);
      if (!Number.isFinite(y)) {
        throw new TypeError(`sijeon heightAt returned a non-finite height for ${shop.id ?? 'shop'}`);
      }
      unit.position.set(x, y, z);
      unit.rotation.y = G.facingY(frontDir);
      signCount += unit.userData.sijeonSignCount || 0;
      source.add(unit);
      builtShops.push(shop);
    }

    const root = mergeStatic([source], 'village-sijeon');
    root.userData.sijeon = {
      schemaVersion: SIJEON_FACADE_SCHEMA_VERSION,
      shopIds: builtShops.map((shop) => shop.id).filter((id) => id != null),
      shopCount: builtShops.length,
      signCount,
      breakCount,
      footprintCount: shops.length,
      materialOwnership: 'caller',
      geometryOwnership: 'renderer',
    };
    lifecycleByRoot.set(root, { disposed: false });
    return root;
  } finally {
    // mergeStatic bakes cloned world-space geometry. The temporary unit geometry
    // is never part of its result and must be released on success and failure.
    disposeInputGeometries(source, [unitBox]);
    source.clear();
  }
}

/**
 * Dispose renderer-owned geometry exactly once. Caller materials are preserved.
 * Scene detachment remains the caller's responsibility.
 */
export function disposeSijeon(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;
  const geometries = new Set();
  root.traverse((object) => {
    if (object.geometry?.dispose) geometries.add(object.geometry);
  });
  for (const geometry of geometries) geometry.dispose();
  return true;
}
