// DOM과 THREE에 의존하지 않는 마을 계획 API.
// 외부 프로젝트, Web Worker, 빠른 Node 계약 검사는 이 진입점만 사용한다.
export { planVillage } from '../village/plan.js';
export * from './temple-plan.js';
export * from './sijeon-plan.js';
export * from './yard-life-plan.js';
export * from './mud-wall-plan.js';
export * from './drainage-plan.js';
export * from './dangsan-plan.js';
export * from './mja-house-plan.js';
export {
  SCALE_ANCHORS,
  VILLAGE_SITE_R_MAX,
  VILLAGE_SITE_R_MIN,
  siteConfigFor,
  resolveSiteR,
  scale01ToR,
  rToScale01,
  tierForR,
  makeSite,
} from '../village/site.js';
export {
  VILLAGE_NUMBER_OPTION_SPECS,
  VILLAGE_MJA_HOUSE_PRODUCT_CONTEXT,
  VILLAGE_OPTION_DEFAULTS,
  VILLAGE_WALL_STYLE_IDS,
  VILLAGE_WALL_WEIGHT_SPEC,
  isVillageMjaHouseProductContext,
  normalizeVillageTuningOptions,
  normalizeVillageWallWeights,
  villageOptionDefaults,
} from '../village/options.js';
export { ROAD_WIDTH } from '../village/roads.js';
export { planRiverPort } from '../village/river-port-plan.js';
export { createSettlementRelief } from '../village/settlement-relief.js';
export { terrainRangeOnPolygon } from '../village/placement-search.js';
export { attachRoadJunctions } from '../village/road-topology.js';
export { planGuardianTrees } from '../village/guardian-plan.js';
export { planParcelFocus } from '../generators/shared/parcel-spatial.js';
export { IMPOSTOR_VARIANT_COUNTS, impostorHouseSpec } from '../village/impostor-spec.js';
export {
  CHUNK_LOD_LEVEL,
  VILLAGE_CHUNK_LOD,
  VILLAGE_DETAIL_LOD,
  villageChunkLodPolicy,
  nextChunkLodLevel,
} from '../village/lod-policy.js';
export {
  VILLAGE_DETAIL_TIER,
  createVillageDetailLodState,
  villageDetailWeightAt,
} from '../runtime/village/detail-lod.js';
export {
  computeFixedRadius,
  terrainGridSize,
  terrainMeshHeightAt,
  terrainWarpInner,
} from '../village/terrain-surface.js';
export {
  ROAD_SURFACE_MAX_SPAN,
  ROAD_SURFACE_MAX_JOIN_SAGITTA,
  ROAD_SURFACE_MIN_JOIN_GAP,
  ROAD_SURFACE_LIFT,
  sampleRoadSurface,
} from '../village/road-surface.js';
export {
  CITY_WALL_DIMENSIONS,
  CITY_WALL_MIN_SITE_R,
  planCityWall,
  cityWallRadiusAt,
  pointOnCityWall,
  normalOnCityWall,
  cityWallClearance,
  cityWallContainsPolygon,
  cityWallOutsidePolygon,
  worldEdgeClearance,
  worldEdgeContainsPolygon,
  clampPointInsideCityWall,
  clampPointOutsideCityWall,
  cityGateFootprint,
  cityGateApproachFootprint,
  cityGateLocalPoint,
  cityGatePierTerrainProfile,
  cityGateTerrainProfile,
  cityGateStructureProfile,
  cityGateStreamClearance,
  cityWallVegetationBlocked,
  sampleCityWallSegments,
  cityWallSegmentCapProfile,
  cityWallSegmentFootprint,
} from '../village/citywall-contour.js';
