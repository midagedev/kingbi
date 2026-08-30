// WebKit (= iOS in-app browser engine) against the LIVE deploy: the
// Twitter-in-app gate — wasm load, rubble spawn, no errors.
import { webkit } from '@playwright/test';
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 150)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
await page.waitForTimeout(2000);
// Demolish: chew + collapse on the live build, in WebKit.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('demolish'));
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/webkit-live-demolish.png' });
const census = await page.evaluate(() => {
  const rows = window.__THREE_GAME_TEST_HOOKS__?.sceneCensus() ?? [];
  return rows.filter((r) => r.root.includes('box3d') || r.root.includes('voxel'));
});
console.log(JSON.stringify({ errors, census }, null, 1));
await browser.close();
