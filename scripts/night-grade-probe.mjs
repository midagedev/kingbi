// Night grade/luminance probe: capture the night gameplay view, report mean
// luminance + a house-band crop luminance (silhouette readability), and the
// full screenshot for vision QA of the lantern pools + house silhouettes.
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdirSync, readFileSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/night-grade-after.png' });

const stats = (() => {
  const png = PNG.sync.read(readFileSync('shots/night-grade-after.png'));
  let sum = 0, n = 0, houseSum = 0, houseN = 0;
  for (let y = 0; y < png.height; y += 3) {
    for (let x = 0; x < png.width; x += 3) {
      const i = (y * png.width + x) * 4;
      const lum = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      sum += lum; n += 1;
      // upper-middle band where the hanok silhouettes stand
      if (y > png.height * 0.18 && y < png.height * 0.5 && x > png.width * 0.15 && x < png.width * 0.85) {
        houseSum += lum; houseN += 1;
      }
    }
  }
  return { meanLum: +(sum / n).toFixed(1), houseBandLum: +(houseSum / houseN).toFixed(1) };
})();
console.log('[night-grade]', JSON.stringify(stats));
await browser.close();
