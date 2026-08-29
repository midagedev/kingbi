import * as THREE from 'three';

function box(name, size, material, position, {
  castShadow = true,
  receiveShadow = false,
} = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    material,
  );
  mesh.name = name;
  mesh.position.set(position.x, position.y, position.z);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

function addGateLeaves(root, passage, podiumTopY, materials) {
  const gateHalf = passage.width * 0.5;
  const leafWidth = (passage.width - 0.08) * 0.5;
  const leafHeight = passage.height - 0.18;
  for (const sign of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.name = 'giwa-middle-gate-open-leaf-hinge';
    hinge.position.set(sign * gateHalf, podiumTopY + 0.1, passage.outerZ + 0.04);
    hinge.rotation.y = sign * passage.leafAngle;
    const leafX = -sign * leafWidth * 0.5;
    hinge.add(box(
      'giwa-middle-gate-open-leaf',
      { x: leafWidth, y: leafHeight, z: 0.075 },
      materials.woodBoard,
      { x: leafX, y: leafHeight * 0.5, z: 0 },
      { receiveShadow: true },
    ));
    // Two restrained horizontal battens make the physical 판문 read as a
    // timber gate leaf from an oblique view. They do not invent painted
    // decoration, ironwork, or a western diagonal brace.
    for (const yFraction of [0.28, 0.72]) {
      hinge.add(box(
        'giwa-middle-gate-leaf-batten',
        { x: leafWidth * 0.88, y: 0.085, z: 0.055 },
        materials.woodDark,
        { x: leafX, y: leafHeight * yFraction, z: 0.065 },
      ));
    }
    root.add(hinge);
  }
}

function addFlankingRooms(root, passage, halfWidth, podiumTopY, materials) {
  const gateHalf = passage.width * 0.5;
  const sideSpan = halfWidth - gateHalf - 0.55;
  const panelGap = 0.18;
  const panelWidth = Math.max(1.05, (sideSpan - panelGap) * 0.5);
  const panelHeight = 1.48;
  const panelBottom = podiumTopY + 0.5;
  for (const side of [-1, 1]) {
    for (let index = 0; index < 2; index++) {
      const distance = gateHalf + 0.38
        + panelWidth * (index + 0.5)
        + panelGap * index;
      root.add(box(
        'giwa-middle-gate-flank-opening',
        { x: panelWidth, y: panelHeight, z: 0.085 },
        materials.door,
        {
          x: side * distance,
          y: panelBottom + panelHeight * 0.5,
          z: passage.outerZ - 0.075,
        },
      ));
      root.add(box(
        'giwa-middle-gate-flank-lower-panel',
        { x: panelWidth, y: 0.36, z: 0.095 },
        materials.woodBoard,
        {
          x: side * distance,
          y: panelBottom + 0.18,
          z: passage.outerZ - 0.085,
        },
      ));
    }
  }
}

/**
 * Build the physical passage through a ㄷ-plan giwa front bar.
 *
 * The roof remains owned by the enclosing building. This module owns only the
 * threshold, posts, lintels, open timber leaves, and inhabited flanking faces;
 * it never creates a freestanding gate or another roof system.
 */
export function buildGiwaMiddleGate(passage, {
  halfWidth,
  halfDepth,
  columnRadius,
  podiumTopY,
  materials,
}) {
  if (!passage) return null;
  const root = new THREE.Group();
  root.name = 'giwa-integrated-middle-gate';
  const gateHalf = passage.width * 0.5;
  const post = Math.max(0.18, columnRadius * 1.35);

  root.add(box(
    'giwa-middle-gate-threshold',
    { x: passage.width + post * 1.5, y: 0.1, z: halfDepth * 2 + 0.5 },
    materials.stoneDark,
    { x: 0, y: podiumTopY + 0.05, z: 0 },
    { castShadow: false, receiveShadow: true },
  ));
  for (const xSign of [-1, 1]) {
    for (const z of [passage.innerZ, passage.outerZ]) {
      root.add(box(
        'giwa-middle-gate-column',
        { x: post, y: passage.height + 0.35, z: post },
        materials.wood,
        {
          x: xSign * (gateHalf + post * 0.5),
          y: podiumTopY + (passage.height + 0.35) * 0.5,
          z,
        },
        { receiveShadow: true },
      ));
    }
  }
  for (const z of [passage.innerZ, passage.outerZ]) {
    root.add(box(
      'giwa-middle-gate-lintel',
      { x: passage.width + post * 2.2, y: 0.22, z: 0.2 },
      materials.woodDark,
      { x: 0, y: podiumTopY + passage.height + 0.08, z },
    ));
  }

  addGateLeaves(root, passage, podiumTopY, materials);
  addFlankingRooms(root, passage, halfWidth, podiumTopY, materials);
  root.userData.giwaThroughPassage = passage;
  return root;
}
