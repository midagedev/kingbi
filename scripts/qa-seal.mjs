// 봉인/새벽/밤의 그림 QA — seal detonation visibility, dawn grade, painting card.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const OUT = process.env.INSPECT_OUT || 'shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.waitForTimeout(600);

// 1. Seal moment from the live gameplay camera (stamp + purge + sigil).
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('seal'));
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/qa-seal-moment.png` });

// 2. Top-down pause over the sigil — the painting mark itself.
const rig = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.defenseRig());
await page.evaluate((r) => {
  window.__THREE_GAME_TEST_HOOKS__?.poseCamera(r.gunX, r.gunY + 40, r.gunZ - 9, r.gunX, r.gunY, r.gunZ - 9, 44);
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
}, rig);
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/qa-seal-sigil.png` });
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(false));

// 3. The composed 밤의 그림 card.
const dataUrl = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.paintingDataUrl());
writeFileSync(`${OUT}/qa-painting.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));

// 4. Dawn ceremony frame (grade eased in, banner live, painted yard).
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('dawn'));
await page.waitForTimeout(2100);
await page.screenshot({ path: `${OUT}/qa-dawn.png` });
const dawnDiag = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);

console.log(JSON.stringify({ dawnDiag, errors: [...new Set(errors)] }, null, 2));
await browser.close();
