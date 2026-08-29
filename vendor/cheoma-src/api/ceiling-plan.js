// Three/DOM-free public façade for the ceiling finish contract (interior roadmap).
// Internal modules must not import this file; use src/builder/ceiling-plan.js.
export {
  CEILING_FINISH,
  CEILING_PLAN_SCHEMA_VERSION,
  CEILING_ZONE_STATUS,
  ROOF_STRUCTURE_LAYER,
  assertCeilingPlan,
  ceilingZone,
  planCeiling,
  planGiwaCeiling,
  planRankedHallCeiling,
} from '../builder/ceiling-plan.js';
