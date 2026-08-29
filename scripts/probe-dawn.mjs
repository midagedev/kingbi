import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => m.type() === 'error' && console.log('CONSOLE-ERR:', m.text().slice(0,200)));
page.on('pageerror', e => console.log('PAGE-ERR:', e.message.slice(0,200)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('dawn'));
for (const wait of [300, 1200, 2400]) {
  await page.waitForTimeout(wait === 300 ? 300 : wait - 300);
  const r = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const noir = d?.post?.noir ?? {};
    return {
      dawnFlag: d?.dawn, night: d?.night, day: d?.day,
      noirDawn: noir.dawn, banner: document.querySelector('#wave-banner')?.textContent,
      stampOn: document.querySelector('#stamp')?.classList.contains('on'),
      stampChar: document.querySelector('#stamp-char')?.textContent,
    };
  });
  console.log(wait, JSON.stringify(r));
}
await browser.close();
