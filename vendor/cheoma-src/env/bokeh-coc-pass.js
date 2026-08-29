// Half-resolution circle-of-confusion prefilter + gather.
//
// docs/dof-cinematic-research.md §4: buy radius with resolution, not with taps.
// Two new programs replace pmndrs' five-pass structure because shader program
// count, not bandwidth, is this project's tracked budget (a transition hitch here
// is a program link stall). The packed depth prepass, the full-resolution
// composite slot, and the source scatter are all reused unchanged.
//
//   pass A  BokehCocPrefilter  half-res, 1 draw
//           RGB = 2x2 downsampled colour with the transferred HDR source removed
//           A   = signed CoC, encoded (see bokeh-coc-contract.js)
//   pass B  BokehCocGather     half-res, 1 draw
//           RGB = disc gather, base rings always live + max()-composed fill ring
//           A   = the radius actually spent, normalized, incl. near dilation
//
// Both targets are allocated on first render, never in the constructor: the
// aerial camera runs at amount 0 with the pass disabled and must not pay for a
// render target it will not sample (§4.6 criterion 5).
import {
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import {
  BOKEH_COC_DEFAULTS,
} from "./bokeh-coc-contract.js";
import {
  BOKEH_COC_GATHER_FRAGMENT_SHADER,
  BOKEH_COC_GATHER_TEXTURE_TAP_COUNT,
  BOKEH_COC_PREFILTER_BLOCK_TAP_COUNT,
  BOKEH_COC_PREFILTER_FRAGMENT_SHADER,
  BOKEH_COC_NEAR_DILATE_OFFSETS,
  BOKEH_COC_VERTEX_SHADER,
} from "./bokeh-coc-shaders.js";

export class BokehCocPass {
  constructor({ depthPacking = 1, perspectiveCamera = 1 } = {}) {
    this.cocTarget = null;
    this.gatherTarget = null;
    this.width = 1;
    this.height = 1;
    this.gatherScale = BOKEH_COC_DEFAULTS.gatherScale;
    this.renderCount = 0;

    this.cocUniforms = {
      tColor: { value: null },
      tDepth: { value: null },
      tHighlight: { value: null },
      sourceTexel: { value: new Vector2(1, 1) },
      focus: { value: 60 },
      nearClip: { value: 0.1 },
      farClip: { value: 2000 },
      cocScalePx: { value: 0 },
      maxCocPx: { value: 0 },
      tiltStrength: { value: 0 },
      tiltAnchorV: { value: 0.5 },
      highlightThreshold: { value: 1.2 },
      bokehSourceScatter: { value: 0 },
    };
    this.cocMaterial = new ShaderMaterial({
      defines: {
        DEPTH_PACKING: depthPacking,
        PERSPECTIVE_CAMERA: perspectiveCamera,
      },
      uniforms: this.cocUniforms,
      vertexShader: BOKEH_COC_VERTEX_SHADER,
      fragmentShader: BOKEH_COC_PREFILTER_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.cocQuad = new FullScreenQuad(this.cocMaterial);

    this.gatherUniforms = {
      tCoc: { value: null },
      texel: { value: new Vector2(1, 1) },
      maxCocPx: { value: 0 },
      bokehQuality: { value: 1 },
    };
    this.gatherMaterial = new ShaderMaterial({
      uniforms: this.gatherUniforms,
      vertexShader: BOKEH_COC_VERTEX_SHADER,
      fragmentShader: BOKEH_COC_GATHER_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.gatherQuad = new FullScreenQuad(this.gatherMaterial);
  }

  get allocated() {
    return !!this.cocTarget && !!this.gatherTarget;
  }

  get targetWidth() {
    return Math.max(1, Math.ceil(this.width * this.gatherScale));
  }

  get targetHeight() {
    return Math.max(1, Math.ceil(this.height * this.gatherScale));
  }

  setSize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.cocUniforms.sourceTexel.value.set(1 / this.width, 1 / this.height);
    this.gatherUniforms.texel.value.set(
      1 / this.targetWidth,
      1 / this.targetHeight,
    );
    // Resize only what already exists; a session that never focuses must not
    // allocate a target here.
    this.cocTarget?.setSize(this.targetWidth, this.targetHeight);
    this.gatherTarget?.setSize(this.targetWidth, this.targetHeight);
  }

  _allocate() {
    if (this.allocated) return;
    const options = {
      type: HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.cocTarget = new WebGLRenderTarget(
      this.targetWidth,
      this.targetHeight,
      { ...options, minFilter: NearestFilter, magFilter: NearestFilter },
    );
    this.cocTarget.texture.name = "BokehPass.coc";
    // The full-resolution composite samples the gather bilinearly, which is what
    // turns a half-resolution disc into a smooth full-resolution one.
    this.gatherTarget = new WebGLRenderTarget(
      this.targetWidth,
      this.targetHeight,
      { ...options, minFilter: LinearFilter, magFilter: LinearFilter },
    );
    this.gatherTarget.texture.name = "BokehPass.cocGather";
  }

  render(
    renderer,
    {
      colorTexture,
      depthTexture,
      highlightTexture,
      focus,
      nearClip,
      farClip,
      cocScalePx,
      maxCocPx,
      tiltStrength,
      tiltAnchorV,
      highlightThreshold,
      sourceScatter,
      bokehQuality,
    },
  ) {
    this._allocate();
    this.cocUniforms.tColor.value = colorTexture;
    this.cocUniforms.tDepth.value = depthTexture;
    this.cocUniforms.tHighlight.value = highlightTexture;
    this.cocUniforms.focus.value = focus;
    this.cocUniforms.nearClip.value = nearClip;
    this.cocUniforms.farClip.value = farClip;
    this.cocUniforms.cocScalePx.value = cocScalePx;
    this.cocUniforms.maxCocPx.value = maxCocPx;
    this.cocUniforms.tiltStrength.value = tiltStrength || 0;
    this.cocUniforms.tiltAnchorV.value =
      Number.isFinite(tiltAnchorV) ? tiltAnchorV : 0.5;
    this.cocUniforms.highlightThreshold.value = highlightThreshold;
    this.cocUniforms.bokehSourceScatter.value = sourceScatter ? 1 : 0;
    this.gatherUniforms.tCoc.value = this.cocTarget.texture;
    this.gatherUniforms.maxCocPx.value = maxCocPx;
    this.gatherUniforms.bokehQuality.value = bokehQuality;

    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.cocTarget);
      this.cocQuad.render(renderer);
      renderer.setRenderTarget(this.gatherTarget);
      this.gatherQuad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    this.renderCount++;
    return this.gatherTarget.texture;
  }

  debugTapBudget() {
    return {
      textureTaps: BOKEH_COC_GATHER_TEXTURE_TAP_COUNT,
      nearDilate: BOKEH_COC_NEAR_DILATE_OFFSETS.length,
      block: BOKEH_COC_PREFILTER_BLOCK_TAP_COUNT,
    };
  }

  dispose() {
    this.cocTarget?.dispose();
    this.gatherTarget?.dispose();
    this.cocTarget = null;
    this.gatherTarget = null;
    this.cocMaterial.dispose();
    this.gatherMaterial.dispose();
    this.cocQuad.dispose();
    this.gatherQuad.dispose();
  }
}
