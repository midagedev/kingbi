// Three r185 copies every source color map onto its shared shadow depth material,
// even when the opaque depth shader cannot use that map. If the source subtree is
// then disposed, the shared material can retain and re-register the stale texture
// on a later shadow draw. Scrub only those semantically unused color/alpha maps at
// the last callback boundary before WebGLRenderer resolves the depth program.

const PATCHED = Symbol.for('cheoma.shadowDepthTextureLifecycle');

function sourceMaterial(object, group) {
  const material = object?.material;
  if (!Array.isArray(material)) return material || null;
  return material[group?.materialIndex] || null;
}

function needsTextureSilhouette(material) {
  return material?.alphaTest > 0
    || material?.alphaToCoverage === true;
}

function hasShadowTexture(material) {
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((entry) => entry?.map || entry?.alphaMap);
}

// Keep callback composition explicit: LOD screen-door and future shadow hooks may
// install either before or after this helper without replacing one another.
export function chainOnBeforeShadow(object, callback) {
  if (!object || typeof callback !== 'function') return false;
  const previous = object.onBeforeShadow;
  object.onBeforeShadow = function onBeforeShadow(
    renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
  ) {
    previous?.call(
      this, renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
    );
    callback.call(
      this, renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
    );
  };
  return true;
}

function mayScrubDepthMaterial(object, depthMaterial) {
  const custom = object?.customDepthMaterial === depthMaterial
    || object?.customDistanceMaterial === depthMaterial;
  return !custom;
}

export function attachShadowDepthTextureLifecycle(root) {
  root?.traverse?.((object) => {
    if ((!object.isMesh && !object.isInstancedMesh)
      || object[PATCHED]
      || !hasShadowTexture(object.material)) return;
    object[PATCHED] = true;
    chainOnBeforeShadow(object, (
      renderer, object3d, camera, shadowCamera, geometry, depthMaterial, group,
    ) => {
      const material = sourceMaterial(object3d, group);
      if (!depthMaterial
        || !mayScrubDepthMaterial(object3d, depthMaterial)
        || needsTextureSilhouette(material)) return;
      // Three r185 does not copy alphaHash onto shared shadow materials or compile an
      // alpha-hashed shadow variant. Source alphaHash alone therefore cannot make a copied
      // map meaningful; keeping it would only retain the stale texture this hook prevents.
      depthMaterial.map = null;
      depthMaterial.alphaMap = null;
    });
  });
  return root;
}
