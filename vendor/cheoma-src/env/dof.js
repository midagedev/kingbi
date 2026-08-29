// Depth-of-field contracts shared by the standalone core and the app wrapper.
// Three's BokehPass `focus` is camera-space axial depth, not Euclidean distance.
//
// `aperture` is an aperture *diameter in metres*. StableBokehPass folds it into
// the one CoC pixel scale together with the live viewport height and lens fov
// (src/env/bokeh-coc-contract.js), so one constant gives the wide aerial lens a
// deep depth of field and the telephoto house lens a shallow one. It is not an
// f-stop: the look this project wants is a 1:22 architectural model shot at
// 85mm f/2.8, which is f/0.13 at full scale and does not exist as a lens
// (docs/dof-cinematic-research.md §1.2). The dofAmount ramp keeps multiplying
// this value, so a transition still scales the CoC linearly and continuously.

const EPSILON = 1e-6;
// Product base aperture diameter in metres. Must stay identical to
// BOKEH_COC_DEFAULTS.apertureMeters and VILLAGE_FOCUS_DOF_APERTURE so the tilt
// ramp weight (aperture / apertureMeters) reaches 1.0 at full focus amount.
export const DEFAULT_DOF_APERTURE = 0.30;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function focusBounds(camera) {
  const near = Number.isFinite(camera?.near) ? Math.max(EPSILON, camera.near) : EPSILON;
  const far = Number.isFinite(camera?.far) ? Math.max(near, camera.far) : Infinity;
  return { near, far };
}

// Keep this module-scoped: StableBokeh calls it for every visible mesh in its depth prepass.
function materialContributesDofDepth(material) {
  return !!material
    && material.visible !== false
    && material.depthWrite !== false
    && !(material.alphaHash === true && material.opacity < 0.999);
}

/**
 * Return a renderable's explicit packed-depth material, if it owns one.
 *
 * Points and Sprites are excluded from the generic opaque-depth policy because
 * replacing them with MeshDepthMaterial changes their primitive, size, and
 * alpha silhouette. A source that needs its own optical depth may instead attach
 * one material at `object.userData.dofDepthMaterial`. `allowOverride=false` is
 * required so the material actually survives BokehPass's scene override.
 */
export function dofDepthMaterialForObject(object) {
  if (!object) return null;
  if (!(object.isMesh || object.isPoints || object.isLine || object.isSprite)) return null;
  if (object.userData?.dofDepth === false) return null;
  const material = object.userData?.dofDepthMaterial;
  if (!material
    || material.isMaterial !== true
    || material.visible === false
    || material.depthWrite === false
    || material.allowOverride !== false) return null;
  return material;
}

/**
 * Return a world point's screen height in [0,1], v=0 at the bottom of the frame.
 *
 * The tilt-shift plane of focus is anchored here, so this has to be the *rendered*
 * position: the focus continuum sets a camera view offset for the panel viewport
 * shift, and that offset lives in the projection matrix. Reading the full clip-row
 * rather than assuming a centred perspective matrix is what keeps the sharp band on
 * the subject when a bottom sheet is open.
 */
export function focusScreenVForPoint(camera, point) {
  if (!camera || !point || ![point.x, point.y, point.z].every(Number.isFinite)) return null;
  if (camera.updateWorldMatrix) camera.updateWorldMatrix(true, false);
  else camera.updateMatrixWorld?.();
  const v = camera.matrixWorldInverse?.elements;
  const p = camera.projectionMatrix?.elements;
  if (!v || !p) return null;
  const xv = v[0] * point.x + v[4] * point.y + v[8] * point.z + v[12];
  const yv = v[1] * point.x + v[5] * point.y + v[9] * point.z + v[13];
  const zv = v[2] * point.x + v[6] * point.y + v[10] * point.z + v[14];
  const clipY = p[1] * xv + p[5] * yv + p[9] * zv + p[13];
  const clipW = p[3] * xv + p[7] * yv + p[11] * zv + p[15];
  if (!Number.isFinite(clipY) || !Number.isFinite(clipW) || Math.abs(clipW) < EPSILON) return null;
  return clipY / clipW * 0.5 + 0.5;
}

/** Return a world point's positive depth along the camera forward axis. */
export function focusDepthForPoint(camera, point) {
  if (!camera || !point || ![point.x, point.y, point.z].every(Number.isFinite)) return null;
  // Public core callers may mount the camera under a moving rig. Updating only the camera leaves
  // a dirty parent transform stale, so refresh ancestors as well before reading matrixWorldInverse.
  if (camera.updateWorldMatrix) camera.updateWorldMatrix(true, false);
  else camera.updateMatrixWorld?.();
  const e = camera.matrixWorldInverse?.elements;
  if (!e) return null;
  const depth = -(e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14]);
  if (!Number.isFinite(depth) || depth <= 0) return null;
  const { near, far } = focusBounds(camera);
  return Math.min(far, Math.max(near, depth));
}

/**
 * Whether an object should contribute to the opaque depth texture used by DoF.
 * Transparent particles and overlays must not become moving opaque occluders when
 * BokehPass temporarily replaces every scene material with MeshDepthMaterial.
 */
export function contributesDofDepth(object) {
  if (!object?.visible) return false;
  if (object.userData?.dofDepth === false) return false;
  if (object.isPoints || object.isLine || object.isSprite) return false;
  if (!object.isMesh) return false;
  if (object.userData?.dofDepth === true) return true;
  // Built-in BokehPass replaces the source material with one opaque depth material, so it
  // cannot reproduce an alphaHash opacity fade. Exclude intermediate hashed fades just as the
  // former transparent/depthWrite=false path did; full-weight hashed meshes still contribute.
  const material = object.material;
  if (!Array.isArray(material)) {
    return materialContributesDofDepth(material);
  }
  // Hot depth-pass path: avoid filter()/some() and temporary arrays across thousands of meshes.
  for (let i = 0; i < material.length; i++) {
    const part = material[i];
    if (materialContributesDofDepth(part)) return true;
  }
  return false;
}

/** Own BokehPass enablement, focus depth, and aperture strength in one place. */
export function createDofController({ camera, pass, aperture = DEFAULT_DOF_APERTURE } = {}) {
  const uniforms = pass?.uniforms;
  if (!camera || !uniforms?.focus || !uniforms?.aperture) {
    throw new TypeError('createDofController requires a camera and BokehPass uniforms');
  }

  let baseAperture = Number.isFinite(aperture) ? Math.max(0, aperture) : 0;
  let amount = pass.enabled ? 1 : 0;
  // Lower bound on the ramp. The aerial camera is the only state that requests
  // amount 0, so a floor above zero is exactly "the aerial diorama gets depth of
  // field too". It lives here rather than in the app because the aerial 0 is
  // decided by the engine's mode wiring; a floor lets the look be evaluated and
  // shipped without that wiring changing. `?doffloor=` is the A/B hook.
  let amountFloor = 0;
  if (typeof location !== 'undefined') {
    const requested = Number(new URLSearchParams(location.search).get('doffloor'));
    if (Number.isFinite(requested)) amountFloor = clamp01(requested);
  }

  function applyAperture() {
    uniforms.aperture.value = baseAperture * amount;
  }

  function setAmount(value) {
    amount = Math.max(amountFloor, clamp01(value));
    applyAperture();
    pass.enabled = amount > EPSILON;
    return amount;
  }

  /** Raise the aerial floor. Returns the amount actually in force afterwards. */
  function setAmountFloor(value) {
    amountFloor = clamp01(value);
    return setAmount(amount);
  }

  function setEnabled(on) {
    return setAmount(on ? 1 : 0) > 0;
  }

  function setAperture(value) {
    if (Number.isFinite(value)) baseAperture = Math.max(0, value);
    // Keep the pass's optical base in lockstep so tiltStrength * (aperture /
    // apertureMeters) still recovers the pure amount ramp after a product
    // setDofAperture call (StableBokehPass._resolveCocScale).
    if (pass && Number.isFinite(baseAperture)) pass.apertureMeters = baseAperture;
    applyAperture();
    return baseAperture;
  }

  function setFocus(value) {
    if (!Number.isFinite(value) || value <= 0) return uniforms.focus.value;
    const { near, far } = focusBounds(camera);
    uniforms.focus.value = Math.min(far, Math.max(near, value));
    return uniforms.focus.value;
  }

  function focusAt(point) {
    const depth = focusDepthForPoint(camera, point);
    // Anchor the tilt on the same subject the focus depth came from, so the plane
    // of focus passes through it and the subject reads exactly as sharp as it would
    // on an untilted lens. Only the frame around it releases harder.
    const screenV = focusScreenVForPoint(camera, point);
    if (screenV != null) pass.setTilt?.(null, screenV);
    return depth == null ? uniforms.focus.value : setFocus(depth);
  }

  function depthAt(point) {
    return focusDepthForPoint(camera, point);
  }

  /** Tilt-shift dial, in fractions of 1/focus per unit frame height. */
  function setTilt(strength) {
    return pass.setTilt?.(strength, null) ?? null;
  }

  if (pass && Number.isFinite(baseAperture)) pass.apertureMeters = baseAperture;
  applyAperture();
  setAmount(amount);
  return {
    setEnabled,
    setAmount,
    setAmountFloor,
    setAperture,
    setFocus,
    setTilt,
    focusAt,
    depthAt,
    get aperture() { return baseAperture; },
    get enabled() { return !!pass.enabled; },
    get focus() { return uniforms.focus.value; },
    get amount() { return amount; },
    get amountFloor() { return amountFloor; },
    get tilt() { return pass.tiltStrength ?? 0; },
    get tiltAnchorV() { return pass.tiltAnchorV ?? 0.5; },
  };
}
