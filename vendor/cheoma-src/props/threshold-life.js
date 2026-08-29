import * as THREE from 'three';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';

const STRAW = new THREE.Color(0xa88f58);
const STRAW_DARK = new THREE.Color(0x826d43);
const WOOD = new THREE.Color(0x76573a);
const WOOD_DARK = new THREE.Color(0x4e3827);

export function createThresholdLifeMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0,
    vertexColors: true,
  });
  material.userData.paletteKey = 'thresholdLife';
  return material;
}

function colored(geometry, color) {
  const owned = geometry.index ? geometry.toNonIndexed() : geometry;
  if (owned !== geometry) geometry.dispose();
  const count = owned.attributes.position.count;
  const values = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) color.toArray(values, index * 3);
  owned.setAttribute('color', new THREE.BufferAttribute(values, 3));
  return owned;
}

function shoePrism(length, width, bottom, top, color, toeLift = 0) {
  const ring = [
    [-0.35, -0.50], [0.35, -0.50], [0.50, -0.30], [0.52, 0.18],
    [0.40, 0.40], [0.18, 0.50], [-0.18, 0.50], [-0.40, 0.40],
    [-0.52, 0.18], [-0.50, -0.30],
  ].map(([x, z]) => [x * width, z * length]);
  const positions = [];
  const push = (...point) => positions.push(...point);
  for (let index = 1; index < ring.length - 1; index++) {
    push(ring[0][0], bottom, ring[0][1]);
    push(ring[index + 1][0], bottom, ring[index + 1][1]);
    push(ring[index][0], bottom, ring[index][1]);
  }
  const topY = (z) => top + toeLift * Math.max(0, z / (length * 0.5));
  for (let index = 1; index < ring.length - 1; index++) {
    push(ring[0][0], topY(ring[0][1]), ring[0][1]);
    push(ring[index][0], topY(ring[index][1]), ring[index][1]);
    push(ring[index + 1][0], topY(ring[index + 1][1]), ring[index + 1][1]);
  }
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    const a = ring[index], b = ring[next];
    push(a[0], bottom, a[1]); push(b[0], bottom, b[1]); push(b[0], topY(b[1]), b[1]);
    push(a[0], bottom, a[1]); push(b[0], topY(b[1]), b[1]); push(a[0], topY(a[1]), a[1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(
    new Float32Array(geometry.attributes.position.count * 2), 2,
  ));
  return colored(geometry, color);
}

function cylinderBetween(a, b, radius, color, radialSegments = 5) {
  const start = new THREE.Vector3(...a);
  const end = new THREE.Vector3(...b);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), radialSegments, 1);
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), direction.normalize(),
  );
  geometry.applyQuaternion(rotation);
  geometry.translate(midpoint.x, midpoint.y, midpoint.z);
  return colored(geometry, color);
}

function jipsinParts(item) {
  const { length: l, width: w, height: h } = item;
  const parts = [shoePrism(l, w, 0, h * 0.42, STRAW, h * 0.08)];
  // A few narrow transverse strands and a raised toe loop suggest the woven
  // front cords without turning a 25cm prop into a literal high-poly braid.
  for (const z of [-l * 0.08, l * 0.08, l * 0.22]) {
    parts.push(cylinderBetween(
      [-w * 0.40, h * 0.55, z], [w * 0.40, h * 0.55, z + l * 0.025],
      0.0045, STRAW_DARK, 4,
    ));
  }
  parts.push(cylinderBetween(
    [-w * 0.38, h * 0.55, l * 0.27], [0, h * 1.35, l * 0.34],
    0.0045, STRAW_DARK, 4,
  ));
  parts.push(cylinderBetween(
    [0, h * 1.35, l * 0.34], [w * 0.38, h * 0.55, l * 0.27],
    0.0045, STRAW_DARK, 4,
  ));
  return parts;
}

function namaksinParts(item) {
  const { length: l, width: w, height: h } = item;
  const parts = [shoePrism(l, w, 0, h * 0.44, WOOD, h * 0.14)];
  const upper = new THREE.SphereGeometry(0.5, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.5);
  upper.scale(w * 0.82, h * 0.95, l * 0.48);
  upper.translate(0, h * 0.37, l * 0.13);
  parts.push(colored(upper, WOOD_DARK));
  return parts;
}

function itemGeometry(item) {
  const parts = item.kind === 'namaksin' ? namaksinParts(item) : jipsinParts(item);
  const geometry = mergeOwnedGeometries(parts, `${item.kind} parts`);
  geometry.rotateY(item.yaw);
  geometry.translate(item.u, item.y, item.outward);
  return geometry;
}

function reverseTriangleWinding(geometry) {
  for (const attribute of Object.values(geometry.attributes)) {
    const { array, itemSize } = attribute;
    for (let triangle = 0; triangle + 2 < attribute.count; triangle += 3) {
      const a = (triangle + 1) * itemSize;
      const b = (triangle + 2) * itemSize;
      for (let component = 0; component < itemSize; component++) {
        const value = array[a + component];
        array[a + component] = array[b + component];
        array[b + component] = value;
      }
    }
    attribute.needsUpdate = true;
  }
}

function normalizedAxis(elements, offset, label) {
  const axis = new THREE.Vector3(elements[offset], elements[offset + 1], elements[offset + 2]);
  const scale = axis.length();
  if (!Number.isFinite(scale) || scale < 1e-8) {
    throw new Error(`Threshold life ${label} basis is degenerate`);
  }
  return { axis: axis.multiplyScalar(1 / scale), scale };
}

// Convert the fully composed opening-to-owner basis into a metric placement
// frame. The jamb, landing height, and porch-depth reference follow the scaled
// building, while the unit axes deliberately remove footprintScale and parcel
// anisotropy from the 24–26cm footwear geometry itself.
export function thresholdLifePlacementFrame(plan, basis) {
  if (!plan?.placement || !basis?.isMatrix4) {
    throw new TypeError('Threshold life placement requires a plan and Matrix4 basis');
  }
  const elements = basis.elements;
  const tangent = normalizedAxis(elements, 0, 'tangent');
  const up = normalizedAxis(elements, 4, 'up');
  const outward = normalizedAxis(elements, 8, 'outward');
  const position = new THREE.Vector3(elements[12], elements[13], elements[14])
    .addScaledVector(tangent.axis, plan.placement.jambU * tangent.scale)
    .addScaledVector(up.axis, plan.placement.surfaceY * up.scale)
    .addScaledVector(outward.axis, plan.placement.outwardReference * outward.scale);
  const frame = new THREE.Matrix4().makeBasis(tangent.axis, up.axis, outward.axis);
  frame.setPosition(position);
  return {
    frame,
    scale: { u: tangent.scale, y: up.scale, outward: outward.scale },
  };
}

function metricItemGeometry(item, placement) {
  return itemGeometry({
    ...item,
    u: item.u - placement.jambU,
    y: 0,
    outward: item.outward - placement.outwardReference,
  });
}

// `basis` is the fully composed opening-to-owner Matrix4. Position and rotation
// follow it, but the adapter removes its scale before baking one owned batch.
export function createThresholdLifeMesh(plan, basis, material) {
  if (!plan?.items?.length) return null;
  const geometries = plan.items.map((item) => metricItemGeometry(item, plan.placement));
  const geometry = mergeOwnedGeometries(geometries, 'Threshold life footwear');
  const placement = thresholdLifePlacementFrame(plan, basis);
  geometry.applyMatrix4(placement.frame);
  // A mirrored house produces a unit reflection rather than a scale. Once that
  // reflection is baked into geometry Three cannot flip frontFace for us, so
  // restore the triangle winding explicitly.
  if (placement.frame.determinant() < 0) reverseTriangleWinding(geometry);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'threshold-life-detail';
  mesh.userData.thresholdLifePlan = plan;
  mesh.userData.thresholdLifeBasis = placement.frame.toArray();
  mesh.userData.thresholdLifeSourceScale = placement.scale;
  mesh.userData.openingDetailTier = 'focus';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}
