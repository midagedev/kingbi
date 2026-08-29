// Runtime-facing compatibility façade. Product palette assembly lives with the
// village generators so legacy populate orchestration never imports upward into
// runtime. New runtime consumers may keep this stable path.
export { createVillageYardLife } from '../../generators/village/yard-life-product.js';
