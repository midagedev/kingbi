import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

// One local opening frame for panel splitting, frame details, hardware, and
// anchors. Keeping this matrix construction shared prevents a rotated wall from
// giving the visible leaf and its hinge slightly different axes.
export function openingPlacementBasis(placement) {
  const tangent = placement.tangent || { x: 1, z: 0 };
  const outward = placement.outward || { x: 0, z: 1 };
  const tangentLength = Math.hypot(tangent.x, tangent.z) || 1;
  const outwardLength = Math.hypot(outward.x, outward.z) || 1;
  const x = new THREE.Vector3(tangent.x / tangentLength, 0, tangent.z / tangentLength);
  const z = new THREE.Vector3(outward.x / outwardLength, 0, outward.z / outwardLength);
  const basis = new THREE.Matrix4().makeBasis(x, UP, z);
  basis.setPosition(placement.center.x, placement.bottomY || 0, placement.center.z);
  return basis;
}
