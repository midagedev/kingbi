// 궁 원본 전환 검증: merged 가시 → 발파 칩(보이는 파편) → 붕괴(merged 소멸+전각 비행) → reset.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 120_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 90, null, { timeout: 60_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(1500);
console.log('[plan]', JSON.stringify(await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.palacePlan())));
console.log('[merged]', JSON.stringify(await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.palaceMergedStats())));
const info0 = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.meshHouseInfo());
console.log('[meshhouses]', JSON.stringify(info0.houses.map(h => [h.index, h.parts, h.shadow])));
console.log('[windows total]', info0.windows);
await page.screenshot({ path: 'shots/palace-mesh-night.png' });
// 궁 발파 — 3회 칩
for (let i = 0; i < 3; i += 1) {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(0, -100, 3, 3));
  await page.waitForTimeout(150);
}
const afterChip = await page.evaluate(() => ({ info: window.__THREE_GAME_TEST_HOOKS__?.meshHouseInfo(), awake: window.__THREE_GAME_DIAGNOSTICS__?.physAwake, rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble }));
console.log('[after chips] palace parts:', afterChip.info.houses.at(-1).parts, 'awake:', afterChip.awake, 'rubble:', afterChip.rubble);
// 궁 붕괴
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.collapseHouseAt(0, -100));
await page.waitForTimeout(800);
console.log('[after collapse] palace:', JSON.stringify((await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.meshHouseInfo())).houses.at(-1)), 'merged:', JSON.stringify(await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.palaceMergedStats())));
await page.screenshot({ path: 'shots/palace-collapsed.png' });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'shots/palace-settled.png' });
// reset
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('title'));
await page.waitForTimeout(500);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('night'));
await page.waitForTimeout(1500);
const restored = await page.evaluate(() => ({ info: window.__THREE_GAME_TEST_HOOKS__?.meshHouseInfo(), merged: window.__THREE_GAME_TEST_HOOKS__?.palaceMergedStats() }));
console.log('[restored] palace collapsed:', restored.info.houses.at(-1).collapsed, 'merged visible:', restored.merged.visible);
console.log('[errors]', errors.slice(0, 6));
await browser.close();
