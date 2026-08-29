import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';
import { validateDangsanPlan } from './dangsan-plan.js';

// Thin Three adapter for the renderer-free dangsan plan.
//
// Product budget: at most two borrowed material roles → ≤ +2 draws.
//   stone — packed ritual ring + low altar
//   wood  — optional dangjip body + simple gable roof (no new material family)
// The adapter never invents placement; every transform comes from the pure plan.

export const DANGSAN_MATERIAL_ROLES = Object.freeze(['stone', 'wood']);

const lifecycleByRoot = new WeakMap();
const RING_SEGMENTS = 14;
const RING_HEIGHT = 0.07;
const RING_LIFT = 0.012;
const DISK_THICKNESS = 0.03;
const ROOF_PANEL_THICKNESS = 0.08;

function requireMaterial(materials, role) {
  const material = materials?.[role];
  if (!material?.isMaterial) {
    throw new TypeError(`dangsan materials.${role} must be a Three material`);
  }
  return material;
}

function placeBox(width, height, depth, transform = {}) {
  const geometry = new THREE.BoxGeometry(width, height, depth, 1, 1, 1);
  geometry.translate(0, height * 0.5, 0);
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(transform.x || 0, transform.y || 0, transform.z || 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, transform.yaw || 0, 0)),
    new THREE.Vector3(1, 1, 1),
  );
  geometry.applyMatrix4(matrix);
  return geometry;
}

function placeCylinder(radiusTop, radiusBottom, height, segments, transform = {}) {
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    segments,
    1,
  );
  geometry.translate(0, height * 0.5, 0);
  geometry.translate(transform.x || 0, transform.y || 0, transform.z || 0);
  return geometry;
}

function buildClearingGeometry(site) {
  const clearing = site.clearing;
  const y = clearing.surfaceY + RING_LIFT;
  const sources = [];
  try {
    // Packed ritual pad under the canopy (황토/다진 흙 암시 — stone role, no new mat).
    sources.push(placeCylinder(
      clearing.radius * 0.92,
      clearing.radius * 0.96,
      DISK_THICKNESS,
      RING_SEGMENTS,
      { x: clearing.x, y, z: clearing.z },
    ));
    // Low stone kerb that reads as a sacred boundary without a third draw.
    const ring = new THREE.TorusGeometry(
      clearing.radius * 0.97,
      RING_HEIGHT * 0.45,
      5,
      RING_SEGMENTS,
    );
    ring.rotateX(Math.PI / 2);
    ring.translate(clearing.x, y + DISK_THICKNESS * 0.5, clearing.z);
    sources.push(ring);

    const altar = site.altar;
    sources.push(placeBox(
      altar.width,
      altar.height * 0.55,
      altar.depth,
      {
        x: altar.x,
        y: altar.surfaceY + RING_LIFT,
        z: altar.z,
        yaw: altar.yaw || 0,
      },
    ));
    sources.push(placeBox(
      altar.width * 0.78,
      altar.height * 0.45,
      altar.depth * 0.72,
      {
        x: altar.x,
        y: altar.surfaceY + RING_LIFT + altar.height * 0.55,
        z: altar.z,
        yaw: altar.yaw || 0,
      },
    ));
    return mergeOwnedGeometries(sources, 'dangsan stone batch');
  } catch (error) {
    for (const geometry of sources) geometry.dispose();
    throw error;
  }
}

function buildDangjipGeometry(shed) {
  const sources = [];
  try {
    const y = shed.surfaceY + RING_LIFT;
    const body = shed.body;
    const roof = shed.roof;
    const yaw = shed.yaw || 0;
    sources.push(placeBox(
      body.width,
      body.height,
      body.depth,
      { x: shed.x, y, z: shed.z, yaw },
    ));

    // Simple two-panel gable in the same wood batch (no thatch material draw).
    const roofWidth = body.width + roof.overhang * 2;
    const run = body.depth * 0.5 + roof.overhang;
    const slopeLength = Math.hypot(run, roof.rise);
    const angle = Math.atan2(roof.rise, run);
    const thickness = Math.min(ROOF_PANEL_THICKNESS, roof.rise * 0.4, run * 0.25);
    const centerY = body.height + roof.rise * 0.5
      - Math.cos(angle) * thickness * 0.5;

    for (const side of [-1, 1]) {
      const panel = new THREE.BoxGeometry(roofWidth, thickness, slopeLength, 1, 1, 1);
      panel.rotateX(side * -angle);
      panel.translate(0, centerY, side * (run * 0.5) * Math.cos(angle));
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(shed.x, y, shed.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
        new THREE.Vector3(1, 1, 1),
      );
      panel.applyMatrix4(matrix);
      sources.push(panel);
    }

    sources.push(placeBox(
      roofWidth * 0.98,
      thickness * 0.9,
      thickness * 1.1,
      {
        x: shed.x,
        y: y + body.height + roof.rise - thickness * 0.4,
        z: shed.z,
        yaw,
      },
    ));
    return mergeOwnedGeometries(sources, 'dangsan wood batch');
  } catch (error) {
    for (const geometry of sources) geometry.dispose();
    throw error;
  }
}

function makeMesh(geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  return mesh;
}

/**
 * Build ≤2 physical meshes from a dangsan plan using borrowed materials.
 *
 * @param {object} plan pure plan from planDangsan / validateDangsanPlan
 * @param {{ materials: { stone: THREE.Material, wood?: THREE.Material } }} options
 */
export function buildDangsan(plan, { materials } = {}) {
  validateDangsanPlan(plan);
  const root = new THREE.Group();
  root.name = 'village-dangsan';
  const geometries = new Set();
  const stoneMat = requireMaterial(materials, 'stone');
  const woodMat = plan.sites.some((site) => site.dangjip)
    ? requireMaterial(materials, 'wood')
    : null;

  try {
    const stoneParts = [];
    const woodParts = [];
    for (const site of plan.sites) {
      stoneParts.push(buildClearingGeometry(site));
      if (site.dangjip) woodParts.push(buildDangjipGeometry(site.dangjip));
    }

    if (stoneParts.length) {
      const geometry = mergeOwnedGeometries(stoneParts, 'dangsan stone root');
      geometries.add(geometry);
      root.add(makeMesh(geometry, stoneMat, 'dangsan-stone'));
    } else {
      for (const geometry of stoneParts) geometry.dispose();
    }

    if (woodParts.length) {
      const geometry = mergeOwnedGeometries(woodParts, 'dangsan wood root');
      geometries.add(geometry);
      root.add(makeMesh(geometry, woodMat, 'dangsan-wood'));
    }

    if (root.children.length > 2) {
      throw new RangeError('dangsan renderer exceeded the +2 draw budget');
    }

    root.userData.dangsan = {
      schema: plan.schema,
      siteCount: plan.sites.length,
      meshCount: root.children.length,
      materialRoles: root.children.map((child) => (
        child.name === 'dangsan-wood' ? 'wood' : 'stone'
      )),
      materialOwnership: 'caller',
      geometryOwnership: 'renderer',
    };
    lifecycleByRoot.set(root, { disposed: false, geometries });
    return root;
  } catch (error) {
    for (const geometry of geometries) geometry.dispose();
    root.clear();
    throw error;
  }
}

/**
 * Dispose renderer-owned geometries once. Borrowed materials are untouched.
 */
export function disposeDangsan(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;
  for (const geometry of lifecycle.geometries) geometry.dispose();
  lifecycle.geometries.clear();
  root.clear();
  root.visible = false;
  root.userData.dangsan = null;
  return true;
}
