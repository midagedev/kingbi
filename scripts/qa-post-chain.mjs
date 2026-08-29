import { chromium, devices } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
async function probe(label, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:4188/?godmode=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
  await page.waitForTimeout(1500);
  const post = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.post);
  console.log(label, JSON.stringify(post));
  await ctx.close();
}
await probe('desktop', { viewport: { width: 1280, height: 720 } });
await probe('mobile ', { ...devices['iPhone 13'] });
await browser.close();
