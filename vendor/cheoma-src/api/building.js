// 재사용 가능한 건물·필지 생성 API. buildBuilding 원본은 disposeBuilding으로 해제한다.
// P.mats를 주입하면 그 공유 팔레트는 호출측 소유로 남고 건물 파생 리소스만 해제된다.
export { PRESETS, computeLayout, giwaFootprint, giwaFootprintPolygon, bayPositions } from '../params.js';
export { giwaRoofEnvelope } from '../layout/giwa-roof-envelope.js';
export {
  KOREA_COLORS,
  VILLAGE_MATERIAL_COLORS,
  TILE_LOOK,
  srgbChannelToLinear,
  srgbHexToLinear3,
  srgbRelativeLuminance,
  tileLookBandViolations,
} from '../builder/material-colors.js';
export { buildBuilding, disposeBuilding } from '../builder/index.js';
export {
  DANCHEONG_BUCKET_STEPS,
  DANCHEONG_DEFAULTS,
  dancheongGrade,
  resolveDancheong,
  resolveTempleRoleDancheong,
} from '../builder/dancheong.js';
export { buildParcel } from '../layout/parcel.js';
export { buildHanok } from '../layout/hanok.js';
export { buildPalaceCompound, disposePalaceCompound } from '../village/palace.js';
export {
  getTofuBounce,
  playAssembly,
  setTofuBounce,
  tofuBob,
  tofuRise,
  tofuScale,
} from '../anim/assembly.js';
// Ceiling finish plan (방 반자 / 대청 연등) — pure; interior mesh deferred.
export {
  CEILING_FINISH,
  CEILING_PLAN_SCHEMA_VERSION,
  CEILING_ZONE_STATUS,
  ROOF_STRUCTURE_LAYER,
  assertCeilingPlan,
  planCeiling,
  planGiwaCeiling,
  planRankedHallCeiling,
} from './ceiling-plan.js';
