// DOM- and THREE-free seasonal yard-life planning API for workers and external generators.
export {
  YARD_LIFE_MOTIFS,
  YARD_LIFE_SCHEMA_VERSION,
  YARD_LIFE_SEASONS,
  planYardLife,
  yardLifeHouseholdEligible,
  yardLifeRecordsToHardObstacles,
} from '../village/yard-life-plan.js';
export {
  validateYardLifeRecords,
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_SEASONS as YARD_LIFE_PRESENTATION_SEASONS,
  YARD_LIFE_WEATHER,
} from '../village/yard-life-record-contract.js';
