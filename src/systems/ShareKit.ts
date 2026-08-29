/**
 * 바이럴 전적 공유 — Wordle-style share text, clipboard/Web Share fallback,
 * and a noir score-card image composited from the live game canvas.
 */

export interface RunStats {
  wave: number;
  /** Chapter count — five waves per night; the painting is titled by it. */
  night: number;
  kills: number;
  maxCombo: number;
  accuracy: number; // 0..1
  survivedSeconds: number;
  isRecord: boolean;
}

export function formatSurvival(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildShareText(stats: RunStats): string {
  const pips = Math.min(10, Math.floor(stats.kills / 100));
  const pipLine = pips > 0 ? '🩸'.repeat(pips) : '🌑 흑백의 밤';
  return [
    '🌑 새벽까지 · 궁가의 밤',
    `밤${Math.max(1, stats.night)} · 제${Math.max(1, stats.wave)}파에서 보루가 무너졌다${stats.isRecord ? ' — 신기록' : ''}`,
    '',
    `격살 ${stats.kills} · 최고 연쇄 ${stats.maxCombo}`,
    `명중률 ${Math.round(stats.accuracy * 100)}% · ${formatSurvival(stats.survivedSeconds)} 생존`,
    pipLine,
    '',
    '이 밤은 그림으로 남는다 — 새벽까지 버틸 수 있는가?',
  ].join('\n');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  // Clipboard API can be blocked (non-secure context, permission, headless);
  // the legacy path still works from a user gesture.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Share the run text; falls back to clipboard copy. Reports what happened. */
export async function shareRun(stats: RunStats): Promise<'shared' | 'copied' | 'failed'> {
  const text = buildShareText(stats);
  const nav = navigator as Navigator & {
    share?: (data: { text: string }) => Promise<void>;
  };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ text });
      return 'shared';
    } catch (error) {
      // AbortError = user dismissed the sheet; anything else falls through.
      if ((error as DOMException)?.name === 'AbortError') return 'shared';
    }
  }
  return (await copyToClipboard(text)) ? 'copied' : 'failed';
}

/** Compose the noir score card: live frame + typographic stats strip. */
export function buildScoreCard(source: HTMLCanvasElement, stats: RunStats): HTMLCanvasElement {
  const width = Math.min(1920, source.width || source.clientWidth || 1280);
  const scale = width / (source.width || width);
  const height = Math.round((source.height || source.clientHeight || 720) * scale);
  const strip = Math.max(120, Math.round(height * 0.24));

  const card = document.createElement('canvas');
  card.width = width;
  card.height = height + strip;
  const ctx = card.getContext('2d');
  if (!ctx) return card;

  ctx.drawImage(source, 0, 0, width, height);

  // Stats strip: ink black with a blood-red hairline, white Myeongjo type.
  ctx.fillStyle = '#060505';
  ctx.fillRect(0, height, width, strip);
  ctx.fillStyle = '#c8102e';
  ctx.fillRect(0, height, width, 4);

  const titleSize = Math.round(strip * 0.3);
  const bodySize = Math.round(strip * 0.2);
  const smallSize = Math.round(strip * 0.14);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${titleSize}px "Nanum Myeongjo", "Apple SD Gothic Neo", sans-serif`;
  ctx.fillText('궁가의 밤', 34, height + strip * 0.42);
  ctx.font = `700 ${bodySize}px "Apple SD Gothic Neo", sans-serif`;
  ctx.fillStyle = 'rgba(244, 241, 234, 0.85)';
  ctx.fillText(
    `제${Math.max(1, stats.wave)}파 · 격살 ${stats.kills} · 연쇄 ${stats.maxCombo} · 명중률 ${Math.round(stats.accuracy * 100)}% · ${formatSurvival(stats.survivedSeconds)}`,
    34,
    height + strip * 0.72,
  );
  ctx.fillStyle = '#ef1935';
  ctx.font = `700 ${smallSize}px "Apple SD Gothic Neo", sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText(stats.isRecord ? '신기록' : '새벽까지 · TILL DAWN', width - 34, height + strip * 0.42);
  ctx.textAlign = 'left';

  return card;
}

function triggerDownload(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Stack Hangul vertically — 세로쓰기 for the painting's title column. */
function drawVerticalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  line: number,
): void {
  let cursor = y;
  for (const char of text) {
    ctx.fillText(char, x, cursor);
    cursor += line;
  }
}

/**
 * 밤의 그림 — the run's painting. The blood-yard canvas (every pool, every
 * seal sigil the night stamped) is mounted on hanji as a sumukhwa with a
 * vertical title, a red 낙관 and the run's stats. 4:5 for feed sharing.
 */
export function buildPaintingCard(source: HTMLCanvasElement | null, stats: RunStats): HTMLCanvasElement {
  const width = 1080;
  const height = 1350;
  const card = document.createElement('canvas');
  card.width = width;
  card.height = height;
  const ctx = card.getContext('2d');
  if (!ctx) return card;

  // Hanji ground.
  ctx.fillStyle = '#e9e1cc';
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 1100; i += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const a = Math.random() * Math.PI;
    const len = 3 + Math.random() * 9;
    ctx.strokeStyle = `rgba(112, 98, 74, ${0.04 + Math.random() * 0.08})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  const shade = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.85);
  shade.addColorStop(0, 'rgba(60, 48, 34, 0)');
  shade.addColorStop(1, 'rgba(60, 48, 34, 0.22)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);

  // Mount: double hairline frame.
  ctx.strokeStyle = 'rgba(46, 38, 28, 0.8)';
  ctx.lineWidth = 3;
  ctx.strokeRect(64, 64, width - 128, height - 128);
  ctx.lineWidth = 1;
  ctx.strokeRect(76, 76, width - 152, height - 152);

  // The painting field: the night's blood canvas, mounted slightly askew.
  const fieldX = 104;
  const fieldY = 104;
  const fieldW = width - 208;
  const fieldH = height - 470;
  // Sumuk wash behind the sheet — pale gray ink gradient so an early-death
  // painting still reads as a mounted work, not an empty frame.
  const wash = ctx.createLinearGradient(fieldX, fieldY, fieldX, fieldY + fieldH);
  wash.addColorStop(0, 'rgba(98, 92, 80, 0.16)');
  wash.addColorStop(0.55, 'rgba(98, 92, 80, 0.07)');
  wash.addColorStop(1, 'rgba(98, 92, 80, 0.2)');
  ctx.fillStyle = wash;
  ctx.fillRect(fieldX, fieldY, fieldW, fieldH);
  ctx.strokeStyle = 'rgba(46, 38, 28, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(fieldX, fieldY, fieldW, fieldH);
  if (source && source.width > 0) {
    const scale = Math.min(fieldW / source.width, fieldH / source.height);
    const dw = source.width * scale;
    const dh = source.height * scale;
    ctx.save();
    ctx.translate(fieldX + fieldW / 2, fieldY + fieldH / 2);
    ctx.rotate(-0.008);
    ctx.shadowColor = 'rgba(30, 22, 14, 0.35)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = 'rgba(255, 252, 244, 0.5)';
    ctx.fillRect(fieldX, fieldY, fieldW, fieldH);
  }

  // Vertical title column (제목) + red seal (낙관) — the mount's signature.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#191410';
  ctx.font = '82px "Nanum Brush Script", "Song Myung", serif';
  drawVerticalText(ctx, '궁가의 밤', width - 138, fieldY + 66, 86);
  ctx.font = '30px "Song Myung", serif';
  drawVerticalText(ctx, `밤${Math.max(1, stats.night)}의 그림`, width - 224, fieldY + 70, 36);
  ctx.save();
  ctx.translate(width - 138, fieldY + 66 + 86 * 4 + 84);
  ctx.rotate(0.035);
  ctx.fillStyle = '#b3122e';
  ctx.fillRect(-44, -44, 88, 88);
  ctx.fillStyle = '#f6efe0';
  ctx.font = '34px "Song Myung", serif';
  ctx.fillText('새', 0, -16);
  ctx.fillText('벽', 0, 20);
  ctx.restore();

  // Stats plaque along the bottom of the mount.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#241d15';
  ctx.font = '700 40px "Song Myung", serif';
  ctx.fillText(
    `제${Math.max(1, stats.wave)}파까지 · 격살 ${stats.kills}`,
    width / 2,
    height - 240,
  );
  ctx.fillStyle = 'rgba(36, 29, 21, 0.75)';
  ctx.font = '28px "Song Myung", serif';
  ctx.fillText(
    `최고 연쇄 ${stats.maxCombo} · 명중률 ${Math.round(stats.accuracy * 100)}% · ${formatSurvival(stats.survivedSeconds)} 생존`,
    width / 2,
    height - 186,
  );
  ctx.fillStyle = '#b3122e';
  ctx.font = '600 20px "Song Myung", serif';
  const label = stats.isRecord ? '新記錄 — 새벽까지 · TILL DAWN' : '새벽까지 · TILL DAWN';
  ctx.fillText(label.split('').join('\u2009'), width / 2, height - 132);

  return card;
}

/** Save/share the night's painting. Reports what happened for the toast. */
export async function sharePainting(
  source: HTMLCanvasElement | null,
  stats: RunStats,
): Promise<'shared' | 'downloaded' | 'failed'> {
  const card = buildPaintingCard(source, stats);
  const blob = await new Promise<Blob | null>((resolve) => card.toBlob(resolve, 'image/png'));
  if (!blob) return 'failed';

  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; text?: string }) => Promise<void>;
  };
  const file = new File([blob], '궁가의밤-밤의그림.png', { type: 'image/png' });
  if (typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], text: buildShareText(stats) });
      return 'shared';
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return 'shared';
    }
  }
  triggerDownload(URL.createObjectURL(blob), '궁가의밤-밤의그림.png');
  return 'downloaded';
}

/** Save/share the score card. Reports what happened for the toast. */
export async function shareScoreCard(source: HTMLCanvasElement, stats: RunStats): Promise<'shared' | 'downloaded' | 'failed'> {
  const card = buildScoreCard(source, stats);
  const toBlob = (): Promise<Blob | null> =>
    new Promise((resolve) => card.toBlob((blob) => resolve(blob), 'image/png'));
  const blob = await toBlob();
  if (!blob) return 'failed';

  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; text?: string }) => Promise<void>;
  };
  const file = new File([blob], '궁가의밤-전적.png', { type: 'image/png' });
  if (typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], text: buildShareText(stats) });
      return 'shared';
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return 'shared';
    }
  }
  triggerDownload(URL.createObjectURL(blob), '궁가의밤-전적.png');
  return 'downloaded';
}
