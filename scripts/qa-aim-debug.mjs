import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 240_000 });
await page.click('#start-button');
await page.waitForTimeout(600);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
await page.waitForTimeout(5000);
const zs = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? []);
const rig = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.defenseRig());
await page.mouse.move(640, 380);
await page.mouse.down();
const d1 = await page.evaluate(() => {
  const q = window.__THREE_GAME_DIAGNOSTICS__;
  return { kills: q.kills, player: q.player.position, heat: q.heat };
});
await page.waitForTimeout(2500);
const d2 = await page.evaluate(() => ({
  kills: window.__THREE_GAME_DIAGNOSTICS__.kills,
  heat: window.__THREE_GAME_DIAGNOSTICS__.heat,
}));
await page.mouse.up();
console.log(JSON.stringify({
  rig,
  sample: zs.slice(0, 8),
  zombieCount: zs.length,
  zombiesNorth: zs.filter((z) => z.z < rig.gunZ).length,
  d1, d2,
}, null, 2));
await browser.close();
