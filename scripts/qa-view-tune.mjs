import { chromium } from '@playwright/test';

// Functional framing grid: the two jobs of this camera are (1) MY GATLING
// VISIBLE in frame, (2) enemy approach direction readable. Tune on a live
// paused gameplay frame (not a posed rig).
const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';
const CANDIDATES = [
  { name: 'A-close-shoulder', dx: 2.0, height: 4.5, back: 10, lookZ: 16, fov: 50, lookDx: -1 },
  { name: 'B-mid-shoulder', dx: 2.5, height: 6.5, back: 12, lookZ: 16, fov: 50, lookDx: -1 },
  { name: 'C-high-shoulder', dx: 2.5, height: 8.5, back: 14, lookZ: 18, fov: 52, lookDx: -1.5 },
  { name: 'D-low-axis', dx: 0.5, height: 4.0, back: 9, lookZ: 14, fov: 48, lookDx: 0 },
];

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
await page.click('#start-button');
await page.waitForTimeout(600);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
await page.waitForTimeout(12000);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
await page.waitForTimeout(200);
const rig = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.defenseRig());

for (const c of CANDIDATES) {
  await page.evaluate(({ c, rig }) => {
    const H = window.__THREE_GAME_TEST_HOOKS__;
    H.setPausedForScreenshot(false);
    H.poseCamera(
      rig.gunX + c.dx, rig.gunY + c.height, rig.gunZ - c.back,
      rig.gateX + c.lookDx, rig.gateY + 2.0, rig.gateZ + c.lookZ,
      c.fov,
    );
    H.setPausedForScreenshot(true);
  }, { c, rig });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `shots/viewtune-${c.name}.png` });
}
console.log(JSON.stringify({ rig, shots: CANDIDATES.map(c => c.name) }));
await browser.close();
