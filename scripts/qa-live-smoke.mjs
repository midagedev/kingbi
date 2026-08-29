import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
page.on('requestfailed', (r) => errs.push('NET:' + r.url()));
await page.goto('https://midagedev.github.io/kingbi/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 240_000 });
await page.click('#start-button');
await page.waitForTimeout(3000);
const d = await page.evaluate(() => {
  const q = window.__THREE_GAME_DIAGNOSTICS__ ?? {};
  return { mode: q.mode, frame: q.frame, canvas: q.canvas?.clientWidth + 'x' + q.canvas?.clientHeight };
});
await page.screenshot({ path: 'shots/live-smoke.png' });
console.log(JSON.stringify({ d, errors: [...new Set(errs)].slice(0, 6) }, null, 2));
await browser.close();
