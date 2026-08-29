// Renderer-free source-scatter contract shared by the gather, scatter, and gates.
export const BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT = 37;
export const BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT = 4;
export const BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT = 12;
export const BOKEH_HIGHLIGHT_PREFILTER_TOTAL_TAP_COUNT =
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT +
  BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT +
  BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT;

export const BOKEH_SOURCE_CONTRACT = Object.freeze({
  blockSize: 2,
  exactOwnershipAlpha: 1,
  gatherSupportAlpha: 0.25,
  gatherSupportCutoff: 0.125,
  exactOwnershipCutoff: 0.75,
  ownershipBroadSupportCutoff: 0.3,
  sharpRadiusPx: 0.45,
  isolation: 0.35,
  pointCoverage: 2,
  profileCore: 0.72,
  profileRim: 0.9,
  profilePower: 12,
  profileIntegral: 0.8485714286,
});

export function bokehSourceGridDimensions(width, height) {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  return Object.freeze({
    width: safeWidth,
    height: safeHeight,
    columns: Math.ceil(safeWidth / BOKEH_SOURCE_CONTRACT.blockSize),
    rows: Math.ceil(safeHeight / BOKEH_SOURCE_CONTRACT.blockSize),
  });
}

export function bokehSourceCellUv(width, height, column, row) {
  const grid = bokehSourceGridDimensions(width, height);
  const halfBlock = BOKEH_SOURCE_CONTRACT.blockSize * 0.5;
  return Object.freeze([
    (column * BOKEH_SOURCE_CONTRACT.blockSize + halfBlock) / grid.width,
    (row * BOKEH_SOURCE_CONTRACT.blockSize + halfBlock) / grid.height,
  ]);
}

// The aperture profile, its normalisation, and the two shape statistics a gate can
// measure on a rendered disc. These are the JS twins of `rawProfile` and
// `kernelNormalization` in bokeh-source-scatter.js: the shader inlines the same
// BOKEH_SOURCE_CONTRACT constants, so there is one owner for the numbers and one
// owner for the curve. A harness that restates the curve as `1 / radiusRatio^2`
// silently encodes "the profile is self-similar", which this profile is not: the
// `coverage` rolloff is one pixel wide in absolute pixels, so its share of the disc
// shrinks as the radius grows and the *peak* therefore drifts away from pure area
// dilution while the flat interior does not.
const PROFILE_LATTICE_RADIUS = 7;
const CONTINUOUS_NORMALIZATION_RADIUS = 7;

/** Unnormalised aperture weight at `distancePx` for a disc of `radiusPx`. */
export function bokehSourceRawProfile(distancePx, radiusPx) {
  if (BOKEH_SOURCE_CONTRACT.profilePower !== 12) {
    throw new Error(
      "bokeh-source-scatter.js hand-unrolls radial^12; profilePower changed",
    );
  }
  const inner = Math.max(radiusPx - 0.5, 0);
  const outer = radiusPx + 0.5;
  const span = Math.max(outer - inner, 1e-9);
  const t = Math.min(1, Math.max(0, (distancePx - inner) / span));
  const coverage = 1 - t * t * (3 - 2 * t);
  const radial = Math.min(distancePx / Math.max(radiusPx, 0.0001), 1);
  return (
    coverage *
    (BOKEH_SOURCE_CONTRACT.profileCore +
      BOKEH_SOURCE_CONTRACT.profileRim *
        radial ** BOKEH_SOURCE_CONTRACT.profilePower)
  );
}

/**
 * Energy-conserving divisor. Below seven pixels the continuous integral is wrong by
 * more than a percent, so the shader sums the same 15x15 lattice; that branch is
 * reproduced exactly here because it is what makes a sub-pixel disc degenerate to
 * the source's own texel instead of vanishing.
 */
export function bokehSourceKernelNormalization(radiusPx) {
  const continuous =
    Math.PI * radiusPx * radiusPx * BOKEH_SOURCE_CONTRACT.profileIntegral;
  if (radiusPx >= CONTINUOUS_NORMALIZATION_RADIUS) {
    return Math.max(continuous, 0.0001);
  }
  let discrete = 0;
  for (let y = -PROFILE_LATTICE_RADIUS; y <= PROFILE_LATTICE_RADIUS; y++) {
    for (let x = -PROFILE_LATTICE_RADIUS; x <= PROFILE_LATTICE_RADIUS; x++) {
      discrete += bokehSourceRawProfile(Math.hypot(x, y), radiusPx);
    }
  }
  const t = Math.min(
    1,
    Math.max(0, (radiusPx - (CONTINUOUS_NORMALIZATION_RADIUS - 1)) / 1),
  );
  const blend = t * t * (3 - 2 * t);
  return Math.max(discrete + (continuous - discrete) * blend, 0.0001);
}

/** Normalised weight, i.e. the fraction of the source's energy landing on one pixel. */
export function bokehSourceProfileWeight(distancePx, radiusPx) {
  return (
    bokehSourceRawProfile(distancePx, radiusPx) /
    bokehSourceKernelNormalization(radiusPx)
  );
}

/**
 * Highest normalised weight any pixel of the disc receives. The maximum sits just
 * inside the rim, where `coverage` is still one and `radial^12` has almost peaked,
 * so it is found by scanning rather than assumed to be at `radiusPx`.
 */
export function bokehSourcePeakWeight(radiusPx, stepPx = 0.05) {
  const limit = radiusPx + 1;
  let peak = 0;
  for (let distance = 0; distance <= limit; distance += stepPx) {
    peak = Math.max(peak, bokehSourceRawProfile(distance, radiusPx));
  }
  return peak / bokehSourceKernelNormalization(radiusPx);
}

/**
 * Pixel-area-weighted mean normalised weight over the annulus
 * `[minFraction, maxFraction] * radiusPx`, which is the quantity an image gate
 * measures when it averages every pixel whose distance falls in that band.
 */
export function bokehSourceAnnulusMeanWeight(
  radiusPx,
  minFraction,
  maxFraction,
  stepPx = 0.05,
) {
  const inner = radiusPx * minFraction;
  const outer = radiusPx * maxFraction;
  let weighted = 0;
  let area = 0;
  for (let distance = inner; distance <= outer; distance += stepPx) {
    // Pixel count in a thin annulus grows with its radius, so weight by distance.
    weighted += bokehSourceRawProfile(distance, radiusPx) * distance;
    area += distance;
  }
  return (
    weighted /
    Math.max(1e-9, area) /
    bokehSourceKernelNormalization(radiusPx)
  );
}

export function bokehSourceNeedsTriangles(requiredDiameter, maxPointSize) {
  return (
    Math.ceil(Math.max(0, requiredDiameter)) >
    Math.floor(Math.max(0, maxPointSize))
  );
}

export function selectBokehSourceBackend(
  currentBackend,
  requiredDiameter,
  maxPointSize,
) {
  return currentBackend === "triangles" ||
    bokehSourceNeedsTriangles(requiredDiameter, maxPointSize)
    ? "triangles"
    : "points";
}
