import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
page.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url()); });
page.on('requestfailed', (r) => console.log('FAILED', r.url(), r.failure()?.errorText));
await page.goto('http://127.0.0.1:4190/kingbi/?godmode=1', { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(4000);
await browser.close();
