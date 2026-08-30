import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (['error','warning'].includes(m.type())) console.log('[' + m.type() + ']', m.text().slice(0, 250)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 400)));
await page.goto('http://127.0.0.1:4190/kingbi/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(12000);
console.log(await page.evaluate(() => ({ disabled: document.querySelector('#start-button')?.disabled, loading: document.querySelector('#title-loading')?.textContent })));
await browser.close();
