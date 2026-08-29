// Reusable, borrowed-material seasonal yard-life renderer and explicit lifecycle API.
export {
  YARD_LIFE_MOTIFS,
  YARD_LIFE_MATERIAL_ROLES,
  YARD_LIFE_PRESENTATION_SEASONS,
  YARD_LIFE_SCHEMA_VERSION,
  YARD_LIFE_SEASONS,
  YARD_LIFE_WEATHER,
  planYardLife,
  validateYardLifeRecords,
  yardLifeHouseholdEligible,
  yardLifeRecordsToHardObstacles,
} from './yard-life-plan.js';
export {
  buildYardLife,
  disposeYardLife,
} from '../generators/village/yard-life.js';
