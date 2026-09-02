import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.waitForTimeout(1500);
const d = await page.evaluate(() => ({
  windows: window.__THREE_GAME_DIAGNOSTICS__?.windows,
  hollow: window.__THREE_GAME_TEST_HOOKS__?.voxelHollow()?.map((h) => h.cells),
}));
console.log(JSON.stringify(d));
await browser.close();
