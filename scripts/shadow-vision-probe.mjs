// Real fire-shadow visual proof + night fps sanity.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
// night fps (no fires yet — pure cached-moon path)
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
const f0 = await page.evaluate(() => ({ f: window.__THREE_GAME_DIAGNOSTICS__?.frame, e: window.__THREE_GAME_DIAGNOSTICS__?.elapsed }));
await page.waitForTimeout(3000);
const f1 = await page.evaluate(() => ({ f: window.__THREE_GAME_DIAGNOSTICS__?.frame, e: window.__THREE_GAME_DIAGNOSTICS__?.elapsed }));
console.log('[night fps]', ((f1.f - f0.f) / (f1.e - f0.e)).toFixed(1));
// demolish rig: house[1] collapses + burns; zombies march past with REAL shadows
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('demolish'));
await page.waitForTimeout(2400);
await page.screenshot({ path: 'shots/real-fire-shadows.png' });
console.log('[errors]', errors.slice(0, 3));
await browser.close();
