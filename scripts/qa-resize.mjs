import { chromium } from '@playwright/test';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';

// Resize/rotate mid-game: canvas + HUD must survive geometry changes, and
// pointer aim must still track after a resize (stale NDC math would break).
async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
  await page.click('#start-button');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await page.waitForTimeout(4000);

  const stages = [
    { name: 'desktop-narrow', vp: { width: 900, height: 700 } },
    { name: 'desktop-ultrawide', vp: { width: 1720, height: 760 } },
    { name: 'rotate-portrait', vp: { width: 390, height: 844 } },
    { name: 'rotate-landscape', vp: { width: 844, height: 390 } },
  ];
  const report = [];
  for (const stage of stages) {
    await page.setViewportSize(stage.vp);
    await page.waitForTimeout(900);
    const probe = await page.evaluate(() => {
      const d = window.__THREE_GAME_DIAGNOSTICS__ ?? {};
      const canvas = document.querySelector('#game-canvas');
      const hud = document.querySelector('#hud');
      const heat = document.querySelector('#heat-bar');
      const cross = document.querySelector('#crosshair');
      const mute = document.querySelector('#mute-button');
      const rect = mute?.getBoundingClientRect();
      const inside = rect
        ? rect.right <= window.innerWidth && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.top >= 0
        : false;
      return {
        frame: d.frame, mode: d.mode, zombies: d.zombies,
        canvasClient: d.canvas?.clientWidth + 'x' + d.canvas?.clientHeight,
        canvasBuf: d.canvas?.width + 'x' + d.canvas?.height,
        hudVisible: hud && !hud.classList.contains('hidden'),
        crosshairVisible: !!cross && cross.getBoundingClientRect().width > 0,
        heatVisible: !!heat && heat.getBoundingClientRect().width > 0,
        muteOnscreen: inside,
      };
    });
    // Aim still tracks after resize: move pointer, ensure frame advances.
    await page.mouse.move(stage.vp.width / 2, stage.vp.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const after = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);
    report.push({ stage: stage.name, ...probe, framesDuringFire: after - probe.frame });
  }
  await page.screenshot({ path: 'shots/qa-rotate-landscape.png' });
  console.log(JSON.stringify({ report, errors: [...new Set(errors)] }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
