import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
console.log(JSON.stringify(await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.villageMaterialInfo())));
await browser.close();
