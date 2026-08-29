// Public renderer-free façade for reusable choga/giwa opening planning.
export {
  RESIDENTIAL_OPENING_DEFAULTS,
  RESIDENTIAL_OPENING_PARAM_KEYS,
  normalizeResidentialOpenings,
  planResidentialOpenings,
  residentialOpeningCapabilities,
  residentialOpeningSlots,
} from '../layout/residential-openings.js';
export {
  planChogaKitchenOpening,
  planGiwaKitchenOpening,
} from '../layout/kitchen-opening-spatial.js';
export {
  CHOGA_SHAPE_BOUNDS,
  CHOGA_SHAPE_DEFAULTS,
  normalizeChogaShape,
} from '../layout/choga-shape.js';
