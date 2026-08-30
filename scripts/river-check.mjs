import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
await page.waitForTimeout(2500);
for (let i = 0; i < 4; i += 1) {
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const list = window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? [];
    const states = {};
    for (const z of list) states[z.state] = (states[z.state] ?? 0) + 1;
    const zs = list.map((z) => Math.round(z.z));
    return { zombies: d?.zombies, queue: d?.waveQueue, states, zMin: Math.min(...zs), zMax: Math.max(...zs) };
  });
  console.log(JSON.stringify(r));
}
await browser.close();
