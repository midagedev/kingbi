import { chromium } from '@playwright/test';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 120_000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#hud,#end-screen,#damage-vignette,#speedlines,#impact-flash,#stamp,#rank-layer,#toast{display:none!important}';
    document.head.appendChild(style);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  });
  await page.waitForTimeout(2500);
  // Kill cam may hold the frame; force death → gate blast.
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(false));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('dead'));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'shots/debris-death.png' });
  console.log(JSON.stringify({ errors }, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
