// Renderer-free temple entry-sequence contract.
//
// Courtyard/extended compounds read as a secular→sacred approach:
//   gate → stair-apron → pass-under (누하) → court
// Mountain profiles keep the same order but express the stair as apron tiers
// rather than a free-standing run. Compact hermitages omit the pass-under.
//
// The planner owns ordered pure records; renderers may raise court meshes and
// open a lower corridor on the pass-under hall but must not invent a second
// sequence from the variant name alone.

import { templeRoleArchitecture, templeHallEaveFootprint } from './role-hierarchy.js';

export const TEMPLE_ENTRY_SEQUENCE_SCHEMA_VERSION = 1;
export const TEMPLE_ENTRY_STAGE_KINDS = Object.freeze([
  'gate', 'stair-apron', 'pass-under', 'court',
]);
export const TEMPLE_ENTRY_PROFILES = Object.freeze(['flat', 'mountain']);

const round = (value, digits = 3) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const point = (x, z) => ({ x: round(x), z: round(z) });

const PASS_UNDER_ID = 'entry-pavilion';
const PASS_UNDER_SCALE = 0.62;
const PASS_UNDER_FRONT_BAYS = 3;
const PASS_UNDER_SIDE_BAYS = 2;
const PASS_UNDER_CORRIDOR_WIDTH = 2.6;
const PASS_UNDER_CORRIDOR_HEIGHT = 2.45;

/** Canonical stage-kind order for a variant + site profile. */
export function templeEntrySequenceKinds(variant, profile = 'flat') {
  const mountain = profile === 'mountain';
  if (variant === 'compact') {
    return mountain
      ? Object.freeze(['gate', 'stair-apron', 'court'])
      : Object.freeze(['gate', 'court']);
  }
  if (variant === 'courtyard' || variant === 'extended') {
    return Object.freeze(['gate', 'stair-apron', 'pass-under', 'court']);
  }
  throw new RangeError(`unsupported temple entry variant: ${variant}`);
}

function normalizeProfile(profile) {
  return profile === 'mountain' ? 'mountain' : 'flat';
}

function southGate(plan) {
  return plan.gates?.find((gate) => gate.id === 'south-gate') || plan.gates?.[0] || null;
}

function worshipCourt(plan) {
  return plan.courtyards?.find((court) => court.role === 'worship')
    || plan.courtyards?.[plan.courtyards.length - 1]
    || null;
}

function entryCourt(plan) {
  return plan.courtyards?.find((court) => court.role === 'entry') || null;
}

function passUnderBuilding(plan) {
  return plan.buildings?.find((building) => (
    building.id === PASS_UNDER_ID
    || building.role === 'gate-pavilion'
    || building.passUnder?.openLower
  )) || null;
}

function courtCenter(court) {
  if (!court?.polygon?.length) return point(0, 0);
  let x = 0;
  let z = 0;
  for (const corner of court.polygon) {
    x += corner.x;
    z += corner.z;
  }
  const count = court.polygon.length;
  return point(x / count, z / count);
}

function courtSouthZ(court) {
  if (!court?.polygon?.length) return 0;
  return Math.max(...court.polygon.map((corner) => corner.z));
}

function courtNorthZ(court) {
  if (!court?.polygon?.length) return 0;
  return Math.min(...court.polygon.map((corner) => corner.z));
}

function mountainTierElevations(variant) {
  if (variant === 'extended') {
    return Object.freeze([0, 0.55, 1.15]);
  }
  if (variant === 'courtyard') {
    return Object.freeze([0, 0.45, 0.95]);
  }
  return Object.freeze([0, 0.4]);
}

/**
 * Local placement for the processional pass-under pavilion.
 * Sits on the south edge of the worship court so the walk continues north to
 * the main hall without inventing a second axis.
 */
export function templePassUnderPlacement(plan) {
  const gate = southGate(plan);
  const court = worshipCourt(plan);
  if (!gate || !court) return null;
  const axisX = Number.isFinite(plan.axis?.offsetX) ? plan.axis.offsetX : gate.position.x;
  const southZ = courtSouthZ(court);
  const northZ = courtNorthZ(court);
  // Keep a short apron south of the pavilion and leave the worship court open
  // north of it. Extended has a deeper precinct so the pavilion sits further
  // from the main hall than a courtyard hermitage would allow.
  const span = Math.max(4, southZ - northZ);
  const z = plan.variant === 'extended'
    ? round(southZ - Math.min(4.2, span * 0.18))
    : round(southZ - Math.min(3.6, span * 0.16));
  return {
    id: PASS_UNDER_ID,
    role: 'gate-pavilion',
    position: point(axisX, z),
    yaw: 0,
    frontBays: PASS_UNDER_FRONT_BAYS,
    sideBays: PASS_UNDER_SIDE_BAYS,
    scale: PASS_UNDER_SCALE,
    passUnder: Object.freeze({
      openLower: true,
      corridorWidth: PASS_UNDER_CORRIDOR_WIDTH,
      corridorHeight: PASS_UNDER_CORRIDOR_HEIGHT,
    }),
  };
}

function withPassUnderArchitecture(placement, seed) {
  const architecture = templeRoleArchitecture(placement.role, {
    seed,
    id: placement.id,
  });
  const eave = templeHallEaveFootprint({
    architecture,
    frontBays: placement.frontBays,
    sideBays: placement.sideBays,
    scale: placement.scale,
    yaw: placement.yaw,
    position: placement.position,
  });
  return {
    id: placement.id,
    role: placement.role,
    style: 'temple',
    position: placement.position,
    yaw: placement.yaw,
    frontBays: placement.frontBays,
    sideBays: placement.sideBays,
    scale: placement.scale,
    formality: architecture.formality,
    architecturalRank: architecture.architecturalRank,
    architectureId: architecture.id,
    roofGrammar: architecture.roofGrammar,
    bracketGrammar: architecture.bracketGrammar,
    eaveGrammar: architecture.eaveGrammar,
    massingGrammar: architecture.massingGrammar,
    eaveFootprint: {
      localWidth: round(eave.localWidth),
      localDepth: round(eave.localDepth),
      width: round(eave.width),
      depth: round(eave.depth),
      polygon: eave.polygon.map((corner) => point(corner.x, corner.z)),
    },
    footprint: { width: round(eave.width), depth: round(eave.depth) },
    passUnder: {
      openLower: true,
      corridorWidth: placement.passUnder.corridorWidth,
      corridorHeight: placement.passUnder.corridorHeight,
    },
  };
}

function stage(order, kind, fields) {
  return {
    id: fields.id,
    kind,
    order,
    role: fields.role,
    position: point(fields.position.x, fields.position.z),
    level: Number.isInteger(fields.level) ? fields.level : 0,
    elevation: round(Number.isFinite(fields.elevation) ? fields.elevation : 0),
    ...(fields.refId ? { refId: fields.refId } : {}),
    ...(fields.stairMode ? { stairMode: fields.stairMode } : {}),
    ...(fields.tiers ? { tiers: fields.tiers } : {}),
    ...(fields.passUnder ? { passUnder: fields.passUnder } : {}),
  };
}

function flatStairStage(order, gate, court, profile) {
  const gateZ = gate.position.z;
  const courtZ = courtSouthZ(court);
  const midZ = (gateZ + courtZ) * 0.5;
  const axisX = gate.position.x;
  if (profile === 'mountain') {
    const elevations = mountainTierElevations('courtyard');
    const span = Math.max(2.4, gateZ - courtZ);
    const tiers = elevations.map((elevation, index) => {
      const t0 = index / elevations.length;
      const t1 = (index + 1) / elevations.length;
      return {
        id: `apron-tier-${index}`,
        level: index,
        elevation: round(elevation),
        southZ: round(gateZ - span * t0),
        northZ: round(gateZ - span * t1),
      };
    });
    return stage(order, 'stair-apron', {
      id: 'entry-stair-apron',
      role: 'approach-apron',
      position: point(axisX, midZ),
      level: tiers.length - 1,
      elevation: tiers[tiers.length - 1].elevation,
      stairMode: 'apron-tiers',
      tiers,
    });
  }
  return stage(order, 'stair-apron', {
    id: 'entry-stair-apron',
    role: 'approach-apron',
    position: point(axisX, midZ),
    level: 0,
    elevation: 0.18,
    stairMode: 'single-run',
    tiers: [{
      id: 'apron-tier-0',
      level: 0,
      elevation: 0.18,
      southZ: round(gateZ - 0.4),
      northZ: round(courtZ + 0.4),
    }],
  });
}

function mountainExtendedStair(order, plan, gate) {
  const worship = worshipCourt(plan);
  const elevations = mountainTierElevations('extended');
  const southZ = gate.position.z;
  const northZ = courtSouthZ(worship);
  const span = Math.max(3, southZ - northZ);
  const tiers = elevations.map((elevation, index) => {
    const t0 = index / elevations.length;
    const t1 = (index + 1) / elevations.length;
    return {
      id: `apron-tier-${index}`,
      level: index,
      elevation: round(elevation),
      southZ: round(southZ - span * t0),
      northZ: round(southZ - span * t1),
    };
  });
  const midZ = (southZ + northZ) * 0.5;
  return stage(order, 'stair-apron', {
    id: 'entry-stair-apron',
    role: 'approach-apron',
    position: point(gate.position.x, midZ),
    level: tiers.length - 1,
    elevation: tiers[tiers.length - 1].elevation,
    stairMode: 'apron-tiers',
    tiers,
  });
}

/**
 * Derive ordered entry-sequence records from an assembled TemplePlan.
 * Does not mutate the plan; callers that need pass-under buildings or mountain
 * court elevations should use applyTempleEntrySequence().
 */
export function planTempleEntrySequence(plan, options = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('TemplePlan is required for entry sequence');
  }
  const variant = plan.variant;
  if (variant !== 'compact' && variant !== 'courtyard' && variant !== 'extended') {
    throw new RangeError(`unsupported temple entry variant: ${variant}`);
  }
  const profile = normalizeProfile(options.profile ?? plan.entrySequence?.profile ?? plan.settings?.entryProfile);
  const kinds = templeEntrySequenceKinds(variant, profile);
  const gate = southGate(plan);
  const court = worshipCourt(plan);
  if (!gate || !court) {
    throw new TypeError('TemplePlan needs a south gate and worship court for entry sequence');
  }

  const stages = [];
  let order = 0;
  for (const kind of kinds) {
    if (kind === 'gate') {
      stages.push(stage(order++, 'gate', {
        id: gate.id,
        role: gate.role || 'entry-gate',
        position: gate.position,
        level: 0,
        elevation: 0,
        refId: gate.id,
      }));
      continue;
    }
    if (kind === 'stair-apron') {
      if (profile === 'mountain' && variant === 'extended') {
        stages.push(mountainExtendedStair(order++, plan, gate));
      } else {
        stages.push(flatStairStage(order++, gate, court, profile));
      }
      continue;
    }
    if (kind === 'pass-under') {
      const pavilion = passUnderBuilding(plan);
      const placement = pavilion || templePassUnderPlacement(plan);
      if (!placement) {
        throw new TypeError('TemplePlan cannot place a pass-under stage');
      }
      const passUnder = pavilion?.passUnder || placement.passUnder || {
        openLower: true,
        corridorWidth: PASS_UNDER_CORRIDOR_WIDTH,
        corridorHeight: PASS_UNDER_CORRIDOR_HEIGHT,
      };
      stages.push(stage(order++, 'pass-under', {
        id: placement.id || PASS_UNDER_ID,
        role: placement.role || 'gate-pavilion',
        position: placement.position,
        level: profile === 'mountain' ? 1 : 0,
        elevation: profile === 'mountain' ? 0.55 : 0,
        refId: placement.id || PASS_UNDER_ID,
        passUnder: {
          openLower: passUnder.openLower !== false,
          corridorWidth: round(passUnder.corridorWidth ?? PASS_UNDER_CORRIDOR_WIDTH),
          corridorHeight: round(passUnder.corridorHeight ?? PASS_UNDER_CORRIDOR_HEIGHT),
        },
      }));
      continue;
    }
    if (kind === 'court') {
      const center = courtCenter(court);
      const elevation = Number.isFinite(court.elevation)
        ? court.elevation
        : (Number.isFinite(court.level) ? court.level * 0.55 : 0);
      stages.push(stage(order++, 'court', {
        id: court.id,
        role: court.role || 'worship',
        position: center,
        level: Number.isInteger(court.level) ? court.level : 0,
        elevation: round(elevation),
        refId: court.id,
      }));
    }
  }

  return {
    schemaVersion: TEMPLE_ENTRY_SEQUENCE_SCHEMA_VERSION,
    profile,
    stages,
  };
}

/**
 * Ensure the plan carries a complete entry sequence. Courtyard/extended gain a
 * processional pass-under pavilion when missing; mountain profiles raise court
 * aprons as the stair. Mutates `plan` and returns it.
 */
export function applyTempleEntrySequence(plan, options = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('TemplePlan is required for entry sequence');
  }
  const profile = normalizeProfile(options.profile ?? plan.settings?.entryProfile);
  if (!plan.settings || typeof plan.settings !== 'object') plan.settings = {};
  plan.settings.entryProfile = profile;

  const needsPassUnder = plan.variant === 'courtyard' || plan.variant === 'extended';
  if (needsPassUnder && !passUnderBuilding(plan)) {
    const placement = templePassUnderPlacement(plan);
    if (placement) {
      plan.buildings.push(withPassUnderArchitecture(placement, plan.seed >>> 0));
    }
  } else if (needsPassUnder) {
    // Existing gate-pavilion must expose the open-lower corridor contract.
    for (const building of plan.buildings) {
      if (building.role === 'gate-pavilion' || building.id === PASS_UNDER_ID) {
        building.passUnder = {
          openLower: true,
          corridorWidth: round(building.passUnder?.corridorWidth ?? PASS_UNDER_CORRIDOR_WIDTH),
          corridorHeight: round(building.passUnder?.corridorHeight ?? PASS_UNDER_CORRIDOR_HEIGHT),
        };
      }
    }
  }

  if (profile === 'mountain') {
    const elevations = mountainTierElevations(plan.variant);
    const entry = entryCourt(plan);
    const worship = worshipCourt(plan);
    if (plan.variant === 'extended' && entry && worship) {
      entry.level = 0;
      entry.elevation = elevations[0];
      worship.level = elevations.length - 1;
      worship.elevation = elevations[elevations.length - 1];
    } else if (worship) {
      worship.level = elevations.length - 1;
      worship.elevation = elevations[elevations.length - 1];
    }
  } else {
    for (const court of plan.courtyards || []) {
      if (!Number.isInteger(court.level)) court.level = 0;
      if (!Number.isFinite(court.elevation)) court.elevation = 0;
    }
  }

  plan.entrySequence = planTempleEntrySequence(plan, { profile });
  // Mirror stage elevation onto the pass-under building so compound can lift
  // the raised hall without re-deriving the sequence.
  const passStage = plan.entrySequence.stages.find((stageRecord) => stageRecord.kind === 'pass-under');
  if (passStage) {
    const building = plan.buildings.find((candidate) => (
      candidate.id === passStage.refId || candidate.id === passStage.id
    ));
    if (building) building.elevation = passStage.elevation;
  }
  return plan;
}

/**
 * Semantic safety for entry sequences: kind order, south→north procession,
 * and pass-under open-lower contract. Renderer-free.
 */
export function templeEntrySequenceIssues(plan) {
  const issues = [];
  const sequence = plan?.entrySequence;
  if (!sequence) {
    issues.push('entry sequence missing');
    return issues;
  }
  if (sequence.schemaVersion !== TEMPLE_ENTRY_SEQUENCE_SCHEMA_VERSION) {
    issues.push(`entry sequence schema ${sequence.schemaVersion} unsupported`);
  }
  const profile = normalizeProfile(sequence.profile);
  let expected;
  try {
    expected = templeEntrySequenceKinds(plan.variant, profile);
  } catch (error) {
    issues.push(error.message);
    return issues;
  }
  const stages = Array.isArray(sequence.stages) ? sequence.stages : [];
  const kinds = stages.map((stageRecord) => stageRecord?.kind);
  if (kinds.length !== expected.length || kinds.some((kind, index) => kind !== expected[index])) {
    issues.push(`entry sequence order ${kinds.join('|') || '<empty>'} != ${expected.join('|')}`);
  }
  for (let index = 0; index < stages.length; index++) {
    const stageRecord = stages[index];
    if (!stageRecord || stageRecord.order !== index) {
      issues.push(`entry stage ${index} has unstable order index`);
    }
    if (!Number.isFinite(stageRecord?.position?.x) || !Number.isFinite(stageRecord?.position?.z)) {
      issues.push(`entry stage ${stageRecord?.id || index} lacks a processional position`);
    }
  }
  // +z is south: the visitor walks from higher z toward lower z.
  for (let index = 1; index < stages.length; index++) {
    const previous = stages[index - 1];
    const current = stages[index];
    if (current.position.z > previous.position.z + 0.05) {
      issues.push(`${current.id}: leaves the south→north processional order`);
    }
  }
  const passUnder = stages.find((stageRecord) => stageRecord.kind === 'pass-under');
  if (passUnder) {
    if (!passUnder.passUnder?.openLower) {
      issues.push(`${passUnder.id}: pass-under must keep an open lower corridor`);
    }
    const building = plan.buildings?.find((candidate) => (
      candidate.id === passUnder.refId || candidate.id === passUnder.id
    ));
    if (!building) {
      issues.push(`${passUnder.id}: pass-under building missing from plan`);
    } else if (!building.passUnder?.openLower) {
      issues.push(`${building.id}: pass-under building lost openLower`);
    }
  }
  const stair = stages.find((stageRecord) => stageRecord.kind === 'stair-apron');
  if (stair) {
    if (profile === 'mountain' && stair.stairMode !== 'apron-tiers') {
      issues.push(`${stair.id}: mountain stair must use apron tiers`);
    }
    if (profile === 'flat' && stair.stairMode !== 'single-run') {
      issues.push(`${stair.id}: flat stair must use a single run`);
    }
    if (!Array.isArray(stair.tiers) || stair.tiers.length < 1) {
      issues.push(`${stair.id}: stair-apron tiers missing`);
    }
  }
  return issues;
}

/** True when a building is an open lower corridor and must not block south light. */
export function templeBuildingIsOpenPassUnder(building) {
  return !!(building?.passUnder?.openLower);
}

export function templeEntryPassUnderId() {
  return PASS_UNDER_ID;
}

// Keep corridor dimensions addressable for compound/renderer consumers.
export const TEMPLE_PASS_UNDER_DEFAULTS = Object.freeze({
  id: PASS_UNDER_ID,
  scale: PASS_UNDER_SCALE,
  frontBays: PASS_UNDER_FRONT_BAYS,
  sideBays: PASS_UNDER_SIDE_BAYS,
  corridorWidth: PASS_UNDER_CORRIDOR_WIDTH,
  corridorHeight: PASS_UNDER_CORRIDOR_HEIGHT,
});
