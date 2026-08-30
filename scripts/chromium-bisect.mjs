// Bisect the Chromium white-screen: toggle composer passes, measure luminance.
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
await page.waitForTimeout(2000);

async function measure(label) {
  await page.screenshot({ path: `shots/chromium-${label}.png` });
  const png = PNG.sync.read(fs.readFileSync(`shots/chromium-${label}.png`));
  let sum = 0, n = 0, min = 255, max = 0;
  for (let i = 0; i < png.data.length; i += 4 * 131) {
    const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    sum += l; n += 1;
    min = Math.min(min, png.data[i], png.data[i + 1], png.data[i + 2]);
    max = Math.max(max, png.data[i], png.data[i + 1], png.data[i + 2]);
  }
  const post = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.post);
  console.log(`${label.padEnd(16)} lum=${(sum / n).toFixed(0)} min=${min} max=${max} exp=${post?.exposure} fog=${JSON.stringify(post?.fog)}`);
}
await measure('baseline');
for (const name of ['UnrealBloomPass', 'FlarePass', 'ShaderPass']) {
  await page.evaluate((n) => window.__THREE_GAME_TEST_HOOKS__?.setPostPassEnabled(n, false), name);
  await page.waitForTimeout(700);
  await measure(`no-${name}`);
  await page.evaluate((n) => window.__THREE_GAME_TEST_HOOKS__?.setPostPassEnabled(n, true), name);
  await page.waitForTimeout(300);
}
// All optional passes off at once (raw scene after OutputPass)
for (const name of ['UnrealBloomPass', 'FlarePass', 'ShaderPass']) {
  await page.evaluate((n) => window.__THREE_GAME_TEST_HOOKS__?.setPostPassEnabled(n, false), name);
}
await page.waitForTimeout(700);
await measure('no-all');
await browser.close();
