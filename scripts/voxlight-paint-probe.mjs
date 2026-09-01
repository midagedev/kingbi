// 색광 페인트 도달 검증: demolish 리그 → 최고 휘도 복셀들의 base vs painted.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 90, null, { timeout: 30_000 });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('demolish'));
await page.waitForTimeout(2600);
const rows = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.voxelLightRows(0) ?? []);
console.log('[house1 top rows]', JSON.stringify(rows, null, 1));
const ok = rows.every((r) => r.painted[0] > r.base[0] + 0.05 && r.painted[0] - r.painted[2] > r.base[0] - r.base[2] + 0.08);
console.log(ok ? 'PASS: warm additive reaches instanceColor buffer' : 'FAIL: paint not landing');
console.log('[errors]', errors.slice(0, 4));
await browser.close();
