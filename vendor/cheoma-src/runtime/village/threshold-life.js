import * as THREE from 'three';
import { planThresholdLife } from '../../props/threshold-life-plan.js';
import {
  createThresholdLifeMaterial,
  createThresholdLifeMesh,
  thresholdLifePlacementFrame,
} from '../../props/threshold-life.js';

const DETAIL_NAME = 'threshold-life-detail';

function placementFor(root, condition) {
  const anchor = root?.getObjectByName('primary-opening-anchor');
  const opening = anchor?.userData?.openingDetailPlan;
  if (!anchor || !opening) return null;
  const plan = planThresholdLife({
    opening,
    seed: `${opening.seed}:focus-threshold`,
    condition,
  });
  if (!plan) return null;
  root.updateWorldMatrix(true, true);
  const basis = root.matrixWorld.clone().invert().multiply(anchor.matrixWorld);
  return { plan, basis };
}

function detailsIn(root) {
  const details = [];
  root?.traverse((object) => {
    if (object.name === DETAIL_NAME) details.push(object);
  });
  return details;
}

/**
 * Own the focused threshold-life renderer for one VillageHandle lifetime.
 *
 * Geometry belongs to each focused overlay and is released on detach. The one
 * opaque material is shared across focus hops, weather swaps, and live-edit
 * rebuilds so those paths cannot repeatedly retire and relink its shader
 * program. `__kept` protects it from the handle's generic subtree disposal;
 * this controller releases it exactly once from `dispose()`.
 */
export function createThresholdLifeRuntime() {
  let material = null;
  let disposed = false;

  function sharedMaterial() {
    if (disposed) return null;
    if (!material) {
      material = createThresholdLifeMaterial();
      material.userData.__kept = true;
      material.userData.thresholdLifeRuntimeOwned = true;
    }
    return material;
  }

  function releaseDetail(detail) {
    if (!detail) return;
    detail.removeFromParent();
    detail.geometry?.dispose();
    detail.clear();
  }

  function detach(root) {
    const details = detailsIn(root);
    for (const detail of details) releaseDetail(detail);
    return details.length;
  }

  function attach(root, condition = 'dry') {
    if (disposed || !root) return null;
    detach(root);
    const placement = placementFor(root, condition);
    if (!placement) return null;
    const ownedMaterial = sharedMaterial();
    if (!ownedMaterial) return null;
    const mesh = createThresholdLifeMesh(placement.plan, placement.basis, ownedMaterial);
    // The focused overlay root owns the batch so a scaled house child cannot
    // distort museum-scale footwear dimensions.
    root.add(mesh);
    return mesh;
  }

  // Consume a mesh detached from the previous live-edit overlay. Compatible
  // placement retains its geometry; an incompatible topology/mirror releases
  // it and creates the correct replacement in the new overlay.
  function reattach(root, mesh, condition = 'dry') {
    if (disposed || !root || !mesh) {
      releaseDetail(mesh);
      return null;
    }
    const placement = placementFor(root, condition);
    const previous = mesh.userData?.thresholdLifeBasis;
    const previousPlan = mesh.userData?.thresholdLifePlan;
    const compatible = placement
      && Array.isArray(previous)
      && previous.length === 16
      && previousPlan?.placement?.signature === placement.plan.placement.signature;
    if (!compatible) {
      releaseDetail(mesh);
      return attach(root, condition);
    }

    const next = thresholdLifePlacementFrame(placement.plan, placement.basis);
    const prior = new THREE.Matrix4().fromArray(previous);
    if (Math.sign(prior.determinant()) !== Math.sign(next.frame.determinant())) {
      releaseDetail(mesh);
      return attach(root, condition);
    }
    mesh.geometry.applyMatrix4(prior.invert());
    mesh.geometry.applyMatrix4(next.frame);
    mesh.material = sharedMaterial();
    mesh.userData.thresholdLifePlan = placement.plan;
    mesh.userData.thresholdLifeBasis = next.frame.toArray();
    mesh.userData.thresholdLifeSourceScale = next.scale;
    root.add(mesh);
    return mesh;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    material?.dispose();
    material = null;
  }

  return { attach, detach, reattach, dispose };
}
