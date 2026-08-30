// Quick desktop luminance probe against a URL (the wash detector).
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const url = process.argv[2];
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: '/tmp/lum-check.png' });
const png = PNG.sync.read(fs.readFileSync('/tmp/lum-check.png'));
let sum = 0, n = 0;
for (let i = 0; i < png.data.length; i += 4 * 131) {
  sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; n += 1;
}
const diag = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.renderer);
console.log(JSON.stringify({ url, lum: +(sum / n).toFixed(0), renderer: diag }));
await browser.close();
