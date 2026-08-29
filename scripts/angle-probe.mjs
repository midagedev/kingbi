import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const OUT = process.env.INSPECT_OUT || 'shots/angles';
mkdirSync(OUT, { recursive: true });

// Candidates around the south-gate emplacement. dx is camera X offset from
// the gun (positive = further east), all positions relative to the gun/gate.
const CANDIDATES = [
  { name: 'A-current', dx: 0, height: 30, back: 31, lookZ: 26, fov: 55, lookDx: 0 },
  { name: 'B-low-gritty', dx: 1, height: 20, back: 22, lookZ: 16, fov: 50, lookDx: -2 },
  { name: 'C-high-tactical', dx: 0, height: 40, back: 37, lookZ: 30, fov: 58, lookDx: 0 },
  { name: 'D-gate-axis', dx: -5, height: 26, back: 27, lookZ: 20, fov: 52, lookDx: -3 },
  { name: 'E-wide-cinema', dx: 0, height: 35, back: 46, lookZ: 34, fov: 62, lookDx: 0 },
  { name: 'F-over-gate', dx: -4, height: 44, back: 21, lookZ: 24, fov: 60, lookDx: -2 },
  { name: 'G-low-hero', dx: 2, height: 15, back: 19, lookZ: 13, fov: 48, lookDx: -1 },
  { name: 'H-east-shoulder', dx: 8, height: 28, back: 30, lookZ: 22, fov: 55, lookDx: -4 },
];

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 120_000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#hud,#damage-vignette,#speedlines,#impact-flash,#stamp,#rank-layer,#toast,#cinema-bars{display:none!important}';
    document.head.appendChild(style);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  });
  await page.waitForTimeout(9000);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
  await page.waitForTimeout(200);

  const rig = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return { zombies: d?.zombies ?? 0, world: window.__THREE_GAME_TEST_HOOKS__?.defenseRig() ?? null };
  });

  const shots = [];
  for (const c of CANDIDATES) {
    await page.evaluate((c) => {
      const H = window.__THREE_GAME_TEST_HOOKS__;
      H.setPausedForScreenshot(false);
      H.poseCamera(
        c.world.gunX + c.dx, c.world.gunY + c.height, c.world.gunZ - c.back,
        c.world.gateX + c.lookDx, c.world.gateY + 1, c.world.gateZ + c.lookZ,
        c.fov,
      );
      H.setPausedForScreenshot(true);
    }, { ...c, world: rig.world });
    await page.waitForTimeout(120);
    const path = `${OUT}/${c.name}.png`;
    await page.screenshot({ path });
    shots.push({ name: c.name, path, ...c });
  }
  console.log(JSON.stringify({ rig, errors, shots }, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
