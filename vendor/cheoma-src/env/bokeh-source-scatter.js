import {
  AddEquation,
  CustomBlending,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  ZeroFactor,
} from "three";
import {
  BOKEH_SOURCE_CONTRACT,
  bokehSourceGridDimensions,
  selectBokehSourceBackend,
} from "./bokeh-source-contract.js";

function glslFloat(value) {
  const text = Number(value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return text.includes(".") ? text : `${text}.0`;
}

const OWNED_OFFSETS = Object.freeze(
  Array.from({ length: BOKEH_SOURCE_CONTRACT.blockSize }, (_, y) =>
    Array.from({ length: BOKEH_SOURCE_CONTRACT.blockSize }, (_, x) => [
      x + 0.5 - BOKEH_SOURCE_CONTRACT.blockSize * 0.5,
      y + 0.5 - BOKEH_SOURCE_CONTRACT.blockSize * 0.5,
    ]),
  ).flat(),
);
const VECTOR_COMPONENTS = Object.freeze(["x", "y", "z", "w"]);
// Colour, luminance, depth and peak of the four texels this primitive owns. Kept at
// function scope, and separate from the radius decision below, because the radius now
// depends on which of the four is the emitter - see DOMINANT_SOURCE_LINES.
const OWNED_SAMPLE_LINES = OWNED_OFFSETS.map(
  ([x, y], index) =>
    `vec2 ownedUv${index} = cellUv` +
    ` + vec2(${x.toFixed(1)}, ${y.toFixed(1)}) * sourceTexel;\n` +
    `    vec3 ownedSource${index} = gatedRawSource(ownedUv${index});\n` +
    `    float ownedLuminance${index} = sourceLuminance(ownedSource${index});\n` +
    `    float ownedDepth${index} = farClip;\n` +
    `    float ownedPeak${index} = 0.0;\n` +
    `    if (ownedLuminance${index} > 0.0) {\n` +
    `      ownedDepth${index} = viewDepth(ownedUv${index});\n` +
    `      ownedPeak${index} = max(max(ownedSource${index}.r,` +
    ` ownedSource${index}.g), ownedSource${index}.b);\n` +
    "    }",
).join("\n    ");
const OWNED_RADIUS_LINES = OWNED_OFFSETS.map(
  (_, index) =>
    `if (ownedLuminance${index} > 0.0) {\n` +
    `      float blockSourceDepth${index} =` +
    ` hueAligned(ownedSource${index}, dominantSource)\n` +
    "        ? dominantDepth\n" +
    `        : ownedDepth${index};\n` +
    `      float ownedRadius${index}` +
    ` = sourceRadiusAtDepth(blockSourceDepth${index});\n` +
    `      if (ownedRadius${index}` +
    ` < ${glslFloat(BOKEH_SOURCE_CONTRACT.sharpRadiusPx)}) {\n` +
    `        ownedSource${index} = vec3(0.0);\n` +
    "      } else {\n" +
    // The varying must carry the depth the radius came from, or the fragment's
    // occlusion test and the disc size disagree about where the emitter is.
    `        sourceDepths.${VECTOR_COMPONENTS[index]}` +
    ` = blockSourceDepth${index};\n` +
    `        sourceRadii.${VECTOR_COMPONENTS[index]} = ownedRadius${index};\n` +
    `        sourceNormalizations.${VECTOR_COMPONENTS[index]}` +
    ` = kernelNormalization(ownedRadius${index});\n` +
    `        sourcePeaks.${VECTOR_COMPONENTS[index]} = ownedPeak${index};\n` +
    `        maxSourceRadius = max(maxSourceRadius, ownedRadius${index});\n` +
    `        activeSourceLuminance += ownedLuminance${index};\n` +
    "      }\n" +
    "    }",
).join("\n    ");
const SOURCE_ENERGY_VARYINGS = OWNED_OFFSETS.map(
  (_, index) => `varying vec3 vSourceEnergy${index};`,
).join("\n  ");
const SOURCE_ENERGY_ASSIGN_LINES = OWNED_OFFSETS.map(
  (_, index) => `vSourceEnergy${index} = ownedSource${index};`,
).join("\n    ");
// A partial-coverage silhouette texel is the emitter's light sitting on the
// background's depth. Multisampling the scene render gave every compact emitter a
// ring of them: the resolve blends the emitter's radiance into its edge texels, but
// the depth buffer still holds whatever won the depth test there, which for a
// foreground lantern against a distant hillside is the hillside. Those texels are
// far above highlightThreshold, so they take the aperture path like any other source
// texel - at the *background's* circle of confusion. Measured on the optical chart
// that turned a 35.97px foreground disc into a 5.25px one carrying the same energy:
// a ten-times-hot compact core buried inside the emitter's own aperture image, and
// gone entirely under `?msaa=0`.
//
// So depth is elected per ownership block. The brightest owned texel is the emitter,
// and any owned texel whose colour is hue-aligned with it belongs to the same emitter
// and adopts its depth. Hue alignment alone is the right test precisely because depth
// is the quantity that is wrong: sharesSourceComponent() below requires the depths to
// agree first, so it can never repair a silhouette. Two genuinely different sources in
// one block have different hues and stay independent, which is what the same-block
// stress cases assert. No new texture, render target, uniform, varying, or program.
const DOMINANT_SOURCE_LINES = OWNED_OFFSETS.map(
  (_, index) =>
    `if (ownedPeak${index} > dominantPeak) {\n` +
    `      dominantPeak = ownedPeak${index};\n` +
    `      dominantDepth = ownedDepth${index};\n` +
    `      dominantSource = ownedSource${index};\n` +
    "    }",
).join("\n    ");
// The election has to reach one ownership block outward as well. A block whose four
// texels are *all* silhouette shoulder owns no emitter to elect, so a block-local
// election elects the shoulder itself and adopts precisely the background depth that
// is wrong. Measured: block-local election alone removed 28% of the hot core and left
// the rest at the same 5.25px background radius, and that residual field's extent is
// the wrong disc's own radius rather than the shoulder's spread - i.e. the emitter
// core is one block away, not several.
//
// The full eight-neighbour ring is consulted. Measured on the ladder: the ring is what
// closes the defect (peak residual against the profile predictor 1.163 block-local ->
// 1.104 with the four orthogonal neighbours -> 1.080 with all eight; core residual
// 0.899 -> 0.965 -> 1.000), so the diagonals are carrying real shoulder texels rather
// than padding.
//
// Note that the shoulder cannot be recognised by being dim: a texel at half coverage of
// an emitter twenty times over threshold is still ten times over it. So the ring is
// gated on brightness ordering and hue only, and the guard against over-reach is the
// short orthogonal radius rather than a luminance test. dominantSource stays the
// block's own hue so the ring cannot walk the election along a chain of gradually
// shifting colours. Colour is read for the four neighbours; depth only for one that
// actually wins, and accepted blocks are the sparse compact-HDR ones.
const NEIGHBOUR_BLOCK_OFFSETS = Object.freeze(
  [-1, 0, 1]
    .flatMap((y) => [-1, 0, 1].map((x) => [x, y]))
    .filter(([x, y]) => x !== 0 || y !== 0)
    .map(([x, y]) => [
      x * BOKEH_SOURCE_CONTRACT.blockSize,
      y * BOKEH_SOURCE_CONTRACT.blockSize,
    ]),
);
const NEIGHBOUR_ELECTION_LINES = NEIGHBOUR_BLOCK_OFFSETS.map(
  ([x, y], index) =>
    "{\n" +
    `      vec2 ringUv${index} = cellUv` +
    ` + vec2(${x.toFixed(1)}, ${y.toFixed(1)}) * sourceTexel;\n` +
    `      vec3 ringSource${index} = gatedRawSource(ringUv${index});\n` +
    `      float ringPeak${index} = max(max(ringSource${index}.r,` +
    ` ringSource${index}.g), ringSource${index}.b);\n` +
    `      if (ringPeak${index} > dominantPeak\n` +
    `        && hueAligned(ringSource${index}, dominantSource)) {\n` +
    `        dominantPeak = ringPeak${index};\n` +
    `        dominantDepth = viewDepth(ringUv${index});\n` +
    "      }\n" +
    "    }",
).join("\n    ");
const SOURCE_COMPONENT_PEAK_LINES = OWNED_OFFSETS.map(
  (_, sourceIndex) =>
    `float componentPeak${sourceIndex}` +
    ` = sourcePeaks.${VECTOR_COMPONENTS[sourceIndex]};`,
).join("\n    ");
const SOURCE_COMPONENT_PAIR_LINES = OWNED_OFFSETS.flatMap((_, sourceIndex) =>
  OWNED_OFFSETS.slice(sourceIndex + 1).map((__, peerOffset) => {
    const peerIndex = sourceIndex + peerOffset + 1;
    const sourceComponent = VECTOR_COMPONENTS[sourceIndex];
    const peerComponent = VECTOR_COMPONENTS[peerIndex];
    return (
      `if (sharesSourceComponent(ownedSource${sourceIndex},` +
      ` sourceDepths.${sourceComponent}, ownedSource${peerIndex},` +
      ` sourceDepths.${peerComponent})) {\n` +
      `      float sharedPeak${sourceIndex}${peerIndex}` +
      ` = max(sourcePeaks.${sourceComponent}, sourcePeaks.${peerComponent});\n` +
      `      componentPeak${sourceIndex}` +
      ` = max(componentPeak${sourceIndex}, sharedPeak${sourceIndex}${peerIndex});\n` +
      `      componentPeak${peerIndex}` +
      ` = max(componentPeak${peerIndex}, sharedPeak${sourceIndex}${peerIndex});\n` +
      "    }"
    );
  }),
).join("\n    ");
const SOURCE_WEIGHT_LINES = OWNED_OFFSETS.map(
  (_, sourceIndex) =>
    `vSourceWeights.${VECTOR_COMPONENTS[sourceIndex]} = smoothstep(\n` +
    "      highlightThreshold,\n" +
    // Compact ownership has already rejected ordinary surfaces. Keep only a
    // narrow acceptance shoulder here so a real source becomes one optical disc
    // instead of retaining a hot pin at its centre.
    "      highlightThreshold + max(highlightKnee * 0.25, 0.0001),\n" +
    `      componentPeak${sourceIndex}\n` +
    "    );",
).join("\n    ");
const SOURCE_DISTANCE_LINES = OWNED_OFFSETS.map(
  ([x, y], index) => {
    const component = VECTOR_COMPONENTS[index];
    return (
      `if (vSourceRadii.${component} > 0.0) {\n` +
      `      sourceDistances.${component} = length(destinationPixel` +
      ` - (vCellPixel + vec2(${x.toFixed(1)}, ${y.toFixed(1)})));\n` +
      `      hasApertureSupport = hasApertureSupport` +
      ` || sourceDistances.${component} <= vSourceRadii.${component} + 0.5;\n` +
      "    }"
    );
  },
).join("\n    ");
const SOURCE_PROFILE_LINES = OWNED_OFFSETS.map(
  (_, index) =>
    `if (vSourceRadii.${VECTOR_COMPONENTS[index]} > 0.0) {\n` +
    `      float sourceDistance${index}` +
    ` = sourceDistances.${VECTOR_COMPONENTS[index]};\n` +
    `      bool acceptsSource${index} =` +
    ` vSourceDepths.${VECTOR_COMPONENTS[index]}` +
    " <= destinationDepth + depthEpsilon;\n" +
    `      if (!acceptsSource${index}` +
    ` && sharesDepthLayer(vSourceDepths.${VECTOR_COMPONENTS[index]},` +
    " destinationDepth)) {\n" +
    "        if (destinationPeak < 0.0) {\n" +
    "          destinationColor = texture2D(tColor, destinationUv).rgb;\n" +
    "          destinationPeak = max(max(destinationColor.r," +
    " destinationColor.g), destinationColor.b);\n" +
    "          vec2 destinationBlock = floor(" +
    "(gl_FragCoord.xy - vec2(0.5)) / " +
    `${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize)});\n` +
    "          vec2 destinationOwnershipUv =" +
    " (destinationBlock + vec2(0.5)) / gridSize;\n" +
    "          destinationCompact = step(" +
    `${glslFloat(BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff)},` +
    " texture2D(tSource, destinationOwnershipUv).a);\n" +
    "        }\n" +
    `        acceptsSource${index} = destinationCompact > 0.5` +
    " && destinationPeak >= highlightThreshold * 0.05" +
    ` && hueAligned(vSourceEnergy${index}, destinationColor);\n` +
    "      }\n" +
    `      if (acceptsSource${index}) {\n` +
    `      float identityWeight${index} = 1.0` +
    ` - step(0.5, sourceDistance${index});\n` +
    `      float apertureWeight${index} = rawProfile(sourceDistance${index},` +
    ` vSourceRadii.${VECTOR_COMPONENTS[index]})` +
    ` / vSourceNormalizations.${VECTOR_COMPONENTS[index]};\n` +
    `      float replacementWeight${index} = mix(identityWeight${index},` +
    ` apertureWeight${index}, vSourceWeights.${VECTOR_COMPONENTS[index]});\n` +
    `      scatteredEnergy += vSourceEnergy${index}` +
    ` * replacementWeight${index};\n` +
    "      }\n" +
    "    }",
).join("\n    ");
// The sub-seven-pixel branch sums this lattice because the continuous integral is
// wrong by more than a percent there, and summing it is what makes a sub-pixel disc
// degenerate exactly to the source's own texel. bokehSourceKernelNormalization() in
// bokeh-source-contract.js is the JS twin of this whole normalisation, so a gate can
// predict the rendered profile without a renderer.
const LATTICE_RADIUS = 7;
const latticeDistanceCounts = new Map();
for (let y = -LATTICE_RADIUS; y <= LATTICE_RADIUS; y++) {
  for (let x = -LATTICE_RADIUS; x <= LATTICE_RADIUS; x++) {
    const distanceSquared = x * x + y * y;
    latticeDistanceCounts.set(
      distanceSquared,
      (latticeDistanceCounts.get(distanceSquared) || 0) + 1,
    );
  }
}
const DISCRETE_NORMALIZATION_LINES = [...latticeDistanceCounts]
  .sort(([a], [b]) => a - b)
  .map(
    ([distanceSquared, count]) =>
      `discreteNormalization += ${glslFloat(count)} * rawProfile(` +
      `${glslFloat(Math.sqrt(distanceSquared))}, radiusPx);`,
  )
  .join("\n    ");
export const BOKEH_SCATTER_VERTEX_SHADER = /* glsl */ `
  #include <common>
  #include <packing>

  uniform sampler2D tSource;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 sourceTexel;
  uniform vec2 gridSize;
  uniform vec2 viewportSize;
  uniform float focus;
  uniform float cocScalePx;
  uniform float maxCocPx;
  uniform float nearClip;
  uniform float farClip;
  uniform float radiusScale;
  uniform float viewportWidth;
  uniform float highlightThreshold;
  uniform float highlightKnee;
  uniform float triangleBackend;
  uniform float tiltStrength;
  uniform float tiltAnchorV;

  // Inverse focus at this primitive's own screen height. Tilt makes the plane of
  // focus a ramp across the frame (bokeh-coc-contract.js), so a source near the top
  // of the frame and one near the bottom are on different sides of it. Held as an
  // inverse and as a cell-local global: a strong tilt sends the plane through
  // infinity, which the inverse form passes through and a focus distance cannot.
  float gInvFocus = 0.0;

  ${SOURCE_ENERGY_VARYINGS}
  varying float vInvFocus;
  varying vec4 vSourceDepths;
  varying vec4 vSourceRadii;
  varying vec4 vSourceNormalizations;
  varying vec4 vSourceWeights;
  varying vec2 vCellPixel;

  float sourceLuminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  float rawProfile(float distancePx, float radiusPx) {
    float coverage = 1.0 - smoothstep(
      max(radiusPx - 0.5, 0.0),
      radiusPx + 0.5,
      distancePx
    );
    float radial = min(distancePx / max(radiusPx, 0.0001), 1.0);
    float radial2 = radial * radial;
    float radial4 = radial2 * radial2;
    float radial12 = radial4 * radial4 * radial4;
    return coverage * (
      ${glslFloat(BOKEH_SOURCE_CONTRACT.profileCore)}
      + ${glslFloat(BOKEH_SOURCE_CONTRACT.profileRim)} * radial12
    );
  }

  float kernelNormalization(float radiusPx) {
    float continuousNormalization =
      3.141592653589793 * radiusPx * radiusPx
      * ${glslFloat(BOKEH_SOURCE_CONTRACT.profileIntegral)};
    if (radiusPx >= 7.0) {
      return max(continuousNormalization, 0.0001);
    }
    float discreteNormalization = 0.0;
    ${DISCRETE_NORMALIZATION_LINES}
    return max(
      mix(
        discreteNormalization,
        continuousNormalization,
        smoothstep(6.0, 7.0, radiusPx)
      ),
      0.0001
    );
  }

  // The same thin-lens CoC the surface gather and the composite evaluate
  // (bokeh-coc-contract.js). Sharing the curve is what keeps a lantern and the
  // wall behind it agreeing about how defocused they are; the former linear
  // (focus - z) * aperture had no perspective falloff and no near/far
  // asymmetry, so the two images drifted apart with distance.
  //
  // radiusScale is a deliberate source-only multiplier on top of the physical
  // radius, not part of the optics: a bright compact emitter keeps the larger
  // disc the eye expects of a point light, and it holds the existing lantern
  // bokeh and the point-size-cap fallback in their current regime.
  // docs/dof-cinematic-research.md sections 4.3 and 8.
  float sourceRadiusAtDepth(float sourceDepth) {
    float signedCoc =
      cocScalePx * (gInvFocus - 1.0 / max(sourceDepth, nearClip));
    return min(abs(signedCoc), maxCocPx) * radiusScale;
  }

  float viewDepth(vec2 uv) {
    float packedDepth = unpackRGBAToDepth(texture2D(tDepth, uv));
    return -perspectiveDepthToViewZ(packedDepth, nearClip, farClip);
  }

  float compactWeight(vec2 uv) {
    return step(
      ${glslFloat(BOKEH_SOURCE_CONTRACT.exactOwnershipCutoff)},
      texture2D(tSource, uv).a
    );
  }

  bool sharesDepthLayer(float firstDepth, float secondDepth) {
    // sign(focus - d) == sign(1/d - invFocus), so the optical-side test is the same
    // one it always was, only evaluated against the tilted plane at this cell.
    float signedSide =
      (1.0 / max(firstDepth, nearClip) - gInvFocus)
      * (1.0 / max(secondDepth, nearClip) - gInvFocus);
    float relativeDepthTolerance =
      max(0.02, min(firstDepth, secondDepth) * 0.005);
    return signedSide >= 0.0
      && abs(firstDepth - secondDepth) <= relativeDepthTolerance;
  }

  // Same test the fragment stage applies to a destination colour. Two texels of one
  // emitter agree on hue even when a multisample resolve has scaled one of them down,
  // which is what lets the depth election below recognise a silhouette texel.
  bool hueAligned(vec3 firstSource, vec3 secondSource) {
    float hueDot = dot(firstSource, secondSource);
    return hueDot > 0.0
      && hueDot * hueDot
        >= 0.990025 * dot(firstSource, firstSource)
          * dot(secondSource, secondSource);
  }

  bool sharesSourceComponent(
    vec3 firstSource,
    float firstDepth,
    vec3 secondSource,
    float secondDepth
  ) {
    float firstPeak = max(max(firstSource.r, firstSource.g), firstSource.b);
    float secondPeak = max(max(secondSource.r, secondSource.g), secondSource.b);
    if (min(firstPeak, secondPeak) <= 0.0) return false;
    return hueAligned(firstSource, secondSource)
      && sharesDepthLayer(firstDepth, secondDepth);
  }

  vec3 gatedRawSource(vec2 uv) {
    if (any(lessThan(uv, vec2(0.0)))
      || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
    vec3 color = texture2D(tColor, uv).rgb;
    float peak = max(max(color.r, color.g), color.b);
    // The sparse prefilter has already accepted this exact 2x2 block because at
    // least one texel crossed the real HDR threshold. Keep the source's dim
    // antialiased shoulder attached to that core for energy conservation.
    vec3 gatedSource = color * step(highlightThreshold * 0.05, peak);
    return gatedSource;
  }

  void rejectVertex() {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  void main() {
    int gridColumns = int(gridSize.x);
    int column = gl_InstanceID % gridColumns;
    int row = gl_InstanceID / gridColumns;
    vec2 cellIndex = vec2(float(column), float(row));
    vec2 cellPixel = min(cellIndex * ${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize)}
      + ${glslFloat(BOKEH_SOURCE_CONTRACT.blockSize * 0.5)}, viewportSize);
    vec2 cellUv = cellPixel / viewportSize;
    gInvFocus = (1.0 / focus) * (1.0 + tiltStrength * (cellUv.y - tiltAnchorV));
    vInvFocus = gInvFocus;
    // One nearest-filtered half-resolution ownership texel maps exactly to this
    // 2x2 source block. Reject empty blocks before any full-resolution color or
    // depth reads; only sparse compact emitters pay the four-texel work.
    if (compactWeight(cellUv) < 0.5) {
      rejectVertex();
      return;
    }
    vec4 sourceDepths = vec4(farClip);
    vec4 sourceRadii = vec4(0.0);
    vec4 sourceNormalizations = vec4(1.0);
    vec4 sourcePeaks = vec4(0.0);
    float maxSourceRadius = 0.0;
    float activeSourceLuminance = 0.0;
    ${OWNED_SAMPLE_LINES}
    float dominantPeak = 0.0;
    float dominantDepth = farClip;
    vec3 dominantSource = vec3(0.0);
    ${DOMINANT_SOURCE_LINES}
    ${NEIGHBOUR_ELECTION_LINES}
    ${OWNED_RADIUS_LINES}
    ${SOURCE_COMPONENT_PEAK_LINES}
    ${SOURCE_COMPONENT_PAIR_LINES}
    ${SOURCE_WEIGHT_LINES}
    if (activeSourceLuminance <= 0.0) {
      rejectVertex();
      return;
    }
    float pointRadiusPx = maxSourceRadius + 1.0;
    float triangleRadiusPx = maxSourceRadius + 1.2071067812;

    // Each primitive owns four disjoint full-resolution source texels and
    // evaluates their shifted aperture profiles in the fragment shader.
    ${SOURCE_ENERGY_ASSIGN_LINES}
    vSourceDepths = sourceDepths;
    vSourceRadii = sourceRadii;
    vSourceNormalizations = sourceNormalizations;
    vCellPixel = cellPixel;
    gl_PointSize = pointRadiusPx
      * ${glslFloat(BOKEH_SOURCE_CONTRACT.pointCoverage)};
    vec2 triangleClipOffset = position.xy * triangleRadiusPx
      * vec2(2.0 / viewportSize.x, 2.0 / viewportSize.y)
      * step(0.5, triangleBackend);
    gl_Position = vec4(cellUv * 2.0 - 1.0 + triangleClipOffset, 0.0, 1.0);
  }
`;

export const BOKEH_SCATTER_FRAGMENT_SHADER = /* glsl */ `
  #include <common>
  #include <packing>

  uniform sampler2D tSource;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 viewportSize;
  uniform vec2 gridSize;
  uniform float nearClip;
  uniform float farClip;
  uniform float highlightThreshold;
  ${SOURCE_ENERGY_VARYINGS}
  varying float vInvFocus;
  varying vec4 vSourceDepths;
  varying vec4 vSourceRadii;
  varying vec4 vSourceNormalizations;
  varying vec4 vSourceWeights;
  varying vec2 vCellPixel;

  float rawProfile(float distancePx, float radiusPx) {
    float coverage = 1.0 - smoothstep(
      max(radiusPx - 0.5, 0.0),
      radiusPx + 0.5,
      distancePx
    );
    float radial = min(distancePx / max(radiusPx, 0.0001), 1.0);
    float radial2 = radial * radial;
    float radial4 = radial2 * radial2;
    float radial12 = radial4 * radial4 * radial4;
    return coverage * (
      ${glslFloat(BOKEH_SOURCE_CONTRACT.profileCore)}
      + ${glslFloat(BOKEH_SOURCE_CONTRACT.profileRim)} * radial12
    );
  }

  bool sharesDepthLayer(float sourceDepth, float destinationDepth) {
    // Same identity as the vertex stage: sign(focus - d) == sign(1/d - invFocus).
    // vInvFocus is the tilted plane at the primitive's cell, so a destination texel
    // is judged against the plane the source itself was measured against.
    float signedSide =
      (1.0 / max(sourceDepth, nearClip) - vInvFocus)
      * (1.0 / max(destinationDepth, nearClip) - vInvFocus);
    float relativeDepthTolerance =
      max(0.02, min(sourceDepth, destinationDepth) * 0.005);
    return signedSide >= 0.0
      && abs(sourceDepth - destinationDepth) <= relativeDepthTolerance;
  }

  bool hueAligned(vec3 sourceColor, vec3 destinationColor) {
    float hueDot = dot(sourceColor, destinationColor);
    return hueDot > 0.0
      && hueDot * hueDot
        >= 0.990025 * dot(sourceColor, sourceColor)
          * dot(destinationColor, destinationColor);
  }

  void main() {
    vec2 destinationPixel = gl_FragCoord.xy;
    vec4 sourceDistances = vec4(1e20);
    bool hasApertureSupport = false;
    ${SOURCE_DISTANCE_LINES}
    // Point and triangle primitives circumscribe the circular aperture. Skip
    // their unsupported corners before the destination depth texture fetch.
    if (!hasApertureSupport) discard;

    vec2 destinationUv = gl_FragCoord.xy / viewportSize;
    float packedDepth = unpackRGBAToDepth(texture2D(tDepth, destinationUv));
    float destinationDepth = -perspectiveDepthToViewZ(
      packedDepth,
      nearClip,
      farClip
    );
    float depthEpsilon = max(0.01, destinationDepth * 0.0001);

    vec3 destinationColor = vec3(0.0);
    float destinationPeak = -1.0;
    float destinationCompact = 0.0;
    vec3 scatteredEnergy = vec3(0.0);
    ${SOURCE_PROFILE_LINES}
    if (max(max(scatteredEnergy.r, scatteredEnergy.g), scatteredEnergy.b)
      <= 0.0) discard;
    gl_FragColor = vec4(scatteredEnergy, 0.0);
  }
`;

function makeInstancedGeometry(positions) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.instanceCount = 0;
  return geometry;
}

/**
 * Source-driven compact bokeh splats. The caller owns all textures and the
 * destination; this class adds one program/draw and owns no render target.
 */
export class BokehSourceScatter {
  constructor() {
    this.uniforms = {
      tSource: { value: null },
      tColor: { value: null },
      tDepth: { value: null },
      sourceTexel: { value: new Vector2(1, 1) },
      gridSize: { value: new Vector2(1, 1) },
      viewportSize: { value: new Vector2(1, 1) },
      focus: { value: 100 },
      cocScalePx: { value: 0 },
      maxCocPx: { value: 0 },
      nearClip: { value: 0.1 },
      farClip: { value: 2000 },
      radiusScale: { value: 1.55 },
      viewportWidth: { value: 1 },
      highlightThreshold: { value: 1.2 },
      highlightKnee: { value: 0.52 },
      triangleBackend: { value: 0 },
      tiltStrength: { value: 0 },
      tiltAnchorV: { value: 0.5 },
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: BOKEH_SCATTER_VERTEX_SHADER,
      fragmentShader: BOKEH_SCATTER_FRAGMENT_SHADER,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.pointGeometry = makeInstancedGeometry([0, 0, 0]);
    // One counter-clockwise triangle circumscribes the unit aperture disc.
    // It is only rendered when the device point-size cap cannot contain the
    // requested circle of confusion.
    this.triangleGeometry = makeInstancedGeometry([
      0,
      2,
      0,
      -Math.sqrt(3),
      -1,
      0,
      Math.sqrt(3),
      -1,
      0,
    ]);
    this.points = new Points(this.pointGeometry, this.material);
    this.points.frustumCulled = false;
    this.triangles = new Mesh(this.triangleGeometry, this.material);
    this.triangles.frustumCulled = false;
    this.triangles.visible = false;
    this.scene = new Scene();
    this.scene.add(this.points);
    this.scene.add(this.triangles);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.width = 0;
    this.height = 0;
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.vertexCount = 0;
    this.renderCount = 0;
    this.backend = "points";
    this.pointSizeRange = null;
    this.requiredPointDiameter = 0;
  }

  setSize(width, height) {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    this.uniforms.viewportSize.value.set(nextWidth, nextHeight);
    this.uniforms.viewportWidth.value = nextWidth;
    if (nextWidth === this.width && nextHeight === this.height) return;
    const grid = bokehSourceGridDimensions(nextWidth, nextHeight);
    this.width = nextWidth;
    this.height = nextHeight;
    this.gridWidth = grid.columns;
    this.gridHeight = grid.rows;
    this.vertexCount = grid.columns * grid.rows;
    this.pointGeometry.instanceCount = this.vertexCount;
    this.triangleGeometry.instanceCount = this.vertexCount;
    this.uniforms.gridSize.value.set(grid.columns, grid.rows);
    this.uniforms.sourceTexel.value.set(1 / nextWidth, 1 / nextHeight);
  }

  _selectBackend(renderer, maxCocPx, radiusScale) {
    if (!this.pointSizeRange) {
      const range = renderer
        .getContext()
        .getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE);
      this.pointSizeRange = [range[0], range[1]];
    }
    // The largest disc a source can ever spend is the clamped CoC times the
    // source multiplier. This is now an absolute pixel bound rather than a
    // product of maxblur and viewport width, so it no longer grows with a wider
    // window at a fixed height.
    this.requiredPointDiameter =
      (maxCocPx * radiusScale + 1.0) * BOKEH_SOURCE_CONTRACT.pointCoverage;
    const nextBackend = selectBokehSourceBackend(
      this.backend,
      this.requiredPointDiameter,
      this.pointSizeRange[1],
    );
    if (this.backend !== nextBackend) {
      this.backend = "triangles";
      this.points.visible = false;
      this.triangles.visible = true;
      this.uniforms.triangleBackend.value = 1;
    }
  }

  render(
    renderer,
    destination,
    sourceTexture,
    colorTexture,
    depthTexture,
    camera,
    focus,
    cocScalePx,
    maxCocPx,
    radiusScale,
    highlightThreshold,
    highlightKnee,
    // Trailing and defaulted: the scatter stays callable with the untilted
    // signature that the source-stress harness and the pre-tilt gates use.
    tiltStrength = 0,
    tiltAnchorV = 0.5,
  ) {
    this.uniforms.tSource.value = sourceTexture;
    this.uniforms.tColor.value = colorTexture;
    this.uniforms.tDepth.value = depthTexture;
    this.uniforms.focus.value = focus;
    this.uniforms.cocScalePx.value = cocScalePx;
    this.uniforms.maxCocPx.value = maxCocPx;
    this.uniforms.nearClip.value = camera.near;
    this.uniforms.farClip.value = camera.far;
    this.uniforms.radiusScale.value = radiusScale;
    this.uniforms.highlightThreshold.value = highlightThreshold;
    this.uniforms.highlightKnee.value = highlightKnee;
    this.uniforms.tiltStrength.value = tiltStrength;
    this.uniforms.tiltAnchorV.value = tiltAnchorV;
    this._selectBackend(renderer, maxCocPx, radiusScale);
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(destination);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
    this.renderCount++;
  }

  dispose() {
    this.pointGeometry.dispose();
    this.triangleGeometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
    this.scene.remove(this.triangles);
  }
}
