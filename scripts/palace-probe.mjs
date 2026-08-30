// Palace false-collapse repro: ONE stray chew on the palace, no further
// input — if the support scan mis-anchors on sloped terrain it will mass
// detach and the palace pancakes within a second.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(900);
const before = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[8]);
console.log('[palace before]', JSON.stringify(before));
// one bite on the palace's south face
const bitten = await page.evaluate(() => {
  const stage = window.__THREE_GAME_TEST_HOOKS__?.stageDebug();
  const palace = stage.houses[8];
  return window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(palace.x, palace.z + 30, 4, 1.2) ?? -1;
});
console.log('[stray bite cells]', bitten);
for (const t of [1, 3, 6]) {
  await page.waitForTimeout(t === 1 ? 1000 : 2000);
  const now = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[8]);
  console.log(`[t+${t === 1 ? 1 : t}s]`, JSON.stringify(now));
}
await browser.close();
