import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

async function sampleCanvas(page: import('@playwright/test').Page): Promise<CanvasSample> {
  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  const buffer = await canvas.screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  const variance = max - min;
  return {
    ok: alphaPixels > 256 && (variance > 8 || buckets.size > 3),
    reason: 'sampled',
    variance,
    colorBuckets: buckets.size,
  };
}

test('renders a nonblank interactive game canvas', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  // Wait until the procedural village finishes building (title button enables).
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#start-button')?.disabled);
  await page.click('#start-button');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  // Wash guard — the desktop IBL envmap once laid an ambient floor that
  // papered the whole night scene white (mean luminance ~198) while every
  // structural check kept passing. A fresh run is a DARK ink night: the
  // mean canvas luminance must sit well under the wash regime.
  const washSample = await sampleCanvas(page);
  const canvasPng = PNG.sync.read(await page.locator('#game-canvas').screenshot());
  let lumSum = 0;
  let lumCount = 0;
  for (let i = 0; i < canvasPng.data.length; i += 4 * 61) {
    lumSum += (canvasPng.data[i] + canvasPng.data[i + 1] + canvasPng.data[i + 2]) / 3;
    lumCount += 1;
  }
  const meanLum = lumSum / lumCount;
  expect(
    meanLum,
    `night scene must stay ink-dark (mean lum ${meanLum.toFixed(0)}; wash regime is ~200)`,
  ).toBeLessThan(150);
  void washSample;

  // The gatling must respond to real input: hold fire and verify kills/heat move.
  const readFiring = () =>
    page.evaluate((): { kills: number; heat: number } => ({
      kills: Number(window.__THREE_GAME_DIAGNOSTICS__?.kills ?? 0),
      heat: Number(window.__THREE_GAME_DIAGNOSTICS__?.heat ?? 0),
    }));
  const before = await readFiring();

  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.zombies ?? 0) > 6, null, { timeout: 20_000 });
  // Press-to-fire everywhere: touch/click on the play surface aims AND fires
  // toward that point — the dedicated fire button is gone by design.
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(1400);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await readFiring();
  expect(after.kills + after.heat, 'firing must produce kills or heat').toBeGreaterThan(before.kills + before.heat);

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${testInfo.project.name}-game`, {
    body: screenshot,
    contentType: 'image/png',
  });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
