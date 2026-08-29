import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 240_000 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const style = document.createElement('style');
  style.textContent = '#hud,#damage-vignette,#speedlines,#impact-flash,#stamp,#rank-layer,#toast,#cinema-bars{display:none!important}';
  document.head.appendChild(style);
  window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
});
await page.waitForTimeout(6000);
await page.screenshot({ path: 'shots/demolish-before.png' });
// Demolish a house: the rig tells us where the defense point is; houses sit
// at (±15-21 lateral, -12..-37 north). Boom the north-west pair.
await page.evaluate(() => {
  const rig = window.__THREE_GAME_TEST_HOOKS__.defenseRig();
  window.__THREE_GAME_TEST_HOOKS__.boomAt(rig.gunX - 17, rig.gunZ - 14);
});
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/demolish-after.png' });
console.log(JSON.stringify({ errors: errs }, null, 2));
await browser.close();
