// 원복 검증: 사망 → 'dying' 애니메이션 복귀, box3d 시체 부재, 러블·화재·색광 생존.
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
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
await page.waitForTimeout(600);
const mid = await page.evaluate(() => {
  const list = window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? [];
  return {
    total: list.length,
    dying: list.filter((z) => z.state === 'dying').length,
    kills: window.__THREE_GAME_DIAGNOSTICS__?.kills,
    rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
    corpsesFieldGone: window.__THREE_GAME_DIAGNOSTICS__?.corpses === undefined,
  };
});
await page.waitForTimeout(1600);
const settled = await page.evaluate(() => {
  const list = window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? [];
  return { dyingLater: list.filter((z) => z.state === 'dying').length };
});
console.log('[dying settle]', JSON.stringify(settled));
// 러블 파이프라인 생존 확인 — 집 철거
await page.evaluate(() => {
  const h = window.__THREE_GAME_TEST_HOOKS__?.defenseRig?.() ?? { gateX: 0, gateZ: 0 };
  window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(h.gateX - 14, h.gateZ - 12, 2, 2.2);
});
await page.waitForTimeout(900);
const after = await page.evaluate(() => ({
  rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
  rubbleVisual: window.__THREE_GAME_DIAGNOSTICS__?.rubbleVisual,
  awake: window.__THREE_GAME_DIAGNOSTICS__?.physAwake,
}));
await page.screenshot({ path: 'shots/revert-verify.png' });
console.log('[mid-burst]', JSON.stringify(mid));
console.log('[after-chew]', JSON.stringify(after));
const pass = mid.dying > 0 && mid.corpsesFieldGone && after.rubble > 0 && errors.length === 0;
console.log(pass ? 'PASS: dying anim back, corpse layer gone, rubble alive' : 'FAIL');
console.log('[errors]', errors.slice(0, 5));
await browser.close();
