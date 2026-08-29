// Reusable Three adapter for renderer-free roadside-drainage plans.
export {
  DRAINAGE_PLAN_LIMITS,
  DRAINAGE_PLAN_SCHEMA_VERSION,
  planRoadsideDrainage,
  validateRoadsideDrainagePlan,
} from './drainage-plan.js';
export {
  DRAINAGE_MATERIAL_ROLES,
  buildDrainage,
  disposeDrainage,
} from '../village/drainage-geometry.js';
