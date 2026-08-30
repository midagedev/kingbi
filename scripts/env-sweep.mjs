import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
await page.waitForTimeout(5000);
async function lum(label) {
  await page.screenshot({ path: `shots/env-${label}.png` });
  const png = PNG.sync.read(fs.readFileSync(`shots/env-${label}.png`));
  let s = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4 * 131) { s += (png.data[i] + png.data[i+1] + png.data[i+2]) / 3; n += 1; }
  console.log(label, (s / n).toFixed(0));
}
for (const v of [0, 0.06, 0.1, 0.16, 0.24]) {
  await page.evaluate((x) => window.__THREE_GAME_TEST_HOOKS__?.setEnvIntensity(x), v);
  await page.waitForTimeout(600);
  await lum(`i${String(v).replace('.', '')}`);
}
await browser.close();
