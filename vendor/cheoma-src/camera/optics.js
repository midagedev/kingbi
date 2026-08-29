// Shared lens and view-relative zoom policy for the village camera.
//
// A focal-length change only becomes visible as perspective when the camera also
// dollies: wide aerial views move closer, telephoto house views move farther away.
// The helpers below preserve projected subject scale while changing that depth
// compression, and let screen-space LOD ignore the compensating dolly distance.

const DEG = Math.PI / 180;
export const VILLAGE_FOCUS_CONTEXT_ELEVATION = 31 * DEG;
// Night aerial (U2 / look-audit): 31° survey puts the top 46° ray ~8° below the horizon, so
// the lunar disc never shares the product frame. Soften only the *default aerial pose* at
// night so moon disc/corona sit in the upper sky band; day/sunset survey and every focus
// continuum stay on the 31° context elevation. Keep in lockstep with
// `NIGHT_AERIAL_MOON_FRAME.cameraElevationDeg` in moon-optics.js.
export const VILLAGE_NIGHT_AERIAL_ELEVATION = 15 * DEG;
// Shared close-parcel pose. The flagship look is a backlit golden-hour rim, and a rim only
// exists where a silhouette edge stands against the sky; bokeh only exists where the frame
// carries depth spread. Both die at survey elevations, so the residential close view stays in
// the eye-level architectural band where the eave curve, not the courtyard plan, is the subject.
// Courtyard readability is bought with azimuth, distance, and target lift instead — the yard
// still reads over the wall from here.
export const VILLAGE_FOCUS_ELEVATION = 9 * DEG;

/** Default village aerial elevation for a time-of-day. Focus paths never call this. */
export function villageAerialElevation(time) {
  return time === 'night' ? VILLAGE_NIGHT_AERIAL_ELEVATION : VILLAGE_FOCUS_CONTEXT_ELEVATION;
}
// Inner end of the residential focus zoom continuum (docs/look-audit-2026-07.md U6 residual,
// GitHub #213). The authored closeup is the 9° yard/door pose above; pinching or scrolling
// past that closeup eases the path elevation down toward this under-eave look so the cheoma
// silhouette and rafter layers read as the main line under sunset rim. Stays inside the
// reviewed 7–12° eye-level band — never a return to the retired 24° survey camera. Hero
// landing keeps VILLAGE_HERO_FOCUS_ELEVATION; landmark palace/temple bases sit above the
// band and are not pulled into this look.
export const VILLAGE_EAVE_FOCUS_ELEVATION = 7 * DEG;
// Residential bases at or below this still participate in the eave inner continuum. Anything
// higher (palace 20°, temple 17°, hero 24°) is a survey/landmark pose and must keep its base
// when the user dollies in.
export const VILLAGE_EAVE_FOCUS_BAND_MAX = 12 * DEG;
// Compose the subject below center so the eave line cuts sky rather than sitting against the far
// hillside. Normalized lens shift only — no camera pose or focus distance moves. A 배산임수 village
// always puts the ridge behind a south-facing house, so this shift alone cannot manufacture sky;
// the ridge-mist bands (generators/village/terrain.js) dissolve that backdrop into 여백, and this
// only buys room above the eave for it. Larger values crop the near yard out of frame.
//
// The fraction is of the **usable band** — the viewport left over after product chrome — not of raw
// viewport height (ui-consolidation §6.19). Sky above the eave is a compositional proportion of what
// the viewer can actually see, so a viewport-relative reading was only ever right while the chrome
// was thin: once a phone shell claimed 43% of the height it pushed the subject's lower half under
// the sheet (measured 56.5px out of a 257px band) while the fit verdict still reported the frame as
// contained. 0.2 of the band reproduces the desktop reference frame this was authored against
// (0.13 x 800px viewport = 104px; 0.2 x 519px band = 103.8px, a 0.2px difference), and the same
// proportion honestly scales to 51px on a 390x844 phone.
export const VILLAGE_FOCUS_SKY_FRACTION = 0.2;
// ...but the proportion may only shrink. The band is also *larger* than the reference share wherever
// chrome is absent — the hero landing and every ?shot=1 capture hide the whole shell — and reading
// 0.2 of a nearly full viewport there pushed the subject's base out of frame (measured 1360x850
// landing: 164px instead of 110px, subjectBottom 1.011 > 1, i.e. the yard cropped away). The authored
// value was calibrated on a framed viewport, so the band feeding the proportion is capped at the share
// it was authored against: 519 of 800. Consequence, and why this is safe: no frame that is correct
// today moves by more than 0.2px, and the shift only shrinks, only where chrome really claims more
// than the reference share (measured: phone editing 109.7px -> 51.4px, everything else unchanged).
export const VILLAGE_FOCUS_SKY_REFERENCE_BAND = 519 / 800;
// The hero landing keeps its own authored approach. It arrives on a compound courtyard whose
// wings only read from above, and its frame is a settled cinematic beat rather than the shared
// close-parcel pose, so lowering the residential elevation must not follow it.
export const VILLAGE_HERO_FOCUS_ELEVATION = 24 * DEG;
// Product close-focus aperture diameter, in metres, for the physical circle of
// confusion (src/env/bokeh-coc-contract.js). Shared with BOKEH_COC_DEFAULTS /
// DEFAULT_DOF_APERTURE. 0.30 m (with tilt 0.32) is the 2026-07-28 residential
// balance: thatch/giwa grain and 마당 props stay readable while neighbours and
// the ridge still separate. 0.40+tilt 0.55 crushed subject detail. Hero settle
// (~170 m axial focus at 7°) multiplies this through bokehLongFocusApertureMeters
// so the far asymptote does not collapse when the focus plane sits near the ridge
// (#214). See bokeh-coc-contract.js.
//
// One base value covers the entire lens continuum on purpose: fov sits in the
// CoC denominator, and long-focus compensation is focus-distance — not per-lens.
// Do not add a per-lens aperture dial.
export const VILLAGE_FOCUS_DOF_APERTURE = 0.30;

const lens = (fov, referenceFov) => Object.freeze({ fov, referenceFov });

export const VILLAGE_LENS = Object.freeze({
  aerial: lens(46, 42),
  // The residential close lens is the one place where focal length decides whether the flagship
  // look can exist at all. At 10° the compensated dolly stood 96m off a 9m house: the top frame
  // ray was −2° no matter how far the lens shifted, so no sky ever reached the frame and the rim
  // had nothing to stand against, while the 2.33× depth compression flattened four neighbouring
  // parcels and the palace into one amber mass behind the subject. 16° halves the dolly (≈60m),
  // lifts the top ray above the horizon, and restores subject dominance. Everything derived from
  // this profile — RIM_DISTANCE_GATE, chunk/detail LOD screen distance, zoom bounds, DoF spread —
  // is computed from the lens rather than hardcoded, so they follow. docs/look-restoration-plan.md
  // "1-0 잔여".
  parcel: lens(16, 23),
  hero: lens(7, 21),
  palace: lens(24, 32),
  temple: lens(26, 34),
});

// Point-based ambience follows the same compensated dolly as geometry. Keep its
// accepted scale derived from the authored lens set so adding a narrower profile
// cannot silently shrink weather, petals, motes, or practical lights. Individual
// shaders still own their final pixel-size cap.
export const VILLAGE_LENS_SCALE_MIN = 0.5;
export const VILLAGE_LENS_SCALE_MAX = Math.max(...Object.values(VILLAGE_LENS)
  .map((profile) => dollyScaleForFov(profile.referenceFov, profile.fov)));

export function normalizeVillageLensScale(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(VILLAGE_LENS_SCALE_MIN, Math.min(VILLAGE_LENS_SCALE_MAX, value));
}

// 휠/핀치는 현재 보기 안의 구도만 바꾸고 explore↔focus 상태를 전환하지 않는다.
// 화면 등가 거리(reference FOV 기준)로 한 번 정의해 광각 부감·망원 근경이 같은 범위를 소비한다.
export const VILLAGE_ZOOM = Object.freeze({
  explore: Object.freeze({
    minReferenceFraction: 0.16,
    minReferenceFloor: 6,
    minReferenceCap: 24,
    maxReferenceFraction: 1.06,
  }),
  focus: Object.freeze({
    minCloseupFraction: 0.42,
    minReferenceFloor: 1.2,
    maxReferenceFraction: 1.06,
  }),
});

export function villageZoomReferenceBounds(mode, aerialReference, closeupReference = 0) {
  const aerial = Number.isFinite(aerialReference) && aerialReference > 0 ? aerialReference : 150;
  if (mode === 'explore') {
    const policy = VILLAGE_ZOOM.explore;
    return {
      min: Math.max(policy.minReferenceFloor, Math.min(
        policy.minReferenceCap,
        aerial * policy.minReferenceFraction,
      )),
      max: aerial * policy.maxReferenceFraction,
    };
  }
  if (mode === 'focus') {
    const policy = VILLAGE_ZOOM.focus;
    const closeup = Number.isFinite(closeupReference) && closeupReference > 0
      ? closeupReference : policy.minReferenceFloor;
    return {
      min: Math.max(policy.minReferenceFloor, closeup * policy.minCloseupFraction),
      max: aerial * policy.maxReferenceFraction,
    };
  }
  throw new Error(`Unknown village zoom mode: ${mode}`);
}

const smoothstep = (edge0, edge1, value) => {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 선택은 유지하되 근경용 얕은 심도는 넓은 문맥에서 사라진다. 화면 등가 거리로 계산해
// 렌즈 dolly만으로 보케 양이 달라지지 않으며, 0에 도달하면 Bokeh pass도 쉴 수 있다.
export function villageFocusEffectWeight(referenceDistance, aerialReference, closeupReference) {
  const bounds = villageZoomReferenceBounds('focus', aerialReference, closeupReference);
  const closeup = Number.isFinite(closeupReference) && closeupReference > 0
    ? closeupReference : bounds.min;
  const fullUntil = Math.min(bounds.max, Math.max(bounds.min, closeup * 1.35));
  const clearAt = Math.max(fullUntil + 1e-6, Math.min(
    bounds.max,
    Math.max(closeup * 3, bounds.max * 0.5),
  ));
  return 1 - smoothstep(fullUntil, clearAt, referenceDistance);
}

// 0 at the authored closeup and beyond, 1 at the protected focus minimum. Only residential
// eye-level bases participate — the weight is for composition/debug consumers of the same
// continuum that villageFocusContextElevation already drives.
export function villageFocusEaveWeight(referenceDistance, aerialReference, closeupReference) {
  const bounds = villageZoomReferenceBounds('focus', aerialReference, closeupReference);
  const closeup = Number.isFinite(closeupReference) && closeupReference > 0
    ? closeupReference : bounds.min;
  if (!(closeup > bounds.min)) return 0;
  // smoothstep(min, closeup, d) is 0 at min and 1 at closeup; invert for eave fill.
  return 1 - smoothstep(bounds.min, closeup, referenceDistance);
}

// Path elevation across the whole focus continuum:
//   inner min  → VILLAGE_EAVE_FOCUS_ELEVATION (7°, residential only)
//   closeup    → baseElevation (authored 9° yard/door pose)
//   zoom-out   → crane toward VILLAGE_FOCUS_CONTEXT_ELEVATION (31°)
// Default focus-in remains the closeup pose; the eave look is only reached by wheel/pinch
// past that closeup. Landmark and hero bases above the 7–12° band keep their elevation.
export function villageFocusContextElevation(
  referenceDistance,
  aerialReference,
  closeupReference,
  baseElevation,
) {
  const base = Number.isFinite(baseElevation) ? baseElevation : 0;
  const bounds = villageZoomReferenceBounds('focus', aerialReference, closeupReference);
  const closeup = Number.isFinite(closeupReference) && closeupReference > 0
    ? closeupReference : bounds.min;
  let pathBase = base;
  const eaveEligible = base > VILLAGE_EAVE_FOCUS_ELEVATION + 1e-9
    && base <= VILLAGE_EAVE_FOCUS_BAND_MAX + 1e-9;
  if (eaveEligible && closeup > bounds.min) {
    const eaveWeight = villageFocusEaveWeight(
      referenceDistance, aerialReference, closeupReference,
    );
    pathBase = base + (VILLAGE_EAVE_FOCUS_ELEVATION - base) * eaveWeight;
  }
  const context = 1 - villageFocusEffectWeight(
    referenceDistance, aerialReference, closeupReference,
  );
  return pathBase + (Math.max(pathBase, VILLAGE_FOCUS_CONTEXT_ELEVATION) - pathBase) * context;
}

function validFov(value) {
  return Number.isFinite(value) && value > 0 && value < 179;
}

/** Dolly multiplier that holds a subject's projected height while FOV changes. */
export function dollyScaleForFov(fromFov, toFov) {
  if (!validFov(fromFov) || !validFov(toFov)) return 1;
  return Math.tan(fromFov * DEG * 0.5) / Math.tan(toFov * DEG * 0.5);
}

export function dollyDistanceForFov(distance, fromFov, toFov) {
  if (!Number.isFinite(distance)) return distance;
  return distance * dollyScaleForFov(fromFov, toFov);
}

/** Compensating FOV after multiplying camera-to-target distance by `scale`. */
export function fovForDollyScale(fov, scale) {
  if (!validFov(fov) || !Number.isFinite(scale) || scale <= 0) return fov;
  return 2 * Math.atan(Math.tan(fov * DEG * 0.5) / scale) / DEG;
}

/** Distance as perceived at referenceFov; useful for screen-space LOD decisions. */
export function equivalentDistanceAtFov(distance, actualFov, referenceFov) {
  if (!Number.isFinite(distance) || !validFov(actualFov) || !validFov(referenceFov)) return distance;
  return distance / dollyScaleForFov(referenceFov, actualFov);
}

// Map the new optical continuum back to the former FOV continuum. This keeps fauna,
// motes, leaves, and other detail at the same apparent size after a compensated dolly.
export function referenceVillageFov(actualFov) {
  if (!validFov(actualFov)) return actualFov;
  const H = VILLAGE_LENS.hero;
  const P = VILLAGE_LENS.parcel;
  const A = VILLAGE_LENS.aerial;
  if (actualFov <= P.fov) {
    const span = P.fov - H.fov;
    const t = span > 0 ? Math.max(0, Math.min(1, (actualFov - H.fov) / span)) : 1;
    return H.referenceFov + (P.referenceFov - H.referenceFov) * t;
  }
  const span = A.fov - P.fov;
  const t = span > 0 ? Math.max(0, Math.min(1, (actualFov - P.fov) / span)) : 0;
  return P.referenceFov + (A.referenceFov - P.referenceFov) * t;
}

/**
 * Resolve the authored reference lens carried by a camera.
 *
 * Generic/standalone cameras are authored at their physical FOV, so missing village
 * metadata must be the identity lens. Village camera paths carry an explicit
 * `villageReferenceFov`; inferring a village profile here would silently opt house
 * cameras into a compensated dolly and make particles/LOD change size on mode exit.
 */
export function referenceFovForCamera(camera) {
  const explicit = camera?.userData?.villageReferenceFov;
  return validFov(explicit) ? explicit : camera?.fov;
}

/** Point-sprite multiplier matching geometry under a compensated lens dolly. */
export function lensScaleForCamera(camera) {
  return dollyScaleForFov(referenceFovForCamera(camera), camera?.fov);
}

export function villageScreenDistance(
  distance,
  actualFov,
  referenceFov = referenceVillageFov(actualFov),
) {
  return equivalentDistanceAtFov(distance, actualFov, referenceFov);
}

export function villageScreenDistanceForCamera(distance, camera) {
  return villageScreenDistance(distance, camera?.fov, referenceFovForCamera(camera));
}
