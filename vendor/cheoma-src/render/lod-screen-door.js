import { screenDoorDiscard } from './screen-door.js';
import { addMaterialProgramKey, MATERIAL_PROGRAM_PATCH } from './material-program-key.js';

export const LOD_SCREEN_DOOR_PROGRAM_VERSION = MATERIAL_PROGRAM_PATCH.LOD_SCREEN_DOOR;

const CHANNEL = Symbol.for('cheoma.lodScreenDoorChannel');
const ORIGINAL_MATRIX_W = Symbol.for('cheoma.lodScreenDoorOriginalMatrixW');
const patchedMaterials = new WeakSet();

const VERTEX_DECLARATION = '#include <common>\nvarying float vLodScreenDoor;';
// Affine modelMatrix[3][3] is 1 for ordinary objects. Only attachObjectChannel roots rewrite it
// for the draw; coverage ≥ 0.999 early-outs discard so non-LOD draws stay a pure no-op.
const VERTEX_ASSIGNMENT = '#include <begin_vertex>\nvLodScreenDoor = modelMatrix[3][3];';
const VERTEX_WORLD_POSITION = `#include <worldpos_vertex>
#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
  worldPosition.w = 1.0;
#endif`;
const FRAGMENT_DECLARATION = '#include <common>\nvarying float vLodScreenDoor;';
const FRAGMENT_DISCARD = `#include <clipping_planes_fragment>
  ${screenDoorDiscard('vLodScreenDoor')}`;

export function patchLodScreenDoorShader(shader) {
  // Idempotent against clone+repatch chains (same as inst-fade).
  if (shader.vertexShader.includes('varying float vLodScreenDoor')) return;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', VERTEX_DECLARATION)
    .replace('#include <begin_vertex>', VERTEX_ASSIGNMENT)
    // modelMatrix[3][3] is only a draw-local scalar carrier. Restore the affine homogeneous
    // coordinate before stock shadow/environment/distance chunks consume worldPosition.
    .replace('#include <worldpos_vertex>', VERTEX_WORLD_POSITION);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', FRAGMENT_DECLARATION)
    .replace('#include <clipping_planes_fragment>', FRAGMENT_DISCARD);
}

function applyObjectChannel(object) {
  const channel = object?.[CHANNEL];
  const matrix = object?.matrixWorld?.elements;
  if (!channel || !matrix) return;
  object[ORIGINAL_MATRIX_W] = matrix[15];
  matrix[15] = channel.value;
}

function restoreObjectMatrix(object) {
  if (object?.[ORIGINAL_MATRIX_W] == null) return;
  object.matrixWorld.elements[15] = object[ORIGINAL_MATRIX_W];
  delete object[ORIGINAL_MATRIX_W];
}

// Install the screen-door *shader path* on a stock material. R8 program diet (#180 / #220):
// every rim-eligible, cloud-shadow, snow, and FAR-impostor stock material always carries this
// path so plain×lod combinations compile as one WebGLProgram family. Coverage defaults to
// affine 1 (discard early-out, no extra work). The matrix channel is a separate object-local
// setup on true LOD roots only — never a per-chunk material uniform.
//
// Material callbacks run after Three has calculated modelView/normal matrices and immediately
// before modelMatrix is uploaded for this draw. The otherwise constant affine [3][3] slot is a
// draw-local scalar channel, so shared MID/FULL materials remain safe across chunks.
export function patchLodScreenDoorMaterial(material) {
  if (!material?.isMaterial || patchedMaterials.has(material)) return false;
  patchedMaterials.add(material);
  const previousCompile = material.onBeforeCompile;
  const previousRender = material.onBeforeRender;
  material.onBeforeCompile = function onBeforeCompile(shader, renderer) {
    previousCompile?.call(this, shader, renderer);
    patchLodScreenDoorShader(shader);
  };
  material.userData.__lodScreenDoorPatchVersion = LOD_SCREEN_DOOR_PROGRAM_VERSION;
  addMaterialProgramKey(material, LOD_SCREEN_DOOR_PROGRAM_VERSION);
  material.onBeforeRender = function onBeforeRender(
    renderer, scene, camera, geometry, object, group,
  ) {
    previousRender?.call(this, renderer, scene, camera, geometry, object, group);
    applyObjectChannel(object);
  };
  material.needsUpdate = true;
  return true;
}

function attachObjectChannel(object, channel) {
  if (object[CHANNEL]) return;
  object[CHANNEL] = channel;
  const previousAfterRender = object.onAfterRender;
  const previousBeforeShadow = object.onBeforeShadow;
  const previousAfterShadow = object.onAfterShadow;
  object.onAfterRender = function onAfterRender(
    renderer, scene, camera, geometry, material, group,
  ) {
    restoreObjectMatrix(this);
    previousAfterRender?.call(this, renderer, scene, camera, geometry, material, group);
  };
  // WebGLShadowMap bypasses Material.onBeforeRender but invokes these callbacks after its own
  // modelView calculation, so the same draw-local channel is safe for custom depth materials.
  object.onBeforeShadow = function onBeforeShadow(
    renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
  ) {
    previousBeforeShadow?.call(
      this, renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
    );
    applyObjectChannel(this);
  };
  object.onAfterShadow = function onAfterShadow(
    renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
  ) {
    restoreObjectMatrix(this);
    previousAfterShadow?.call(
      this, renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
    );
  };
}

export function hasLodScreenDoor(object) {
  return !!object?.[CHANNEL];
}

export function hasLodScreenDoorMaterial(material) {
  return material?.userData?.__lodScreenDoorPatchVersion === LOD_SCREEN_DOOR_PROGRAM_VERSION
    && material.customProgramCacheKey?.().split('|').includes(LOD_SCREEN_DOOR_PROGRAM_VERSION);
}

export function lodScreenDoorValue(object) {
  return object?.[CHANNEL]?.value ?? null;
}

// Setup-only traversal. Runtime updates one scalar per root and allocates/uploads no geometry,
// material, texture, uniform, or attribute resource.
export function attachLodScreenDoorRoot(root, { depth = null, distance = null } = {}) {
  const channel = {
    value: 1,
    set(value) {
      const next = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 1));
      if (next === this.value) return false;
      this.value = next;
      return true;
    },
  };
  root?.traverse?.((object) => {
    if (!object.isMesh) return;
    attachObjectChannel(object, channel);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) patchLodScreenDoorMaterial(material);
    if (object.castShadow) {
      if (depth) object.customDepthMaterial = depth;
      if (distance) object.customDistanceMaterial = distance;
    }
  });
  return channel;
}
