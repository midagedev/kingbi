// A/B: how much of the blown lane is the desktop IBL envmap?
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(2200);

const lane = (file) => {
  const png = PNG.sync.read(readFileSync(file));
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height * 0.55); y < png.height * 0.8; y += 3) {
    for (let x = Math.floor(png.width * 0.3); x < png.width * 0.7; x += 3) {
      const i = (y * png.width + x) * 4;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; n += 1;
    }
  }
  return +(sum / n).toFixed(1);
};
await page.screenshot({ path: 'shots/env-ab-on.png' });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setEnvIntensity(0));
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/env-ab-off.png' });
console.log('[lane] env ON:', lane('shots/env-ab-on.png'), ' env OFF:', lane('shots/env-ab-off.png'));
await browser.close();
