import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
for (let i = 0; i < 25; i += 1) {
  const snap = await page.evaluate(() => {
    const h = window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[8];
    const vox = window.__THREE_GAME_TEST_HOOKS__?.voxelHollow?.()[8];
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return { alive: h.alive, visible: h.visible, cells: vox?.cells, rubble: d?.rubble, frame: d?.frame };
  });
  console.log(JSON.stringify(snap));
  if (!snap.visible) break;
  await page.waitForTimeout(250);
}
await browser.close();
