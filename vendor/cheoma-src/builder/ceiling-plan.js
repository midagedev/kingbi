// Renderer-free ceiling finish contract for eventual interiors.
//
// Evidence (docs/ceiling.md):
//   · 방 (ondol room): usually has 반자 — a separate cover under the roof frame.
//   · 대청 (open maru hall): usually 연등천장 — rafters exposed, no banja.
//   · Roof stack is always 서까래 → 산자/개판 → 기와; that structural underside is
//     NOT the room banja. Zero-thickness DoubleSide tile co-owned those planes and
//     z-fought; physical gaepan thickness is the structure layer only.
//
// Product phasing:
//   1. Roof structure always owns tile + gaepan layers (and rafters where present).
//   2. This plan records per-space finish so a later interior pass can emit banja
//      geometry only over 방 zones without changing roof structure.
//   3. No banja mesh is required until interior volumes are product-visible.

import { ROOF_SHELL_THICKNESS } from '../core/surface-clearance.js';

export const CEILING_PLAN_SCHEMA_VERSION = 1;

/** How the occupant-facing ceiling of a space is finished. */
export const CEILING_FINISH = Object.freeze({
  /** Exposed rafters + gaepan/sanja between — typical 대청 / eave underside read. */
  YEONDEUNG: 'yeondeung',
  /** Separate cover under the roof frame, usually papered — typical 온돌 방. */
  BANJA: 'banja',
  /** Lattice well ceiling — palace/temple halls; not residential default. */
  WELL: 'well',
});

/** Physical layers of the roof envelope (not room finishes). */
export const ROOF_STRUCTURE_LAYER = Object.freeze({
  TILE: 'tile',
  /** Structural underside of the tile stack (개판/산자 하면). */
  GAEPAN: 'gaepan',
  RAFTER: 'rafter',
});

export const CEILING_ZONE_STATUS = Object.freeze({
  /** Structure already present in the roof mesh (tile/gaepan/rafters). */
  STRUCTURE: 'structure',
  /** Finish planned for interior pass; no room mesh yet. */
  PLANNED: 'planned',
  /** Finish geometry already in the scene graph. */
  RENDERED: 'rendered',
});

const FINISHES = new Set(Object.values(CEILING_FINISH));
const STATUSES = new Set(Object.values(CEILING_ZONE_STATUS));

function finite(n, label) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`ceiling plan ${label} must be a finite number`);
  }
  return n;
}

/**
 * @param {object} input
 * @param {string} input.spaceId
 * @param {string} input.finish
 * @param {string} [input.status]
 * @param {number} [input.floorY] world y of the space floor
 * @param {number} [input.ceilingY] world y of the planned finish plane (banja bottom)
 * @param {{ x0:number,x1:number,z0:number,z1:number }} [input.bounds] local plan AABB
 * @param {string} [input.notes]
 */
export function ceilingZone(input = {}) {
  const spaceId = String(input.spaceId || '').trim();
  if (!spaceId) throw new Error('ceiling zone requires spaceId');
  const finish = input.finish;
  if (!FINISHES.has(finish)) {
    throw new Error(`ceiling zone ${spaceId}: unknown finish ${finish}`);
  }
  const status = input.status || CEILING_ZONE_STATUS.PLANNED;
  if (!STATUSES.has(status)) {
    throw new Error(`ceiling zone ${spaceId}: unknown status ${status}`);
  }
  const zone = {
    spaceId,
    finish,
    status,
  };
  if (input.floorY != null) zone.floorY = finite(input.floorY, 'floorY');
  if (input.ceilingY != null) zone.ceilingY = finite(input.ceilingY, 'ceilingY');
  if (input.bounds) {
    const { x0, x1, z0, z1 } = input.bounds;
    zone.bounds = {
      x0: finite(x0, 'bounds.x0'),
      x1: finite(x1, 'bounds.x1'),
      z0: finite(z0, 'bounds.z0'),
      z1: finite(z1, 'bounds.z1'),
    };
    if (!(zone.bounds.x1 > zone.bounds.x0) || !(zone.bounds.z1 > zone.bounds.z0)) {
      throw new Error(`ceiling zone ${spaceId}: bounds must be non-empty`);
    }
  }
  if (input.notes) zone.notes = String(input.notes);
  return Object.freeze(zone);
}

/**
 * Immutable ceiling plan attached to a building root as userData.ceilingPlan.
 * JSON-safe (no Three, no functions).
 */
export function planCeiling(input = {}) {
  const style = String(input.style || 'giwa');
  const shellThickness = finite(
    input.shellThickness != null ? input.shellThickness : ROOF_SHELL_THICKNESS,
    'shellThickness',
  );
  if (!(shellThickness > 0)) throw new Error('shellThickness must be positive');

  const zonesIn = Array.isArray(input.zones) ? input.zones : [];
  const zones = zonesIn.map((z) => (z && z.spaceId && z.finish ? ceilingZone(z) : ceilingZone(z)));

  return Object.freeze({
    schemaVersion: CEILING_PLAN_SCHEMA_VERSION,
    style,
    roofStructure: Object.freeze({
      shellThickness,
      // Authored stack the roof mesh owns today.
      layers: Object.freeze([
        ROOF_STRUCTURE_LAYER.TILE,
        ROOF_STRUCTURE_LAYER.GAEPAN,
        ROOF_STRUCTURE_LAYER.RAFTER,
      ]),
      // Gaepan is structural underside, never a substitute for room banja.
      undersideIsRoomBanja: false,
    }),
    zones: Object.freeze(zones.slice()),
    // Interior banja meshes are deferred until room volumes are product-visible.
    banjaGeometry: 'deferred',
  });
}

/**
 * Residential giwa default: open daecheong = yeondeung; other bays = banja (planned).
 * Bounds are local building-frame AABB hints for a future interior pass.
 */
export function planGiwaCeiling({
  podiumTopY,
  columnTopY,
  eaveY,
  daecheong,
  rooms = [],
  shellThickness = ROOF_SHELL_THICKNESS,
} = {}) {
  const floorMaru = finite(podiumTopY, 'podiumTopY') + 0.42;
  // Banja sits under the frame — slightly below eave/column head, not at tile shell.
  const banjaY = Math.min(
    finite(columnTopY, 'columnTopY') - 0.08,
    finite(eaveY, 'eaveY') - 0.2,
  );
  const zones = [];

  if (daecheong) {
    zones.push(ceilingZone({
      spaceId: 'daecheong',
      finish: CEILING_FINISH.YEONDEUNG,
      status: CEILING_ZONE_STATUS.STRUCTURE,
      floorY: floorMaru,
      // Yeondeung has no separate finish plane; ceilingY is the gaepan/rafter band.
      ceilingY: finite(eaveY, 'eaveY') - shellThickness,
      bounds: daecheong.bounds,
      notes: 'Open maru hall — exposed rafters; no room banja',
    }));
  }

  for (const room of rooms) {
    zones.push(ceilingZone({
      spaceId: room.spaceId || 'room',
      finish: CEILING_FINISH.BANJA,
      status: CEILING_ZONE_STATUS.PLANNED,
      floorY: room.floorY != null ? room.floorY : finite(podiumTopY, 'podiumTopY') + 0.02,
      ceilingY: room.ceilingY != null ? room.ceilingY : banjaY,
      bounds: room.bounds,
      notes: room.notes || 'Ondol room banja deferred until interior volume pass',
    }));
  }

  // Whole-building eave underside is always structural yeondeung read from outside.
  zones.push(ceilingZone({
    spaceId: 'eave-underside',
    finish: CEILING_FINISH.YEONDEUNG,
    status: CEILING_ZONE_STATUS.STRUCTURE,
    ceilingY: finite(eaveY, 'eaveY') - shellThickness,
    notes: 'Exterior eave read — gaepan + rafters, not room banja',
  }));

  return planCeiling({
    style: 'giwa',
    shellThickness,
    zones,
  });
}

/** Palace/temple default: main hall well ceiling planned; structure is still tile+gaepan. */
export function planRankedHallCeiling({
  style = 'palace',
  podiumTopY = 0,
  columnTopY = 3,
  eaveY = 3.5,
  shellThickness = ROOF_SHELL_THICKNESS,
} = {}) {
  const finish = style === 'choga' ? CEILING_FINISH.YEONDEUNG : CEILING_FINISH.WELL;
  return planCeiling({
    style,
    shellThickness,
    zones: [
      ceilingZone({
        spaceId: 'main-hall',
        finish,
        status: finish === CEILING_FINISH.YEONDEUNG
          ? CEILING_ZONE_STATUS.STRUCTURE
          : CEILING_ZONE_STATUS.PLANNED,
        floorY: finite(podiumTopY, 'podiumTopY') + 0.4,
        ceilingY: finish === CEILING_FINISH.YEONDEUNG
          ? finite(eaveY, 'eaveY') - shellThickness
          : finite(columnTopY, 'columnTopY') - 0.12,
        notes: finish === CEILING_FINISH.WELL
          ? 'Palace/temple well ceiling deferred to interior hall pass'
          : 'Choga keeps yeondeung structural read',
      }),
      ceilingZone({
        spaceId: 'eave-underside',
        finish: CEILING_FINISH.YEONDEUNG,
        status: CEILING_ZONE_STATUS.STRUCTURE,
        ceilingY: finite(eaveY, 'eaveY') - shellThickness,
      }),
    ],
  });
}

/** Strict validation for attached userData / share / tests. */
export function assertCeilingPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('ceiling plan missing');
  if (plan.schemaVersion !== CEILING_PLAN_SCHEMA_VERSION) {
    throw new Error(`ceiling plan schemaVersion ${plan.schemaVersion} unsupported`);
  }
  if (!plan.roofStructure || plan.roofStructure.undersideIsRoomBanja !== false) {
    throw new Error('ceiling plan must declare undersideIsRoomBanja: false');
  }
  if (!(plan.roofStructure.shellThickness > 0)) {
    throw new Error('ceiling plan shellThickness must be positive');
  }
  if (!Array.isArray(plan.zones) || plan.zones.length < 1) {
    throw new Error('ceiling plan needs at least one zone');
  }
  let hasYeondeung = false;
  for (const z of plan.zones) {
    ceilingZone(z); // re-validate
    if (z.finish === CEILING_FINISH.YEONDEUNG) hasYeondeung = true;
  }
  if (!hasYeondeung) {
    throw new Error('ceiling plan must include at least one yeondeung zone (eave/structure)');
  }
  return plan;
}
