// Renderer-free residential chimney grammar.
//
// Sources (see docs/architectural-authenticity.md §2.1): 아궁이(부엌) → 구들 → 굴뚝.
// This plan owns only the product-visible end of that chain: which kitchen wall
// the stack belongs to, the stack kind, and the local smoke emission point.
// It does not model interior 고래, regional frequency, or a freestanding exterior stove.

import { deepFreeze } from '../core/stable-seed.js';
import {
  planChogaKitchenOpening,
  planGiwaKitchenOpening,
} from '../layout/kitchen-opening-spatial.js';

export const CHIMNEY_KINDS = Object.freeze(['mud-stack', 'jeondol', 'none']);

/** Product style → chimney kind. Palace/temple/pavilion have no residential stack. */
export function resolveChimneyKind(style) {
  if (style === 'choga') return 'mud-stack';
  if (style === 'giwa') return 'jeondol';
  return 'none';
}

// Authored product dimensions — not surveyed national distributions.
// Keep builders and smoke emission in lock-step through this table.
const GIWA_JEONDOL = Object.freeze({
  // East of main half-width `a`, past the eave so smoke clears the roof.
  eaveClearance: 1.55,
  // South of the north wall line (-b); kitchen end sits on the east wall.
  northInset: 1.0,
  bodyWidth: 0.46,
  bodyHeight: 2.7,
  baseHeight: 0.22,
  baseExtra: 0.22,
  corniceExtra: 0.12,
  corniceHeight: 0.14,
  corniceLift: 0.05,
  capRoofLift: 0.28,
  yeongaBaseLift: 0.33,
  emissionAboveTallestYeonga: 0.06,
  yeonga: Object.freeze([
    Object.freeze({ dx: -0.18, dz: -0.04, h: 0.48, r: 0.055 }),
    Object.freeze({ dx: 0.03, dz: 0.11, h: 0.36, r: 0.062 }),
    Object.freeze({ dx: 0.18, dz: -0.10, h: 0.44, r: 0.050 }),
  ]),
});

const CHOGA_MUD = Object.freeze({
  // East kitchen corner, inset from the wall line toward the house interior.
  kitchenInsetX: 0.45,
  // Beyond the thatch rear eave so the column clears the roof.
  eaveOutsetZ: 0.28,
  stackHeight: 2.68,
  // Matches the historical material-heuristic lift (bbox top + 0.35).
  emissionAboveStack: 0.35,
  flueHeight: 0.5,
  flueWidth: 0.42,
  flueDepthPad: 0.2,
  // Lathe radii (r, y) for the organic mud stack silhouette.
  stackProfile: Object.freeze([
    Object.freeze([0.31, 0.00]), Object.freeze([0.32, 0.25]),
    Object.freeze([0.29, 0.60]), Object.freeze([0.27, 1.05]),
    Object.freeze([0.255, 1.55]), Object.freeze([0.25, 2.05]),
    Object.freeze([0.25, 2.35]), Object.freeze([0.21, 2.52]),
    Object.freeze([0.13, 2.63]), Object.freeze([0.0, 2.68]),
  ]),
});

function kitchenEndFromOpening(opening, role = 'agungi-source') {
  return Object.freeze({
    wall: opening.wall,
    wallX: opening.wallX,
    centerZ: opening.centerZ,
    openingWidth: opening.openingWidth,
    openingHeight: opening.openingHeight,
    spanZ: opening.spanZ,
    role,
  });
}

function nonePlan(style, kitchen = null) {
  return deepFreeze({
    version: 1,
    kind: 'none',
    style: style || 'none',
    kitchenEnd: kitchen
      ? kitchenEndFromOpening(kitchen)
      : null,
    emission: null,
  });
}

/**
 * Giwa (반가 기와) independent 전돌 stack outside the east eave, tied to the
 * east-wall kitchen opening plan.
 *
 * @param {{ halfWidthA: number, halfDepthB: number, kitchen?: object }} input
 */
export function planGiwaChimney(input = {}) {
  const halfWidthA = Number(input.halfWidthA);
  const halfDepthB = Number(input.halfDepthB);
  if (!Number.isFinite(halfWidthA) || halfWidthA <= 0) {
    throw new TypeError('planGiwaChimney requires a positive finite halfWidthA');
  }
  if (!Number.isFinite(halfDepthB) || halfDepthB <= 0) {
    throw new TypeError('planGiwaChimney requires a positive finite halfDepthB');
  }
  const kitchen = input.kitchen || planGiwaKitchenOpening(halfWidthA);
  if (kitchen.wall !== 'east' || Math.abs(kitchen.wallX - halfWidthA) > 1e-9) {
    throw new Error('giwa chimney kitchen end must sit on the east wall at halfWidthA');
  }

  const x = halfWidthA + GIWA_JEONDOL.eaveClearance;
  const z = -halfDepthB + GIWA_JEONDOL.northInset;
  const baseTop = GIWA_JEONDOL.baseHeight;
  const cTop = baseTop + GIWA_JEONDOL.bodyHeight;
  const yeongaBaseY = cTop + GIWA_JEONDOL.yeongaBaseLift;
  const tallestYeonga = Math.max(...GIWA_JEONDOL.yeonga.map((s) => s.h));
  const emissionY = yeongaBaseY + tallestYeonga + GIWA_JEONDOL.emissionAboveTallestYeonga;
  const cw = GIWA_JEONDOL.bodyWidth;

  return deepFreeze({
    version: 1,
    kind: 'jeondol',
    style: 'giwa',
    kitchenEnd: kitchenEndFromOpening(kitchen),
    base: Object.freeze({
      x, y: baseTop / 2, z,
      width: cw + GIWA_JEONDOL.baseExtra,
      height: baseTop,
    }),
    body: Object.freeze({
      x, y: baseTop + GIWA_JEONDOL.bodyHeight / 2, z,
      width: cw,
      height: GIWA_JEONDOL.bodyHeight,
    }),
    cornice: Object.freeze({
      x, y: cTop + GIWA_JEONDOL.corniceLift, z,
      width: cw + GIWA_JEONDOL.corniceExtra,
      height: GIWA_JEONDOL.corniceHeight,
    }),
    capRoof: Object.freeze({
      x, y: cTop + GIWA_JEONDOL.capRoofLift, z,
      radius: cw * 0.95,
      height: 0.30,
    }),
    bodyTopY: cTop,
    yeongaBaseY,
    yeonga: GIWA_JEONDOL.yeonga,
    // Building-local point for smoke.js (group at origin).
    emission: Object.freeze({ x, y: emissionY, z }),
  });
}

/**
 * Choga mud stack at the +x kitchen corner, beyond the rear thatch eave,
 * linked to the east-wall kitchen opening.
 *
 * @param {{ eastWallX: number, zEave: number, backWallZ: number, kitchen?: object }} input
 */
export function planChogaChimney(input = {}) {
  const eastWallX = Number(input.eastWallX);
  const zEave = Number(input.zEave);
  const backWallZ = Number(input.backWallZ);
  if (!Number.isFinite(eastWallX)) {
    throw new TypeError('planChogaChimney requires a finite eastWallX');
  }
  if (!Number.isFinite(zEave) || zEave <= 0) {
    throw new TypeError('planChogaChimney requires a positive finite zEave');
  }
  if (!Number.isFinite(backWallZ)) {
    throw new TypeError('planChogaChimney requires a finite backWallZ');
  }
  const kitchen = input.kitchen || planChogaKitchenOpening(eastWallX);
  if (kitchen.wall !== 'east' || Math.abs(kitchen.wallX - eastWallX) > 1e-9) {
    throw new Error('choga chimney kitchen end must sit on the east wall at eastWallX');
  }

  const x = eastWallX - CHOGA_MUD.kitchenInsetX;
  const z = -zEave - CHOGA_MUD.eaveOutsetZ;
  const stackHeight = CHOGA_MUD.stackHeight;
  const flueDepth = Math.abs(z - backWallZ) + CHOGA_MUD.flueDepthPad;

  return deepFreeze({
    version: 1,
    kind: 'mud-stack',
    style: 'choga',
    kitchenEnd: kitchenEndFromOpening(kitchen),
    stack: Object.freeze({
      x, y: 0, z,
      height: stackHeight,
      profile: CHOGA_MUD.stackProfile,
    }),
    flue: Object.freeze({
      x,
      y: CHOGA_MUD.flueHeight / 2,
      z: (z + backWallZ) / 2,
      width: CHOGA_MUD.flueWidth,
      height: CHOGA_MUD.flueHeight,
      depth: flueDepth,
    }),
    // Building-local emission (group at origin; stack mesh at stack.x/z).
    emission: Object.freeze({
      x, y: stackHeight + CHOGA_MUD.emissionAboveStack, z,
    }),
  });
}

/**
 * Unified entry: style + envelope → plan. Unknown / non-residential styles
 * resolve to kind `none` without throwing.
 */
export function planResidentialChimney(input = {}) {
  const style = input.style || 'none';
  const kind = resolveChimneyKind(style);
  if (kind === 'none') return nonePlan(style, input.kitchen || null);
  if (kind === 'jeondol') {
    return planGiwaChimney({
      halfWidthA: input.halfWidthA ?? input.a,
      halfDepthB: input.halfDepthB ?? input.b,
      kitchen: input.kitchen,
    });
  }
  return planChogaChimney({
    eastWallX: input.eastWallX ?? input.wallX ?? input.xR,
    zEave: input.zEave,
    backWallZ: input.backWallZ ?? input.zB,
    kitchen: input.kitchen,
  });
}
