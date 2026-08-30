import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
await page.waitForTimeout(6000);
async function report(label) {
  const r = await page.evaluate(() => {
    const p = window.__THREE_GAME_DIAGNOSTICS__?.post ?? {};
    return { envIntensity: p.envIntensity, hasEnv: p.hasEnv, exposure: p.exposure };
  });
  console.log(label, JSON.stringify(r));
}
await report('boot+6s');
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setEnvIntensity(0.42));
await page.waitForTimeout(500);
await report('forced-0.42');
await page.waitForTimeout(2500);
await report('forced-0.42+2.5s');
