import {
  addSemanticRayRecord,
  createSemanticRayIndex,
  createSemanticRayQueryContext,
  prepareSemanticRayQuery,
  removeSemanticRayRecord,
  semanticRayQueryHit,
  traverseSemanticRayIndex,
} from './semantic-ray-index.js';
import {
  buildVillageDoorParcelRecords,
  buildVillageDoorRecords,
  buildVillageDoorTreeRecords,
} from './village-door-records.js';

// Door input needs the first meaningful rendered obstruction, not a recursive
// Raycaster walk over every Hanyang mesh. Forest/scatter vegetation is omitted:
// those layers follow focus tree-fade, while visible yard/guardian anchors are
// refreshed explicitly. All query work remains THREE/DOM-free and allocation-
// free after construction.

function optionalIndex(records) {
  if (!records.length) return null;
  const index = createSemanticRayIndex();
  for (const record of records) addSemanticRayRecord(index, record);
  return index;
}

const EMPTY_FIND_OPTIONS = Object.freeze({});

/**
 * Build a plan-backed, renderer-independent door occlusion index.
 *
 * find(ray, maxDistance, options) returns one stable mutable hit record (or null):
 * `{ distance, id, kind, parcelId, record }`. Callers should consume it before
 * the next find. `stats` is reset and filled without allocating query arrays.
 */
export function createVillageDoorOcclusion({
  plan,
  site,
  yardTrees = [],
  guardianTrees = plan?.features?.guardianTrees || [],
} = {}) {
  const index = createSemanticRayIndex();
  const authored = buildVillageDoorRecords(plan, site);
  const parcels = authored.parcels;
  for (const record of authored.records) addSemanticRayRecord(index, record);

  let yardTreeIndex = optionalIndex(buildVillageDoorTreeRecords(yardTrees, 'yard-tree', site));
  let guardianTreeIndex = optionalIndex(
    buildVillageDoorTreeRecords(guardianTrees, 'guardian-tree', site),
  );
  const query = createSemanticRayQueryContext();
  const hit = { distance: Infinity, id: null, kind: null, parcelId: null, record: null };
  const internalStats = { cells: 0, candidates: 0, solids: 0 };

  function refreshParcel(parcel) {
    const previous = parcels.get(parcel?.id) || [];
    const replacement = buildVillageDoorParcelRecords(parcel, site, authored.char01);
    const reusableSlots = previous.map((record) => record.slot);
    for (const record of previous) {
      removeSemanticRayRecord(index, record);
      index.records[record.slot] = null;
    }
    if (!replacement.length) {
      if (previous.length) parcels.delete(parcel.id);
      return false;
    }
    for (let recordIndex = 0; recordIndex < replacement.length; recordIndex++) {
      addSemanticRayRecord(
        index,
        replacement[recordIndex],
        reusableSlots[recordIndex] ?? index.records.length,
      );
    }
    parcels.set(parcel.id, replacement);
    return true;
  }

  // Flora replacement is already a deliberate generation/runtime event. Build
  // both small indices there so first hover never pays hidden allocation cost.
  function refreshFlora({ yardTreeAnchors = [], guardianAnchors = [] } = {}) {
    yardTreeIndex = optionalIndex(
      buildVillageDoorTreeRecords(yardTreeAnchors, 'yard-tree', site),
    );
    guardianTreeIndex = optionalIndex(
      buildVillageDoorTreeRecords(guardianAnchors, 'guardian-tree', site),
    );
    return {
      yardTrees: yardTreeIndex?.records.length || 0,
      guardianTrees: guardianTreeIndex?.records.length || 0,
    };
  }

  function find(ray, maxDistance, options = EMPTY_FIND_OPTIONS) {
    const {
      excludeParcelId = null,
      season = 'summer',
      stats = internalStats,
    } = options;
    // Door queries are finite camera-to-door segments. Reject an unbounded ray
    // rather than letting its empty-grid DDA walk forever.
    if (!prepareSemanticRayQuery(
      query, ray, maxDistance, excludeParcelId, season, stats,
    )) return null;

    traverseSemanticRayIndex(index, query);
    traverseSemanticRayIndex(yardTreeIndex, query);
    traverseSemanticRayIndex(guardianTreeIndex, query);
    if (!semanticRayQueryHit(query)) return null;
    hit.distance = query.best;
    hit.id = query.record.id;
    hit.kind = query.record.kind;
    hit.parcelId = query.record.parcelId;
    hit.record = query.record;
    return hit;
  }

  return {
    find,
    refreshParcel,
    refreshFlora,
    get recordCount() {
      return index.records.reduce((count, record) => count + (record?.active ? 1 : 0), 0);
    },
  };
}
