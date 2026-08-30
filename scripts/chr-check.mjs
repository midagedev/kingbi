import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[' + m.type() + ']', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 400)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
const state = await page.evaluate(() => ({
  disabled: document.querySelector('#start-button')?.disabled,
  titleVisible: document.querySelector('#title-screen')?.classList.contains('visible'),
  diag: !!window.__THREE_GAME_DIAGNOSTICS__,
  frame: window.__THREE_GAME_DIAGNOSTICS__?.frame,
}));
console.log(JSON.stringify(state));
await browser.close();
