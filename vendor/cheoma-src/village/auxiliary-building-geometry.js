import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';

// Three adapter for the renderer-free auxiliary-building plan. The plan owns
// placement, dimensions, covering, and footprint. This module only turns that
// exact local-space record into the existing low-cost body + gable silhouette.

export const AUXILIARY_BUILDING_MATERIAL_ROLES = Object.freeze({
  tile: Object.freeze({
    body: 'plaster',
    roof: 'tileConvex',
    ridge: 'tileRidge',
  }),
  thatch: Object.freeze({
    body: 'mud',
    roof: 'thatch',
    ridge: 'jipjul',
  }),
});

const lifecycleByRoot = new WeakMap();
const ROOF_PANEL_THICKNESS = 0.1;
const RIDGE_HEIGHT = 0.12;
const RIDGE_DEPTH = 0.14;
const DIMENSION_EPSILON = 1e-6;

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function positive(value, label) {
  const resolved = finite(value, label);
  if (!(resolved > 0)) throw new RangeError(`${label} must be positive`);
  return resolved;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('auxiliary building spec must be an object');
  }
  nonEmptyString(spec.id, 'auxiliary building spec.id');
  nonEmptyString(spec.role, 'auxiliary building spec.role');
  finite(spec.local?.x, 'auxiliary building spec.local.x');
  finite(spec.local?.z, 'auxiliary building spec.local.z');
  finite(spec.local?.yaw, 'auxiliary building spec.local.yaw');
  const width = positive(spec.body?.width, 'auxiliary building spec.body.width');
  const depth = positive(spec.body?.depth, 'auxiliary building spec.body.depth');
  const height = positive(spec.body?.height, 'auxiliary building spec.body.height');
  if (spec.roof?.form !== 'gable') {
    throw new RangeError('auxiliary building spec.roof.form must be gable');
  }
  if (!AUXILIARY_BUILDING_MATERIAL_ROLES[spec.roof?.covering]) {
    throw new RangeError(
      'auxiliary building spec.roof.covering must be tile or thatch',
    );
  }
  const overhang = positive(
    spec.roof.overhang,
    'auxiliary building spec.roof.overhang',
  );
  const rise = positive(spec.roof.rise, 'auxiliary building spec.roof.rise');
  const roofTopY = finite(spec.roofTopY, 'auxiliary building spec.roofTopY');
  if (Math.abs(roofTopY - (height + rise)) > DIMENSION_EPSILON) {
    throw new RangeError(
      'auxiliary building spec.roofTopY must equal body.height + roof.rise',
    );
  }
  if (!Array.isArray(spec.footprint) || spec.footprint.length !== 4) {
    throw new RangeError('auxiliary building spec.footprint must contain four points');
  }
  spec.footprint.forEach((point, index) => {
    finite(point?.x, `auxiliary building spec.footprint[${index}].x`);
    finite(point?.z, `auxiliary building spec.footprint[${index}].z`);
  });
  return { width, depth, height, overhang, rise, roofTopY };
}

function resolveMaterials(covering, wallMats) {
  if (!wallMats || typeof wallMats !== 'object') {
    throw new TypeError('auxiliary building wallMats must be an object');
  }
  const roles = AUXILIARY_BUILDING_MATERIAL_ROLES[covering];
  const resolved = {};
  for (const [part, role] of Object.entries(roles)) {
    const material = wallMats[role];
    if (!material?.isMaterial) {
      throw new TypeError(`auxiliary building wallMats.${role} must be a material`);
    }
    resolved[part] = material;
  }
  return resolved;
}

function buildRoofGeometry(width, depth, height, overhang, rise) {
  const roofWidth = width + overhang * 2;
  const run = depth * 0.5 + overhang;
  const slopeLength = Math.hypot(run, rise);
  const angle = Math.atan2(rise, run);
  const thickness = Math.min(
    ROOF_PANEL_THICKNESS,
    rise * 0.35,
    run * 0.2,
  );
  const halfNormalZ = Math.sin(angle) * thickness * 0.5;
  const centerY = height + rise * 0.5 - Math.cos(angle) * thickness * 0.5;
  const sources = [];
  let mergeOwnsSources = false;
  try {
    for (const side of [-1, 1]) {
      const geometry = new THREE.BoxGeometry(
        roofWidth,
        thickness,
        slopeLength,
      );
      sources.push(geometry);
      geometry.rotateX(side * angle);
      // Pull the panel centre inward by its normal's horizontal half-extent.
      // The complete solid then ends exactly at the plan's roof-overhang
      // footprint instead of leaking a thin strip beyond it.
      geometry.translate(
        0,
        centerY,
        side * (run * 0.5 - halfNormalZ),
      );
    }
    mergeOwnsSources = true;
    return mergeOwnedGeometries(
      sources,
      'Auxiliary building gable roof geometries',
    );
  } catch (error) {
    if (!mergeOwnsSources) {
      for (const geometry of sources) geometry.dispose();
    }
    throw error;
  }
}

function makeMesh(name, geometry, material, materialRole) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.auxiliaryMaterialRole = materialRole;
  return mesh;
}

/**
 * Build one planned auxiliary building in parcel-local coordinates.
 *
 * The returned Group owns its three geometries and exact `spec.local`
 * transform. `wallMats` and every material/texture reachable through it remain
 * caller-owned; no material is cloned or created here.
 */
export function buildAuxiliaryBuilding(spec, wallMats) {
  const dimensions = validateSpec(spec);
  const materials = resolveMaterials(spec.roof.covering, wallMats);
  const geometries = new Set();
  const root = new THREE.Group();
  root.name = 'auxiliary-building';
  root.position.set(spec.local.x, 0, spec.local.z);
  root.rotation.y = spec.local.yaw;
  root.userData.auxiliarySpec = spec;
  root.userData.auxiliaryBuilding = {
    id: spec.id,
    role: spec.role,
    covering: spec.roof.covering,
    geometryOwnership: 'builder',
    materialOwnership: 'caller',
  };

  try {
    const bodyGeometry = new THREE.BoxGeometry(
      dimensions.width,
      dimensions.height,
      dimensions.depth,
    );
    geometries.add(bodyGeometry);
    const body = makeMesh(
      'auxiliary-building-body',
      bodyGeometry,
      materials.body,
      AUXILIARY_BUILDING_MATERIAL_ROLES[spec.roof.covering].body,
    );
    body.position.y = dimensions.height * 0.5;
    root.add(body);

    const roofGeometry = buildRoofGeometry(
      dimensions.width,
      dimensions.depth,
      dimensions.height,
      dimensions.overhang,
      dimensions.rise,
    );
    geometries.add(roofGeometry);
    root.add(makeMesh(
      'auxiliary-building-gable-roof',
      roofGeometry,
      materials.roof,
      AUXILIARY_BUILDING_MATERIAL_ROLES[spec.roof.covering].roof,
    ));

    const ridgeHeight = Math.min(RIDGE_HEIGHT, dimensions.rise * 0.4);
    const ridgeDepth = Math.min(
      RIDGE_DEPTH,
      dimensions.overhang,
      dimensions.depth * 0.2,
    );
    const ridgeWidth = Math.min(
      dimensions.width + 0.1,
      dimensions.width + dimensions.overhang * 2,
    );
    const ridgeGeometry = new THREE.BoxGeometry(
      ridgeWidth,
      ridgeHeight,
      ridgeDepth,
    );
    geometries.add(ridgeGeometry);
    const ridge = makeMesh(
      'auxiliary-building-roof-ridge',
      ridgeGeometry,
      materials.ridge,
      AUXILIARY_BUILDING_MATERIAL_ROLES[spec.roof.covering].ridge,
    );
    ridge.position.y = dimensions.roofTopY - ridgeHeight * 0.5;
    root.add(ridge);

    lifecycleByRoot.set(root, {
      disposed: false,
      geometries,
    });
    return root;
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    root.clear();
    root.visible = false;
    throw error;
  }
}

/**
 * Release builder-owned geometry exactly once. Scene detachment and every
 * borrowed material/texture remain the caller's responsibility.
 */
export function disposeAuxiliaryBuilding(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;
  for (const geometry of lifecycle.geometries) geometry.dispose();
  lifecycle.geometries.clear();
  root.clear();
  root.visible = false;
  root.userData.auxiliarySpec = null;
  root.userData.auxiliaryBuilding = null;
  return true;
}
