// DOM- and THREE-free temple planning API for workers and external generators.
export {
  TEMPLE_PLAN_SCHEMA_VERSION,
  TEMPLE_VARIANTS,
  TEMPLE_VARIANT_SPECS,
  normalizeTemplePlan,
  planTempleCompound,
  templeCompoundDefaultsForSite,
  templePlanIssues,
  templeVariantForSite,
  templeVariantsForSize,
} from '../temple/plan.js';
export {
  TEMPLE_ROLE_HIERARCHY,
  templeHallBuilderParams,
  templeHallEaveFootprint,
  templeRoleArchitecture,
} from '../temple/role-hierarchy.js';
export {
  TEMPLE_ENTRY_PROFILES,
  TEMPLE_ENTRY_SEQUENCE_SCHEMA_VERSION,
  TEMPLE_ENTRY_STAGE_KINDS,
  TEMPLE_PASS_UNDER_DEFAULTS,
  applyTempleEntrySequence,
  planTempleEntrySequence,
  templeBuildingIsOpenPassUnder,
  templeEntrySequenceIssues,
  templeEntrySequenceKinds,
  templePassUnderPlacement,
} from '../temple/entry-sequence.js';
