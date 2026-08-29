// Palette provider boundary: canvas allocation and texture-paint RNG.
//
// Product path keeps browser defaults (document.createElement('canvas') + Math.random).
// Node gates and future non-DOM runtimes inject both; village determinism only swaps
// the RNG through setTextureRandom (palette.js) without touching createCanvas.
// Context objects are immutable; swapping means installing a new context.

function browserCreateCanvas() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error(
      'palette createCanvas: no document; inject createCanvas for non-browser runtimes',
    );
  }
  return document.createElement('canvas');
}

function browserRandom() {
  return Math.random();
}

/**
 * Build an immutable palette context.
 * @param {{ random?: () => number, createCanvas?: () => unknown }} [options]
 * @returns {{ random: () => number, createCanvas: () => unknown }}
 */
export function createPaletteContext(options = {}) {
  const random = typeof options.random === 'function' ? options.random : browserRandom;
  const createCanvas = typeof options.createCanvas === 'function'
    ? options.createCanvas
    : browserCreateCanvas;
  return Object.freeze({ random, createCanvas });
}
