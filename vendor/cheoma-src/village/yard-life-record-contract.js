import { YARD_LIFE_SCHEMA_VERSION } from './yard-life-plan.js';

// Renderer-independent validation for the JSON-safe planner/renderer boundary.
// Keep this module free of Three, DOM APIs, and ambient randomness so external
// consumers can reject malformed records before allocating render resources.

export const YARD_LIFE_MATERIAL_ROLES = Object.freeze([
  'wood',
  'onggi',
  'straw',
  'stone',
  'chaff',
  'fiber',
]);

export const YARD_LIFE_SEASONS = Object.freeze([
  'spring',
  'summer',
  'autumn',
  'winter',
]);

export const YARD_LIFE_WEATHER = Object.freeze([
  'clear',
  'rain',
  'snow',
]);

const MOTIFS = Object.freeze({
  'spring-seed-prep': Object.freeze({
    season: 'spring',
    variants: new Set(['onggi-bowl', 'wooden-bowl']),
    weather: new Set(['clear', 'rain']),
    kinds: new Set(['water-bowl', 'seed-basket']),
  }),
  'autumn-threshing': Object.freeze({
    season: 'autumn',
    variants: new Set(['gesang', 'taetdol']),
    weather: new Set(['clear']),
    kinds: new Set([
      'threshing-bench',
      'threshing-stone',
      'bound-sheaf',
      'chaff-patch',
    ]),
  }),
  'winter-fuel': Object.freeze({
    season: 'winter',
    variants: new Set(['firewood-stack', 'straw-covered-firewood']),
    weather: new Set(['clear', 'rain', 'snow']),
    kinds: new Set(['split-log', 'stack-support', 'straw-cover']),
  }),
});

const EXPECTED_ROLES = Object.freeze({
  'water-bowl': new Set(['onggi', 'wood']),
  'seed-basket': new Set(['fiber']),
  'threshing-bench': new Set(['wood']),
  'threshing-stone': new Set(['stone']),
  'bound-sheaf': new Set(['straw']),
  'chaff-patch': new Set(['chaff']),
  'split-log': new Set(['wood']),
  'stack-support': new Set(['wood']),
  'straw-cover': new Set(['straw']),
});

const COUNT_LIMITS = Object.freeze({
  'water-bowl': [1, 1],
  'seed-basket': [1, 2],
  'threshing-bench': [1, 1],
  'threshing-stone': [1, 1],
  'bound-sheaf': [2, 4],
  'chaff-patch': [1, 1],
  'split-log': [8, 14],
  'stack-support': [1, 1],
  'straw-cover': [1, 1],
});

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function positive(value, label) {
  const result = finite(value, label);
  if (!(result > 0)) throw new RangeError(`${label} must be positive`);
  return result;
}

function countOf(part, label) {
  const count = part?.count ?? 1;
  if (!Number.isInteger(count)) throw new TypeError(`${label}.count must be an integer`);
  const limits = COUNT_LIMITS[part.kind];
  if (!limits || count < limits[0] || count > limits[1]) {
    throw new RangeError(
      `${label}.count for ${part.kind} must be ${limits?.[0] ?? 0}..${limits?.[1] ?? 0}`,
    );
  }
  return count;
}

function assertExactSet(values, expected, label) {
  if (!Array.isArray(values) || values.length !== expected.size) {
    throw new RangeError(`${label} must contain exactly ${[...expected].join(', ')}`);
  }
  const actual = new Set(values);
  if (actual.size !== values.length || actual.size !== expected.size) {
    throw new RangeError(`${label} must not contain duplicate or extra values`);
  }
  for (const value of actual) {
    if (!expected.has(value)) {
      throw new RangeError(`${label} contains unsupported value ${value}`);
    }
  }
  return actual;
}

function assertRequiredKinds(parts, expected, label) {
  const actual = new Set(parts.map((part) => part.kind));
  if (actual.size !== parts.length) {
    throw new RangeError(`${label}.parts must not contain duplicate part kinds`);
  }
  if (actual.size !== expected.size || [...actual].some((kind) => !expected.has(kind))) {
    throw new RangeError(`${label}.parts do not exactly match the ${label} variant`);
  }
  return actual;
}

function requiredKinds(record) {
  if (record.motif === 'spring-seed-prep') {
    return new Set(['water-bowl', 'seed-basket']);
  }
  if (record.motif === 'autumn-threshing') {
    return new Set([
      record.variant === 'gesang' ? 'threshing-bench' : 'threshing-stone',
      'bound-sheaf',
      'chaff-patch',
    ]);
  }
  return new Set([
    'split-log',
    'stack-support',
    ...(record.variant === 'straw-covered-firewood' ? ['straw-cover'] : []),
  ]);
}

function normalizeYardLifeRecord(record, index = 0, heightAt) {
  const label = `yard-life record[${index}]`;
  if (!record || typeof record !== 'object') throw new TypeError(`${label} must be an object`);
  if (record.schema !== YARD_LIFE_SCHEMA_VERSION) {
    throw new RangeError(`${label}.schema must be ${YARD_LIFE_SCHEMA_VERSION}`);
  }
  if (typeof record.id !== 'string' || !record.id || record.id.length > 160) {
    throw new TypeError(`${label}.id must be a non-empty string no longer than 160 characters`);
  }
  if (typeof record.owner?.parcelId !== 'string' || !record.owner.parcelId) {
    throw new TypeError(`${label}.owner.parcelId must be a non-empty string`);
  }
  const motif = MOTIFS[record.motif];
  if (!motif) throw new RangeError(`${label}.motif is unsupported`);
  if (record.season !== motif.season) {
    throw new RangeError(`${label}.season does not match ${record.motif}`);
  }
  if (!motif.variants.has(record.variant)) {
    throw new RangeError(`${label}.variant is unsupported for ${record.motif}`);
  }
  if (record.footprint?.shape !== 'rect') {
    throw new RangeError(`${label}.footprint must be an oriented rect`);
  }
  const halfX = positive(record.footprint.halfX, `${label}.footprint.halfX`);
  const halfZ = positive(record.footprint.halfZ, `${label}.footprint.halfZ`);
  const footprintYaw = finite(record.footprint.yaw, `${label}.footprint.yaw`);
  const x = finite(record.world?.x, `${label}.world.x`);
  const z = finite(record.world?.z, `${label}.world.z`);
  let y = record.world?.y;
  if (!Number.isFinite(y)) {
    if (typeof heightAt !== 'function') {
      throw new TypeError(`${label}.world.y must be finite when heightAt is absent`);
    }
    y = heightAt(x, z);
  }
  finite(y, `${label} base height`);
  const yaw = finite(record.world?.yaw, `${label}.world.yaw`);
  const scale = positive(record.scale ?? 1, `${label}.scale`);
  positive(record.height, `${label}.height`);

  const allowedWeather = assertExactSet(
    record.weather?.allow,
    motif.weather,
    `${label}.weather.allow`,
  );
  if (!Array.isArray(record.parts) || record.parts.length === 0) {
    throw new TypeError(`${label}.parts must be a non-empty array`);
  }
  const parts = record.parts.map((part, partIndex) => {
    const partLabel = `${label}.parts[${partIndex}]`;
    if (!part || !motif.kinds.has(part.kind)) {
      throw new RangeError(`${partLabel}.kind is unsupported for ${record.motif}`);
    }
    if (!EXPECTED_ROLES[part.kind]?.has(part.materialRole)) {
      throw new RangeError(`${partLabel}.materialRole is unsupported for ${part.kind}`);
    }
    return {
      kind: part.kind,
      materialRole: part.materialRole,
      count: countOf(part, partLabel),
    };
  });

  assertRequiredKinds(parts, requiredKinds(record), label);
  const bowl = parts.find((part) => part.kind === 'water-bowl');
  if (record.variant === 'onggi-bowl' && bowl?.materialRole !== 'onggi') {
    throw new RangeError(`${label} onggi-bowl requires an onggi water-bowl`);
  }
  if (record.variant === 'wooden-bowl' && bowl?.materialRole !== 'wood') {
    throw new RangeError(`${label} wooden-bowl requires a wood water-bowl`);
  }

  const partRoles = new Set(parts.map((part) => part.materialRole));
  if (record.materialRoles != null) {
    assertExactSet(record.materialRoles, partRoles, `${label}.materialRoles`);
  }

  return {
    source: record,
    id: record.id,
    ownerId: record.owner.parcelId,
    season: record.season,
    motif: record.motif,
    variant: record.variant,
    weather: allowedWeather,
    parts,
    world: { x, y, z, yaw },
    footprint: { halfX, halfZ, yaw: footprintYaw },
    scale,
  };
}

export function validateYardLifeRecords(records, heightAt) {
  if (!Array.isArray(records)) throw new TypeError('yard-life records must be an array');
  const ids = new Set();
  return records.map((record, index) => {
    const normalized = normalizeYardLifeRecord(record, index, heightAt);
    if (ids.has(normalized.id)) throw new RangeError(`duplicate yard-life id ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
}
