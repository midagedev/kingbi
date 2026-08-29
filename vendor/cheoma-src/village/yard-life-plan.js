import { deepFreeze, normalizeStableSeed } from '../core/stable-seed.js';
import { hashString, makeRng } from '../rng.js';
import * as G from '../core/math/geom2.js';
import { parcelWorldPoint } from './parcel-contract.js';
import {
  YARD_HARD_GAP,
  yardLifePotentialSlots,
} from './yard-layout.js';

export const YARD_LIFE_SCHEMA_VERSION = 1;
export const YARD_LIFE_SEASONS = Object.freeze(['spring', 'autumn', 'winter']);

// Historical evidence decides the motif vocabulary; these dimensions remain a
// deliberately small product-tuning surface. They are conservative world-scale
// envelopes, not measurements claimed by the sources.
export const YARD_LIFE_MOTIFS = deepFreeze({
  'spring-seed-prep': {
    season: 'spring',
    weather: ['clear', 'rain'],
    slotClass: 'service-edge',
    halfX: 0.575,
    halfZ: 0.4,
    height: 0.34,
    scale: [0.9, 1.06],
  },
  'autumn-threshing': {
    season: 'autumn',
    weather: ['clear'],
    slotClass: 'open-work-yard',
    halfX: 0.775,
    halfZ: 0.425,
    height: 1.02,
    scale: [0.9, 1.06],
  },
  'winter-fuel': {
    season: 'winter',
    weather: ['clear', 'rain', 'snow'],
    slotClass: 'service-edge',
    halfX: 0.67,
    halfZ: 0.34,
    height: 0.82,
    scale: [0.9, 1.06],
  },
});

const FARM_WALLS = new Set(['open', 'brush', 'hedge', 'mud']);
const OWNER_SALT = 'yard-life-owner-v1';
const RECORD_SALT = 'yard-life-record-v1';

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function ownerSeed(parcel, seed) {
  return hashString([
    OWNER_SALT,
    normalizeStableSeed(seed),
    parcel.id,
    finite(parcel.seed, hashString(String(parcel.id))) >>> 0,
  ].join('|'));
}

export function yardLifeHouseholdEligible(parcel) {
  if (!parcel || parcel.hero || !['giwa', 'choga'].includes(parcel.kind)) return false;
  if (typeof parcel.id !== 'string' || !parcel.id
    || !Number.isFinite(parcel.plotW) || !Number.isFinite(parcel.plotD)) return false;
  // v1 is agricultural yard life: choga is accepted directly; giwa needs one
  // existing livelihood/lot signal rather than being treated as a generic prop host.
  return parcel.kind === 'choga'
    || !!parcel.vegBed
    || !!parcel.yardStack
    || FARM_WALLS.has(parcel.wallType)
    || finite(parcel.wealth, 0.5) <= 0.62;
}

function selectionProbability(parcel) {
  let probability = parcel.kind === 'choga' ? 0.105 : 0.065;
  if (parcel.vegBed) probability += 0.025;
  if (parcel.yardStack) probability += 0.015;
  if (FARM_WALLS.has(parcel.wallType)) probability += 0.01;
  probability += (1 - Math.max(0, Math.min(1, finite(parcel.wealth, 0.5)))) * 0.02;
  return Math.max(0.06, Math.min(0.16, probability));
}

function materialRoles(parts) {
  return [...new Set(parts.map((part) => part.materialRole))];
}

function motifDrafts(parcel, rng) {
  const springVariant = rng() < 0.58 ? 'onggi-bowl' : 'wooden-bowl';
  const autumnVariant = rng() < 0.7 ? 'gesang' : 'taetdol';
  const winterVariant = rng() < 0.36 ? 'straw-covered-firewood' : 'firewood-stack';
  return [
    {
      motif: 'spring-seed-prep',
      variant: springVariant,
      scale: rng.range(...YARD_LIFE_MOTIFS['spring-seed-prep'].scale),
      yaw: rng.range(-0.14, 0.14),
      parts: [
        { kind: 'water-bowl', materialRole: springVariant === 'onggi-bowl' ? 'onggi' : 'wood', count: 1 },
        { kind: 'seed-basket', materialRole: 'fiber', count: rng.int(1, 2) },
      ],
    },
    {
      motif: 'autumn-threshing',
      variant: autumnVariant,
      scale: rng.range(...YARD_LIFE_MOTIFS['autumn-threshing'].scale),
      yaw: Math.PI * 0.5 + rng.range(-0.12, 0.12),
      parts: [
        {
          kind: autumnVariant === 'gesang' ? 'threshing-bench' : 'threshing-stone',
          materialRole: autumnVariant === 'gesang' ? 'wood' : 'stone',
          count: 1,
        },
        { kind: 'bound-sheaf', materialRole: 'straw', count: rng.int(2, 4) },
        { kind: 'chaff-patch', materialRole: 'chaff', count: 1 },
      ],
    },
    {
      motif: 'winter-fuel',
      variant: winterVariant,
      scale: rng.range(...YARD_LIFE_MOTIFS['winter-fuel'].scale),
      yaw: rng.range(-0.08, 0.08),
      parts: [
        { kind: 'split-log', materialRole: 'wood', count: rng.int(8, 14) },
        { kind: 'stack-support', materialRole: 'wood', count: 1 },
        ...(winterVariant === 'straw-covered-firewood'
          ? [{ kind: 'straw-cover', materialRole: 'straw', count: 1 }]
          : []),
      ],
    },
  ].map((draft) => {
    const spec = YARD_LIFE_MOTIFS[draft.motif];
    return {
      ...draft,
      season: spec.season,
      slotClass: spec.slotClass,
      footprint: {
        shape: 'rect',
        halfX: spec.halfX * draft.scale,
        halfZ: spec.halfZ * draft.scale,
        yaw: draft.yaw,
      },
      height: spec.height * draft.scale,
    };
  });
}

function sampleGround(heightAt, parcel, world) {
  if (Number.isFinite(parcel.baseY)) return parcel.baseY;
  if (typeof heightAt === 'function') {
    const sampled = heightAt(world.x, world.z, parcel);
    if (Number.isFinite(sampled)) return sampled;
  }
  return 0;
}

function makeRecord(parcel, draft, slot, heightAt) {
  const localYaw = draft.yaw;
  const facingYaw = G.facingY(parcel.frontDir || { x: 0, z: 1 });
  const worldPoint = parcelWorldPoint(parcel, slot);
  const groundY = sampleGround(heightAt, parcel, worldPoint);
  const parts = draft.parts.map((part) => ({ ...part }));
  return deepFreeze({
    schema: YARD_LIFE_SCHEMA_VERSION,
    id: `${RECORD_SALT}:${parcel.id}:${draft.season}:${draft.motif}`,
    owner: {
      parcelId: parcel.id,
      seed: finite(parcel.seed, hashString(String(parcel.id))) >>> 0,
      kind: parcel.kind,
      wealth: finite(parcel.wealth, 0.5),
    },
    season: draft.season,
    motif: draft.motif,
    variant: draft.variant,
    weather: { allow: [...YARD_LIFE_MOTIFS[draft.motif].weather] },
    slot: slot.id,
    local: { x: slot.x, y: 0, z: slot.z, yaw: localYaw },
    world: { x: worldPoint.x, y: groundY, z: worldPoint.z, yaw: facingYaw + localYaw },
    footprint: { ...draft.footprint },
    height: draft.height,
    scale: draft.scale,
    yaw: localYaw,
    slotClass: draft.slotClass,
    materialRoles: materialRoles(parts),
    parts,
  });
}

// Emits all three seasonal records for each selected household. Selection and all
// motif variation use a parcel-local hash stream, so adding this plan does not
// consume village plan/populate RNG or global Math.random. Stable seasonal batches
// may be built once while flora reserves the union of the returned potential slots.
export function planYardLife(parcels, { seed = 0, heightAt } = {}) {
  if (!Array.isArray(parcels)) return Object.freeze([]);
  const ordered = parcels.slice().sort((a, b) => {
    const left = String(a?.id), right = String(b?.id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const records = [];
  const viable = [];
  let eligibleCount = 0;
  for (const parcel of ordered) {
    if (!yardLifeHouseholdEligible(parcel)) continue;
    eligibleCount++;
    const rng = makeRng(ownerSeed(parcel, seed));
    const probability = selectionProbability(parcel);
    const selectionRoll = rng();

    const drafts = motifDrafts(parcel, rng);
    const placements = [];
    const usedServiceSlots = new Set();
    for (const draft of drafts) {
      const slots = yardLifePotentialSlots(parcel, {
        footprint: draft.footprint,
        height: draft.height,
        slotClass: draft.slotClass,
      });
      const distinct = draft.slotClass === 'service-edge'
        ? slots.filter((slot) => !usedServiceSlots.has(slot.id))
        : slots;
      const choices = distinct.length ? distinct : slots;
      if (!choices.length) {
        placements.length = 0;
        break;
      }
      const slot = rng.pick(choices);
      if (draft.slotClass === 'service-edge') usedServiceSlots.add(slot.id);
      placements.push({ draft, slot });
    }
    if (placements.length !== drafts.length) continue;
    viable.push({
      ownerId: parcel.id,
      priority: selectionRoll / probability,
      parcel,
      placements,
    });
    if (selectionRoll < probability) {
      for (const { draft, slot } of placements) {
        records.push(makeRecord(parcel, draft, slot, heightAt));
      }
    }
  }
  // A ten-house hamlet should not randomly lose the feature altogether. When a
  // sufficiently large eligible population has at least one collision-safe
  // household but every independent sparse roll misses, promote only the most
  // nearly selected viable owner. This remains seed-local, deterministic, and
  // bounded to one owner rather than raising density for every parcel.
  if (records.length === 0 && eligibleCount >= 8 && viable.length) {
    viable.sort((left, right) => (
      left.priority - right.priority
      || left.ownerId.localeCompare(right.ownerId)
    ));
    for (const { draft, slot } of viable[0].placements) {
      records.push(makeRecord(viable[0].parcel, draft, slot, heightAt));
    }
  }
  return deepFreeze(records);
}

// Converts only selected household records into the existing yard flora obstacle
// vocabulary. Exact oriented renderer rectangles become conservative bounding
// circles; only records sharing the exact same slot collapse to their largest
// envelope, so every distinct all-season potential position remains reserved.
export function yardLifeRecordsToHardObstacles(records, parcelId = null) {
  const groups = new Map();
  for (const record of records || []) {
    const ownerId = record?.owner?.parcelId;
    if (!ownerId || (parcelId != null && ownerId !== parcelId)) continue;
    if (record?.footprint?.shape !== 'rect'
      || !Number.isFinite(record.footprint.halfX)
      || !Number.isFinite(record.footprint.halfZ)
      || !Number.isFinite(record.local?.x)
      || !Number.isFinite(record.local?.z)) continue;
    // Slot ids describe a semantic edge, not one fixed coordinate: footprints
    // with different dimensions are inset to different local x/z positions.
    // Collapse only records that truly share the same authored point.
    const localX = Object.is(record.local.x, -0) ? 0 : record.local.x;
    const localZ = Object.is(record.local.z, -0) ? 0 : record.local.z;
    const key = `${ownerId}|${record.slot}|${localX}|${localZ}`;
    const prior = groups.get(key);
    const radius = Math.hypot(record.footprint.halfX, record.footprint.halfZ) + YARD_HARD_GAP;
    if (!prior || radius > prior.radius) {
      groups.set(key, {
        id: `yard-life-obstacle:${ownerId}:${record.slot}:${localX}:${localZ}`,
        ownerId,
        kind: 'yard-life',
        motif: record.motif,
        slot: record.slot,
        mode: 'trunk',
        shape: 'circle',
        x: localX,
        z: localZ,
        radius,
        height: record.height,
      });
    } else {
      prior.height = Math.max(prior.height, record.height);
    }
  }
  return deepFreeze([...groups.values()].sort((a, b) => (
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )));
}
