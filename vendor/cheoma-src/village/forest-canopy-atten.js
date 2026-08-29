// #20 village-adjacent canopy scale attenuation — renderer-free pure math.
// forest-crunch consumes this for instance Y/XZ scales; pure gate imports only this file.
// docs/surface-materials.md · oriental-painting-research §7.3
import { smoothstep } from '../core/math/scalar.js';

// rC / bowlR radial term + structure clearDist near term. No RNG.
// y falls more than xz so wall crowns get vertical clearance without bald mountains.
export function villageCanopyAtten(rC, bowlR, clearDist = Infinity, keep = 7, ramp = 28) {
  const b = Math.max(1e-3, bowlR);
  // Inside bowl / fringe = 1, outer mountain (≥1.18 bowlR) = 0.
  const radial = 1 - smoothstep(b * 0.58, b * 1.18, rC);
  // Near parcels/roads/walls: stronger (1 inside KEEP → 0 at KEEP+1.6·RAMP).
  const near = Number.isFinite(clearDist)
    ? 1 - smoothstep(keep * 0.9, keep + ramp * 1.6, clearDist)
    : 0;
  const atten = Math.min(1, Math.max(radial * 0.85, near * 0.95));
  return {
    atten,
    yMul: 1 - 0.40 * atten,   // ≥ 0.60
    xzMul: 1 - 0.16 * atten,  // ≥ 0.84
  };
}
