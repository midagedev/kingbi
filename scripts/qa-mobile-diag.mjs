import { chromium, devices } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://127.0.0.1:4188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
await page.click('#start-button');
await page.waitForTimeout(600);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
await page.waitForTimeout(6000);
const d = await page.evaluate(() => {
  const q = window.__THREE_GAME_DIAGNOSTICS__;
  const rig = window.__THREE_GAME_TEST_HOOKS__.defenseRig();
  const cam = q.player.position;
  return {
    compact: window.matchMedia('(max-width: 820px), (pointer: coarse)').matches,
    zombies: q.zombies, mode: q.mode,
    cam: { x: +cam.x.toFixed(1), y: +cam.y.toFixed(1), z: +cam.z.toFixed(1) },
    rig,
    camToGun: {
      dx: +(cam.x - rig.gunX).toFixed(1), dy: +(cam.y - rig.gunY).toFixed(1), dz: +(cam.z - rig.gunZ).toFixed(1),
    },
  };
});
console.log(JSON.stringify(d, null, 2));
await browser.close();
