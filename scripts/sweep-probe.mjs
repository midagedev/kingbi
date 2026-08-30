import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(900);
const rig = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.defenseRig());
await page.evaluate((rig) => window.__THREE_GAME_TEST_HOOKS__?.fireSealAt(rig.gateX, rig.gateZ - 10), rig);
await page.waitForTimeout(1500);
const before = await page.evaluate(() => ({
  corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
  corpseVisual: window.__THREE_GAME_DIAGNOSTICS__?.corpseVisual,
}));
console.log('[after purge]', JSON.stringify(before));
// force the next wave the way the game does
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
  corpseVisual: window.__THREE_GAME_DIAGNOSTICS__?.corpseVisual,
  day: window.__THREE_GAME_DIAGNOSTICS__?.day,
}));
console.log('[after next wave]', JSON.stringify(after));
await browser.close();
