// Fire visual QA: demolish rig collapses house[1] → fire ignites; capture
// the gameplay view with zombies marching past the glow (long shadows).
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('demolish'));
await page.waitForTimeout(2600);
const zombies = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? []);
console.log('[zombies]', zombies.length, 'frame', await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame));
await page.screenshot({ path: 'shots/fire-demolish.png' });
// second shot a beat later (flames flicker, zombies advance)
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/fire-demolish-2.png' });
console.log('[errors]', errors.slice(0, 4));
await browser.close();
