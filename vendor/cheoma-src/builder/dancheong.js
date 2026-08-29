// Renderer-free dancheong policy and Canvas2D painter.
//
// The public axes stay continuous, while texture sources are quantized into a small,
// deterministic grid. That keeps repeated edits and concurrent compounds from mutating
// one global canvas or creating an unbounded set of GPU programs/material definitions.

export const DANCHEONG_BUCKET_STEPS = 8;

export const DANCHEONG_DEFAULTS = Object.freeze({
  // Palace buildings default to restrained moro dancheong. The upper range is reserved
  // for a highest-rank hall when a caller deliberately raises the splendour control.
  palace: Object.freeze({ dancheongClarity: 0.68, dancheongSplendor: 0.28 }),
  // A temple preset represents the central worship hall; compound renderers step
  // subsidiary and domestic halls down independently.
  temple: Object.freeze({ dancheongClarity: 0.62, dancheongSplendor: 0.82 }),
});

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

function supportedStyle(style) {
  return style === 'palace' || style === 'temple';
}

function bucket(value) {
  return Math.round(clamp01(value) * DANCHEONG_BUCKET_STEPS);
}

function unbucket(index) {
  return index / DANCHEONG_BUCKET_STEPS;
}

export function dancheongGrade(splendor) {
  const value = clamp01(finite(splendor, 0));
  if (value < 0.4) return 'moro';
  if (value < 0.72) return 'geummoro';
  return 'geum';
}

/**
 * Normalize either public parameter names or the compact reusable-API aliases.
 * Ordinary giwa/choga styles deliberately return null: dancheong is not a generic
 * surface effect and must not leak into vernacular houses.
 */
export function resolveDancheong(style, input = {}) {
  if (!supportedStyle(style)) return null;
  const source = input?.dancheong || input || {};
  const defaults = DANCHEONG_DEFAULTS[style];
  const clarity = clamp01(finite(
    source.dancheongClarity ?? source.clarity,
    defaults.dancheongClarity,
  ));
  const splendor = clamp01(finite(
    source.dancheongSplendor ?? source.splendor,
    defaults.dancheongSplendor,
  ));
  const clarityBucket = bucket(clarity);
  const splendorBucket = bucket(splendor);
  return {
    style,
    dancheongClarity: clarity,
    dancheongSplendor: splendor,
    clarityBucket,
    splendorBucket,
    sourceClarity: unbucket(clarityBucket),
    sourceSplendor: unbucket(splendorBucket),
    grade: dancheongGrade(unbucket(splendorBucket)),
  };
}

/** Keep non-central temple halls below the main worship hall without a second planner. */
export function resolveTempleRoleDancheong(input, { role, formality } = {}) {
  const main = resolveDancheong('temple', input);
  if (role === 'main-hall') return main;
  const domestic = formality === 'domestic' || formality === 'pavilion';
  return resolveDancheong('temple', {
    dancheongClarity: Math.min(main.dancheongClarity * (domestic ? 0.72 : 0.86), 0.62),
    dancheongSplendor: Math.min(main.dancheongSplendor, domestic ? 0.30 : 0.56),
  });
}

export function dancheongSourceKey(config, kind) {
  if (!config || !supportedStyle(config.style)) return null;
  return `${config.style}:${config.clarityBucket}:${config.splendorBucket}:${kind}`;
}

const hex = (value) => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value).replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

const mix = (a, b, t) => {
  const x = hex(a), y = hex(b);
  const channel = (p, q) => Math.round(p + (q - p) * t).toString(16).padStart(2, '0');
  return `#${channel(x.r, y.r)}${channel(x.g, y.g)}${channel(x.b, y.b)}`;
};

function pigment(config) {
  const t = config.sourceClarity;
  const temple = config.style === 'temple';
  return {
    noerok: mix(temple ? 0x6c684e : 0x596755, 0x2e7257, t),
    noerokDark: mix(0x494638, 0x174737, t),
    juhong: mix(0x8f6047, 0xc84631, t),
    samcheong: mix(0x657987, 0x2766a3, t),
    yellow: mix(0xa68f58, 0xd6ad3f, t),
    white: mix(0xbeb69d, 0xeee8d8, t),
    ink: mix(0x51483c, 0x222c28, t),
    wood: mix(0x7e6849, 0x755033, t),
  };
}

function hashKey(value) {
  let h = 2166136261;
  for (let index = 0; index < value.length; index++) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFor(config, kind) {
  let state = hashKey(dancheongSourceKey(config, kind));
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function line(ctx, x1, y1, x2, y2, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

function lotus(ctx, cx, cy, radius, colors, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let index = 0; index < 8; index++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((index / 8) * Math.PI * 2);
    ctx.fillStyle = index % 2 ? colors.white : colors.samcheong;
    ctx.beginPath();
    ctx.ellipse(0, -radius * 0.55, radius * 0.16, radius * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = Math.max(0.8, radius * 0.035);
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = colors.juhong;
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.24, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colors.yellow;
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function ageSurface(ctx, width, height, config, colors, kind) {
  const age = 1 - config.sourceClarity;
  if (age <= 0.01) return;
  const rand = rngFor(config, kind);
  const spots = Math.round(12 + age * 42);
  for (let index = 0; index < spots; index++) {
    const x = rand() * width, y = rand() * height;
    const rx = 1.5 + rand() * (4 + age * 8);
    ctx.fillStyle = `${colors.wood}${Math.round((0.025 + rand() * 0.09) * age * 255).toString(16).padStart(2, '0')}`;
    ctx.beginPath(); ctx.ellipse(x, y, rx, rx * (0.35 + rand() * 0.45), rand(), 0, Math.PI * 2); ctx.fill();
  }
}

function paintBand(canvas, config) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const colors = pigment(config);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.noerok;
  ctx.fillRect(0, 0, width, height);

  // Moro meoricho: coloured head motifs terminate each member; the central field
  // remains line-only until the splendour axis explicitly advances to geummoro/geum.
  const end = 104;
  const bands = [colors.ink, colors.white, colors.juhong, colors.yellow, colors.samcheong, colors.white];
  const widths = [8, 8, 14, 12, 18, 7];
  for (const side of [0, 1]) {
    let cursor = side ? width : 0;
    bands.forEach((color, index) => {
      const w = widths[index];
      cursor += side ? -w : 0;
      ctx.fillStyle = color;
      ctx.fillRect(cursor, 0, w, height);
      cursor += side ? 0 : w;
    });
    const cx = side ? width - end * 0.72 : end * 0.72;
    lotus(ctx, cx, height / 2, height * 0.38, colors, 0.92);
  }
  line(ctx, 0, 5, width, 5, colors.white, 3);
  line(ctx, 0, height - 5, width, height - 5, colors.ink, 3);
  line(ctx, end, 10, end, height - 10, colors.white, 2);
  line(ctx, width - end, 10, width - end, height - 10, colors.white, 2);

  const centerLeft = end + 9;
  const centerRight = width - end - 9;
  if (config.grade === 'moro') {
    // Gyepung is intentionally empty except for framing lines.
    line(ctx, centerLeft, height * 0.37, centerRight, height * 0.37, colors.ink, 2);
    line(ctx, centerLeft, height * 0.63, centerRight, height * 0.63, colors.white, 2);
  } else {
    const dense = config.grade === 'geum';
    const step = dense ? 34 : 56;
    for (let x = centerLeft + step / 2; x < centerRight; x += step) {
      ctx.save();
      ctx.translate(x, height / 2);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = colors.yellow;
      ctx.lineWidth = dense ? 4 : 3;
      const size = dense ? 17 : 14;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.restore();
      if (dense) lotus(ctx, x, height / 2, 12, colors, 0.94);
    }
    if (!dense) {
      line(ctx, centerLeft, height * 0.25, centerRight, height * 0.25, colors.white, 2);
      line(ctx, centerLeft, height * 0.75, centerRight, height * 0.75, colors.ink, 2);
    }
  }
  ageSurface(ctx, width, height, config, colors, 'band');
}

function paintRound(canvas, config, lotusFace = false) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const colors = pigment(config);
  const cx = width / 2, cy = height / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.noerokDark; ctx.fillRect(0, 0, width, height);
  if (lotusFace || config.grade === 'geum') {
    lotus(ctx, cx, cy, width * 0.44, colors, 1);
  } else {
    const rings = [
      [0.46, colors.ink], [0.39, colors.samcheong], [0.29, colors.yellow],
      [0.19, colors.juhong], [0.09, colors.white],
    ];
    for (const [radius, color] of rings) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(cx, cy, width * radius, 0, Math.PI * 2); ctx.fill();
    }
  }
  ageSurface(ctx, width, height, config, colors, lotusFace ? 'face' : 'round');
}

function paintSquare(canvas, config) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const colors = pigment(config);
  ctx.clearRect(0, 0, width, height);
  const layers = [colors.ink, colors.samcheong, colors.juhong, colors.white];
  layers.forEach((color, index) => {
    const inset = [0, 7, 17, 27][index];
    ctx.fillStyle = color;
    ctx.fillRect(inset, inset, width - inset * 2, height - inset * 2);
  });
  if (config.grade === 'geum') lotus(ctx, width / 2, height / 2, 13, colors, 0.96);
  else {
    ctx.fillStyle = colors.yellow;
    ctx.fillRect(width / 2 - 4, height / 2 - 4, 8, 8);
  }
  ageSurface(ctx, width, height, config, colors, 'square');
}

/** Paint one immutable cached source. `canvas` is supplied by the Three adapter. */
export function paintDancheongSource(canvas, kind, input) {
  const resolved = Number.isInteger(input?.clarityBucket)
    && Number.isInteger(input?.splendorBucket)
    && Number.isFinite(input?.sourceClarity)
    && Number.isFinite(input?.sourceSplendor);
  const config = resolved ? input : resolveDancheong(input?.style || 'palace', input);
  if (!config) return false;
  if (kind === 'band') paintBand(canvas, config);
  else if (kind === 'face') paintRound(canvas, config, true);
  else if (kind === 'round') paintRound(canvas, config, false);
  else if (kind === 'square') paintSquare(canvas, config);
  else throw new Error(`Unknown dancheong source kind: ${kind}`);
  return true;
}
