/** Clamp a scalar to the inclusive unit interval. */
export const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Cubic Hermite interpolation between two scalar edges. */
export function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
