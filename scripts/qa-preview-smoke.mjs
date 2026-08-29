import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
page.on('crash', () => errs.push('RENDERER CRASH'));
await page.goto('http://127.0.0.1:4188/?godmode=1', { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  const d = await page.evaluate(() => ({ ...window.__THREE_GAME_DIAGNOSTICS__ }));
  await page.screenshot({ path: 'shots/preview-smoke.png' });
  console.log(JSON.stringify({ ok: true, mode: d.mode, errors: [...new Set(errs)] }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e), errors: [...new Set(errs)] }, null, 2));
}
await browser.close();
