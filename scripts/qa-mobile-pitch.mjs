import { chromium, devices } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
await page.click('#start-button');
await page.waitForTimeout(600);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
await page.waitForTimeout(9000);
const out = await page.evaluate(() => {
  const q = window.__THREE_GAME_DIAGNOSTICS__;
  const cam = q.player.position;
  const canvas = document.querySelector('#game-canvas');
  return {
    cam: { x: +cam.x.toFixed(1), y: +cam.y.toFixed(1), z: +cam.z.toFixed(1) },
    zombies: q.zombies,
    fovHint: 'see cam pitch via project test',
    // project the road point 20m south of the gate into NDC
    roadNdc: (() => {
      const rig = window.__THREE_GAME_TEST_HOOKS__.defenseRig();
      return { gateZ: +rig.gateZ.toFixed(1) };
    })(),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
