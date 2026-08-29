/**
 * 바이럴 전적 공유 — Wordle-style share text, clipboard/Web Share fallback,
 * and a noir score-card image composited from the live game canvas.
 */

export interface RunStats {
  wave: number;
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
    `제${Math.max(1, stats.wave)}파에서 보루가 무너졌다${stats.isRecord ? ' — 신기록' : ''}`,
    '',
    `격살 ${stats.kills} · 최고 연쇄 ${stats.maxCombo}`,
    `명중률 ${Math.round(stats.accuracy * 100)}% · ${formatSurvival(stats.survivedSeconds)} 생존`,
    pipLine,
    '',
    '새벽까지 버틸 수 있는가?',
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
