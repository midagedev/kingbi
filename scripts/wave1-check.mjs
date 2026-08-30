import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('https://midagedev.github.io/kingbi/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
for (let i = 0; i < 5; i += 1) {
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return { mode: d?.mode, zombies: d?.zombies, queue: d?.waveQueue, day: d?.day, phase: d?.phase };
  });
  console.log(JSON.stringify(r));
}
await browser.close();
