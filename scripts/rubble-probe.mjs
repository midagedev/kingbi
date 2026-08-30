// Rubble + palace-shootability probe on the dev server (the "잔해가 안 쌓여"
// repro): chew by hand, read live body counts, shoot-test the palace box.
import { chromium, webkit } from '@playwright/test';
for (const [name, launch, opts] of [
  ['chromium', () => chromium.launch({ channel: 'chromium' }), {}],
  ['webkit', () => webkit.launch(), { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  const browser = await launch();
  const page = await browser.newPage(opts);
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(`[${m.type()}] ${m.text().slice(0, 120)}`); });
  page.on('pageerror', (e) => warnings.push(`[pageerror] ${String(e).slice(0, 150)}`));
  await page.goto('http://127.0.0.1:5188/?godmode=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
  await page.evaluate(() => document.querySelector('#start-button')?.click());
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({
    rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
    houses: window.__THREE_GAME_TEST_HOOKS__?.stageDebug()?.houses?.length,
  }));
  // Chew two houses by hand (simulated sustained fire).
  const chewed = await page.evaluate(() => {
    const h = window.__THREE_GAME_TEST_HOOKS__?.stageDebug()?.houses ?? [];
    let removed = 0;
    for (let k = 0; k < 14; k += 1) {
      removed += window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(h[0].x + (k % 3) * 2, h[0].z + (k % 2), 1 + (k % 4) * 1.3, 1.3) ?? 0;
    }
    return removed;
  });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.rubble);
  // Palace shootability: ray-test toward the palace center.
  const palace = await page.evaluate(() => {
    const st = window.__THREE_GAME_TEST_HOOKS__?.stageDebug();
    return { palaceZ: st.palace?.z, palaceVoxelIndex: st.palaceVoxelIndex, gunX: st.bunker.x, gunZ: st.bunker.z, houseCount: st.houses.length };
  });
  console.log(JSON.stringify({ name, before, chewed, rubbleAfter: after, palace, warnings: warnings.slice(0, 4) }));
  await browser.close();
}
