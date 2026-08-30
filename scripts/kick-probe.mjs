// Bullet-kick proof: settle a corpse pile (physAwake low), hold fire into
// it — bodies must wake and skid (awake count jumps, corpses persist).
// Plus: new 6-house layout rect overlap audit + capture.
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
const rig = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.defenseRig());
// purge where zombies ACTUALLY are: wait for the wave to close in, then
// seal the densest cluster near the lane.
let target = null;
for (let attempt = 0; attempt < 20 && !target; attempt += 1) {
  const list = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? []);
  target = list.find((z) => z.type !== 'bloater' && Math.abs(z.x - rig.gateX) < 14 && z.z < rig.gateZ && rig.gateZ - z.z < 16) ?? null;
  if (!target) await page.waitForTimeout(700);
}
if (target) {
  await page.evaluate((t) => window.__THREE_GAME_TEST_HOOKS__?.fireSealAt(t.x, t.z), target);
}
await page.waitForTimeout(4500); // let the pile SETTLE (asleep)
const settled = await page.evaluate(() => ({
  awake: window.__THREE_GAME_DIAGNOSTICS__?.physAwake,
  corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
  rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
}));
console.log('[settled pile]', JSON.stringify(settled));
await page.mouse.move(760, 620);
await page.mouse.down();
await page.waitForTimeout(900);
const firing = await page.evaluate(() => ({
  awake: window.__THREE_GAME_DIAGNOSTICS__?.physAwake,
  corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
  rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
  kills: window.__THREE_GAME_DIAGNOSTICS__?.kills,
}));
await page.mouse.up();
console.log('[firing into pile]', JSON.stringify(firing));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shots/kick-layout-night.png' });
// layout audit: rects of the six yard houses
const stage = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug());
const rects = stage.obstaclesNearDefense.map((r) => ({ ...r, cx: +(r.minX + r.maxX).toFixed(1), cz: +(r.minZ + r.maxZ).toFixed(1) }));
console.log('[houses]', JSON.stringify(stage.houses.map((h) => [h.x, h.z, h.alive])));
let overlaps = 0;
for (let i = 0; i < rects.length; i += 1) {
  for (let j = i + 1; j < rects.length; j += 1) {
    const a = rects[i], b = rects[j];
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    if (ox > 0.3 && oz > 0.3) { overlaps += 1; console.log('[overlap]', a.cx, a.cz, '×', b.cx, b.cz, ox.toFixed(1), oz.toFixed(1)); }
  }
}
console.log('[rect overlaps]', overlaps, 'of', rects.length, 'rects');
console.log('[errors]', errors.slice(0, 3));
await browser.close();
