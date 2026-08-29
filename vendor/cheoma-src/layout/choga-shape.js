// Renderer-free shape frame shared by the choga planner and production builder.
// Local +z is south/front. These are product geometry limits, not historical
// frequency or proportion claims.

export const CHOGA_SHAPE_DEFAULTS = Object.freeze({
  frontBays: 3,
  sideBays: 2,
  centerBayW: 3,
  middleBayW: 2.6,
  endBayW: 2.6,
  centerBayD: 2.2,
  endBayD: 2.2,
  columnRadius: 0.12,
});

export const CHOGA_SHAPE_BOUNDS = Object.freeze({
  frontBays: Object.freeze({ min: 3, max: 9 }),
  sideBays: Object.freeze({ min: 1, max: 5 }),
  bayWidth: Object.freeze({ min: 1.4, max: 5 }),
  columnRadius: Object.freeze({ min: 0.05, max: 0.35 }),
});

function supportedNumber(source, key, { min, max }, integer = false) {
  const value = source[key];
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return CHOGA_SHAPE_DEFAULTS[key];
  }
  if (typeof value !== 'number') {
    throw new TypeError(`choga ${key} must be a number`);
  }
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`choga ${key} is outside the supported ${min}..${max} range`);
  }
  return value;
}

export function normalizeChogaShape(P = {}) {
  const source = P && typeof P === 'object' ? P : {};
  return Object.freeze({
    frontBays: supportedNumber(source, 'frontBays', CHOGA_SHAPE_BOUNDS.frontBays, true),
    sideBays: supportedNumber(source, 'sideBays', CHOGA_SHAPE_BOUNDS.sideBays, true),
    centerBayW: supportedNumber(source, 'centerBayW', CHOGA_SHAPE_BOUNDS.bayWidth),
    middleBayW: supportedNumber(source, 'middleBayW', CHOGA_SHAPE_BOUNDS.bayWidth),
    endBayW: supportedNumber(source, 'endBayW', CHOGA_SHAPE_BOUNDS.bayWidth),
    centerBayD: supportedNumber(source, 'centerBayD', CHOGA_SHAPE_BOUNDS.bayWidth),
    endBayD: supportedNumber(source, 'endBayD', CHOGA_SHAPE_BOUNDS.bayWidth),
    columnRadius: supportedNumber(source, 'columnRadius', CHOGA_SHAPE_BOUNDS.columnRadius),
  });
}
