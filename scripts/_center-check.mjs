import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
await p.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await p.evaluate(() => document.querySelector('#start-button')?.click());
await p.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 20, null, { timeout: 30_000 });
await p.waitForTimeout(1200);
await p.screenshot({ path: 'shots/street-band-gameplay.png' });
const info = await p.evaluate(() => {
  const st = window.__THREE_GAME_TEST_HOOKS__?.stageDebug?.();
  return st?.houses?.map((h, i) => ({ i, x: h.x, z: h.z })) ?? [];
});
console.log(JSON.stringify(info));
await b.close();
