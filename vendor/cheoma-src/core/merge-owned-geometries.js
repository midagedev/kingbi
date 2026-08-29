import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Merge short-lived builder geometries while transferring ownership exactly
// once. A single geometry moves directly to its Mesh; every multi-input path
// releases the sources even when BufferGeometryUtils throws or returns null.
export function mergeOwnedGeometries(geometries, label = 'Builder geometries') {
  if (!Array.isArray(geometries) || geometries.length === 0) {
    throw new Error(`${label} cannot merge an empty geometry list`);
  }
  if (geometries.length === 1) return geometries[0];
  let merged = null;
  try {
    merged = mergeGeometries(geometries, false);
  } finally {
    for (const geometry of geometries) geometry.dispose();
  }
  if (!merged) throw new Error(`${label} have incompatible attributes`);
  return merged;
}
