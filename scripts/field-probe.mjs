// Open-field staging probe: gun-to-nearest-palace-mesh distance per seed.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
for (const seed of [20260815, 7, 12345, 999, 31337]) {
  if (seed !== 20260815) {
    await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.reroll(s), seed);
    await page.waitForTimeout(2600);
  }
  const r = await page.evaluate(() => {
    const st = window.__THREE_GAME_TEST_HOOKS__?.stageDebug();
    const rig = window.__THREE_GAME_TEST_HOOKS__?.defenseRig();
    return {
      seed: st.villageSeed,
      gunZ: rig.gunZ,
      palaceZ: +st.palace.z.toFixed(0),
      // obstacles (houses) near the gun — the ONLY structures allowed close
      nearestHouseDz: Math.min(...st.houses.map((hh) => Math.abs(hh.z - rig.gunZ))),
      houseX: st.houses.map((hh) => Math.round(hh.x - rig.gunX)),
    };
  });
  const palaceGap = r.gunZ - r.palaceZ; // positive = gun south of palace center
  console.log(`seed ${String(r.seed).padEnd(9)} gunZ=${r.gunZ.toFixed(0)} palaceZ=${r.palaceZ} gap=${palaceGap.toFixed(0)}m houseDz≈-${r.nearestHouseDz.toFixed(0)} houseX=${r.houseX}`);
}
await browser.close();
