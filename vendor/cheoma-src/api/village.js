// 마을 계획부터 THREE 조립·runtime handle까지의 공개 API.
export * from './village-plan.js';
export { buildSijeon, disposeSijeon } from './sijeon.js';
export {
  buildYardLife,
  disposeYardLife,
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_PRESENTATION_SEASONS,
  YARD_LIFE_WEATHER,
} from './yard-life.js';
export {
  buildMudWallSurfaceGeometry,
  disposeMudWallSurfaceGeometry,
} from './mud-wall.js';
export {
  buildDrainage,
  disposeDrainage,
  DRAINAGE_MATERIAL_ROLES,
} from './drainage.js';
export {
  buildDangsan,
  disposeDangsan,
  DANGSAN_MATERIAL_ROLES,
} from './dangsan.js';
export { populateVillage, populateVillageSteps } from '../village/populate.js';
export { createVillage, createVillageAsync } from '../village/adapter.js';
export { createRerollWave } from '../village/wave.js';
export { buildFeaturePad, buildParcelPads, computePadY } from '../generators/village/pads.js';
export {
  buildFeatureObjects,
  buildHeroParcel,
  buildPaddyFields,
  buildVillageSijeon,
  buildTempleCluster,
  collectMaterialSets,
} from '../generators/village/features.js';
export {
  buildSiteTerrain,
  buildWaterRibbon,
  computeRidgeMistAnchors,
  setVillageWaterTime,
} from '../generators/village/terrain.js';
export { buildRoads } from '../generators/village/roads.js';
export { scatterTrees } from '../generators/village/trees.js';
export {
  attachChunkLodSwap,
  buildCourtyard,
  buildKindDecomps,
  makeHouseProtos,
  placeParcel,
} from '../generators/village/houses.js';
