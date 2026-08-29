import { makeRng } from '../../rng.js';

// 공통 permutation 기반 2D value-noise. signed=false는 0..1, signed=true는 -1..1 계약이다.
export function createValueNoise2D(seed, { signed = false } = {}) {
  const rng = makeRng(seed);
  const permutation = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = base[i]; base[i] = base[j]; base[j] = swap;
  }
  for (let i = 0; i < 512; i++) permutation[i] = base[i & 255];

  const lattice = (x, z) => {
    const value = permutation[(permutation[x & 255] + z) & 255] / 255;
    return signed ? value * 2 - 1 : value;
  };
  const smooth = (value) => value * value * (3 - 2 * value);
  const noise = (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = x - x0, fz = z - z0;
    const v00 = lattice(x0, z0), v10 = lattice(x0 + 1, z0);
    const v01 = lattice(x0, z0 + 1), v11 = lattice(x0 + 1, z0 + 1);
    const sx = smooth(fx), sz = smooth(fz);
    const top = v00 + (v10 - v00) * sx;
    const bottom = v01 + (v11 - v01) * sx;
    return top + (bottom - top) * sz;
  };
  const fbm = (x, z, octaves = 4) => {
    let sum = 0, amplitude = 0.5, frequency = 1, normalization = 0;
    for (let octave = 0; octave < octaves; octave++) {
      sum += amplitude * noise(x * frequency, z * frequency);
      normalization += amplitude;
      amplitude *= 0.5;
      frequency *= 2.03;
    }
    return sum / normalization;
  };
  return { noise, fbm };
}
