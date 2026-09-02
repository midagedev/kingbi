// 원본 메시 한옥 검증: 렌더(가시성·창호지) → 칩 분쇄(부품 감소·물리 기상) →
// 점화 → 전체 붕괴(부재 전멸·피스 강체) → reset 복원.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 120_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 90, null, { timeout: 40_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(1500);
const rig = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.defenseRig());
const houses = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.yardHouses());
console.log('[rig]', JSON.stringify(rig));
console.log('[houses]', JSON.stringify(houses));
console.log('[mesh-windows]', await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.meshHouseInfo?.() ?? 'no-hook'));
await page.screenshot({ path: 'shots/meshhouse-night.png' });
// 칩: 첫 집에 반복 발사
const hx = houses[0].x, hz = houses[0].z;
for (let i = 0; i < 6; i += 1) {
  await page.evaluate(({ x, z }) => window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(x, z, 1.5, 1.8), { x: hx, z: hz });
  await page.waitForTimeout(120);
}
const after6 = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.yardHouses());
console.log('[after 6 chews] h0 alive:', after6[0].alive, 'rubble:', await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.rubble), 'awake:', await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.physAwake));
await page.waitForTimeout(2500);
await page.screenshot({ path: 'shots/meshhouse-chipped.png' });
// 붕괴
await page.evaluate(({ x, z }) => window.__THREE_GAME_TEST_HOOKS__?.collapseHouseAt(x, z), { x: hx, z: hz });
await page.waitForTimeout(700);
const collapsed = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.yardHouses());
console.log('[after collapse] h0 visible:', collapsed[0].visible, 'fires:', await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.fires ?? -1));
await page.screenshot({ path: 'shots/meshhouse-collapsed.png' });
await page.waitForTimeout(2200);
await page.screenshot({ path: 'shots/meshhouse-settled.png' });
console.log('[errors]', errors.slice(0, 6));
await browser.close();
