import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';
import { openingPlacementBasis } from './opening-placement.js';
import { createPrimaryDoorRecessGeometry } from './primary-door-panel.js';

// Three assembler for the pure opening-detail-plan. Fixed frame/threshold and
// the active primary-leaf rail/seam stay separate while sharing the existing
// envelope wood material; small ironwork uses one FULL-only material.

function transformGeometry(geometry, part, basis) {
  geometry.translate(part.u || 0, part.y || 0, part.outward || 0);
  geometry.applyMatrix4(basis);
  return geometry;
}

function partGeometry(part, basis) {
  if (part.shape === 'torus') {
    return transformGeometry(
      new THREE.TorusGeometry(part.radius, part.tube, 5, 12),
      part,
      basis,
    );
  }
  if (part.shape === 'cylinder') {
    const geometry = new THREE.CylinderGeometry(part.radius, part.radius, part.depth, 8);
    geometry.rotateX(Math.PI * 0.5);
    return transformGeometry(geometry, part, basis);
  }
  return transformGeometry(
    new THREE.BoxGeometry(part.width, part.height, part.depth),
    part,
    basis,
  );
}

function plainVector(vector) {
  return Object.freeze({ x: vector.x, y: vector.y, z: vector.z });
}

function openingGlowMetadata(plan, basis) {
  const anchor = plan.anchors.glow;
  const position = new THREE.Vector3(anchor.u, anchor.y, anchor.outward).applyMatrix4(basis);
  const outward = new THREE.Vector3(0, 0, 1).transformDirection(basis);
  return Object.freeze({
    openingId: plan.id,
    kind: plan.kind,
    style: plan.style,
    primary: plan.primary,
    width: plan.width,
    height: plan.height,
    position: plainVector(position),
    outward: plainVector(outward),
  });
}

export function createOpeningDetailAssembler(target, materials) {
  const frameGeometries = [];
  const primaryLeafGeometries = [];
  const hardwareGeometries = [];
  const primaryRecesses = [];
  const openingGlowAnchors = [];
  let finished = false;

  function add(plan, placement, owner = null) {
    if (finished) throw new Error('Opening detail assembler is already finished');
    const basis = openingPlacementBasis(placement);
    openingGlowAnchors.push(openingGlowMetadata(plan, basis));
    for (const part of plan.frame.parts) {
      // Active-leaf rail/seam split only when hinge motion owns a pivot.
      const pivot = plan.primary && plan.kind === 'door' && plan.anchors.pivot
        ? plan.anchors.pivot
        : null;
      if (pivot && part.kind === 'lower-panel-rail') {
        primaryLeafGeometries.push(partGeometry({
          ...part, u: pivot.leafCenterU, width: pivot.leafWidth,
        }, basis));
        const fixedWidth = plan.width - pivot.leafWidth;
        if (fixedWidth > 1e-5) frameGeometries.push(partGeometry({
          ...part,
          u: -pivot.hingeSide * pivot.leafWidth * 0.5,
          width: fixedWidth,
        }, basis));
      } else if (pivot && part.kind === 'leaf-seam'
          && Math.abs(part.u - pivot.meetingU) < 1e-6) {
        primaryLeafGeometries.push(partGeometry(part, basis));
      } else {
        frameGeometries.push(partGeometry(part, basis));
      }
    }
    if (plan.threshold) frameGeometries.push(partGeometry(plan.threshold, basis));
    for (const part of plan.hardware) hardwareGeometries.push(partGeometry(part, basis));

    if (plan.primary) {
      const marker = new THREE.Group();
      marker.name = 'primary-opening-anchor';
      marker.applyMatrix4(basis);
      marker.userData.openingDetailPlan = plan;
      target.add(marker);
      if (owner) {
        owner.name = 'primary-opening-panel';
        owner.userData.openingDetailId = plan.id;
      }
    }
    return plan;
  }

  function addPrimaryRecess(plan, placement, panelDepth = plan?.wallThickness) {
    if (finished) throw new Error('Opening detail assembler is already finished');
    const { geometry, recessDepth } = createPrimaryDoorRecessGeometry({
      plan, placement, panelDepth,
    });
    frameGeometries.push(geometry);
    primaryRecesses.push(Object.freeze({ openingId: plan.id, recessDepth }));
    return recessDepth;
  }

  function finish() {
    if (finished) return;
    finished = true;
    // Plain immutable target-local metadata only: no marker Object3D, geometry,
    // material, texture, or draw call is allocated per opening.
    target.userData.openingGlowAnchors = Object.freeze(openingGlowAnchors.slice());
    if (frameGeometries.length) {
      const mesh = new THREE.Mesh(
        mergeOwnedGeometries(frameGeometries, 'Opening frame geometries'),
        materials.frame,
      );
      mesh.name = 'opening-frame-details';
      mesh.userData.openingDetailTier = 'envelope';
      mesh.userData.primaryDoorRecesses = Object.freeze(primaryRecesses.slice());
      mesh.receiveShadow = false;
      target.add(mesh);
    }
    if (primaryLeafGeometries.length) {
      const mesh = new THREE.Mesh(
        mergeOwnedGeometries(primaryLeafGeometries, 'Primary opening leaf geometries'),
        materials.frame,
      );
      mesh.name = 'primary-opening-leaf-details';
      mesh.userData.openingDetailTier = 'envelope';
      mesh.receiveShadow = false;
      target.add(mesh);
    }
    if (hardwareGeometries.length) {
      const mesh = new THREE.Mesh(
        mergeOwnedGeometries(hardwareGeometries, 'Opening hardware geometries'),
        materials.hardware,
      );
      mesh.name = 'opening-hardware-details';
      mesh.userData.openingDetailTier = 'full';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      target.add(mesh);
    }
  }

  return { add, addPrimaryRecess, finish };
}
