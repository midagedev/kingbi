// Staging probe: measures the defense placement across several seeds.
import { chromium } from '@playwright/test';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGE-ERR:', e.message.slice(0, 160)));
await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });

const dump = async (label) => {
  const d = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stageDebug());
  const { palace, bunker, heights, houses } = d;
  const slope = Math.max(...heights.map((s) => s.y)) - Math.min(...heights.map((s) => s.y));
  const north = heights.filter((s) => s.dz <= -30);
  const rise = north.length ? (north[north.length - 1].y - north[0].y) : 0;
  console.log(`\n== ${label} (seed ${d.villageSeed}) ==`);
  console.log(`palace z=${palace.z.toFixed(0)} bunker z=${bunker.z.toFixed(0)} (palace${(bunker.z - palace.z).toFixed(0)}) y=${bunker.y}`);
  console.log(`heights(dz:+24→-84): ${heights.map((s) => s.y).join(' ')}`);
  console.log(`profile span=${slope.toFixed(1)}m north-rise=${rise.toFixed(1)}m`);
  console.log(`houses: ${houses.map((hh) => `(${hh.x - bunker.x},${hh.z - bunker.z})v=${hh.visible}`).join(' ')}`);
  console.log(`obstacles near: ${d.obstaclesNearDefense.length}`);
};
await dump('default');
for (const seed of [7, 12345, 999, 31337]) {
  await page.evaluate((s) => window.__THREE_GAME_TEST_HOOKS__?.reroll(s), seed);
  await page.waitForTimeout(2500);
  await dump(`seed-${seed}`);
}
await browser.close();
