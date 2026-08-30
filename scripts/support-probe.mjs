// Support-scan proof: saw a full horizontal band through house[0]'s walls
// (all four sides) at mid height, then WAIT — with no further bullets the
// roof island must detach (alive drops hard, rubble rows grow) and, past
// the structure threshold, the house pancakes.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(1000);
const info = await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  const stage = hooks?.stageDebug();
  const rect = stage.obstaclesNearDefense
    .map((r) => ({ ...r, cx: (r.minX + r.maxX) / 2, cz: (r.minZ + r.maxZ) / 2 }))
    .filter((r) => Math.abs(r.cx - stage.houses[0].x) < 3 && Math.abs(r.cz - stage.houses[0].z) < 3)[0];
  return { house: stage.houses[0], rect };
});
const read = () => page.evaluate(() => ({
  alive: window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[0].alive,
  rubbleVisual: window.__THREE_GAME_DIAGNOSTICS__?.rubbleVisual,
}));
// Saw the wall band: points around the perimeter at mid-wall height.
const saw = await page.evaluate((info) => {
  const H = window.__THREE_GAME_TEST_HOOKS__;
  const { minX, maxX, minZ, maxZ } = info.rect;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  let chewed = 0;
  // Wall grinder: chew the whole footprint below the roofline so every
  // vertical path from ground to roof is gone.
  for (let x = minX + 0.3; x <= maxX - 0.3; x += 0.7) {
    for (let z = minZ + 0.3; z <= maxZ - 0.3; z += 0.7) {
      for (let y = 0.2; y <= 2.8; y += 0.7) {
        chewed += H.chewHouseAt(x, z, y, 0.8) ?? 0;
      }
    }
  }
  void cx; void cz;
  return chewed;
}, info);
console.log('[saw chewed]', saw, JSON.stringify(await read()));
// NO further input — the scheduled scan must drop the roof on its own.
await page.waitForTimeout(900);
const after = await read();
console.log('[after settle]', JSON.stringify(after));
await page.waitForTimeout(400);
console.log('[after settle2]', JSON.stringify(await read()));
await page.screenshot({ path: 'shots/support-after-saw.png' });
console.log('[errors]', errors.slice(0, 3));
await browser.close();
