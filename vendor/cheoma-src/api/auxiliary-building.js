// Reusable Three.js adapter for a renderer-free auxiliary-building plan.
// Materials remain caller-owned; disposeAuxiliaryBuilding releases geometry only.
export {
  AUXILIARY_BUILDING_MATERIAL_ROLES,
  buildAuxiliaryBuilding,
  disposeAuxiliaryBuilding,
} from '../village/auxiliary-building-geometry.js';
