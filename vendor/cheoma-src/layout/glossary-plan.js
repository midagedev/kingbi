// Renderer-free focus glossary anchors (#216).
// Local house-frame labels for study: 처마·용마루·기단·창방|서까래·공포·창호·기와|이엉.
// Positions are product teaching points derived from computeLayout geometry —
// not surveyed restoration of a named monument. JSON-safe, frozen, no THREE.

export const GLOSSARY_SCHEMA_VERSION = 1;

/** Canonical label ids in stable teaching order. */
export const GLOSSARY_LABEL_IDS = Object.freeze([
  'podium',
  'changho',
  'changbang',
  'rafter',
  'bracket',
  'eave',
  'giwa',
  'ieung',
  'ridge',
]);

/** One-line product disclaimer (Korean); UI may i18n but the product text is this. */
export const GLOSSARY_DISCLAIMER_KO = '제품 해석 · 실측 복원 아님';

const FINITE = (n) => Number.isFinite(n);

function freezeLabel(label) {
  return Object.freeze({
    id: label.id,
    local: Object.freeze({ x: label.local.x, y: label.local.y, z: label.local.z }),
  });
}

/**
 * Whether a focus buildingSpec may show the exterior glossary overlay.
 * Product scope: residential FULL (giwa/choga) or hero. Compounds (궁·절·ㅁ자) fail closed.
 */
export function isGlossarySubject(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (spec.family === 'palace-compound' || spec.family === 'temple') return false;
  if (spec.family === 'mja' || spec.mjaHouse) return false;
  if (spec.hero === true) return true;
  return spec.kind === 'giwa' || spec.kind === 'choga';
}

/**
 * Bracket stack present → 공포 (+ 서까래 frame slot). Mindori residential → 창방.
 * Hero palace / palace style uses brackets; giwa/choga/hanok hero are mindori.
 */
export function glossaryHasBrackets(spec) {
  if (!isGlossarySubject(spec)) return false;
  if (spec.hero === true) return (spec.heroStyle || 'hanok') === 'palace';
  const style = spec.params?.style || spec.kind;
  return style === 'palace' || style === 'temple';
}

/** Roof cover token for the 기와/이엉 slot. */
export function glossaryRoofCover(spec) {
  if (!isGlossarySubject(spec)) return null;
  if (spec.kind === 'choga' && !spec.hero) return 'thatch';
  return 'tile';
}

/**
 * Plan local anchors from a computeLayout result + subject flags.
 * @param {{ layout: object, hasBrackets?: boolean, roofCover?: 'tile'|'thatch' }} input
 * @returns {Readonly<{ schemaVersion: number, labels: readonly object[], disclaimer: string }>|null}
 */
export function planGlossaryAnchors(input = {}) {
  const layout = input.layout;
  if (!layout || typeof layout !== 'object') return null;

  const {
    W, D, podTopY, colTopY, plateY, plateH, bracketH,
    eaveInnerY, eaveEdgeY, zEave, ridgeY,
  } = layout;
  const ridgeH = FINITE(layout.ridgeH) ? layout.ridgeH
    : (FINITE(layout.totalH) && FINITE(ridgeY) ? Math.max(0, layout.totalH - ridgeY) : 0.4);

  const required = [W, D, podTopY, colTopY, plateY, eaveEdgeY, zEave, ridgeY];
  if (!required.every(FINITE) || W <= 0 || D <= 0) return null;

  const hasBrackets = input.hasBrackets === true;
  const roofCover = input.roofCover === 'thatch' ? 'thatch' : 'tile';
  const pH = FINITE(plateH) && plateH > 0 ? plateH : 0.2;
  const bH = FINITE(bracketH) && bracketH > 0 ? bracketH : 0.3;
  const eaveInner = FINITE(eaveInnerY) ? eaveInnerY : eaveEdgeY;
  const frontWallZ = D * 0.5;
  const labels = [];

  // 기단 — front face mid-height, slightly proud of the wall line.
  labels.push({
    id: 'podium',
    local: { x: 0, y: Math.max(0.08, podTopY * 0.55), z: frontWallZ + 0.45 },
  });

  // 창호 — primary south frontage, mid opening height.
  const wallSpan = Math.max(0.6, colTopY - podTopY);
  labels.push({
    id: 'changho',
    local: {
      x: 0,
      y: podTopY + Math.min(1.35, wallSpan * 0.52),
      z: frontWallZ + 0.12,
    },
  });

  // Frame slot: 창방 (mindori) or 서까래 (bracketed / double-eave story).
  if (hasBrackets) {
    labels.push({
      id: 'rafter',
      local: {
        x: 0,
        y: (eaveInner + eaveEdgeY) * 0.5,
        z: zEave * 0.62,
      },
    });
    labels.push({
      id: 'bracket',
      local: {
        x: 0,
        y: plateY + bH * 0.42,
        z: frontWallZ + 0.08,
      },
    });
  } else {
    labels.push({
      id: 'changbang',
      local: {
        x: 0,
        y: plateY - pH * 0.35,
        z: frontWallZ + 0.06,
      },
    });
  }

  // 처마 — front eave edge tip.
  labels.push({
    id: 'eave',
    local: { x: 0, y: eaveEdgeY, z: zEave },
  });

  // 기와 / 이엉 — mid roof face between eave and ridge.
  labels.push({
    id: roofCover === 'thatch' ? 'ieung' : 'giwa',
    local: {
      x: 0,
      y: eaveEdgeY + (ridgeY - eaveEdgeY) * 0.48,
      z: zEave * 0.38,
    },
  });

  // 용마루 — ridge centre, slightly above the surface line.
  labels.push({
    id: 'ridge',
    local: {
      x: 0,
      y: ridgeY + Math.max(0.08, ridgeH * 0.35),
      z: 0,
    },
  });

  if (labels.length < 3 || labels.length > 8) return null;

  return Object.freeze({
    schemaVersion: GLOSSARY_SCHEMA_VERSION,
    disclaimer: GLOSSARY_DISCLAIMER_KO,
    labels: Object.freeze(labels.map(freezeLabel)),
  });
}

/**
 * Transform house-local glossary points into world space using the same
 * scale → houseLocal → rotY → centre/baseY order as chimeWorldCorners / houseMatrix.
 * Pure: no THREE.
 */
export function glossaryLocalToWorld(local, parcel, {
  sx = 1, sy = 1, sz = 1, baseY, mirrorX = 1, houseLocalX = 0, houseLocalZ = 0, rotY = 0,
} = {}) {
  if (!local || !parcel?.center) return null;
  if (![local.x, local.y, local.z].every(FINITE)) return null;
  const mx = FINITE(mirrorX) ? mirrorX : 1;
  const scaleX = (FINITE(sx) ? sx : 1) * mx;
  const scaleY = FINITE(sy) ? sy : 1;
  const scaleZ = FINITE(sz) ? sz : 1;
  const originY = FINITE(baseY)
    ? baseY
    : (FINITE(parcel.baseY) ? parcel.baseY
      : (FINITE(parcel.padY) ? parcel.padY : 0));
  const lx = houseLocalX + local.x * scaleX;
  const ly = local.y * scaleY;
  const lz = houseLocalZ + local.z * scaleZ;
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  return Object.freeze({
    x: parcel.center.x + lx * cos + lz * sin,
    y: originY + ly,
    z: parcel.center.z - lx * sin + lz * cos,
  });
}
