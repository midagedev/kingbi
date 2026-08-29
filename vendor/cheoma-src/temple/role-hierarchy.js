// Renderer-free architectural hierarchy for temple halls.
//
// The planner writes one complete grammar onto every building. Renderers consume
// those values directly; they must not recover roof/bracket/eave choices from a
// role name. Ratios are restrained product translations of the institutional
// evidence documented in docs/temple-generator.md, not measurements copied from
// one monument.

const BASE_BAYS = Object.freeze({
  front: Object.freeze({ center: 4.2, middle: 3.4, end: 3.4 }),
  side: Object.freeze({ center: 2.4, middle: 2.4, end: 2.4 }),
});

const freezeGrammar = (grammar) => Object.freeze({
  ...grammar,
  roofGrammar: Object.freeze({ ...grammar.roofGrammar }),
  bracketGrammar: Object.freeze({ ...grammar.bracketGrammar }),
  eaveGrammar: Object.freeze({ ...grammar.eaveGrammar }),
  massingGrammar: Object.freeze({ ...grammar.massingGrammar }),
});

const MAIN_MATBAE = freezeGrammar({
  // Chilgok Songnimsa Daeungjeon: matbae roof with dapo brackets.
  id: 'principal-matbae-dapo',
  architecturalRank: 4,
  formality: 'hall',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.62,
    profileCurve: 0.50,
    ridgeHeight: 0.44,
    gableOverhang: 0.92,
    cornerLift: 0.20,
    planCurve: 0.08,
  },
  bracketGrammar: {
    family: 'dapo',
    tiers: 2,
    interBrackets: 1,
    scale: 1.18,
    density: 'column-and-intercolumn',
  },
  eaveGrammar: {
    overhang: 1.82,
    drop: 0.29,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 4.08,
    podiumTiers: 1,
    podiumTierHeight: 1.42,
  },
});

const MAIN_PALJAK = freezeGrammar({
  // Buseoksa Muryangsujeon: paljak roof with jusimpo brackets.
  id: 'principal-paljak-jusimpo',
  architecturalRank: 4,
  formality: 'hall',
  roofGrammar: {
    family: 'paljak',
    type: 'paljak',
    pitch: 0.68,
    profileCurve: 0.54,
    ridgeHeight: 0.48,
    gableOverhang: 0,
    cornerLift: 0.48,
    planCurve: 0.18,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.42,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.88,
    drop: 0.31,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 4.18,
    podiumTiers: 1,
    podiumTierHeight: 1.42,
  },
});

const SUBSIDIARY_MATBAE = freezeGrammar({
  id: 'subsidiary-matbae-jusimpo',
  architecturalRank: 3,
  formality: 'hall',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.58,
    profileCurve: 0.46,
    ridgeHeight: 0.38,
    gableOverhang: 0.70,
    cornerLift: 0.14,
    planCurve: 0.05,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.16,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.52,
    drop: 0.29,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 3.58,
    podiumTiers: 1,
    podiumTierHeight: 0.92,
  },
});

const SUBSIDIARY_PALJAK = freezeGrammar({
  id: 'subsidiary-paljak-jusimpo',
  architecturalRank: 3,
  formality: 'hall',
  roofGrammar: {
    family: 'paljak',
    type: 'paljak',
    pitch: 0.60,
    profileCurve: 0.48,
    ridgeHeight: 0.40,
    gableOverhang: 0,
    cornerLift: 0.34,
    planCurve: 0.12,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.12,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.58,
    drop: 0.30,
    layers: 2,
  },
  massingGrammar: {
    columnHeight: 3.62,
    podiumTiers: 1,
    podiumTierHeight: 0.92,
  },
});

const LECTURE = freezeGrammar({
  id: 'lecture-matbae-minimal',
  architecturalRank: 2,
  formality: 'domestic',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.50,
    profileCurve: 0.38,
    ridgeHeight: 0.30,
    gableOverhang: 0.46,
    cornerLift: 0.07,
    planCurve: 0.03,
  },
  bracketGrammar: {
    family: 'minimal-column-head',
    tiers: 0,
    interBrackets: 0,
    scale: 0.96,
    density: 'column-head',
  },
  eaveGrammar: {
    // Share the modest service-hall roof skin; the lecture hall's hierarchy is
    // carried by its taller columns, podium, and bracket scale, not a material
    // variant that would buy no additional silhouette.
    overhang: 1.12,
    drop: 0.27,
    layers: 1,
  },
  massingGrammar: {
    columnHeight: 3.22,
    podiumTiers: 1,
    podiumTierHeight: 0.62,
  },
});

const DOMESTIC = freezeGrammar({
  id: 'domestic-matbae-minimal',
  architecturalRank: 1,
  formality: 'domestic',
  roofGrammar: {
    family: 'matbae',
    type: 'matbae',
    pitch: 0.50,
    profileCurve: 0.38,
    ridgeHeight: 0.30,
    gableOverhang: 0.46,
    cornerLift: 0.07,
    planCurve: 0.03,
  },
  bracketGrammar: {
    family: 'minimal-column-head',
    tiers: 0,
    interBrackets: 0,
    scale: 0.84,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.12,
    drop: 0.27,
    layers: 1,
  },
  massingGrammar: {
    columnHeight: 2.88,
    podiumTiers: 1,
    podiumTierHeight: 0.46,
  },
});

const PAVILION = freezeGrammar({
  id: 'ritual-pavilion-paljak',
  architecturalRank: 2,
  formality: 'pavilion',
  roofGrammar: {
    family: 'paljak',
    type: 'paljak',
    pitch: 0.60,
    profileCurve: 0.50,
    ridgeHeight: 0.38,
    gableOverhang: 0,
    cornerLift: 0.38,
    planCurve: 0.14,
  },
  bracketGrammar: {
    family: 'jusimpo',
    tiers: 1,
    interBrackets: 0,
    scale: 1.04,
    density: 'column-head',
  },
  eaveGrammar: {
    overhang: 1.52,
    drop: 0.29,
    layers: 1,
  },
  massingGrammar: {
    columnHeight: 3.48,
    podiumTiers: 1,
    podiumTierHeight: 0.48,
  },
});

export const TEMPLE_ROLE_HIERARCHY = Object.freeze({
  // Repertoire order is part of the seed-stable public contract. The canonical
  // product seed selects the restrained matbae family; other seeds still expose
  // the documented paljak/dapo alternative without raising the default budget.
  'main-hall': Object.freeze([MAIN_PALJAK, MAIN_MATBAE]),
  'subsidiary-hall': Object.freeze([SUBSIDIARY_PALJAK, SUBSIDIARY_MATBAE]),
  'lecture-hall': Object.freeze([LECTURE]),
  yosa: Object.freeze([DOMESTIC]),
  seonbang: Object.freeze([DOMESTIC]),
  'gate-pavilion': Object.freeze([PAVILION]),
  'bell-pavilion': Object.freeze([PAVILION]),
});

function stringHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cloneArchitecture(source) {
  return {
    id: source.id,
    architecturalRank: source.architecturalRank,
    formality: source.formality,
    roofGrammar: { ...source.roofGrammar },
    bracketGrammar: { ...source.bracketGrammar },
    eaveGrammar: { ...source.eaveGrammar },
    massingGrammar: { ...source.massingGrammar },
  };
}

export function templeRoleArchitecture(role, { seed = 1, id = role } = {}) {
  const repertoire = TEMPLE_ROLE_HIERARCHY[role];
  if (!repertoire) throw new RangeError(`unsupported temple architectural role: ${role}`);
  const index = (stringHash(`${seed >>> 0}:${id}:${role}`) % repertoire.length);
  return cloneArchitecture(repertoire[index]);
}

export function templeHallBuilderParams(architecture) {
  if (!architecture?.roofGrammar || !architecture?.bracketGrammar
    || !architecture?.eaveGrammar || !architecture?.massingGrammar) {
    throw new TypeError('complete temple hall architecture is required');
  }
  const roof = architecture.roofGrammar;
  const bracket = architecture.bracketGrammar;
  const eave = architecture.eaveGrammar;
  const massing = architecture.massingGrammar;
  return {
    centerBayW: BASE_BAYS.front.center,
    middleBayW: BASE_BAYS.front.middle,
    endBayW: BASE_BAYS.front.end,
    centerBayD: BASE_BAYS.side.center,
    endBayD: BASE_BAYS.side.end,
    roofType: roof.type,
    roofPitch: roof.pitch,
    profileCurve: roof.profileCurve,
    ridgeH: roof.ridgeHeight,
    gableOverhang: roof.gableOverhang,
    cornerLift: roof.cornerLift,
    planCurve: roof.planCurve,
    bracketTiers: bracket.tiers,
    interBrackets: bracket.interBrackets,
    bracketScale: bracket.scale,
    eaveOverhang: eave.overhang,
    eaveDrop: eave.drop,
    doubleEave: eave.layers === 2,
    columnHeight: massing.columnHeight,
    podiumTiers: massing.podiumTiers,
    podiumTierH: massing.podiumTierHeight,
  };
}

function baySpan(count, widths) {
  let total = 0;
  for (let index = 0; index < count; index++) {
    const fromCenter = Math.abs(index - (count - 1) / 2);
    total += fromCenter < 0.6
      ? widths.center
      : (index === 0 || index === count - 1) ? widths.end : widths.middle;
  }
  return total;
}

export function templeHallEaveFootprint({
  architecture,
  frontBays = 3,
  sideBays = 2,
  scale = 1,
  yaw = 0,
  position = { x: 0, z: 0 },
} = {}) {
  const roof = architecture?.roofGrammar;
  const eave = architecture?.eaveGrammar;
  if (!roof || !eave) throw new TypeError('complete temple roof/eave grammar is required');
  const columnWidth = baySpan(frontBays, BASE_BAYS.front);
  const columnDepth = baySpan(sideBays, BASE_BAYS.side);
  const curvedExtra = roof.planCurve || 0;
  const localHalfWidth = roof.type === 'matbae'
    ? columnWidth / 2 + (roof.gableOverhang || 0) + curvedExtra
    : columnWidth / 2 + eave.overhang + curvedExtra;
  const localHalfDepth = columnDepth / 2 + eave.overhang + curvedExtra;
  const halfWidth = localHalfWidth * scale;
  const halfDepth = localHalfDepth * scale;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const polygon = [
    { x: -halfWidth, z: halfDepth },
    { x: halfWidth, z: halfDepth },
    { x: halfWidth, z: -halfDepth },
    { x: -halfWidth, z: -halfDepth },
  ].map((point) => ({
    x: position.x + point.x * cos + point.z * sin,
    z: position.z - point.x * sin + point.z * cos,
  }));
  const xs = polygon.map((point) => point.x);
  const zs = polygon.map((point) => point.z);
  return {
    localWidth: localHalfWidth * 2 * scale,
    localDepth: localHalfDepth * 2 * scale,
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...zs) - Math.min(...zs),
    polygon,
  };
}
