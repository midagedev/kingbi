import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
await page.waitForTimeout(12000);
await page.screenshot({ path: 'shots/mob-check.png' });
const png = PNG.sync.read(fs.readFileSync('shots/mob-check.png'));
let s = 0, n = 0;
for (let i = 0; i < png.data.length; i += 4 * 131) { s += (png.data[i] + png.data[i+1] + png.data[i+2]) / 3; n += 1; }
console.log('mobile lum', (s / n).toFixed(0));
await browser.close();
