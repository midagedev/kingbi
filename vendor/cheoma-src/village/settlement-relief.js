import { smoothstep } from '../core/math/scalar.js';
import { createValueNoise2D } from '../core/math/value-noise2.js';

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const lerp = (a, b, t) => a + (b - a) * t;

// A continuous staircase with broad, rounded risers. The mean-preserving offset
// keeps enabling terraces from lifting or sinking the whole settlement floor.
function softTerrace(value, step, transitionStart = 0.56) {
  const scaled = value / step;
  const level = Math.floor(scaled);
  const phase = scaled - level;
  const transitionMean = (1 - transitionStart) * 0.5;
  const offset = 0.5 - transitionMean;
  return (level + smoothstep(transitionStart, 1, phase) + offset) * step;
}

// Reusable, renderer-independent settlement-floor grammar. It deliberately owns
// two spatial scales:
//   - local relief has a metre-based wavelength, so it does not disappear as R grows;
//   - broad soft terraces group several parcels on one landform bench at town scale.
// Roads, parcels, vegetation, water and rendering all consume the resulting height.
export function createSettlementRelief({
  R,
  seed,
  streamZ,
  mountainZ,
  benchDrop,
  undAmp,
  undAmpK = 1,
  macroNoise,
}) {
  const { fbm: localNoise } = createValueNoise2D((seed ^ 0x40a11) >>> 0, { signed: true });
  const amount = Math.max(0, undAmpK);
  const macroF = 1.4 / R;
  const macroF2 = 3.6 / R;
  const localWavelength = lerp(30, 46, smoothstep(30, 250, R));
  const localF = 1 / localWavelength;
  const terraceScale = smoothstep(100, 250, R);
  const terraceStrength = 0.82 * terraceScale * clamp01(amount);
  const terraceStep = R <= 250
    ? lerp(0.58, 1.25, smoothstep(100, 250, R))
    : lerp(1.25, 1.8, smoothstep(250, 500, R));

  const benchAt = (_x, z) => {
    const t = smoothstep(streamZ, mountainZ + 0.12 * R, z);
    return benchDrop * t;
  };

  const naturalReliefAt = (x, z) => {
    if (amount <= 0) return 0;
    const macro = 0.68 * macroNoise(x * macroF + 11, z * macroF - 7, 3)
      + 0.22 * macroNoise(x * macroF2 - 5, z * macroF2 + 9, 2);
    // The second field is intentionally metre-based rather than site-relative.
    // Its modest amplitude gives hamlets visible ground life without making a
    // single house footprint exceed the planning relief cap.
    // Dense cities need the same readable wavelength but less amplitude so it
    // does not reject whole frontage rows. Their broad terrace field carries the
    // larger elevation grouping instead.
    const localScale = lerp(1, 0.55, smoothstep(176, 500, R));
    const local = localScale * (
      0.34 * localNoise(x * localF + 17, z * localF - 13, 2)
      + 0.16 * localNoise(x * localF * 1.75 - 29, z * localF * 1.75 + 23, 1)
    );
    // Rural sites retain more of their small natural rises; dense capitals have
    // broader prepared benches and therefore converge to the anchor amplitude.
    const ruralGain = lerp(2.1, 1, smoothstep(74, 250, R));
    return undAmp * amount * ruralGain * (macro + local);
  };

  const heightAt = (x, z) => {
    const organic = benchAt(x, z) + naturalReliefAt(x, z);
    if (terraceStrength <= 0) return organic;
    // Warp only the contour position. Plateau elevations remain coherent instead
    // of inheriting a noisy renderer-only displacement.
    const warp = terraceStep * 0.30
      * localNoise(x / (R * 0.42) + 41, z / (R * 0.42) - 37, 2);
    const terraced = softTerrace(organic + warp, terraceStep);
    return lerp(organic, terraced, terraceStrength);
  };

  return {
    heightAt,
    benchAt,
    naturalReliefAt,
    config: {
      localWavelength,
      terraceStep,
      terraceStrength,
    },
  };
}
