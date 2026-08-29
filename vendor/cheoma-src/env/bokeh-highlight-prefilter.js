import {
  HalfFloatType,
  NearestFilter,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import {
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT,
  BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT,
  BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT,
  BOKEH_SOURCE_CONTRACT,
} from "./bokeh-source-contract.js";

function glslFloat(value) {
  const text = Number(value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

// One normalized, deterministic half-resolution gather. The downsample footprint
// turns a subpixel HDR source into continuous data before the sparse aperture
// kernel sees it. RGB stores normalized source energy; alpha encodes 0 for broad
// content, 0.25 for compact gather-removal support, and 1 for exact 2x2 source
// ownership. Source-local CoC remains a scatter concern: gather must remove a
// compact emitter from blurred destination pixels even while that emitter is in
// focus, or the target-driven gather duplicates it across the background.
function makePrefilterKernel() {
  const points = [{ x: 0, y: 0, weight: 1, broadProbe: false }];
  for (const [count, radius, broadProbe = false] of [
    [12, 1.5, false],
    [16, 3.5, false],
    [8, 9, true],
  ]) {
    const radialWeight = Math.exp(-(radius * radius) / (2 * 1.75 * 1.75));
    for (let index = 0; index < count; index++) {
      const angle = (index * Math.PI * 2) / count;
      points.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        weight: radialWeight,
        broadProbe,
      });
    }
  }
  const weightSum = points.reduce((sum, point) => sum + point.weight, 0);
  return points.map((point) => ({
    ...point,
    weight: point.weight / weightSum,
  }));
}

const PREFILTER_KERNEL = Object.freeze(makePrefilterKernel());
if (
  PREFILTER_KERNEL.length !==
  BOKEH_HIGHLIGHT_PREFILTER_ANALYTIC_TAP_COUNT
) {
  throw new Error("Bokeh prefilter analytic tap contract diverged");
}
const PREFILTER_SAMPLE_LINES = PREFILTER_KERNEL.map(
  ({ x, y, weight }, index) => {
    const uv =
      `blockCenterUv + vec2(${x.toFixed(7)}, ${y.toFixed(7)}) * sourceTexel`;
    return (
      `vec2 sourceUv${index} = ${uv};\n` +
      `    vec4 sourceSample${index} = sourceSample(sourceUv${index});\n` +
      `    float sourceRawEnergy${index} = sourceSample${index}.a;\n` +
      `    source += sourceSample${index}.rgb * ${weight.toFixed(8)};\n` +
      `    analyticPeakRawEnergy = max(` +
      `analyticPeakRawEnergy, sourceRawEnergy${index});`
    );
  },
).join("\n    ");
const BROAD_SUPPORT_LINES = PREFILTER_KERNEL.map(
  ({ broadProbe }, index) =>
    broadProbe
      ? `broadSupport += smoothstep(0.05, 0.25,` +
        ` sourceRawEnergy${index}` +
        ` / max(analyticPeakRawEnergy, 0.0001));`
      : "",
)
  .filter(Boolean)
  .join("\n    ");
const OWNERSHIP_OFFSETS = Object.freeze([
  [-0.5, -0.5],
  [0.5, -0.5],
  [-0.5, 0.5],
  [0.5, 0.5],
]);
const OWNERSHIP_SAMPLE_LINES = OWNERSHIP_OFFSETS.map(
  ([x, y], index) =>
    `float blockRawEnergy${index} = sourceSample(` +
    `blockCenterUv + vec2(${x.toFixed(1)}, ${y.toFixed(1)})` +
    ` * sourceTexel).a;`,
)
  .join("\n    ");
const GATHER_SUPPORT_OFFSETS = Object.freeze(
  [-1.5, -0.5, 0.5, 1.5].flatMap((y) =>
    [-1.5, -0.5, 0.5, 1.5].map((x) => Object.freeze([x, y])),
  ),
);
const GATHER_SUPPORT_SAMPLE_LINES = GATHER_SUPPORT_OFFSETS.map(([x, y]) => {
  const ownershipIndex = OWNERSHIP_OFFSETS.findIndex(
    ([ownershipX, ownershipY]) =>
      x === ownershipX && y === ownershipY,
  );
  const rawEnergy =
    ownershipIndex < 0
      ? `sourceSample(blockCenterUv + vec2(${x.toFixed(1)}, ${y.toFixed(
          1,
        )}) * sourceTexel).a`
      : `blockRawEnergy${ownershipIndex}`;
  return (
    "gatherSupportPeakRawEnergy = max(" +
    `gatherSupportPeakRawEnergy, ${rawEnergy});`
  );
}).join("\n    ");
if (
  OWNERSHIP_OFFSETS.length !==
    BOKEH_HIGHLIGHT_PREFILTER_OWNERSHIP_TAP_COUNT ||
  GATHER_SUPPORT_OFFSETS.length - OWNERSHIP_OFFSETS.length !==
    BOKEH_HIGHLIGHT_PREFILTER_GUARD_EXTRA_TAP_COUNT
) {
  throw new Error("Bokeh prefilter ownership/guard tap contract diverged");
}
export const BOKEH_HIGHLIGHT_PREFILTER_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  varying vec2 vUv;
  uniform sampler2D tColor;
  uniform vec2 sourceTexel;
  uniform float highlightThreshold;
  uniform float highlightKnee;

  vec4 sourceSample(vec2 uv) {
    if (any(lessThan(uv, vec2(0.0)))
      || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
    vec3 color = texture2D(tColor, uv).rgb;
    float peak = max(max(color.r, color.g), color.b);
    float gate = smoothstep(
      highlightThreshold,
      highlightThreshold + max(highlightKnee, 0.0001),
      peak
    );
    return vec4(
      color * gate,
      dot(color, vec3(0.2126, 0.7152, 0.0722))
    );
  }

  void main() {
    // Match source scatter's explicit 2x2 ownership grid. For an odd source
    // extent the last half-resolution texel owns one source texel, so the
    // ordinary render-target vUv would otherwise land half a texel inward.
    vec2 blockCenterUv = min(
      gl_FragCoord.xy * ${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize)}
        * sourceTexel,
      vec2(1.0)
    );
    vec3 source = vec3(0.0);
    float broadSupport = 0.0;
    ${OWNERSHIP_SAMPLE_LINES}
    float blockPeakRawEnergy = max(
      max(blockRawEnergy0, blockRawEnergy1),
      max(blockRawEnergy2, blockRawEnergy3)
    );
    // Only the adjacent full-resolution texel ring participates in removing
    // bilinearly gathered source energy. The analytic 37-tap footprint below
    // must not expand this encoded support into a distant halo.
    float gatherSupportPeakRawEnergy = 0.0;
    ${GATHER_SUPPORT_SAMPLE_LINES}
    float analyticPeakRawEnergy = 0.0;
    ${PREFILTER_SAMPLE_LINES}
    ${BROAD_SUPPORT_LINES}
    broadSupport /= 8.0;
    // A compact source has no authored highlight support nine source pixels
    // away. A broad field or atmospheric sprite has several such neighbours,
    // including at a soft edge where a local max/mean test gives a false peak.
    float compactSupport = (
      1.0 - step(
        ${glslFloat(BOKEH_SOURCE_CONTRACT.ownershipBroadSupportCutoff)},
        broadSupport
      )
    ) * step(
      highlightThreshold * 0.05,
      gatherSupportPeakRawEnergy
    );
    float compactOwnership = compactSupport * step(
      highlightThreshold * 0.05,
      blockPeakRawEnergy
    );
    // Exact ownership and the wider gather-removal support share alpha without
    // another render target. Their consumers use disjoint contract thresholds.
    float encodedCompact = max(
      compactOwnership
        * ${glslFloat(BOKEH_SOURCE_CONTRACT.exactOwnershipAlpha)},
      compactSupport
        * ${glslFloat(BOKEH_SOURCE_CONTRACT.gatherSupportAlpha)}
    );
    gl_FragColor = vec4(source, encodedCompact);
  }
`;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export class BokehHighlightPrefilter {
  constructor() {
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.name = "BokehPass.highlightPrefilter";
    this.uniforms = {
      tColor: { value: null },
      sourceTexel: { value: new Vector2(1, 1) },
      highlightThreshold: { value: 1.2 },
      highlightKnee: { value: 0.52 },
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: BOKEH_HIGHLIGHT_PREFILTER_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.sourceWidth = 1;
    this.sourceHeight = 1;
    this.renderCount = 0;
  }

  setSize(width, height) {
    this.sourceWidth = Math.max(1, Math.floor(width));
    this.sourceHeight = Math.max(1, Math.floor(height));
    this.target.setSize(
      Math.max(1, Math.ceil(this.sourceWidth * 0.5)),
      Math.max(1, Math.ceil(this.sourceHeight * 0.5)),
    );
    this.uniforms.sourceTexel.value.set(
      1 / this.sourceWidth,
      1 / this.sourceHeight,
    );
  }

  render(
    renderer,
    {
      colorTexture,
      threshold,
      knee,
    },
  ) {
    this.uniforms.tColor.value = colorTexture;
    this.uniforms.highlightThreshold.value = threshold;
    this.uniforms.highlightKnee.value = knee;
    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    this.renderCount++;
    return this.target.texture;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
