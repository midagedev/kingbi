import * as THREE from 'three';
import { openingPlacementBasis } from './opening-placement.js';

function segmentGeometry(segment, {
  panelBottom, panelHeight, depth, totalWidth, uRepeats, vMin, outward, basis,
}) {
  const geometry = new THREE.BoxGeometry(segment.width, panelHeight, depth);
  const uv = geometry.attributes.uv;
  const u0 = ((segment.center - segment.width * 0.5) / totalWidth + 0.5) * uRepeats;
  const u1 = ((segment.center + segment.width * 0.5) / totalWidth + 0.5) * uRepeats;
  for (let index = 0; index < uv.count; index++) {
    uv.setXY(
      index,
      u0 + uv.getX(index) * (u1 - u0),
      vMin + uv.getY(index) * (1 - vMin),
    );
  }
  uv.needsUpdate = true;
  geometry.translate(segment.center, panelBottom + panelHeight * 0.5, outward);
  geometry.applyMatrix4(basis);
  return geometry;
}

// Split one multi-leaf primary panel into exactly one moving outer leaf and one
// fixed remainder. Both meshes reuse the caller's material; only geometry
// ownership changes, so opening interaction adds no material/program family.
export function createPrimaryDoorPanelSegments({
  target,
  plan,
  placement,
  material,
  panelBottom = 0,
  panelHeight = plan?.height || 0,
  depth = plan?.wallThickness || 0.1,
  uRepeats = 1,
  vMin = 0,
  activeName = 'primary-opening-panel',
  fixedName = 'primary-opening-fixed-panels',
  castShadow = true,
  receiveShadow = true,
} = {}) {
  const pivot = plan?.anchors?.pivot;
  if (!target || !plan?.primary || !pivot || !material || panelHeight <= 0) {
    throw new Error('Primary door panel segments require a primary plan, target, and material');
  }
  const active = {
    center: pivot.leafCenterU,
    width: pivot.leafWidth,
  };
  const fixed = {
    center: -pivot.hingeSide * pivot.leafWidth * 0.5,
    width: plan.width - pivot.leafWidth,
  };
  const basis = openingPlacementBasis(placement);
  const options = {
    panelBottom, panelHeight, depth, totalWidth: plan.width,
    outward: pivot.outward || 0,
    uRepeats, vMin, basis,
  };
  const makeMesh = (segment, name) => {
    const mesh = new THREE.Mesh(segmentGeometry(segment, options), material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.userData.openingDetailId = plan.id;
    target.add(mesh);
    return mesh;
  };
  return {
    active: makeMesh(active, activeName),
    fixed: fixed.width > 1e-5 ? makeMesh(fixed, fixedName) : null,
  };
}

// A solid host wall can remain behind an overlaid door panel (notably choga and
// the representative hanok). This returns a two-sided face for the assembler's
// existing fixed frame batch: no new mesh, material, draw call, or shader family.
export function createPrimaryDoorRecessGeometry({
  plan,
  placement,
  panelDepth = plan?.wallThickness || 0.1,
  backClearance = 0.002,
} = {}) {
  if (!plan?.primary || plan.kind !== 'door') {
    throw new Error('Primary door recess requires a primary door plan');
  }
  const recessDepth = Math.max(0.002, panelDepth * 0.5 + backClearance);
  const geometry = new THREE.PlaneGeometry(plan.width, plan.height);
  // Opening bases can be mirrored on clockwise/courtyard edges. Duplicate the
  // two triangles with reversed winding instead of cloning a DoubleSide material.
  const front = Array.from(geometry.index.array);
  const back = [];
  for (let index = 0; index < front.length; index += 3) {
    back.push(front[index], front[index + 2], front[index + 1]);
  }
  geometry.setIndex([...front, ...back]);
  // Hinge primary doors own pivot.outward; fixed primary still needs a recess
  // plane, so fall back to the wall face (0 in opening-local outward).
  const leafOutward = plan.anchors?.pivot?.outward || 0;
  geometry.translate(0, plan.height * 0.5, leafOutward - recessDepth);
  geometry.applyMatrix4(openingPlacementBasis(placement));
  return { geometry, recessDepth };
}
