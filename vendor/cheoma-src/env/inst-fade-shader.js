// Shared screen-door vocabulary for tree color+DoF and building-LOD color+shadow+DoF+ink.
// Each participating pass must discard the same pixels or a faded object remains as an invisible
// depth blob. Tree shadow fading is intentionally outside this module. Positive coverage keeps
// the low IGN subset; negative coverage keeps its high, complementary subset.
import { screenDoorDiscard } from '../render/screen-door.js';
import {
  MATERIAL_PROGRAM_PATCH,
  addMaterialProgramKey,
} from '../render/material-program-key.js';

export const INST_FADE_PROGRAM_VERSION = MATERIAL_PROGRAM_PATCH.INST_FADE;

const VERTEX_DECLARATION = '#include <common>\nattribute float instFade;\nvarying float vInstFade;';
const VERTEX_ASSIGNMENT = '#include <begin_vertex>\nvInstFade = instFade;';
const FRAGMENT_DECLARATION = '#include <common>\nvarying float vInstFade;';
const FRAGMENT_DISCARD = `#include <clipping_planes_fragment>
  ${screenDoorDiscard('vInstFade')}`;

export function patchInstFadeShader(shader) {
  // Idempotent: material.clone() copies onBeforeCompile, and a later
  // patchInstFadeMaterial on the clone would otherwise double-inject.
  if (shader.vertexShader.includes('varying float vInstFade')) return;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', VERTEX_DECLARATION)
    .replace('#include <begin_vertex>', VERTEX_ASSIGNMENT);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', FRAGMENT_DECLARATION)
    .replace('#include <clipping_planes_fragment>', FRAGMENT_DISCARD);
}

const patchedMaterials = new WeakSet();

// Material-level installer for tree color presentation. LOD shadows use their own draw-local
// material contract; tree shadow parity remains a separate concern. The explicit key composes
// safely with later snow/rim patches in any order.
export function patchInstFadeMaterial(material) {
  if (!material?.isMaterial || patchedMaterials.has(material)) return false;
  patchedMaterials.add(material);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    patchInstFadeShader(shader);
  };
  material.userData.__instFadePatchVersion = INST_FADE_PROGRAM_VERSION;
  addMaterialProgramKey(material, INST_FADE_PROGRAM_VERSION);
  material.needsUpdate = true;
  return true;
}
