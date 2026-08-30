// Corpse-pile + blast-aggression probe (the "시체가 안 쌓여 / 집이 튼튼해" repro):
// seal-purge a zombie cluster → box3d corpses must appear and SURVIVE frames
// later (piled, not vanished); chew a house by hand → the crater per blast
// must be an order bigger than the old 1.15m radius bite.
import { chromium, webkit } from '@playwright/test';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
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
  // Wait for the horde to actually march in (diagnostics lag a frame —
  // always read counts a beat after the action).
  await page.waitForFunction(
    () => (window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? []).length >= 6,
    null,
    { timeout: 45_000 },
  );

  // Purge on an ACTUAL zombie (the centroid of a converging spawn ring is
  // usually empty ground) — corpses must replace the ballistic flight.
  // Diagnostics snapshots lag a frame: read counters a beat after acting.
  const purge = await page.evaluate(() => {
    const list = window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? [];
    if (list.length === 0) return { zombies: 0 };
    const target = list.find((z) => z.type !== 'bloater') ?? list[0];
    const kills = window.__THREE_GAME_DIAGNOSTICS__?.kills ?? 0;
    window.__THREE_GAME_TEST_HOOKS__?.fireSealAt(target.x, target.z);
    return { zombies: list.length, killsBefore: kills, at: [target.x, target.z] };
  });
  await page.waitForTimeout(1200);
  const killsDelta = await page.evaluate(
    (before) => ({
      kills: (window.__THREE_GAME_DIAGNOSTICS__?.kills ?? 0) - before,
    }),
    purge.killsBefore ?? 0,
  );
  const corpsesSoon = await page.evaluate(() => ({
    corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
    rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
    zombiesLeft: (window.__THREE_GAME_TEST_HOOKS__?.listZombies() ?? []).length,
  }));
  // Pile persistence: corpses must still be there 4s later (settled, asleep).
  await page.waitForTimeout(4000);
  const corpsesSettled = await page.evaluate(() => ({
    corpses: window.__THREE_GAME_DIAGNOSTICS__?.corpses,
    rubble: window.__THREE_GAME_DIAGNOSTICS__?.rubble,
  }));

  // Blast aggression: one manual chew at the new fire radius vs house volume.
  const chewed = await page.evaluate(() => {
    const h = window.__THREE_GAME_TEST_HOOKS__?.stageDebug()?.houses ?? [];
    if (h.length === 0) return -1;
    return window.__THREE_GAME_TEST_HOOKS__?.chewHouseAt(h[0].x, h[0].z, 2, 2.0) ?? -1;
  });
  await page.waitForTimeout(700);
  const rubbleAfterChew = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.rubble);

  await page.screenshot({ path: `shots/corpse-probe-${name}.png` });
  console.log(JSON.stringify({
    name, purge, killsDelta, corpsesSoon, corpsesSettled, chewPermille: chewed, rubbleAfterChew,
    warnings: warnings.slice(0, 4),
  }));
  await browser.close();
}
