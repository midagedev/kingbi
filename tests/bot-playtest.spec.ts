import { expect, test } from '@playwright/test';

// Automated bot playtest: drives the gatling siege through real mouse input,
// forces a wave, and proves the core loop (aim → hold fire → kills) progresses
// without errors or softlocks.

type BotSnapshot = {
  frame: number;
  kills: number;
  mode: string;
  phase: string;
  hp: number;
  heat: number;
  spin: number;
  zombies: number;
  x: number;
  z: number;
};

test('bot playtest: gatling mows down a forced wave', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chrome',
    'The bot uses mouse input; mobile touch is exercised by visual.spec.ts.',
  );
  test.setTimeout(120_000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await page.waitForFunction(() => !(document.querySelector('#start-button') as HTMLButtonElement | null)?.disabled);
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(12345);
    // stress: a close, dense, deterministic two-river press on a fixed bearing.
    window.__THREE_GAME_TEST_HOOKS__?.setState('stress');
  });
  await page.waitForFunction((): boolean => window.__THREE_GAME_DIAGNOSTICS__?.mode === 'playing');

  const sample = (): Promise<BotSnapshot | null> =>
    page.evaluate((): BotSnapshot | null => {
      const d = window.__THREE_GAME_DIAGNOSTICS__ as Record<string, number | string> | undefined;
      if (!d) return null;
      return {
        frame: Number(d.frame),
        kills: Number(d.kills),
        mode: String(d.mode),
        phase: String(d.phase),
        hp: Number(d.hp),
        heat: Number(d.heat),
        spin: Number(d.spin),
        zombies: Number(d.zombies),
        x: Number((d.player as unknown as { position: { x: number } }).position.x),
        z: Number((d.player as unknown as { position: { z: number } }).position.z),
      };
    });

  // Wait for the trickle spawn to put bodies downrange.
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.zombies ?? 0) > 8, null, { timeout: 20_000 });

  const before = (await sample()) as BotSnapshot;
  expect(before).not.toBeNull();

  // Sweep the aim across the incoming bearing while holding fire.
  await page.mouse.move(400, 400);
  await page.mouse.down();
  for (let sweep = 0; sweep < 8; sweep += 1) {
    await page.mouse.move(260 + sweep * 100, 400, { steps: 6 });
    await page.waitForTimeout(550);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = (await sample()) as BotSnapshot;
  expect(after).not.toBeNull();

  const report = {
    framesAdvanced: after.frame - before.frame,
    killsBefore: before.kills,
    killsAfter: after.kills,
    mode: after.mode,
    phase: after.phase,
    hp: after.hp,
    heat: Number(after.heat.toFixed(2)),
    zombies: after.zombies,
    consoleErrors,
    pageErrors,
  };
  await testInfo.attach('bot-playtest-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(`bot playtest: ${JSON.stringify(report)}`);

  expect(pageErrors, 'page errors during bot play').toEqual([]);
  expect(consoleErrors, 'console errors during bot play').toEqual([]);
  expect(report.framesAdvanced, 'game loop must keep running').toBeGreaterThan(100);
  expect(report.killsAfter, 'gatling sweep must kill zombies').toBeGreaterThan(0);
  expect(report.heat, 'heat must accumulate while firing').toBeGreaterThan(0);
});
