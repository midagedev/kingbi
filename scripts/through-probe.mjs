// Through-penetration proof on house[2] (left giwa — inside the gun arc):
// slit its south wall, fire through the opening — the far wall must open
// too (voids drop further). Old bbox hits would chew nothing past the slit.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 60, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(1000);

const target = 2; // left giwa, proven in-gun-arc
const info = await page.evaluate((target) => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  const stage = hooks?.stageDebug();
  const house = stage.houses[target];
  const rect = stage.obstaclesNearDefense
    .map((r) => ({ ...r, cx: (r.minX + r.maxX) / 2, cz: (r.minZ + r.maxZ) / 2 }))
    .filter((r) => Math.abs(r.cx - house.x) < 4 && Math.abs(r.cz - house.z) < 4)[0];
  return { house, rect };
}, target);
const voids = () => page.evaluate((t) => window.__THREE_GAME_TEST_HOOKS__?.voxelHollow()[t], target);
const alive = () => page.evaluate((t) => window.__THREE_GAME_TEST_HOOKS__?.stageDebug().houses[t].alive, target);
console.log('[target]', JSON.stringify(info));

// 1) narrow slit in the south wall (the gun-facing side)
const slit = await page.evaluate((info) => {
  const H = window.__THREE_GAME_TEST_HOOKS__;
  const wallZ = info.rect.maxZ;
  let chewed = 0;
  for (const y of [0.9, 1.6, 2.3]) chewed += H.chewHouseAt(info.house.x, wallZ - 0.2, y, 0.7) ?? 0;
  return chewed;
}, info);
const v0 = await voids();
console.log('[slit] chewed:', slit, '→ voids:', v0.voids, 'alive:', await alive());

// 2) hold fire aimed mid-left (the sweep that chewed this house before)
await page.mouse.move(1280 * 0.32, 800 * 0.42);
await page.waitForTimeout(500);
await page.mouse.down();
await page.waitForTimeout(2000);
await page.mouse.up();
const v1 = await voids();
console.log('[after fire] voids:', v1.voids, 'alive:', await alive());
console.log('[through-proof] cells removed:', Math.round((v0.cells * v0.voids - 0) ? 0 : 0), 'void delta:', v1.voids - v0.voids);
await browser.close();
