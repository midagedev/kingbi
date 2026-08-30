// Real-camera street framing captures (desktop idle/firing + mobile).
import { chromium } from '@playwright/test';
const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const browser = await chromium.launch({ channel: 'chromium' });

async function shot(name, ctxOpts, pan) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(name, '[pageerror]', e.message.slice(0, 140)));
  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await page.waitForTimeout(14000);
  if (pan) await page.mouse.move(pan, 400);
  if (name.includes('firing')) {
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.waitForTimeout(2600);
  }
  await page.screenshot({ path: `shots/street-${name}.png` });
  await ctx.close();
}
await shot('idle', { viewport: { width: 1280, height: 720 } });
await shot('firing', { viewport: { width: 1280, height: 720 } });
await shot('pan-left', { viewport: { width: 1280, height: 720 } }, 180);
await shot('mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
await browser.close();
console.log('done');
