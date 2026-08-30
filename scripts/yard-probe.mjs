// Big-courtyard staging probe: mesh-measured palace edge vs gun/camera/cliff.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
for (const seed of [20260815, 7, 999, 31337]) {
  if (seed !== 20260815) {
    await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.reroll(s), seed);
    await page.waitForTimeout(2600);
  }
  const r = await page.evaluate(() => {
    const st = window.__THREE_GAME_TEST_HOOKS__?.stageDebug();
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return {
      seed: st.villageSeed,
      palaceZ: +st.palace.z.toFixed(0),
      gunZ: st.bunker.z,
      camZ: +d.player.position.z.toFixed(0),
      camY: +d.player.position.y.toFixed(0),
      heights: st.heights.map((x) => x.y).slice(0, 6).join(','),
    };
  });
  console.log(JSON.stringify(r));
}
await browser.close();
