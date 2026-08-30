// Burn-cascade proof: chew a house just past the ignition threshold
// (alive < 0.88, above collapse), STOP all input — the fire must devour
// it alone: alive decays, flakes fall, then the threshold sweep pancakes
// it (visible=false) with the fire persisting.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(800);
const stage = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug());
const h0 = stage.houses[0];
console.log('[house0]', h0.x, h0.z);
// nibble to just under 0.88, never past 0.80 (avoid early collapse)
for (let i = 0; i < 14; i += 1) {
  const alive = await page.evaluate((h) => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[0].alive, h0);
  if (alive < 0.875) break;
  await page.evaluate(({ h, i }) => {
    const a = i * 1.1;
    window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(h.x + Math.cos(a) * 3.4, h.z + Math.sin(a) * 2.6, 1.4, 1.5);
  }, { h: h0, i });
  await page.waitForTimeout(350); // let the support scan settle between bites
}
const ignited = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[0]);
console.log('[ignited state]', JSON.stringify(ignited));
await page.screenshot({ path: 'shots/burn-standing.png' });
// hands off — the fire must do the rest
let last = ignited;
for (let t = 0; t < 14; t += 1) {
  await page.waitForTimeout(2000);
  const now = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[0]);
  if (now.alive !== last.alive || now.visible !== last.visible) {
    console.log(`[t+${(t + 1) * 2}s]`, JSON.stringify(now));
  }
  last = now;
  if (!now.visible) break;
}
await page.screenshot({ path: 'shots/burn-after.png' });
console.log('[errors]', errors.slice(0, 3));
await browser.close();
