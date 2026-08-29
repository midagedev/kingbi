// Three-free GLSL builders for the half-resolution CoC prefilter and gather.
//
// Split out of bokeh-coc-pass.js on purpose: the browser-free contract gate
// (tools/check-dof.mjs) must assert the *generated* shader text - tap counts,
// the near max-dilate, the acceptance rule, the absence of loops and screen-space
// noise - and it cannot import a module that pulls in three. Everything here is
// string generation and pure arithmetic; bokeh-coc-pass.js owns the render
// targets, materials, and draw calls.
//
// docs/dof-cinematic-research.md section 4.
import {
  BOKEH_GATHER_BASE_KERNEL,
  BOKEH_GATHER_BASE_TAP_COUNT,
  BOKEH_GATHER_FILL_KERNEL,
  BOKEH_GATHER_FILL_TAP_COUNT,
} from "./bokeh-coc-contract.js";
import { BOKEH_SOURCE_CONTRACT } from "./bokeh-source-contract.js";

function glslFloat(value) {
  const text = Number(value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

export const BOKEH_COC_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Shared decode helpers. Kept as source strings so both new programs and the
// full-resolution composite express the identical curve; a divergence here would
// make a lantern and the wall behind it disagree about how defocused they are.
export const BOKEH_COC_GLSL = /* glsl */ `
  // Scheimpflug tilt: inverse focus ramps linearly across the frame height, which
  // is exactly a tilted plane in camera space (bokeh-coc-contract.js). tiltStrength
  // is already anchor-clamped and amount-scaled on the CPU, so this is one multiply
  // and one add - no extra program, no extra target, no extra texture fetch.
  float bokehInvFocus(float screenV) {
    return (1.0 / focus) * (1.0 + tiltStrength * (screenV - tiltAnchorV));
  }
  float bokehSignedCocAt(float axialDepth, float screenV) {
    return cocScalePx * (bokehInvFocus(screenV) - 1.0 / max(axialDepth, nearClip));
  }
  float bokehEncodeCoc(float signedCocPx) {
    float normalized = clamp(signedCocPx / max(maxCocPx, 0.0001), -1.0, 1.0);
    return 0.5 + 0.5 * normalized;
  }
  float bokehDecodeCoc(float alpha) {
    return (alpha * 2.0 - 1.0) * maxCocPx;
  }
`;

const DEPTH_GLSL = /* glsl */ `
  float getDepth(const in vec2 screenPosition) {
    #if DEPTH_PACKING == 1
      return unpackRGBAToDepth(texture2D(tDepth, screenPosition));
    #else
      return texture2D(tDepth, screenPosition).x;
    #endif
  }
  float getAxialDepth(const in vec2 screenPosition) {
    #if PERSPECTIVE_CAMERA == 1
      return -perspectiveDepthToViewZ(getDepth(screenPosition), nearClip, farClip);
    #else
      return -orthographicDepthToViewZ(getDepth(screenPosition), nearClip, farClip);
    #endif
  }
`;

// Exactly the 2x2 block the source scatter already owns, so colour, source
// ownership, and CoC agree on one grid.
const BLOCK_OFFSETS = Object.freeze([
  [-0.5, -0.5],
  [0.5, -0.5],
  [-0.5, 0.5],
  [0.5, 0.5],
]);
export const BOKEH_COC_PREFILTER_BLOCK_TAP_COUNT = BLOCK_OFFSETS.length;

const PREFILTER_BLOCK_LINES = BLOCK_OFFSETS.map(([x, y], index) => {
  const uv =
    `blockCenterUv + vec2(${glslFloat(x)}, ${glslFloat(y)}) * sourceTexel`;
  return (
    `vec2 blockUv${index} = ${uv};\n` +
    `    vec3 blockColor${index} = texture2D(tColor, blockUv${index}).rgb;\n` +
    `    colorSum += withoutTransferredSource(blockColor${index}, ownership);\n` +
    `    float blockSigned${index} = ` +
    `bokehSignedCocAt(getAxialDepth(blockUv${index}), blockUv${index}.y);\n` +
    `    if (abs(blockSigned${index}) > abs(peakSigned)) ` +
    `peakSigned = blockSigned${index};`
  );
}).join("\n    ");

export const BOKEH_COC_PREFILTER_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <packing>

  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform sampler2D tHighlight;
  uniform vec2 sourceTexel;
  uniform float focus;
  uniform float nearClip;
  uniform float farClip;
  uniform float cocScalePx;
  uniform float maxCocPx;
  uniform float tiltStrength;
  uniform float tiltAnchorV;
  uniform float highlightThreshold;
  uniform float bokehSourceScatter;

  ${BOKEH_COC_GLSL}
  ${DEPTH_GLSL}

  // The gather must not spread an HDR source that the scatter already renders as
  // an energy-conserving filled disc, or a lantern is drawn twice. This is the
  // existing full-resolution rule moved down to the downsample step (§4.5).
  vec3 withoutTransferredSource(vec3 color, vec4 highlightSample) {
    float brightness = max(max(color.r, color.g), color.b);
    float compactSource =
      step(
        ${glslFloat(BOKEH_SOURCE_CONTRACT.gatherSupportCutoff)},
        highlightSample.a
      )
      * step(highlightThreshold * 0.05, brightness)
      * step(0.5, bokehSourceScatter);
    return max(color - color * compactSource, vec3(0.0));
  }

  void main() {
    // Match the scatter's explicit 2x2 ownership grid rather than the render
    // target's own vUv, which lands half a texel inward on an odd extent.
    vec2 blockCenterUv = min(
      gl_FragCoord.xy * ${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize)}
        * sourceTexel,
      vec2(1.0)
    );
    // The highlight prefilter target is already this exact half-resolution grid,
    // so one fetch resolves source ownership for the whole 2x2 block.
    vec4 ownership = texture2D(tHighlight, vUv);
    vec3 colorSum = vec3(0.0);
    // Take the largest-magnitude CoC in the block on both sides. A mean would
    // smear the focus plane across a roof edge and a nearest/farthest pair would
    // need two channels; the conservative peak removes silhouette CoC aliasing
    // deterministically, which is what dof2's depthblur buys with a blur pass.
    float peakSigned = 0.0;
    ${PREFILTER_BLOCK_LINES}
    gl_FragColor = vec4(
      colorSum / ${glslFloat(BLOCK_OFFSETS.length)},
      bokehEncodeCoc(peakSigned)
    );
  }
`;

export const BOKEH_COC_NEAR_DILATE_OFFSETS = Object.freeze(
  [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => Object.freeze([x, y]))),
);

const NEAR_DILATE_LINES = BOKEH_COC_NEAR_DILATE_OFFSETS.map(([x, y], index) =>
  `float dilateSigned${index} = bokehDecodeCoc(texture2D(tCoc, vUv + vec2(` +
  `${glslFloat(x)}, ${glslFloat(y)}) * texel).a);\n` +
  `    nearDilatedPx = max(nearDilatedPx, max(0.0, -dilateSigned${index}));`,
).join("\n    ");

function gatherTapLines(kernel, prefix, accumulator, weightAccumulator) {
  return kernel
    .map(([x, y], index) => {
      const length = Math.hypot(x, y);
      return (
        `vec4 ${prefix}${index} = texture2D(tCoc, vUv + vec2(` +
        `${glslFloat(x)}, ${glslFloat(y)}) * discRadius);\n` +
        `    accumulateTap(${prefix}${index}, ` +
        `${glslFloat(length)} * centerRadiusPx, centerSigned, centerRadiusPx, ` +
        `${accumulator}, ${weightAccumulator});`
      );
    })
    .join("\n    ");
}

export const BOKEH_COC_GATHER_FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  varying vec2 vUv;

  uniform sampler2D tCoc;
  uniform vec2 texel;
  uniform float maxCocPx;
  uniform float bokehQuality;

  float bokehDecodeCoc(float alpha) {
    return (alpha * 2.0 - 1.0) * maxCocPx;
  }

  // Scatter-as-gather acceptance, expressed without a second depth fetch.
  // signedCoc is strictly increasing in z, so its ordering is a valid depth
  // proxy (bokeh-coc-contract.js). A sample only reaches this pixel if its own
  // CoC covers the offset; a sample at or behind the centre additionally needs
  // the centre's own CoC to cover it, which is the lightweight equivalent of
  // pmndrs' MaskMaterial and stops background colour haloing a sharp eave line.
  // A sample in front keeps only its own reach, so a defocused foreground washes
  // over the subject instead of staying trapped inside its silhouette (§4.5).
  void accumulateTap(
    vec4 tap,
    float offsetPx,
    float centerSigned,
    float centerRadiusPx,
    inout vec3 colorSum,
    inout float weightSum
  ) {
    float tapSigned = bokehDecodeCoc(tap.a);
    float tapRadiusPx = abs(tapSigned) * 0.5;
    float behind = step(centerSigned, tapSigned);
    float reachPx = mix(tapRadiusPx, min(centerRadiusPx, tapRadiusPx), behind);
    float weight = clamp(reachPx - offsetPx + 1.0, 0.0, 1.0);
    colorSum += tap.rgb * weight;
    weightSum += weight;
  }

  void main() {
    vec4 center = texture2D(tCoc, vUv);
    float centerSigned = bokehDecodeCoc(center.a);
    float nearDilatedPx = 0.0;
    ${NEAR_DILATE_LINES}
    // Half-resolution pixels: the contract's radii are full-resolution.
    float centerRadiusPx = max(abs(centerSigned), nearDilatedPx) * 0.5;
    float normalizedRadius =
      clamp(centerRadiusPx * 2.0 / max(maxCocPx, 0.0001), 0.0, 1.0);
    if (centerRadiusPx < 0.5) {
      gl_FragColor = vec4(center.rgb, normalizedRadius);
      return;
    }

    vec2 discRadius = texel * centerRadiusPx;
    vec3 baseSum = vec3(0.0);
    float baseWeight = 0.0;
    ${gatherTapLines(BOKEH_GATHER_BASE_KERNEL, "baseTap", "baseSum", "baseWeight")}
    vec3 base = baseSum / max(baseWeight, 0.0001);

    // The fill ring lands in the base kernel's angular gaps and is composed with
    // max(), which closes ring banding at a large radius. bokehQuality gates only
    // this term: the base rings never stop running, so a camera settling no
    // longer pops depth of field into existence (§5.3, acceptance criterion 4).
    vec3 fillSum = vec3(0.0);
    float fillWeight = 0.0;
    ${gatherTapLines(BOKEH_GATHER_FILL_KERNEL, "fillTap", "fillSum", "fillWeight")}
    vec3 fill = fillSum / max(fillWeight, 0.0001);
    vec3 composed = mix(base, max(base, fill), clamp(bokehQuality, 0.0, 1.0));
    gl_FragColor = vec4(composed, normalizedRadius);
  }
`;

// Total tCoc fetches in the gather: centre + 3x3 near dilate + base + fill. The
// gate asserts this against the generated shader text so a silently added tap
// cannot escape the budget.
export const BOKEH_COC_GATHER_TEXTURE_TAP_COUNT =
  1 + BOKEH_COC_NEAR_DILATE_OFFSETS.length
  + BOKEH_GATHER_BASE_TAP_COUNT + BOKEH_GATHER_FILL_TAP_COUNT;
