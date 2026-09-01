// 색광 전파 QA: baseline (석등만) → 화재 점화 → 수치 + 스크린샷.
// Assert: 인접 집 lit>0, 화재 점화 후 lit 급증, tickMs 가벼움.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 90, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
await page.waitForTimeout(1200); // 2+ bake ticks under lanterns

const before = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.voxelLightDebug() ?? []);
console.log('[lanterns-only]', JSON.stringify(before));
await page.screenshot({ path: 'shots/voxlight-lanterns.png' });

// Fire next to the nearest hanok row house (house specs: inner choga ~(-7.5,-24)/(7.5,-25)).
const houses = await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  const rig = hooks?.defenseRig?.() ?? { gateX: 0, gateZ: 0 };
  return rig;
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.igniteFireAt(-7.5, -24, 1.3));
await page.waitForTimeout(1400);
const after = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.voxelLightDebug() ?? []);
console.log('[fire-lit]', JSON.stringify(after));
await page.screenshot({ path: 'shots/voxlight-fire.png' });

const litBefore = before.reduce((a, h) => a + h.lit, 0);
const litAfter = after.reduce((a, h) => a + h.lit, 0);
const tickMs = Math.max(...after.map((h) => h.tickMs), 0);
console.log(`[assert] litBefore=${litBefore} litAfter=${litAfter} tickMs=${tickMs}`);
console.log(litBefore > 0 && litAfter > litBefore ? 'PASS: light propagates & fire adds warmth' : 'FAIL: propagation inert');
console.log('[errors]', errors.slice(0, 5));
await browser.close();
