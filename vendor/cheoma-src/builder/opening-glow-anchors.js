import * as THREE from 'three';

const EMPTY_ANCHORS = Object.freeze([]);

function plainVector(vector, label) {
  const value = { x: vector.x, y: vector.y, z: vector.z };
  if (!Object.values(value).every(Number.isFinite)) {
    throw new Error(`Non-finite opening glow ${label}`);
  }
  return Object.freeze(value);
}

function cloneAnchor(anchor, matrix) {
  if (typeof anchor.openingId !== 'string' || anchor.openingId.length === 0
      || typeof anchor.kind !== 'string' || typeof anchor.style !== 'string') {
    throw new Error('Opening glow anchor lost its authored identity');
  }
  const position = new THREE.Vector3(
    anchor.position.x,
    anchor.position.y,
    anchor.position.z,
  ).applyMatrix4(matrix);
  const outward = new THREE.Vector3(
    anchor.outward.x,
    anchor.outward.y,
    anchor.outward.z,
  ).transformDirection(matrix);
  if (!Number.isFinite(anchor.width) || anchor.width <= 0
      || !Number.isFinite(anchor.height) || anchor.height <= 0) {
    throw new Error(`Invalid opening glow dimensions: ${anchor.openingId}`);
  }
  return Object.freeze({
    openingId: anchor.openingId,
    kind: anchor.kind,
    style: anchor.style,
    primary: anchor.primary === true,
    width: anchor.width,
    height: anchor.height,
    position: plainVector(position, 'position'),
    outward: plainVector(outward, 'outward'),
  });
}

/**
 * Collect renderer-authored opening glow metadata without retaining scene
 * objects. The default result is expressed in `root` local coordinates so a
 * generated building variant can be cached and instanced. `space: 'world'` is
 * reserved for already-placed compound/overlay roots.
 */
export function collectOpeningGlowAnchors(root, { space = 'local' } = {}) {
  if (!root?.isObject3D) return EMPTY_ANCHORS;
  if (space !== 'local' && space !== 'world') {
    throw new Error(`Unknown opening glow anchor space: ${space}`);
  }

  root.updateWorldMatrix(true, true);
  const rootInverse = space === 'local'
    ? new THREE.Matrix4().copy(root.matrixWorld).invert()
    : null;
  const transform = new THREE.Matrix4();
  const anchors = [];
  root.traverse((object) => {
    const authored = object.userData?.openingGlowAnchors;
    if (!Array.isArray(authored) || authored.length === 0) return;
    if (rootInverse) transform.copy(rootInverse).multiply(object.matrixWorld);
    else transform.copy(object.matrixWorld);
    for (const anchor of authored) anchors.push(cloneAnchor(anchor, transform));
  });
  return Object.freeze(anchors);
}

/** Mirror one cached building variant around its local X axis. */
export function mirrorOpeningGlowAnchorsX(anchors) {
  return Object.freeze((anchors || []).map((anchor) => Object.freeze({
    openingId: anchor.openingId,
    kind: anchor.kind,
    style: anchor.style,
    primary: anchor.primary,
    width: anchor.width,
    height: anchor.height,
    position: Object.freeze({
      x: -anchor.position.x,
      y: anchor.position.y,
      z: anchor.position.z,
    }),
    outward: Object.freeze({
      x: -anchor.outward.x,
      y: anchor.outward.y,
      z: anchor.outward.z,
    }),
  })));
}
