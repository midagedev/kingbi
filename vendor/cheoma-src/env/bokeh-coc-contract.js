// Renderer-free circle-of-confusion contract shared by the CoC prefilter, the
// half-resolution gather, the full-resolution composite, the source scatter, and
// the browser-free gates. See docs/dof-cinematic-research.md §4.
//
// The single formula every consumer uses is the thin-lens circle of confusion
// reduced for d >> f (always true at village scale):
//
//   r_px = cocScalePx * | 1/focus - 1/z |,
//   cocScalePx = A_eff * viewportHeight / (4 * tan(fov / 2))
//
// Three properties fall out of it, and they are exactly the acceptance criteria:
// blur is a monotone function of z on both sides of the focus plane, the
// background flattens to a finite asymptote (cocScalePx / focus) without an
// artificial clamp, and the foreground releases harder than the background at
// equal distance. fov sits in the denominator, so one base aperture constant
// gives the 46 deg aerial lens a deep depth of field and the 7 deg hero lens a
// shallow one. A second, focus-only dial (bokehLongFocusApertureMeters) keeps the
// far asymptote from collapsing when compensated telephoto dolly parks the focus
// plane near the ridge (hero settle ~170 m) — without touching the residential
// near band that #207 deepened. Never hardcode cocScalePx: the lens profile and
// live focus distance change it.

const DEG2RAD_HALF = Math.PI / 360;

// signedCoc = cocScalePx * (1/focus - 1/z) is strictly increasing in z, so its
// sign alone separates the two optical sides and its ordering is a valid depth
// proxy. The gather relies on that monotonicity to reject background bleed
// without sampling depth a second time.
export const BOKEH_COC_FAR_SIGN = 1;
export const BOKEH_COC_NEAR_SIGN = -1;

// --- Tilt (Scheimpflug) --------------------------------------------------------
//
// A tilt-shift lens rotates the plane of focus off the optical axis. Written in
// the same reduced form the CoC above uses, that is exactly a linear ramp of
// *inverse* focus across the frame height:
//
//   invFocus(v) = (1 / focus) * (1 + tiltStrength * (v - anchorV))
//
// and it is a genuine plane, not an approximation. A camera-space plane
// b*Y + c*Z = 1 gives 1/z = c + b*t where t is the tangent of the vertical view
// angle, and t is linear in the screen coordinate v, so a linear ramp in v is a
// plane and nothing else. The sharp locus therefore stays one flat surface and
// blur remains a monotone function of the distance to it - the acceptance
// criteria in docs/dof-cinematic-research.md section 1 survive unchanged.
//
// Why this is the tilt-shift dial and not a second aperture: the ground recedes
// upward in screen space, so on the ground 1/z *falls* as v rises. A positive
// tiltStrength makes invFocus *rise* with v, so the two curves cross once (at the
// anchor) and diverge from it at the sum of both slopes. That narrows the sharp
// band and steepens the exit ramp simultaneously, which is the whole of the
// diorama signature, without touching aperture - the one thing the user's
// 2026-07-25 instruction ruled out.
//
// Bound: the far asymptote is scalePx * invFocus, so tilt multiplies it by
// (1 + tiltStrength * maxAnchorOffset). It must stay under maxCocPx or the
// background starts clamping and the guaranteed near/far asymmetry (section 4.2)
// degrades into a tuning accident. bokehTiltFarAsymptoteHeadroom() is that check,
// and the anchor clamp below is what makes its worst case finite.
export const BOKEH_TILT_ANCHOR_MIN = 0.35;
export const BOKEH_TILT_ANCHOR_MAX = 0.65;
export const BOKEH_TILT_MAX_ANCHOR_OFFSET = Math.max(
  BOKEH_TILT_ANCHOR_MAX,
  1 - BOKEH_TILT_ANCHOR_MIN,
);

// Reference axial focus (m) at which the authored base aperture is exact. Longer
// product focus multiplies aperture up to BOKEH_LONG_FOCUS_BOOST_MAX so the far
// asymptote (A / (4 tan(fov/2) focus)) cannot collapse under compensated dolly.
// Residential door focus (~50–60 m) stays at boost 1 — the #207 near-band contract.
export const BOKEH_LONG_FOCUS_REF_M = 60;
// Hero settle parks a 7° lens at ~170 m of axial focus; without a boost the ridge
// at 220–300 m sits only 1–3 px soft at 720p. Cap at 2× so the far asymptote under
// product tilt still clears maxCocFraction (check:dof hero-headroom).
export const BOKEH_LONG_FOCUS_BOOST_MAX = 2;

/**
 * Effective aperture diameter after long-focus compensation.
 *
 * Far asymptote as a fraction of frame height is A / (4·tan(fov/2)·focus). With
 * compensated telephoto dolly the hero compound focus moves toward the ridge, so
 * that fraction shrinks even though the 7° lens scales cocScale up. Scale A with
 * focus above the residential reference so the miniature soft-separation look
 * survives hero settle without re-softening the 마당 near band at short focus.
 */
export function bokehLongFocusApertureMeters(
  apertureMeters,
  focus,
  {
    refFocus = BOKEH_LONG_FOCUS_REF_M,
    maxBoost = BOKEH_LONG_FOCUS_BOOST_MAX,
  } = {},
) {
  if (!Number.isFinite(apertureMeters) || apertureMeters <= 0) return 0;
  if (!Number.isFinite(focus) || focus <= 0) return apertureMeters;
  const ref = Number.isFinite(refFocus) && refFocus > 0 ? refFocus : BOKEH_LONG_FOCUS_REF_M;
  const cap = Number.isFinite(maxBoost) && maxBoost >= 1 ? maxBoost : 1;
  const boost = Math.min(cap, Math.max(1, focus / ref));
  return apertureMeters * boost;
}

export const BOKEH_COC_DEFAULTS = Object.freeze({
  // Product close-focus aperture diameter in metres (thin-lens CoC). Originally
  // 0.675 m (~85mm f/2.8 on a 1:22 model, docs/dof-cinematic-research.md §1.2 / §4.3)
  // so a 150 m ridge sat at ~1.2% of frame height. 0.40 m + tilt 0.55 still soft-
  // crushed thatch/giwa grain and 마당 props at residential focus (2026-07-28 A/B
  // on p27). 0.30 m keeps neighbour/ridge separation and lantern discs while the
  // subject house and yard stay readable. Long hero settle multiplies this through
  // bokehLongFocusApertureMeters (not a second product dial). Exposed in metres
  // rather than an f-stop because no real full-scale lens reaches the required
  // f-number.
  apertureMeters: 0.30,
  // Fraction of viewport height. It binds the foreground only: the background
  // asymptote (cocScalePx / focus) stays below it at product focus distances, so
  // far blur runs the pure physical curve to infinity and the near/far asymmetry
  // is a guaranteed contract rather than a tuning accident.
  //
  // 0.04 (not 0.03): a product telephoto focus at ~50 m already spends a few
  // percent of frame height on the untilted far asymptote (16°, 720p). The
  // Scheimpflug tilt multiplies that asymptote by (1 + tilt * maxAnchorOffset), so
  // a 3% clamp was already saturated before tilt could add the diorama exit ramp.
  // 4% restores headroom for the product tilt below without re-clamping the far
  // curve (tools/check-dof.mjs product-headroom assertion).
  maxCocFraction: 0.04,
  // Radius is bought with resolution, not with taps. Half resolution is also the
  // mobile form of this effect.
  gatherScale: 0.5,
  // A bright compact HDR source keeps a deliberately larger disc than the surface
  // behind it. Optically impure, but it preserves the existing lantern/window
  // bokeh that the source scatter already renders best in class, and it keeps the
  // scatter's point-size cap fallback in the same regime. §8 leaves the exact
  // value to the judgment cuts.
  sourceRadiusScale: 2.8,
  // Below this the composite takes the direct one-fetch path.
  sharpRadiusPx: 0.45,
  // Scheimpflug tilt as a fraction of 1/focus per unit screen height. 0 is the
  // ordinary lens. 0.32 is the product diorama dial after the 2026-07-28 A/B:
  // enough to keep a miniature exit ramp and soft neighbours, not so much that
  // the subject roof/yard band collapses (0.55 did). Far-asymptote headroom at
  // product telephoto focus (50 m / 16° / 720p) with maxCocFraction 0.04:
  //   asymptote * (1 + 0.32 * 0.65) < 4.00%
  // Raising tilt requires checking bokehTiltFarAsymptoteHeadroom() in the same edit.
  tiltStrength: 0.32,
});

export const BOKEH_GATHER_BASE_RINGS = 4;
export const BOKEH_GATHER_BASE_PER_RING = 12;
export const BOKEH_GATHER_FILL_RINGS = 2;
export const BOKEH_GATHER_FILL_PER_RING = 6;
// Centre plus four twelve-sample rings.
export const BOKEH_GATHER_BASE_TAP_COUNT =
  1 + BOKEH_GATHER_BASE_RINGS * BOKEH_GATHER_BASE_PER_RING;
export const BOKEH_GATHER_FILL_TAP_COUNT =
  BOKEH_GATHER_FILL_RINGS * BOKEH_GATHER_FILL_PER_RING;
export const BOKEH_GATHER_TAP_COUNT =
  BOKEH_GATHER_BASE_TAP_COUNT + BOKEH_GATHER_FILL_TAP_COUNT;
// Foreground has to escape its own silhouette or it reads as cut paper. A 3x3
// max of the near magnitude replaces pmndrs' separate CoC blur pass.
export const BOKEH_GATHER_NEAR_DILATE_TAP_COUNT = 9;

/** Pixel CoC scale for one lens. Recompute per frame; fov is not a constant. */
export function bokehCocScalePx(apertureMeters, viewportHeight, fovDegrees) {
  if (
    !Number.isFinite(apertureMeters) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(fovDegrees) ||
    apertureMeters <= 0 ||
    viewportHeight <= 0 ||
    fovDegrees <= 0 ||
    fovDegrees >= 179
  ) {
    return 0;
  }
  return (
    (apertureMeters * viewportHeight) / (4 * Math.tan(fovDegrees * DEG2RAD_HALF))
  );
}

export function bokehMaxCocPx(viewportHeight, maxCocFraction) {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  const fraction = Number.isFinite(maxCocFraction) ? Math.max(0, maxCocFraction) : 0;
  return viewportHeight * fraction;
}

/** Clamp a subject's screen v into the range the tilt asymptote bound assumes. */
export function bokehTiltAnchorV(screenV) {
  if (!Number.isFinite(screenV)) return 0.5;
  return Math.min(BOKEH_TILT_ANCHOR_MAX, Math.max(BOKEH_TILT_ANCHOR_MIN, screenV));
}

/**
 * Inverse focus at one screen height. This is the only place tilt enters the
 * optics; every consumer keeps evaluating `scalePx * (invFocus - 1/z)`.
 *
 * Returned as an inverse rather than a distance on purpose: a strong enough tilt
 * sends the plane of focus through infinity and out the far side, which is real
 * lens behaviour, and the inverse form passes straight through that instead of
 * dividing by zero.
 */
export function bokehTiltedInvFocus(focus, tiltStrength, screenV, anchorV) {
  if (!Number.isFinite(focus) || focus <= 0) return 0;
  const base = 1 / focus;
  const tilt = Number.isFinite(tiltStrength) ? tiltStrength : 0;
  if (tilt === 0 || !Number.isFinite(screenV)) return base;
  return base * (1 + tilt * (screenV - bokehTiltAnchorV(anchorV)));
}

/** Signed CoC in pixels from an inverse focus. Positive is background. */
export function bokehSignedCocFromInvFocusPx(scalePx, invFocus, z, nearClip = 1e-4) {
  if (!Number.isFinite(scalePx) || !Number.isFinite(invFocus)) return 0;
  const depth = Math.max(Number.isFinite(nearClip) ? nearClip : 1e-4, z);
  if (!Number.isFinite(depth) || depth <= 0) return 0;
  return scalePx * (invFocus - 1 / depth);
}

/** Signed CoC in pixels. Positive is background, negative is foreground. */
export function bokehSignedCocPx(scalePx, focus, z, nearClip = 1e-4) {
  if (!Number.isFinite(focus) || focus <= 0) return 0;
  return bokehSignedCocFromInvFocusPx(scalePx, 1 / focus, z, nearClip);
}

/**
 * Worst-case far asymptote once tilt is applied, and the headroom left under the
 * clamp. `ratio < 1` is the contract "the background never clamps".
 */
export function bokehTiltFarAsymptoteHeadroom({
  scalePx,
  focus,
  tiltStrength = BOKEH_COC_DEFAULTS.tiltStrength,
  maxCocPx,
}) {
  const asymptote = bokehFarAsymptotePx(scalePx, focus);
  const tilt = Number.isFinite(tiltStrength) ? Math.max(0, tiltStrength) : 0;
  const worstAsymptotePx =
    asymptote * (1 + tilt * BOKEH_TILT_MAX_ANCHOR_OFFSET);
  const cap = Number.isFinite(maxCocPx) && maxCocPx > 0 ? maxCocPx : Infinity;
  return {
    asymptotePx: asymptote,
    worstAsymptotePx,
    maxCocPx: cap,
    ratio: worstAsymptotePx / cap,
  };
}

/** Clamped CoC radius in pixels, the quantity the gather actually spends. */
export function bokehCocRadiusPx(scalePx, focus, z, maxCocPx, nearClip = 1e-4) {
  const signed = bokehSignedCocPx(scalePx, focus, z, nearClip);
  const cap = Number.isFinite(maxCocPx) && maxCocPx > 0 ? maxCocPx : Infinity;
  return Math.min(Math.abs(signed), cap);
}

/** Background asymptote. Staying under maxCocPx is what keeps far unclamped. */
export function bokehFarAsymptotePx(scalePx, focus) {
  if (!Number.isFinite(scalePx) || !Number.isFinite(focus) || focus <= 0) return 0;
  return scalePx / focus;
}

// Deterministic concentric rings of exact antipodal pairs. Equal-area radii
// (sqrt((i + 0.5) / rings)) spread the taps evenly over the disc instead of
// crowding the centre, and every non-centre tap has an exact opposite so the
// optical centre survives without screen-space dither. Generated rather than
// transcribed: copying pmndrs' kernel64/kernel16 tables would attach a Zlib
// attribution obligation (docs/dof-cinematic-research.md §4.1, §7).
function makeRingKernel(rings, perRing, phaseStep, includeCenter, phaseOffset = 0) {
  const points = includeCenter ? [[0, 0]] : [];
  for (let ring = 0; ring < rings; ring++) {
    const radius = Math.sqrt((ring + 0.5) / rings);
    const phase = phaseOffset + phaseStep * ring;
    const pairs = perRing / 2;
    for (let index = 0; index < pairs; index++) {
      const angle = phase + (index * Math.PI * 2) / perRing;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      points.push([x, y], [-x, -y]);
    }
  }
  return points;
}

export const BOKEH_GATHER_BASE_KERNEL = Object.freeze(
  makeRingKernel(
    BOKEH_GATHER_BASE_RINGS,
    BOKEH_GATHER_BASE_PER_RING,
    Math.PI / BOKEH_GATHER_BASE_PER_RING,
    true,
  ).map((point) => Object.freeze(point)),
);

// The fill taps must land in the base kernel's angular gaps or max() has nothing
// to fill. The base rings repeat every 2*PI/12 = PI/6 and their per-ring phases
// occupy {0, PI/12} within that pitch, so the fill phases are placed on the
// PI/18 lattice, which shares no angle with either. Composed with max() this
// closes ring banding the way pmndrs' second bokeh pass does, without trading
// rings for the temporal noise dof2 uses.
export const BOKEH_GATHER_FILL_KERNEL = Object.freeze(
  makeRingKernel(
    BOKEH_GATHER_FILL_RINGS,
    BOKEH_GATHER_FILL_PER_RING,
    Math.PI / 18,
    false,
    Math.PI / 18,
  ).map((point) => Object.freeze(point)),
);

/**
 * Encode a signed CoC into a unit alpha channel and back.
 *
 * One half-resolution RGBA target carries downsampled colour in RGB and the
 * signed CoC in A, so the near/far split costs no second render target and no
 * second program (docs/dof-cinematic-research.md §4.1 deviates from pmndrs here
 * because program count, not bandwidth, is this project's tracked budget).
 */
export function encodeBokehCoc(signedCocPx, maxCocPx) {
  if (!(maxCocPx > 0)) return 0.5;
  const normalized = Math.max(-1, Math.min(1, signedCocPx / maxCocPx));
  return 0.5 + 0.5 * normalized;
}

export function decodeBokehCoc(alpha, maxCocPx) {
  if (!(maxCocPx > 0)) return 0;
  return (alpha * 2 - 1) * maxCocPx;
}

/**
 * The §4.4 layer ladder as data, so the browser-free gate can assert layer
 * separation, subject sharpness, monotonicity, and near/far asymmetry without a
 * renderer. `z` values are metres of camera-axis depth.
 */
export function bokehCocLadder({
  focus,
  apertureMeters = BOKEH_COC_DEFAULTS.apertureMeters,
  maxCocFraction = BOKEH_COC_DEFAULTS.maxCocFraction,
  viewportHeight,
  fovDegrees,
  depths,
  // Tilt defaults to zero here so the existing untilted ladder assertions keep
  // measuring the plain lens; a tilted ladder is a second, explicit case.
  tiltStrength = 0,
  screenV = 0.5,
  anchorV = 0.5,
  // Product path always applies long-focus compensation. Gates that pin the
  // bare thin-lens ladder at residential focus pass either value (boost = 1).
  longFocusCompensation = true,
}) {
  const effectiveAperture = longFocusCompensation
    ? bokehLongFocusApertureMeters(apertureMeters, focus)
    : apertureMeters;
  const scalePx = bokehCocScalePx(effectiveAperture, viewportHeight, fovDegrees);
  const maxCocPx = bokehMaxCocPx(viewportHeight, maxCocFraction);
  const invFocus = bokehTiltedInvFocus(focus, tiltStrength, screenV, anchorV);
  return depths.map((z) => {
    const signedPx = bokehSignedCocFromInvFocusPx(scalePx, invFocus, z);
    return {
      z,
      radiusPx: Math.min(Math.abs(signedPx), maxCocPx > 0 ? maxCocPx : Infinity),
      signedPx,
    };
  });
}
