import * as THREE from 'three';
import {
  buildYardLife,
  YARD_LIFE_MATERIAL_ROLES,
} from './yard-life.js';

// Product palette adapter kept outside the reusable renderer. The six source
// materials are borrowed by buildYardLife, whose fixed derived clones receive
// vertex-color/screen-door patches. This wrapper retains and releases its source
// inputs after the renderer has emptied the group, so generic village disposal
// sees no stale geometry or derived material references.

const PRODUCT_MATERIALS = Object.freeze({
  wood: Object.freeze({ color: 0x65452e, roughness: 0.94, role: 'wood' }),
  onggi: Object.freeze({ color: 0x563227, roughness: 0.9, role: 'stone' }),
  straw: Object.freeze({ color: 0xb29454, roughness: 0.98, role: 'wood' }),
  stone: Object.freeze({ color: 0x747168, roughness: 1, role: 'stone' }),
  chaff: Object.freeze({ color: 0xb89a4f, roughness: 1, role: 'wood' }),
  fiber: Object.freeze({ color: 0x8b7448, roughness: 0.98, role: 'wood' }),
});

function createProductMaterials() {
  const materials = {};
  for (const role of YARD_LIFE_MATERIAL_ROLES) {
    const spec = PRODUCT_MATERIALS[role];
    const material = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: 0,
    });
    material.name = `village-yard-life-${role}`;
    material.userData.role = spec.role;
    material.userData.yardLifeRole = role;
    materials[role] = material;
  }
  return materials;
}

export function createVillageYardLife(records, options = {}) {
  const materials = createProductMaterials();
  let controller;
  try {
    controller = buildYardLife(records, { ...options, materials });
  } catch (error) {
    for (const material of Object.values(materials)) material.dispose();
    throw error;
  }

  const disposeRenderer = controller.dispose.bind(controller);
  let disposed = false;
  controller.dispose = () => {
    if (disposed) return false;
    disposed = true;
    disposeRenderer();
    for (const material of Object.values(materials)) material.dispose();
    return true;
  };
  const debugRenderer = controller.debug.bind(controller);
  controller.debug = () => ({
    ...debugRenderer(),
    productBorrowedMaterials: YARD_LIFE_MATERIAL_ROLES.length,
    productMaterialsDisposed: disposed,
  });
  controller.group.userData.yardLife = controller;
  return controller;
}
