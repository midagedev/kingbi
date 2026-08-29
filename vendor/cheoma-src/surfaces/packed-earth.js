// Renderer-free packed-earth source. The tile is periodic by construction, consumes no
// global RNG, and carries no baked lighting so it can be reused by roads, yards, or another
// project's own renderer adapter.

export const PACKED_EARTH_DEFAULTS = Object.freeze({
  seed: 0x5041434b,
  size: 256,
});

const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const fade = (value) => value * value * (3 - 2 * value);

function hashLattice(x, y, seed) {
  let value = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function periodicValueNoise(x, y, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const wrappedX = ((x0 % period) + period) % period;
  const wrappedY = ((y0 % period) + period) % period;
  const tx = fade(x - x0), ty = fade(y - y0);
  const a = hashLattice(wrappedX, wrappedY, seed);
  const b = hashLattice(x1, wrappedY, seed);
  const c = hashLattice(wrappedX, y1, seed);
  const d = hashLattice(x1, y1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

function validateOptions({ size, seed }) {
  if (!Number.isInteger(size) || size < 32 || size > 1024 || (size & (size - 1)) !== 0) {
    throw new RangeError('packed-earth size must be a power of two from 32 through 1024');
  }
  if (!Number.isFinite(seed)) throw new TypeError('packed-earth seed must be finite');
}

/**
 * Creates two RGBA8 sources with identical dimensions.
 *
 * The albedo is a near-white, slightly warm modulation intended to multiply an authored
 * material/vertex colour. Height is neutral greyscale; only its local gradients matter to a
 * renderer's bump mapping. Pixel coordinates sample a torus, so the last-to-first derivative
 * stays continuous even though opposite edge pixels are not duplicated.
 */
export function createPackedEarthTile(options = {}) {
  const size = options.size ?? PACKED_EARTH_DEFAULTS.size;
  const inputSeed = options.seed ?? PACKED_EARTH_DEFAULTS.seed;
  validateOptions({ size, seed: inputSeed });
  const seed = inputSeed >>> 0;

  const albedo = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Co-prime octave periods avoid a single recognisable blob or half-tile echo. All
      // octaves remain exactly periodic at the tile boundary.
      const broad = periodicValueNoise(u * 5, v * 5, 5, seed ^ 0xa53c9e17);
      const packed = periodicValueNoise(u * 13, v * 13, 13, seed ^ 0x7f4a7c15);
      const grain = periodicValueNoise(u * 31, v * 31, 31, seed ^ 0x94d049bb);
      const field = broad * 0.52 + packed * 0.34 + grain * 0.14;
      const compacted = 0.5 + (field - 0.5) * 0.84;

      const offset = (y * size + x) * 4;
      // Near-white keeps the existing road vertex-colour hierarchy authoritative. Warmth is
      // restrained and the map contains no directional highlight or photograph-derived mark.
      const shade = (compacted - 0.5) * 28;
      albedo[offset] = clampByte(250 + shade);
      albedo[offset + 1] = clampByte(248 + shade * 0.96);
      albedo[offset + 2] = clampByte(242 + shade * 0.88);
      albedo[offset + 3] = 255;

      const heightByte = clampByte(128 + (compacted - 0.5) * 72);
      height[offset] = heightByte;
      height[offset + 1] = heightByte;
      height[offset + 2] = heightByte;
      height[offset + 3] = 255;
    }
  }

  return { width: size, height: size, albedo, heightMap: height, seed };
}
