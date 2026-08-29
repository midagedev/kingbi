// Reusable, borrowed-material sijeon renderer and explicit lifecycle API.
export {
  SIJEON_FACADE_BAYS,
  SIJEON_FACADE_SCHEMA_VERSION,
  SIJEON_KIND_BREAK,
  SIJEON_KIND_SHOP,
  SIJEON_PLACEMENT,
  isSijeonShop,
  SIJEON_SIGN_POLICY,
  planSijeon,
  planSijeonFacade,
} from './sijeon-plan.js';
export {
  buildSijeon,
  disposeSijeon,
} from '../generators/village/sijeon.js';
