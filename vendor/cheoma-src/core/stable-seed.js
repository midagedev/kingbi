import { hashString } from '../rng.js';

// Public plans may be called from editors, URLs, or foreign generators where a
// seed is not necessarily a finite number. Canonicalize it without retaining
// caller-owned data or relying on JSON.stringify (BigInt/cycles are valid here).
function stableSeedText(value, stack = new Set()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return `string:${value}`;
  if (type === 'number') return `number:${Number.isFinite(value) ? value : String(value)}`;
  if (type === 'bigint') return `bigint:${value.toString()}`;
  if (type === 'boolean') return `boolean:${value}`;
  if (type === 'undefined') return 'undefined';
  if (type !== 'object') return `${type}:${String(value)}`;
  if (stack.has(value)) return '[circular]';
  stack.add(value);
  const text = Array.isArray(value)
    ? `[${value.map((child) => stableSeedText(child, stack)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => (
      `${stableSeedText(key, stack)}:${stableSeedText(value[key], stack)}`
    )).join(',')}}`;
  stack.delete(value);
  return text;
}

export function normalizeStableSeed(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return `seed-${hashString(stableSeedText(value)).toString(16)}`;
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
