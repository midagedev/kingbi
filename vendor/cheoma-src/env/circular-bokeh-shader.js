// Full-resolution cinematic DoF composite for StableBokehPass.
//
// Layer separation lives in the physical circle of confusion
// (bokeh-coc-contract.js) and is reconstructed by the half-resolution CoC gather
// (bokeh-coc-pass.js). This module is only the composite: it recomputes the same
// CoC curve at full resolution, takes the direct one-fetch path where the frame
// is sharp, and otherwise blends the bilinearly upsampled gather in.
//
// What used to be here, and why it is gone (docs/dof-cinematic-research.md §3):
//   * `min(blurRadiusPx, surfaceRadiusPx)` with surfaceRadiusPx = 3.25 saturated
//     every ordinary surface 2-4m off the focus plane, so a neighbouring parcel,
//     the row of houses behind it, and the background ridge all received the same
//     0.2%-of-frame blur. That single clamp was the whole reason the frame had no
//     depth layers. It existed because a 13-tap full-resolution kernel cannot
//     fill a large disc without ringing; buying radius with resolution removes
//     its reason to exist.
//   * `contrastGate` kept any low-contrast region perfectly sharp regardless of
//     defocus, which is most of a village background (plaster, roof planes,
//     terrain, paddy water). Uniform surfaces must defocus too.
//   * the moving-camera full stop. bokehQuality now only weights the gather's
//     fill ring, so depth of field exists throughout a dolly and settling no
//     longer pops (§5.3).
// Compact HDR sources still transfer exactly once to the source scatter, which
// keeps ownership of the large energy-conserving disc.
import { BOKEH_COC_DEFAULTS } from "./bokeh-coc-contract.js";
import { BOKEH_SOURCE_CONTRACT } from "./bokeh-source-contract.js";

export {
  BOKEH_GATHER_BASE_TAP_COUNT,
  BOKEH_GATHER_FILL_TAP_COUNT,
  BOKEH_GATHER_TAP_COUNT,
} from "./bokeh-coc-contract.js";

// color + packed depth + source ownership + upsampled gather.
export const CIRCULAR_BOKEH_COMPOSITE_TAP_COUNT = 4;

export const CIRCULAR_BOKEH_DEFAULTS = Object.freeze({
  highlightThreshold: 1.2,
  highlightKnee: 0.52,
  // A bright compact source keeps a deliberately larger disc than the surface
  // behind it; the surface radius is now the pure optical value.
  sourceRadiusScale: BOKEH_COC_DEFAULTS.sourceRadiusScale,
  apertureMeters: BOKEH_COC_DEFAULTS.apertureMeters,
  maxCocFraction: BOKEH_COC_DEFAULTS.maxCocFraction,
});

function glslFloat(value) {
  const text = Number(value).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

export const CIRCULAR_BOKEH_FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tHighlight;
  uniform sampler2D tGather;
  uniform float nearClip;
  uniform float farClip;
  uniform float focus;
  uniform float cocScalePx;
  uniform float maxCocPx;
  uniform float tiltStrength;
  uniform float tiltAnchorV;
  uniform float highlightThreshold;
  uniform float bokehSourceScatter;

  #include <packing>

  float getDepth(const in vec2 screenPosition) {
    #if DEPTH_PACKING == 1
      return unpackRGBAToDepth(texture2D(tDepth, screenPosition));
    #else
      return texture2D(tDepth, screenPosition).x;
    #endif
  }

  float getViewZ(const in float depth) {
    #if PERSPECTIVE_CAMERA == 1
      return perspectiveDepthToViewZ(depth, nearClip, farClip);
    #else
      return orthographicDepthToViewZ(depth, nearClip, farClip);
    #endif
  }

  vec3 withoutTransferredSource(vec3 color, vec4 highlightSample) {
    float brightness = max(max(color.r, color.g), color.b);
    float compactSource =
      step(
        ${glslFloat(BOKEH_SOURCE_CONTRACT.gatherSupportCutoff)},
        highlightSample.a
      )
      // Once an exact 2x2 block owns an HDR source, transfer its antialiased
      // shoulder with the core so the source remains one energy-conserving unit.
      * step(highlightThreshold * 0.05, brightness)
      * step(0.5, bokehSourceScatter);
    return max(color - color * compactSource, vec3(0.0));
  }

  void main() {
    // The identical curve the CoC prefilter and the source scatter evaluate.
    // Sky pixels sit at BokehPass's deliberate far-depth clear, so background
    // blur is a fixed optical quantity and cannot drift with time or weather.
    // Tilt ramps inverse focus across the frame height, identically to the
    // prefilter and the source scatter. All three must read the same screen v or a
    // lantern, the wall behind it, and the composite disagree about the plane.
    float axialDepth = -getViewZ(getDepth(vUv));
    float invFocus = (1.0 / focus) * (1.0 + tiltStrength * (vUv.y - tiltAnchorV));
    float signedCoc = cocScalePx * (invFocus - 1.0 / max(axialDepth, nearClip));
    float cocPx = min(abs(signedCoc), maxCocPx);

    // The gather's alpha carries the radius it actually spent, including the
    // near 3x3 max-dilate. Reading it here is what lets a defocused foreground
    // reach across a sharp subject instead of stopping at its own silhouette.
    vec4 gather = texture2D(tGather, vUv);
    float dilatedPx = gather.a * maxCocPx;
    float effectivePx = max(cocPx, dilatedPx);

    if (effectivePx < ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx)}) {
      gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
      return;
    }

    vec3 centerColor = texture2D(tColor, vUv).rgb;
    vec4 centerHighlight = texture2D(tHighlight, vUv);
    vec3 centerBase = withoutTransferredSource(centerColor, centerHighlight);
    // One sub-pixel ramp off the sharp cut. The gather already removed the
    // transferred source, so both sides of this mix are the same image.
    float mixWeight = smoothstep(
      ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx)},
      ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx + 1.5)},
      effectivePx
    );
    gl_FragColor = vec4(mix(centerBase, gather.rgb, mixWeight), 1.0);
  }
`;

/** Install the physical CoC composite without replacing BokehPass's public API. */
export function installCircularBokeh(material, options = {}) {
  if (!material?.uniforms)
    throw new TypeError("installCircularBokeh requires a ShaderMaterial");
  const tuning = { ...CIRCULAR_BOKEH_DEFAULTS, ...options };
  material.uniforms.highlightThreshold = { value: tuning.highlightThreshold };
  material.uniforms.highlightKnee = { value: tuning.highlightKnee };
  material.uniforms.tHighlight = { value: null };
  material.uniforms.tGather = { value: null };
  // CPU-resolved per frame: the lens fov changes across the focus continuum, so
  // this scale must never be baked into the shader as a constant.
  material.uniforms.cocScalePx = { value: 0 };
  material.uniforms.maxCocPx = { value: 0 };
  // Tilt-shift plane of focus. Resolved per frame from the dof amount ramp and the
  // subject's own screen height, so it fades in with the aperture and never appears
  // in a frame that has no depth of field (docs/dof-cinematic-research.md §4.7).
  material.uniforms.tiltStrength = { value: 0 };
  material.uniforms.tiltAnchorV = { value: 0.5 };
  // Legacy uniform name retained: it is now strictly the compact-source disc
  // multiplier on top of the physical CoC, never a surface radius.
  material.uniforms.bokehRadiusScale = { value: tuning.sourceRadiusScale };
  material.uniforms.viewportWidth = { value: 1 };
  material.uniforms.viewportHeight = { value: 1 };
  material.uniforms.bokehQuality = { value: 1 };
  material.uniforms.bokehSourceScatter = { value: 0 };
  material.fragmentShader = CIRCULAR_BOKEH_FRAGMENT_SHADER;
  material.needsUpdate = true;
  return material.uniforms;
}
