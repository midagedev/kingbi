// Renderer-free roof rank and palace-ornament policy (#150 item C).
//
// Hierarchy (high → low): palace > magistracy/gaeksa > city-gate > giwa.
// Temple and choga sit outside the palace-style ladder; they resolve to the same
// ornament denial as giwa so japsang/chwidu cannot leak through style or roofType.
//
// Product ornament gate (more conservative than some secondary readings of
// 「잡상」 for 문루·관아): only rank `palace` receives palace-japsang / palace-chwidu.
// Magistracy and gaeksa may still use palace materials / dancheong / ridge plaster,
// but not those figures. City gates never receive palace ornaments.

export const ROOF_RANK = Object.freeze({
  PALACE: 'palace',
  MAGISTRACY: 'magistracy',
  CITY_GATE: 'city-gate',
  GIWA: 'giwa',
});

/** Stable high → low order for docs, gates, and UI. */
export const ROOF_RANK_ORDER = Object.freeze([
  ROOF_RANK.PALACE,
  ROOF_RANK.MAGISTRACY,
  ROOF_RANK.CITY_GATE,
  ROOF_RANK.GIWA,
]);

const LEVEL = Object.freeze({
  [ROOF_RANK.PALACE]: 3,
  [ROOF_RANK.MAGISTRACY]: 2,
  [ROOF_RANK.CITY_GATE]: 1,
  [ROOF_RANK.GIWA]: 0,
});

/** Product aliases that collapse onto the four public ranks. */
const ALIASES = Object.freeze({
  gaeksa: ROOF_RANK.MAGISTRACY,
  government: ROOF_RANK.MAGISTRACY,
  'guest-house': ROOF_RANK.MAGISTRACY,
  'gov-core': ROOF_RANK.MAGISTRACY,
  gate: ROOF_RANK.CITY_GATE,
  'city-wall-gate': ROOF_RANK.CITY_GATE,
  munru: ROOF_RANK.CITY_GATE,
  hanok: ROOF_RANK.GIWA,
  choga: ROOF_RANK.GIWA,
  temple: ROOF_RANK.GIWA,
});

export const PALACE_CHWIDU_NAME = 'palace-chwidu';
export const PALACE_JAPSANG_NAME = 'palace-japsang';

export function normalizeRoofRank(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL, key)) return key;
  if (Object.prototype.hasOwnProperty.call(ALIASES, key)) return ALIASES[key];
  return null;
}

export function roofRankLevel(rank) {
  const normalized = normalizeRoofRank(rank);
  return normalized == null ? -1 : LEVEL[normalized];
}

/** Positive when `a` is higher rank than `b`. */
export function compareRoofRank(a, b) {
  return roofRankLevel(a) - roofRankLevel(b);
}

function isCityGateContext(input = {}) {
  const kind = input.kind != null ? String(input.kind) : '';
  const family = input.family != null ? String(input.family) : '';
  const role = input.role != null ? String(input.role) : '';
  const placement = input.placement != null ? String(input.placement) : '';
  return kind === 'city-gate'
    || family === 'city-gate'
    || role === 'city-gate'
    || placement === 'city-gate'
    || normalizeRoofRank(input.roofRank) === ROOF_RANK.CITY_GATE;
}

/**
 * Resolve the public roof rank from plan/build context.
 *
 * Precedence:
 * 1. explicit `roofRank` (and known aliases)
 * 2. city-gate markers
 * 3. true palace compound / landmark kind `palace`
 * 4. magistracy/gaeksa cores that borrow palace style via `heroStyle: 'palace'`
 * 5. standalone `style: 'palace'` (PRESETS.korea / multi-area halls) → palace
 * 6. everything else → giwa (ornament denial)
 */
export function resolveRoofRank(input = {}) {
  const explicit = normalizeRoofRank(input.roofRank);
  if (explicit) return explicit;

  if (isCityGateContext(input)) return ROOF_RANK.CITY_GATE;

  const kind = input.kind != null ? String(input.kind) : null;
  const family = input.family != null ? String(input.family) : null;
  const heroStyle = input.heroStyle != null ? String(input.heroStyle) : null;
  const style = input.style != null ? String(input.style) : null;
  const placement = input.placement != null ? String(input.placement) : null;

  if (
    kind === 'palace'
    || family === 'palace-compound'
    || placement === 'landmark' && kind === 'palace'
    || input.palace === true
  ) {
    return ROOF_RANK.PALACE;
  }

  // Town/capital reserved cores borrow palace materials but are not multi-곽 palaces.
  if (
    heroStyle === 'palace'
    || family === 'government'
    || family === 'magistracy'
    || family === 'gaeksa'
  ) {
    return ROOF_RANK.MAGISTRACY;
  }

  if (style === 'palace') return ROOF_RANK.PALACE;

  return ROOF_RANK.GIWA;
}

/**
 * Palace-only roof figures. Ridge plaster and dancheong stay style-owned;
 * this policy only gates named japsang / chwidu meshes.
 */
export function roofOrnamentPolicy(rankOrInput) {
  const rank = typeof rankOrInput === 'string' || rankOrInput == null
    ? (normalizeRoofRank(rankOrInput) || ROOF_RANK.GIWA)
    : resolveRoofRank(rankOrInput);
  const palaceOrnaments = rank === ROOF_RANK.PALACE;
  return Object.freeze({
    rank,
    chwidu: palaceOrnaments,
    japsang: palaceOrnaments,
    chwiduName: PALACE_CHWIDU_NAME,
    japsangName: PALACE_JAPSANG_NAME,
  });
}

export function allowsPalaceRoofOrnaments(rankOrInput) {
  const policy = roofOrnamentPolicy(rankOrInput);
  return policy.chwidu && policy.japsang;
}

/**
 * Plan-facing helper: assign the roof rank field for a reserved hero parcel.
 * True multi-area palaces use features.palace + kind palace, not this path.
 */
export function planHeroRoofRank(heroStyle) {
  if (heroStyle === 'palace') return ROOF_RANK.MAGISTRACY;
  if (heroStyle === 'hanok') return ROOF_RANK.GIWA;
  return null;
}
