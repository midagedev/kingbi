// Corridor probe: do any building boxes intersect the camera→gun→lane
// sightline cone, per seed? (The "거대한 건물에 가려" repro.)
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });

for (const seed of [20260815, 7, 12345, 999, 31337, 42, 777, 5]) {
  if (seed !== 20260815) {
    await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.reroll(s), seed);
    await page.waitForTimeout(2600);
  }
  const r = await page.evaluate(() => {
    const st = window.__THREE_GAME_TEST_HOOKS__?.stageDebug();
    const q = st;
    // The sightline corridor: camera sits 34m south of the gun at +30 h;
    // lane extends 40m north. Any obstacle box whose xz overlaps the strip
    // [gunZ-40, gunZ+34] × [gunX-11, gunX+11] blocks it.
    const gx = st.bunker.x, gz = st.bunker.z;
    const blockers = (st.obstaclesNearDefense || []).filter((o) => {
      const cx = (o.minX + o.maxX) / 2, cz = (o.minZ + o.maxZ) / 2;
      const half = Math.max(o.maxX - o.minX, o.maxZ - o.minZ) / 2;
      return Math.abs(cx - gx) < 11 + half && cz < gz + 40 && cz > gz - 46;
    });
    // houses are expected flankers — separate them by distance from specs
    return {
      seed: st.villageSeed,
      palace: st.palace ? { z: st.palace.z } : null,
      bunker: { x: gx, z: gz, y: st.bunker.y },
      houses: st.houses,
      blockerCount: blockers.length,
      blockers: blockers.slice(0, 4).map((o) => ({
        cx: +((o.minX + o.maxX) / 2).toFixed(0),
        cz: +((o.minZ + o.maxZ) / 2).toFixed(0),
        w: +(o.maxX - o.minX).toFixed(0),
        d: +(o.maxZ - o.minZ).toFixed(0),
      })),
    };
  });
  const rel = r.blockers.map((b) => `(${b.cx - r.bunker.x},${b.cz - r.bunker.z})${b.w}x${b.d}`);
  console.log(`seed ${String(r.seed).padEnd(9)} gunZ=${r.bunker.z.toFixed(0)} palaceZ=${r.palace?.z} blockers=${r.blockerCount} ${rel.join(' ')}`);
}
await browser.close();
