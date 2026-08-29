// buildBuilding이 만든 GPU 리소스의 소유권을 한곳에서 관리한다.
// 외부에서 P.mats를 주입한 경우 팔레트 재질·텍스처는 호출측 소유이고,
// 빌더가 그 팔레트에서 파생한 clone과 모든 지오메트리만 건물 소유다.

import {
  addMaterialResource,
  collectObjectResources,
  disposeObjectResources,
} from '../core/three-resources.js';

const lifecycleByRoot = new WeakMap();

function collectPaletteResources(palette) {
  const materials = new Set();
  const textures = new Set();
  for (const value of Object.values(palette || {})) {
    if (value?.isMaterial) addMaterialResource(value, materials, textures);
    else if (value?.isTexture) textures.add(value);
  }
  return { materials, textures };
}

function addAll(target, source) {
  for (const value of source) target.add(value);
}

// builder/index.js 전용 등록 훅. 생성 임계 경로에서 큰 건물 서브트리를 다시 순회하지
// 않고 소유권만 기록한다. 공유 팔레트 borrower만 보호 집합을 한 번 스냅샷한다.
export function registerBuildingResources(root, palette, ownsPalette) {
  lifecycleByRoot.set(root, {
    disposed: false,
    ownsPalette,
    palette,
    sharedPaletteResources: ownsPalette ? null : collectPaletteResources(palette),
  });
  return root;
}

// buildBuilding이 반환한 원본 root를 해제한다. scene 분리는 호출측 책임이다.
// 반환값은 실제로 처음 해제했을 때만 true라 중복 teardown도 안전하다.
export function disposeBuilding(root) {
  const lifecycle = root && lifecycleByRoot.get(root);
  if (!lifecycle || lifecycle.disposed) return false;
  lifecycle.disposed = true;

  const current = collectObjectResources(root);
  const paletteNow = collectPaletteResources(lifecycle.palette);
  if (lifecycle.ownsPalette) {
    addAll(current.materials, paletteNow.materials);
    addAll(current.textures, paletteNow.textures);
  } else {
    // P.mats는 여러 건물이 공유할 수 있다. 등록 당시와 현재의 팔레트 리소스를
    // 모두 보호해, 파생 재질이 base map을 공유해도 호출측 소유 텍스처를 끊지 않는다.
    const sharedMaterials = new Set(lifecycle.sharedPaletteResources.materials);
    const sharedTextures = new Set(lifecycle.sharedPaletteResources.textures);
    addAll(sharedMaterials, paletteNow.materials);
    addAll(sharedTextures, paletteNow.textures);
    for (const material of sharedMaterials) current.materials.delete(material);
    for (const texture of sharedTextures) current.textures.delete(texture);
  }

  disposeObjectResources(current);
  return true;
}
