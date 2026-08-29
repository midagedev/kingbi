// 외부 프로젝트용 전체 browser runtime façade.
// 순수 plan만 필요하면 './village-plan.js'를 직접 import해 browser/THREE 의존을 피한다.
export * from './building.js';
export * from './village.js';
// These explicit bindings take precedence over aggregate star exports and keep
// the reusable renderer distinct from the product-only village palette adapter.
export {
  SIJEON_FACADE_BAYS,
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_KIND_BREAK,
  SIJEON_KIND_SHOP,
  SIJEON_PLACEMENT,
  SIJEON_SIGN_POLICY,
  buildSijeon,
  disposeSijeon,
  isSijeonShop,
  planSijeon,
  planSijeonFacade,
} from './sijeon.js';
export {
  YARD_LIFE_MOTIFS,
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_PRESENTATION_SEASONS,
  YARD_LIFE_SCHEMA_VERSION,
  YARD_LIFE_SEASONS,
  YARD_LIFE_WEATHER,
  buildYardLife,
  disposeYardLife,
  planYardLife,
  validateYardLifeRecords,
  yardLifeHouseholdEligible,
  yardLifeRecordsToHardObstacles,
} from './yard-life.js';
export {
  buildMudWallSurfaceGeometry,
  disposeMudWallSurfaceGeometry,
  MUD_WALL_SURFACE_LIMITS,
  MUD_WALL_SURFACE_SCHEMA_VERSION,
  planMudWallSurface,
  validateMudWallSurfacePlan,
} from './mud-wall.js';
export {
  buildDrainage,
  disposeDrainage,
  DRAINAGE_MATERIAL_ROLES,
  DRAINAGE_PLAN_LIMITS,
  DRAINAGE_PLAN_SCHEMA_VERSION,
  planRoadsideDrainage,
  validateRoadsideDrainagePlan,
} from './drainage.js';
export {
  buildDangsan,
  disposeDangsan,
  DANGSAN_MATERIAL_ROLES,
  DANGSAN_PLAN_LIMITS,
  DANGSAN_PLAN_SCHEMA_VERSION,
  dangsanHardObstacles,
  planDangsan,
  validateDangsanPlan,
} from './dangsan.js';
export {
  buildMjaHouse,
  disposeMjaHouse,
} from './mja-house.js';
export {
  MJA_HOUSE_PLAN_LIMITS,
  MJA_HOUSE_PLAN_SCHEMA_VERSION,
  planMjaHouse,
  validateMjaHousePlan,
} from './mja-house-plan.js';
export * from './environment.js';
export * from './post-quality.js';
export * from './particles.js';
export * from './lighting.js';
export * from './cinematic.js';
export * from './audio.js';
export * from './props.js';
export * from './temple.js';
export * from './export.js';
export * from './rendering.js';
export * from './surface-materials.js';
export * from './threshold-life.js';
export * from './glossary-plan.js';
