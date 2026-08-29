// THREE.Object3D 서브트리의 GPU 리소스를 identity 기준으로 수집·해제한다.
// three를 import하지 않고 duck type을 써서 core 생성기와 앱 하네스가 같은 계약을 재사용한다.

// props/materials처럼 모듈 수명 동안 여러 생성물이 함께 쓰는 리소스는 개별 Object3D 소유가 아니다.
// WeakSet 표식은 Material.clone()에 복사되지 않아, 공유 원본에서 파생된 clone은 정상적으로 소비자 소유가 된다.
const sharedResources = new WeakSet();

export function markSharedResource(resource) {
  if (resource && (typeof resource === 'object' || typeof resource === 'function')) sharedResources.add(resource);
  return resource;
}

export function isSharedResource(resource) {
  return !!resource && sharedResources.has(resource);
}

export function addMaterialTextures(material, textures) {
  for (const value of Object.values(material || {})) {
    if (value?.isTexture) textures.add(value);
  }
  for (const uniform of Object.values(material?.uniforms || {})) {
    const value = uniform?.value;
    if (value?.isTexture) textures.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (item?.isTexture) textures.add(item);
    }
  }
}

export function addMaterialResource(material, materials, textures) {
  if (!material?.isMaterial) return;
  materials.add(material);
  addMaterialTextures(material, textures);
}

export function collectObjectResources(root) {
  const resources = {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  };
  root?.traverse?.((object) => {
    if (object.geometry?.dispose) resources.geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material)
      ? object.material
      : (object.material ? [object.material] : []);
    for (const material of objectMaterials) {
      addMaterialResource(material, resources.materials, resources.textures);
    }
  });
  return resources;
}

export function disposeObjectResources(resources) {
  for (const geometry of resources.geometries) if (!isSharedResource(geometry)) geometry.dispose();
  for (const material of resources.materials) if (!isSharedResource(material)) material.dispose();
  for (const texture of resources.textures) if (!isSharedResource(texture)) texture.dispose();
}

export function disposeObjectTree(root) {
  const resources = collectObjectResources(root);
  disposeObjectResources(resources);
  return resources;
}
