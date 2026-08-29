// Public, renderer-free changho grammar for generators and focused interaction.
// Internal builders import the implementation directly; app/other projects use
// this façade so the src/api boundary remains one-way.
export {
  OPENING_DETAIL_KINDS,
  OPENING_DETAIL_STYLES,
  OPENING_DETAIL_TYPES,
  OPENING_MOTION_MODES,
  OPENING_LEAF_SURFACES,
  resolveOpeningDetailType,
  resolveOpeningDetailMotion,
  leafSurfaceForOpeningType,
  assertLawfulOpeningDetailSet,
  planOpeningDetail,
} from '../builder/opening-detail-plan.js';
