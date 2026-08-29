import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const OUT_DIR = process.env.INSPECT_OUT || 'shots';

/** Per-type framing: level shots at head height — a downward tilt hides the
 *  face (maw/fangs live on the head front) and flattens everything. */
const FRAMING = {
  normal: { back: 3.1, up: 2.0, side: 1.5, lookY: 1.15, fov: 30 },
  runner: { back: 2.8, up: 1.9, side: 1.4, lookY: 1.05, fov: 30 },
  shield: { back: 3.2, up: 2.0, side: 1.5, lookY: 1.1, fov: 30 },
  bloater: { back: 3.0, up: 1.8, side: 1.6, lookY: 0.7, fov: 30 },
  brute: { back: 5.2, up: 3.2, side: 2.4, lookY: 2.0, fov: 34 },
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium' });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
      '#hud,#damage-vignette,#speedlines,#impact-flash,#stamp,#rank-layer,#toast,#wave-banner{display:none!important}';
    document.head.appendChild(style);
    window.__THREE_GAME_TEST_HOOKS__?.setState('models');
  });
  await page.waitForTimeout(900);

  const zombies = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? []);
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
  });
  await page.waitForTimeout(250);

  const shots = [];
  for (const z of zombies) {
    const f = FRAMING[z.type] ?? FRAMING.normal;
    // Front 3/4: camera south-east of the subject, subject mid-stride facing the bunker.
    const px = z.x + f.side;
    const py = f.up;
    const pz = z.z + f.back;
    await page.evaluate(
      ({ px, py, pz, tx, ty, tz, fov }) => {
        window.__THREE_GAME_TEST_HOOKS__?.poseCamera(px, py, pz, tx, ty, tz, fov);
      },
      { px, py, pz, tx: z.x, ty: f.lookY, tz: z.z - 0.2, fov: f.fov },
    );
    await page.waitForTimeout(120);
    const path = `${OUT_DIR}/model-${z.type}.png`;
    await page.screenshot({ path });
    shots.push({ type: z.type, x: z.x, z: z.z, state: z.state, path });
  }

  // Group lineup: everyone in one frame for silhouette comparison.
  const zs = zombies.map((z) => z.z);
  const zMid = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 7;
  await page.evaluate(
    ({ zMid }) => {
      // North-side low angle (bunker side): their faces + the lit courtyard —
      // the south rampart body swallows any camera placed south of the line.
      window.__THREE_GAME_TEST_HOOKS__?.poseCamera(0.5, 3.0, zMid - 7, 0, 1.0, zMid + 0.5, 50);
    },
    { zMid },
  );
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT_DIR}/model-lineup.png` });

  console.log(JSON.stringify({ shots, consoleErrors: [...new Set(consoleErrors)], pageErrors }, null, 2));
  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
