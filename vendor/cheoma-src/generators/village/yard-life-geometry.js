import * as THREE from 'three';
import { mergeOwnedGeometries } from '../../core/merge-owned-geometries.js';
import { YARD_LIFE_MATERIAL_ROLES } from '../../village/yard-life-record-contract.js';

// Physical geometry boundary for the reusable yard-life renderer. This module
// owns primitive construction, world transforms, semantic role batching, exact
// footprint verification, and batch geometry disposal. It deliberately knows
// nothing about season transitions, LOD policy, or product palette ownership.

const BOUNDS_EPSILON = 1e-4;
const UP = new THREE.Vector3(0, 1, 0);

function matrix({
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
} = {}) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

function place(geometry, transform) {
  geometry.applyMatrix4(matrix(transform));
  return geometry;
}

function box(width, height, depth, transform = {}) {
  return place(
    new THREE.BoxGeometry(width, height, depth, 1, 1, 1),
    { y: height / 2, ...transform },
  );
}

function cylinder(radiusTop, radiusBottom, height, segments, transform = {}, openEnded = false) {
  return place(
    new THREE.CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      segments,
      1,
      openEnded,
    ),
    { y: height / 2, ...transform },
  );
}

function cylinderBetween(radius, start, end, segments = 5) {
  const from = new THREE.Vector3(start.x, start.y, start.z);
  const to = new THREE.Vector3(end.x, end.y, end.z);
  const direction = to.clone().sub(from);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.9, length, segments, 1);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()));
  geometry.translate(
    (from.x + to.x) / 2,
    (from.y + to.y) / 2,
    (from.z + to.z) / 2,
  );
  return geometry;
}

function torus(radius, tube, segments, transform = {}) {
  return place(
    new THREE.TorusGeometry(radius, tube, 4, segments),
    transform,
  );
}

function dodeca(radius, transform = {}) {
  return place(new THREE.DodecahedronGeometry(radius, 0), transform);
}

function circle(radius, segments, transform = {}) {
  return place(new THREE.CircleGeometry(radius, segments), transform);
}

function strawCoverGeometry() {
  const hx = 0.65;
  const hz = 0.34;
  const baseY = 0.43;
  const ridgeY = 0.62;
  const columns = 7;
  const rows = 5;
  const positions = [];
  const indices = [];
  for (let column = 0; column < columns; column++) {
    const tx = column / (columns - 1);
    const x = -hx + tx * hx * 2;
    for (let row = 0; row < rows; row++) {
      const tz = -1 + row * 2 / (rows - 1);
      const arch = Math.max(0, 1 - Math.pow(Math.abs(tz), 1.35));
      const irregular = Math.sin(column * 2.17 + row * 0.83) * 0.012;
      positions.push(
        x,
        baseY + (ridgeY - baseY) * arch + irregular * arch,
        hz * tz,
      );
    }
  }
  for (let column = 0; column < columns - 1; column++) {
    for (let row = 0; row < rows - 1; row++) {
      const a = column * rows + row;
      const b = a + rows;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function springGeometries(part) {
  if (part.kind === 'water-bowl') {
    return [
      cylinder(0.29, 0.24, 0.14, 10, { x: -0.25 }, true),
      circle(0.235, 10, { x: -0.25, y: 0.012, rx: -Math.PI / 2 }),
      torus(0.29, 0.025, 10, { x: -0.25, y: 0.14, rx: Math.PI / 2 }),
    ];
  }
  const geometries = [];
  for (let index = 0; index < part.count; index++) {
    const radius = part.count === 1 ? 0.2 : 0.18;
    const x = part.count === 1 ? 0.24 : 0.25;
    const z = part.count === 1 ? 0 : (index === 0 ? -0.18 : 0.18);
    const height = index === 0 ? 0.24 : 0.22;
    geometries.push(
      cylinder(radius * 1.05, radius * 0.82, height, 8, { x, z }, true),
      torus(radius * 1.05, 0.022, 8, { x, y: height, z, rx: Math.PI / 2 }),
    );
    const handleTop = Math.min(0.33, height + 0.09);
    geometries.push(
      cylinderBetween(
        0.014,
        { x, y: height - 0.01, z: z - radius * 0.72 },
        { x, y: handleTop, z },
        5,
      ),
      cylinderBetween(
        0.014,
        { x, y: handleTop, z },
        { x, y: height - 0.01, z: z + radius * 0.72 },
        5,
      ),
    );
  }
  return geometries;
}

function autumnGeometries(part) {
  if (part.kind === 'threshing-bench') {
    const geometries = [];
    for (const z of [-0.16, 0, 0.16]) {
      geometries.push(cylinder(0.075, 0.075, 1.55, 7, {
        y: 0.46,
        z,
        rz: Math.PI / 2,
      }));
    }
    for (const x of [-0.58, 0.58]) {
      for (const z of [-0.16, 0.16]) {
        geometries.push(box(0.12, 0.42, 0.12, { x, z }));
      }
    }
    return geometries;
  }
  if (part.kind === 'threshing-stone') {
    return [dodeca(1, {
      y: 0.16,
      sx: 0.36,
      sy: 0.16,
      sz: 0.28,
    })];
  }
  if (part.kind === 'bound-sheaf') {
    const positions = [
      [-0.58, -0.22],
      [0.58, -0.2],
      [-0.48, 0.21],
      [0.48, 0.22],
    ];
    const geometries = [];
    for (let index = 0; index < part.count; index++) {
      const [x, z] = positions[index];
      const height = 0.78 + index * 0.045;
      const tieY = height * 0.55;
      geometries.push(cylinder(0.08, 0.13, tieY, 7, { x, z }));
      const fan = [
        [-0.14, -0.045, -0.015],
        [-0.075, 0.03, -0.04],
        [0, 0.055, 0],
        [0.075, 0.015, 0.04],
        [0.14, -0.03, 0.015],
      ];
      for (const [dx, dy, dz] of fan) {
        geometries.push(cylinderBetween(
          0.026,
          { x: x + dx * 0.18, y: tieY - 0.025, z: z + dz * 0.18 },
          { x: x + dx, y: height + dy, z: z + dz },
        ));
      }
      geometries.push(torus(0.105, 0.018, 7, {
        x,
        y: tieY,
        z,
        rx: Math.PI / 2,
      }));
    }
    return geometries;
  }
  return [circle(1, 12, {
    y: 0.012,
    rx: -Math.PI / 2,
    sx: 0.6,
    sy: 0.375,
  })];
}

function winterGeometries(part) {
  if (part.kind === 'stack-support') {
    return [
      cylinder(0.045, 0.045, 1.18, 7, {
        y: 0.045,
        z: -0.19,
        rz: Math.PI / 2,
      }),
      cylinder(0.045, 0.045, 1.18, 7, {
        y: 0.045,
        z: 0.19,
        rz: Math.PI / 2,
      }),
    ];
  }
  if (part.kind === 'split-log') {
    const geometries = [];
    const columns = 4;
    for (let index = 0; index < part.count; index++) {
      const layer = Math.floor(index / columns);
      const column = index % columns;
      const x = (column - 1.5) * 0.3 + (layer % 2 ? 0.045 : 0);
      const y = 0.15 + layer * 0.13;
      const z = index % 2 ? 0.012 : -0.012;
      const radius = 0.047 + (index % 3) * 0.004;
      geometries.push(cylinder(radius, radius * 0.88, 0.5, 7, {
        x,
        y,
        z,
        rx: Math.PI / 2,
      }));
    }
    return geometries;
  }
  const cover = [strawCoverGeometry()];
  // Leave the fibre radius inside the planner's exact 0.34m half-depth.
  const hz = 0.318;
  const baseY = 0.43;
  const ridgeY = 0.62;
  for (const x of [-0.52, -0.26, 0, 0.26, 0.52]) {
    for (const side of [-1, 1]) {
      const middleZ = side * hz * 0.5;
      const middleArch = 1 - Math.pow(0.5, 1.35);
      const middleY = baseY + (ridgeY - baseY) * middleArch;
      cover.push(
        cylinderBetween(
          0.012,
          { x, y: ridgeY + 0.006, z: 0 },
          { x, y: middleY + 0.006, z: middleZ },
          5,
        ),
        cylinderBetween(
          0.012,
          { x, y: middleY + 0.006, z: middleZ },
          { x, y: baseY + 0.006, z: side * hz },
          5,
        ),
      );
    }
  }
  return cover;
}

function partGeometries(record, part) {
  if (record.season === 'spring') return springGeometries(part);
  if (record.season === 'autumn') return autumnGeometries(part);
  return winterGeometries(part);
}

function hashString(value) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function normalizeGeometry(source, record, part, primitiveIndex) {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const transform = matrix({
    x: record.world.x,
    y: record.world.y,
    z: record.world.z,
    ry: record.world.yaw,
    sx: record.scale,
    sy: record.scale,
    sz: record.scale,
  });
  geometry.applyMatrix4(transform);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const count = geometry.attributes.position.count;
  if (!geometry.attributes.uv) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  const tint = new Float32Array(count * 3);
  const seed = hashString(`${record.id}|${part.kind}|${primitiveIndex}`);
  for (let vertex = 0; vertex < count; vertex++) {
    const bits = Math.imul(seed ^ (vertex + 1), 2246822519) >>> 0;
    const value = 0.88 + (bits / 0xffffffff) * 0.18;
    tint[vertex * 3] = value;
    tint[vertex * 3 + 1] = value;
    tint[vertex * 3 + 2] = value;
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(tint, 3));
  geometry.setAttribute(
    'instFade',
    new THREE.Float32BufferAttribute(new Float32Array(count), 1),
  );
  for (const name of Object.keys(geometry.attributes)) {
    if (name === 'position' || name === 'normal' || name === 'uv'
      || name === 'color' || name === 'instFade') continue;
    geometry.deleteAttribute(name);
  }
  geometry.morphAttributes = {};
  return geometry;
}

export function disposeYardLifeBatches(batches) {
  for (const batch of batches) batch.geometry.dispose();
}

function recordBoundsFromBatches(batches, records) {
  const bounds = records.map((record) => ({
    id: record.id,
    minX: Infinity,
    maxX: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
    halfX: record.footprint.halfX,
    halfZ: record.footprint.halfZ,
  }));
  for (const batch of batches) {
    const positions = batch.geometry.attributes.position.array;
    for (const range of batch.ranges) {
      const record = records[range.recordIndex];
      const result = bounds[range.recordIndex];
      const cosine = Math.cos(record.world.yaw);
      const sine = Math.sin(record.world.yaw);
      const end = range.start + range.count;
      for (let vertex = range.start; vertex < end; vertex++) {
        const offset = vertex * 3;
        const dx = positions[offset] - record.world.x;
        const dz = positions[offset + 2] - record.world.z;
        const localX = cosine * dx - sine * dz;
        const localZ = sine * dx + cosine * dz;
        result.minX = Math.min(result.minX, localX);
        result.maxX = Math.max(result.maxX, localX);
        result.minZ = Math.min(result.minZ, localZ);
        result.maxZ = Math.max(result.maxZ, localZ);
      }
    }
  }
  for (const result of bounds) {
    if (result.minX < -result.halfX - BOUNDS_EPSILON
      || result.maxX > result.halfX + BOUNDS_EPSILON
      || result.minZ < -result.halfZ - BOUNDS_EPSILON
      || result.maxZ > result.halfZ + BOUNDS_EPSILON) {
      throw new RangeError(`yard-life geometry escaped planned footprint for ${result.id}`);
    }
  }
  return bounds;
}

export function createYardLifeBatches(
  records,
  derivedMaterials,
  depthMaterial,
  distanceMaterial,
) {
  const byRole = new Map(YARD_LIFE_MATERIAL_ROLES.map((role) => [role, []]));
  const batches = [];
  try {
    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const record = records[recordIndex];
      for (let partIndex = 0; partIndex < record.parts.length; partIndex++) {
        const part = record.parts[partIndex];
        const geometries = partGeometries(record, part);
        for (let primitiveIndex = 0; primitiveIndex < geometries.length; primitiveIndex++) {
          byRole.get(part.materialRole).push({
            geometry: normalizeGeometry(
              geometries[primitiveIndex],
              record,
              part,
              partIndex * 32 + primitiveIndex,
            ),
            recordIndex,
          });
        }
      }
    }

    for (const role of YARD_LIFE_MATERIAL_ROLES) {
      const entries = byRole.get(role);
      if (!entries.length) continue;
      let cursor = 0;
      const ranges = [];
      for (const entry of entries) {
        const count = entry.geometry.attributes.position.count;
        ranges.push({ recordIndex: entry.recordIndex, start: cursor, count });
        cursor += count;
      }
      const sourceGeometries = entries.map((entry) => entry.geometry);
      byRole.set(role, []);
      const geometry = mergeOwnedGeometries(
        sourceGeometries,
        `Yard-life ${role} geometries`,
      );
      geometry.getAttribute('instFade')?.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.Mesh(geometry, derivedMaterials[role]);
      mesh.name = `yard-life-${role}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMaterial;
      mesh.customDistanceMaterial = distanceMaterial;
      mesh.userData.dofDepthMaterial = depthMaterial;
      batches.push({ role, mesh, geometry, ranges });
    }
    const bounds = recordBoundsFromBatches(batches, records);
    return { batches, bounds };
  } catch (error) {
    disposeYardLifeBatches(batches);
    for (const entries of byRole.values()) {
      for (const entry of entries) entry.geometry.dispose();
    }
    throw error;
  }
}
