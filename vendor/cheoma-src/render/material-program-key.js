// Stable, order-independent cache-key composition for stock materials patched through
// onBeforeCompile. Three cannot infer shader variants from callback closures, so every known
// patch contributes one explicit token while preserving the prior explicit-token chain.
// Callers must not use this helper to bless an unknown callback that relies only on Three's
// inherited callback-source key.
export const MATERIAL_PROGRAM_PATCH = Object.freeze({
  LOD_SCREEN_DOOR: 'cheoma-lod-screen-door-v1',
  INST_FADE: 'cheoma-inst-fade-v2',
  // v2: soft centre-peaked falloff (no hard 0.42 plateau) — look-audit U5 / #221
  CLOUD_SHADOW: 'cloudshadow-v2',
  SNOW: 'snow-v2',
  PHYSICAL_RIM: 'cheoma-rim-physical-v1',
  CRITTER_ARTICULATION: 'cheoma-critter-articulation-v1',
});

const PROGRAM_KEY_STATE = Symbol.for('cheoma.materialProgramKeyState');

export function addMaterialProgramKey(material, token) {
  if (!material || typeof token !== 'string' || token.length === 0) return false;
  let state = material[PROGRAM_KEY_STATE];
  if (!state) {
    const baseKey = Object.hasOwn(material, 'customProgramCacheKey')
      && typeof material.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey.call(material) : '';
    state = { tokens: new Set(), baseKey: baseKey || '' };
    material[PROGRAM_KEY_STATE] = state;
    material.customProgramCacheKey = function customProgramCacheKey() {
      const known = [...state.tokens].sort();
      if (state.baseKey) known.push(state.baseKey);
      return known.join('|');
    };
  }
  const size = state.tokens.size;
  state.tokens.add(token);
  return state.tokens.size !== size;
}

export function materialProgramKeyTokens(material) {
  if (!Object.hasOwn(material || {}, 'customProgramCacheKey')
    || typeof material.customProgramCacheKey !== 'function') return [];
  try {
    const key = material.customProgramCacheKey();
    return typeof key === 'string' ? key.split('|').filter(Boolean) : [];
  } catch {
    return null;
  }
}

export function hasOnlyMaterialProgramKeys(material, allowedTokens) {
  const tokens = materialProgramKeyTokens(material);
  return tokens != null && tokens.every((token) => allowedTokens.has(token));
}
