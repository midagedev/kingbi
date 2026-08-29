// Perf probe: real draw calls (autoReset disabled around composer render) + FPS.
import { chromium } from '@playwright/test';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const STATE = process.env.PERF_STATE || 'stress';
const SECONDS = Number(process.env.PERF_SECONDS || 5);

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate((state) => window.__THREE_GAME_TEST_HOOKS__?.setState(state), STATE);
await page.waitForTimeout(2500);

const report = await page.evaluate(async ({ seconds }) => {
  const canvas = document.querySelector('#game-canvas');
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  const frames0 = d?.frame ?? 0;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const d2 = window.__THREE_GAME_DIAGNOSTICS__;
  const frames = (d2?.frame ?? 0) - frames0;
  return {
    fps: Number((frames / seconds).toFixed(1)),
    zombies: d2?.zombies,
    phase: d2?.phase,
    renderer: d2?.renderer,
    canvas: { w: canvas?.clientWidth, h: canvas?.clientHeight, bufW: canvas?.width, bufH: canvas?.height },
  };
}, { seconds: SECONDS });

console.log(JSON.stringify({ state: STATE, ...report, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
await browser.close();
