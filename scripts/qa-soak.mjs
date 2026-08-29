import { chromium } from '@playwright/test';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';

// Long-run soak + memory drift: stress wave → death → RETRY (real button) ×2.
// Leak signal = renderer geometries/textures drifting upward across cycles.
async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  const pageErrors = [];
  const netFails = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => netFails.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));

  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
  // Player path: real start click (audio gesture + beginRun).
  await page.click('#start-button');
  await page.waitForTimeout(1200);

  const sample = async (label) => {
    const d = await page.evaluate(() => {
      const q = window.__THREE_GAME_DIAGNOSTICS__ ?? {};
      return {
        frame: q.frame, mode: q.mode, zombies: q.zombies,
        geometries: q.renderer?.geometries, textures: q.renderer?.textures,
        calls: q.renderer?.calls, triangles: q.renderer?.triangles,
        canvasW: q.canvas?.clientWidth, canvasH: q.canvas?.clientHeight,
      };
    });
    return { label, ...d };
  };

  const samples = [];
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
    await page.waitForTimeout(1500);
    // 25s of sweeping fire per cycle.
    for (let sweep = 0; sweep < 5; sweep += 1) {
      await page.mouse.move(500, 380);
      await page.mouse.down();
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.move(330 + i * 90, 380, { steps: 3 });
        await page.waitForTimeout(700);
      }
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
    samples.push(await sample(`cycle${cycle}-postfight`));
    // Death → end screen → REAL retry button.
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('dead'));
    await page.waitForTimeout(2600); // death card settles
    await page.click('#retry-button');
    await page.waitForTimeout(2500);
    samples.push(await sample(`cycle${cycle}-postretry`));
  }

  // One more baseline check after everything.
  samples.push(await sample('final'));
  console.log(JSON.stringify({
    samples,
    consoleErrors: [...new Set(consoleErrors)],
    pageErrors,
    netFails: [...new Set(netFails)].slice(0, 8),
  }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
