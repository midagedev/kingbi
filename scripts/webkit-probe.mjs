// Desktop WebKit (Safari engine) probe — reproduce the white-screen report.
import { webkit } from '@playwright/test';
import { PNG } from 'pngjs';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message.slice(0, 300)}`));
await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shots/webkit-title.png' });
await page.click('#start-button');
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/webkit-play.png' });
const diag = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  const gl = document.querySelector('#game-canvas')?.getContext('webgl2');
  return { frame: d?.frame, mode: d?.mode, renderer: d?.renderer, post: d?.post, glVersion: gl?.getParameter?.(gl?.VERSION) ?? null };
});
// pixel stats of the play screenshot
const fs = await import('node:fs');
const png = PNG.sync.read(fs.readFileSync('shots/webkit-play.png'));
let sum = 0, n = 0, min = 255, max = 0;
for (let i = 0; i < png.data.length; i += 4 * 97) {
  const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  sum += l; n += 1; min = Math.min(min, png.data[i], png.data[i + 1], png.data[i + 2]);
  max = Math.max(max, png.data[i], png.data[i + 1], png.data[i + 2]);
}
console.log(JSON.stringify({
  diag,
  luminance: { mean: +(sum / n).toFixed(1), min, max },
  console: consoleMsgs.slice(0, 12),
}, null, 2));
await browser.close();
