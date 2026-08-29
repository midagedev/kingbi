import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { MeshDepthMaterial, NoBlending, RGBADepthPacking } from "three";
import { contributesDofDepth, dofDepthMaterialForObject } from "./dof.js";
import {
  CIRCULAR_BOKEH_COMPOSITE_TAP_COUNT,
  CIRCULAR_BOKEH_DEFAULTS,
  installCircularBokeh,
} from "./circular-bokeh-shader.js";
import {
  BOKEH_COC_DEFAULTS,
  BOKEH_GATHER_BASE_TAP_COUNT,
  BOKEH_GATHER_TAP_COUNT,
  bokehCocScalePx,
  bokehFarAsymptotePx,
  bokehLongFocusApertureMeters,
  bokehMaxCocPx,
  bokehTiltAnchorV,
  bokehTiltFarAsymptoteHeadroom,
} from "./bokeh-coc-contract.js";
import { BokehCocPass } from "./bokeh-coc-pass.js";
import { BokehHighlightPrefilter } from "./bokeh-highlight-prefilter.js";
import { BokehSourceScatter } from "./bokeh-source-scatter.js";
import {
  INST_FADE_PROGRAM_VERSION,
  patchInstFadeShader,
} from "./inst-fade-shader.js";
import {
  hasLodScreenDoor,
  LOD_SCREEN_DOOR_PROGRAM_VERSION,
  patchLodScreenDoorMaterial,
} from "../render/lod-screen-door.js";

function createInstFadeDepthMaterial() {
  const material = new MeshDepthMaterial();
  material.depthPacking = RGBADepthPacking;
  material.blending = NoBlending;
  // WebGLRenderer only substitutes materials whose allowOverride is true. This one must survive
  // BokehPass's scene override so instFade can cut the same screen-door holes as the color pass.
  material.allowOverride = false;
  material.onBeforeCompile = (shader) => {
    patchInstFadeShader(shader);
  };
  material.customProgramCacheKey = () =>
    `cheoma-dof-depth|${INST_FADE_PROGRAM_VERSION}`;
  return material;
}

function createLodScreenDoorDepthMaterial() {
  const material = new MeshDepthMaterial();
  material.depthPacking = RGBADepthPacking;
  material.blending = NoBlending;
  material.allowOverride = false;
  patchLodScreenDoorMaterial(material);
  material.customProgramCacheKey = () =>
    `cheoma-dof-depth|${LOD_SCREEN_DOOR_PROGRAM_VERSION}`;
  return material;
}

/**
 * BokehPass whose depth prepass contains only opaque depth contributors.
 * The stock pass uses one opaque override material for the entire scene, which
 * otherwise turns drifting particles, smoke, clouds, and overlays into fake depth.
 */
export class StableBokehPass extends BokehPass {
  constructor(scene, camera, params) {
    super(scene, camera, params);
    installCircularBokeh(this.materialBokeh, params?.bokeh);
    // The gather owns the aperture image; the composite is a fixed 4 fetches.
    // Base rings run in every state, so the tap budget no longer collapses
    // during camera motion (docs/dof-cinematic-research.md §5.3).
    this.bokehSampleCount = BOKEH_GATHER_TAP_COUNT;
    this.compositeTapCount = CIRCULAR_BOKEH_COMPOSITE_TAP_COUNT;
    this.apertureMeters =
      params?.bokeh?.apertureMeters ?? CIRCULAR_BOKEH_DEFAULTS.apertureMeters;
    this.maxCocFraction =
      params?.bokeh?.maxCocFraction ?? CIRCULAR_BOKEH_DEFAULTS.maxCocFraction;
    this.effectiveApertureMeters = 0;
    this.cocScalePx = 0;
    this.maxCocPx = 0;
    // Tilt-shift plane of focus. `tiltStrength` is the authored dial; the value
    // actually pushed to the three programs is scaled by the same dofAmount ramp
    // the aperture uses, so an aerial frame at amount 0 has no tilt either and a
    // dolly-in grows the tilt continuously instead of switching it on.
    this.tiltStrength =
      params?.bokeh?.tiltStrength ?? BOKEH_COC_DEFAULTS.tiltStrength;
    this.tiltAnchorV = 0.5;
    this.depthExcludedCount = 0;
    this.depthDitheredCount = 0;
    this.instFadeDepthCount = 0;
    this.lodScreenDoorDepthCount = 0;
    this.sourceDepthMaterialCount = 0;
    this._hiddenForDepth = [];
    this._materialsForDepth = [];
    this._instFadeDepthMaterial = createInstFadeDepthMaterial();
    this._lodScreenDoorDepthMaterial = createLodScreenDoorDepthMaterial();
    this.highlightPrefilter = new BokehHighlightPrefilter();
    this.uniforms.tHighlight.value = this.highlightPrefilter.target.texture;
    // Mirror BokehPass's own depth/camera defines so the CoC prefilter linearizes
    // depth identically instead of forking a second program family.
    this._cocPass = new BokehCocPass({
      depthPacking: this.materialBokeh.defines?.DEPTH_PACKING ?? 1,
      perspectiveCamera: this.materialBokeh.defines?.PERSPECTIVE_CAMERA ?? 1,
    });
    this._sourceScatter = new BokehSourceScatter();
    this._sourceScatterEnabled = true;
    this._width = 1;
    this._height = 1;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const hidden = this._hiddenForDepth;
    const materials = this._materialsForDepth;
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    hidden.length = 0;
    materials.length = 0;
    let instFadeDepthCount = 0;
    let lodScreenDoorDepthCount = 0;
    let sourceDepthMaterialCount = 0;
    // Match WebGLRenderer's effective visibility. A visible child beneath a hidden
    // group cannot reach either pass, so walking that subtree only burns CPU and
    // can inflate the diagnostic counts in large village scenes.
    this.scene.traverseVisible((object) => {
      const renderable =
        object.isMesh || object.isPoints || object.isLine || object.isSprite;
      const sourceDepthMaterial = renderable
        ? dofDepthMaterialForObject(object)
        : null;
      const contributes =
        !!sourceDepthMaterial || (renderable && contributesDofDepth(object));
      if (renderable && !contributes) hidden.push(object);
      if (sourceDepthMaterial) {
        // This material has allowOverride=false and therefore preserves the
        // source primitive's exact vertex size and fragment silhouette while
        // the rest of the scene uses BokehPass's packed MeshDepthMaterial.
        materials.push(object, object.material, sourceDepthMaterial);
        sourceDepthMaterialCount++;
      } else if (
        contributes &&
        object.isMesh &&
        object.geometry?.getAttribute?.("instFade")
      ) {
        materials.push(object, object.material, this._instFadeDepthMaterial);
        instFadeDepthCount++;
      } else if (contributes && object.isMesh && hasLodScreenDoor(object)) {
        materials.push(
          object,
          object.material,
          this._lodScreenDoorDepthMaterial,
        );
        lodScreenDoorDepthCount++;
      }
    });
    for (const object of hidden) object.visible = false;
    for (let i = 0; i < materials.length; i += 3)
      materials[i].material = materials[i + 2];
    this.depthExcludedCount = hidden.length;
    this.depthDitheredCount = instFadeDepthCount + lodScreenDoorDepthCount;
    this.instFadeDepthCount = instFadeDepthCount;
    this.lodScreenDoorDepthCount = lodScreenDoorDepthCount;
    this.sourceDepthMaterialCount = sourceDepthMaterialCount;
    // BokehPass clears its packed-depth target to white (far). A Scene Color background would
    // immediately clear over that with arbitrary RGB, which unpackRGBAToDepth interprets as a
    // time/weather-dependent fake distance. Keep sky pixels at the deliberate far-depth clear.
    this.scene.background = null;
    try {
      this._renderWithHighlightPrefilter(renderer, writeBuffer, readBuffer);
    } finally {
      this.scene.overrideMaterial = previousOverride;
      this.scene.background = previousBackground;
      for (let i = 0; i < materials.length; i += 3)
        materials[i].material = materials[i + 1];
      for (const object of hidden) object.visible = true;
      hidden.length = 0;
      materials.length = 0;
    }
  }

  _renderWithHighlightPrefilter(renderer, writeBuffer, readBuffer) {
    this.scene.overrideMaterial = this._materialDepth;
    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setClearColor(0xffffff);
      renderer.setClearAlpha(1);
      renderer.setRenderTarget(this._renderTargetDepth);
      renderer.clear();
      renderer.render(this.scene, this.camera);

      this.uniforms.tHighlight.value = this.highlightPrefilter.render(
        renderer,
        {
          colorTexture: readBuffer.texture,
          threshold: this.uniforms.highlightThreshold.value,
          knee: this.uniforms.highlightKnee.value,
        },
      );
      this.uniforms.tColor.value = readBuffer.texture;
      this.uniforms.nearClip.value = this.camera.near;
      this.uniforms.farClip.value = this.camera.far;
      this.uniforms.bokehSourceScatter.value = this._sourceScatterEnabled
        ? 1
        : 0;
      this._resolveCocScale();

      // Half-resolution CoC prefilter + gather. Radius is bought with resolution,
      // so a 32px disc costs the same fixed 61 taps a 3px one did.
      this.uniforms.tGather.value = this._cocPass.render(renderer, {
        colorTexture: readBuffer.texture,
        depthTexture: this._renderTargetDepth.texture,
        highlightTexture: this.highlightPrefilter.target.texture,
        focus: this.uniforms.focus.value,
        nearClip: this.camera.near,
        farClip: this.camera.far,
        cocScalePx: this.cocScalePx,
        maxCocPx: this.maxCocPx,
        tiltStrength: this.uniforms.tiltStrength.value,
        tiltAnchorV: this.uniforms.tiltAnchorV.value,
        highlightThreshold: this.uniforms.highlightThreshold.value,
        sourceScatter: this._sourceScatterEnabled,
        bokehQuality: this.uniforms.bokehQuality.value,
      });

      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (!this.renderToScreen) renderer.clear();
      this._fsQuad.render(renderer);
      if (this._sourceScatterEnabled) {
        this._sourceScatter.render(
          renderer,
          this.renderToScreen ? null : writeBuffer,
          this.highlightPrefilter.target.texture,
          readBuffer.texture,
          this._renderTargetDepth.texture,
          this.camera,
          this.uniforms.focus.value,
          this.cocScalePx,
          this.maxCocPx,
          this.uniforms.bokehRadiusScale.value,
          this.uniforms.highlightThreshold.value,
          this.uniforms.highlightKnee.value,
          this.uniforms.tiltStrength.value,
          this.uniforms.tiltAnchorV.value,
        );
      }
    } finally {
      renderer.setClearColor(this._oldClearColor);
      renderer.setClearAlpha(oldClearAlpha);
      renderer.autoClear = oldAutoClear;
    }
  }

  /**
   * Resolve the one CPU scalar the whole DoF stack shares.
   *
   * `uniforms.aperture` is still the ramp carrier that createDofController
   * writes (base aperture x amount), so folding it in here preserves the
   * existing dofAmount contract exactly while the value itself is now an
   * aperture diameter in metres. fov must be read live: the focus continuum
   * moves it from 46 deg aerial to 7 deg hero, and that alone is what makes the
   * telephoto frame shallower. Live focus then multiplies the effective aperture
   * through bokehLongFocusApertureMeters so hero settle (~170 m axial focus)
   * keeps far soft-separation without re-softening the residential near band
   * (#207 / #214).
   */
  _resolveCocScale() {
    const fov = this.camera?.isPerspectiveCamera ? this.camera.fov : 0;
    const focus = this.uniforms.focus.value;
    this.effectiveApertureMeters = bokehLongFocusApertureMeters(
      this.uniforms.aperture.value,
      focus,
    );
    this.cocScalePx = bokehCocScalePx(
      this.effectiveApertureMeters,
      this._height,
      fov,
    );
    this.maxCocPx = bokehMaxCocPx(this._height, this.maxCocFraction);
    this.uniforms.cocScalePx.value = this.cocScalePx;
    this.uniforms.maxCocPx.value = this.maxCocPx;
    // Ride the dofAmount ramp. `aperture` is base x amount, so this recovers the
    // ramp weight without a second piece of state and keeps tilt at exactly 0
    // wherever the aperture is 0 (aerial, criterion 5). Long-focus boost is not
    // part of the ramp — it scales only the CoC, never the Scheimpflug dial.
    const rampWeight = this.apertureMeters > 0
      ? Math.min(1, Math.max(0, this.uniforms.aperture.value / this.apertureMeters))
      : 0;
    this.uniforms.tiltStrength.value = this.tiltStrength * rampWeight;
    this.uniforms.tiltAnchorV.value = bokehTiltAnchorV(this.tiltAnchorV);
    return this.cocScalePx;
  }

  /**
   * Set the tilt dial and the subject's screen height.
   *
   * The anchor is where the plane of focus crosses the subject; the tilt term is
   * exactly zero there, so the subject stays as sharp as it was on a plain lens no
   * matter how strong the tilt is. It is clamped into the range the far-asymptote
   * bound assumes (bokeh-coc-contract.js).
   */
  setTilt(strength, anchorV) {
    if (Number.isFinite(strength)) this.tiltStrength = Math.max(0, strength);
    if (Number.isFinite(anchorV)) this.tiltAnchorV = anchorV;
    return { strength: this.tiltStrength, anchorV: bokehTiltAnchorV(this.tiltAnchorV) };
  }

  setSize(width, height) {
    super.setSize(width, height);
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this.materialBokeh.uniforms.viewportWidth.value = this._width;
    this.materialBokeh.uniforms.viewportHeight.value = this._height;
    this.highlightPrefilter.setSize(width, height);
    this._cocPass.setSize(this._width, this._height);
    this._sourceScatter.setSize(this._width, this._height);
  }

  /** Verification counterfactual; the product path keeps source scatter enabled. */
  setSourceScatterEnabled(enabled) {
    this._sourceScatterEnabled = !!enabled;
    return this._sourceScatterEnabled;
  }

  debugSourceScatter() {
    return {
      enabled: this._sourceScatterEnabled,
      allocated: !!this._sourceScatter,
      gridWidth: this._sourceScatter?.gridWidth || 0,
      gridHeight: this._sourceScatter?.gridHeight || 0,
      vertexCount: this._sourceScatter?.vertexCount || 0,
      renderCount: this._sourceScatter?.renderCount || 0,
      backend: this._sourceScatter?.backend || null,
      pointSizeRange: this._sourceScatter?.pointSizeRange || null,
      requiredPointDiameter: this._sourceScatter?.requiredPointDiameter || 0,
    };
  }

  /** Physical optics readout for the browser-free and app gates. */
  debugCoc() {
    return {
      // Ramp carrier (base × amount) — product base aperture at full focus.
      apertureMeters: this.uniforms.aperture.value,
      baseApertureMeters: this.apertureMeters,
      // After long-focus compensation; equals apertureMeters at residential focus.
      effectiveApertureMeters: this.effectiveApertureMeters,
      maxCocFraction: this.maxCocFraction,
      cocScalePx: this.cocScalePx,
      maxCocPx: this.maxCocPx,
      farAsymptotePx: bokehFarAsymptotePx(
        this.cocScalePx,
        this.uniforms.focus.value,
      ),
      baseTiltStrength: this.tiltStrength,
      tiltStrength: this.uniforms.tiltStrength.value,
      tiltAnchorV: this.uniforms.tiltAnchorV.value,
      // The bound that keeps the background on the pure physical curve. ratio >= 1
      // means tilt pushed the far asymptote into the clamp.
      tiltHeadroom: bokehTiltFarAsymptoteHeadroom({
        scalePx: this.cocScalePx,
        focus: this.uniforms.focus.value,
        tiltStrength: this.uniforms.tiltStrength.value,
        maxCocPx: this.maxCocPx,
      }),
      sourceRadiusScale: this.uniforms.bokehRadiusScale.value,
      gatherScale: this._cocPass.gatherScale,
      gatherWidth: this._cocPass.targetWidth,
      gatherHeight: this._cocPass.targetHeight,
      gatherAllocated: this._cocPass.allocated,
      gatherRenderCount: this._cocPass.renderCount,
      baseTaps: BOKEH_GATHER_BASE_TAP_COUNT,
      taps: BOKEH_GATHER_TAP_COUNT,
      fillWeight: this.uniforms.bokehQuality.value,
    };
  }

  debugResources() {
    return {
      highlightPrefilter: this.highlightPrefilter,
      highlightTarget: this.highlightPrefilter?.target || null,
      highlightMaterial: this.highlightPrefilter?.material || null,
      cocPass: this._cocPass,
      cocTarget: this._cocPass?.cocTarget || null,
      cocMaterial: this._cocPass?.cocMaterial || null,
      cocGatherTarget: this._cocPass?.gatherTarget || null,
      cocGatherMaterial: this._cocPass?.gatherMaterial || null,
      sourceScatter: this._sourceScatter,
      sourceScatterMaterial: this._sourceScatter?.material || null,
      sourcePointGeometry: this._sourceScatter?.pointGeometry || null,
      sourceTriangleGeometry: this._sourceScatter?.triangleGeometry || null,
    };
  }

  /**
   * Route adaptive quality to the gather's fill ring only.
   *
   * The former policy dropped the whole surface reconstruction to a single tap
   * during camera motion, which was invisible while the radius was capped at
   * 3.25px but becomes a hard settling pop at physical radii. A half-resolution
   * 48-tap base disc is not sparse, so the condition that produced kernel crawl
   * ("large radius through a 13-tap full-resolution kernel") no longer exists and
   * the base never sleeps. Tap cost is constant; only ring smoothness varies.
   */
  setBokehQuality(value) {
    const quality = Math.max(0, Math.min(1, Number(value) || 0));
    this.materialBokeh.uniforms.bokehQuality.value = quality;
    this.bokehSampleCount = BOKEH_GATHER_TAP_COUNT;
    return quality;
  }

  dispose() {
    this._hiddenForDepth.length = 0;
    this._materialsForDepth.length = 0;
    this._instFadeDepthMaterial.dispose();
    this._lodScreenDoorDepthMaterial.dispose();
    this.highlightPrefilter.dispose();
    this._cocPass?.dispose();
    this._cocPass = null;
    this._sourceScatter?.dispose();
    this._sourceScatter = null;
    super.dispose();
  }
}
