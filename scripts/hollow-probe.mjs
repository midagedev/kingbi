// Hollow-house + corpse-color verification:
//  1. corpseColorRows — must now be LINEAR-range (~0.09 for a normal robe;
//     the old ~0.4 read white at night).
//  2. Fire real input bursts across the screen — at least one yard house
//     must lose cubes (the voxel-march hit path works end to end).
//  3. Chew an eye-level breach into house[0]'s gun-facing wall, pose the
//     camera looking THROUGH it — the enclosed room must read hollow.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const warnings = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(`[${m.type()}] ${m.text().slice(0, 120)}`); });
page.on('pageerror', (e) => warnings.push(`[pageerror] ${String(e).slice(0, 150)}`));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });

// --- 1. corpse colors after the colorspace fix -------------------------------
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
await page.waitForTimeout(2500);
const corpseColors = await page.evaluate(() => ({
  colors: window.__THREE_GAME_TEST_HOOKS__?.corpseColorRows?.() ?? [],
  diag: {
    corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
    kills: window.__THREE_GAME_DIAGNOSTICS__?.kills,
  },
}));
console.log('[corpse-color rows (linear)]', JSON.stringify(corpseColors.colors));
console.log('[corpse diag]', JSON.stringify(corpseColors.diag));

// Corpse field visual — low angle over the kill yard.
await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  window.__THREE_GAME_TEST_HOOKS__?.poseCamera(
    d ? 0 : 0, 6.5, 6, // placeholder replaced below
    0, 1, -12, 55,
  );
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/hollow-corpse-color.png' });

// --- 2. real input fire → voxel-march hits ------------------------------------
// back to a calm state, then sweep short bursts across the upper band
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(800);
const aliveBefore = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses.map((h) => h.alive));
for (const fx of [0.28, 0.42, 0.58, 0.72]) {
  await page.mouse.move(1280 * fx, 800 * 0.42);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
  await page.waitForTimeout(350);
}
const afterFire = await page.evaluate(() => ({
  houses: window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses.map((h) => h.alive),
  shots: window.__THREE_GAME_DIAGNOSTICS__?.kills,
}));
console.log('[fire] house alive before:', JSON.stringify(aliveBefore));
console.log('[fire] house alive after :', JSON.stringify(afterFire.houses));

// --- 3. breach + look inside ---------------------------------------------------
const stage = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug());
const h0 = stage.houses[0];
// gun-facing (south) wall breach: chew stacked points just outside center-z
const breaches = await page.evaluate((h) => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  let chewed = 0;
  for (const [dx, dz, y, r] of [[0, 2.2, 0.9, 1.15], [0, 2.2, 1.7, 1.15], [0, 2.2, 2.4, 1.0], [0, 1.2, 1.6, 1.0]]) {
    chewed += hooks?.chewHouseAt(h.x + dx, h.z + dz, y, r) ?? 0;
  }
  return chewed;
}, h0);
console.log('[breach] chewed cells:', breaches);
const hollowAfter = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.voxelHollow());
console.log('[hollow after breach] house#0', JSON.stringify(hollowAfter?.[0]));
// camera outside the breach looking through into the room
await page.evaluate((h) => {
  window.__THREE_GAME_TEST_HOOKS__?.poseCamera(h.x, 2.4, h.z + 7.5, h.x, 1.1, h.z - 2.5, 60);
}, h0);
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/hollow-room-inside.png' });

// restore play camera
await page.keyboard.press('Escape');
console.log('[warnings]', warnings.slice(0, 10));
await browser.close();
