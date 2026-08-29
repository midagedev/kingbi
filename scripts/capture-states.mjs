import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const OUT_DIR = process.env.INSPECT_OUT || 'shots';

const CAPTURES = [
  { name: 'title-desktop', settle: 2500 },
  { name: 'wave-desktop', state: 'active-play', settle: 16000 },
  { name: 'firing-desktop', state: 'active-play', settle: 14000, holdFire: 4000 },
  { name: 'stress-desktop', state: 'stress', settle: 5000, holdFire: 3000 },
  { name: 'bloodnight-desktop', state: 'bloodnight', settle: 6000, holdFire: 2500 },
  { name: 'style-desktop', state: 'showcase', settle: 4500, holdFire: 1200, stamp: true },
  { name: 'tide-desktop', state: 'tide', settle: 8000, holdFire: 2000 },
  { name: 'seal-desktop', state: 'seal', settle: 900 },
  { name: 'armed-desktop', state: 'active-play', settle: 16000, armSeal: true },
  { name: 'dawn-desktop', state: 'dawn', settle: 2500 },
  { name: 'dead-desktop', state: 'dead', settle: 1500 },
  { name: 'wave-mobile', state: 'active-play', settle: 12000, mobile: true },
  { name: 'stress-mobile', state: 'stress', settle: 6000, mobile: true, holdFire: 1500 },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  const results = [];

  for (const capture of CAPTURES) {
    const context = await browser.newContext(
      capture.mobile
        ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
        : { viewport: { width: 1280, height: 720 } },
    );
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
    await page.waitForTimeout(800);

    if (capture.state) {
      await page.evaluate((state) => window.__THREE_GAME_TEST_HOOKS__?.setState(state), capture.state);
    }
    if (capture.armSeal) {
      await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setSealCharge(1));
    }
    await page.waitForTimeout(Math.max(0, (capture.settle ?? 2000) - (capture.holdFire ?? 0)));
    if (capture.holdFire) {
      await page.mouse.move(420, 400);
      await page.mouse.down();
      const hold = capture.holdFire;
      const steps = 6;
      for (let i = 0; i < steps; i += 1) {
        await page.mouse.move(360 + i * 130, 400, { steps: 4 });
        await page.waitForTimeout(Math.max(60, hold / steps - 40));
      }
      // Screenshot WHILE fire is still down (no mouse.up).
      await page.mouse.move(520, 400, { steps: 3 });
      await page.waitForTimeout(140);
    }
    if (capture.stamp) {
      // Fire the style stamp right before the shot so the slam reads.
      await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.showcaseStamp('巨', '거구 격파'));
      await page.waitForTimeout(420);
    }

    const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
    await page.screenshot({ path: `${OUT_DIR}/${capture.name}.png` });

    results.push({
      name: capture.name,
      diagnostics,
      consoleErrors: [...new Set(consoleErrors)],
      pageErrors,
    });
    await context.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
