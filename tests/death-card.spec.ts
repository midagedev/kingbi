import { expect, test } from '@playwright/test';

// Viral loop regression: death card stats, record badge, share text, and the
// score-card download all work end to end on a fresh profile.

test('death card: stats, record, share text, score-card download', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chrome',
    'Share/drop wiring is input-agnostic; the firing step needs the mouse.',
  );
  test.setTimeout(90_000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  // Hermetic clipboard: the headless build's real clipboard API can hang, so
  // install a recording fake. Its navigator.share stub rejects with
  // AbortError (reads as user-dismiss), so remove it to exercise the
  // clipboard fallback deterministically. Must run before goto.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as unknown as { __lastSharedText__?: string }).__lastSharedText__ = text;
          return Promise.resolve();
        },
      },
    });
  });

  await page.goto('/');
  // Fresh context = empty localStorage, so this run must be a 신기록.
  await page.waitForFunction(() => !(document.querySelector('#start-button') as HTMLButtonElement | null)?.disabled);
  await page.click('#start-button');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.mode === 'playing');

  // Rack up kills with a real hold-fire sweep.
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.zombies ?? 0) > 6, null, { timeout: 20_000 });
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let sweep = 0; sweep < 5; sweep += 1) {
    await page.mouse.move(400 + sweep * 120, 340, { steps: 5 });
    await page.waitForTimeout(450);
  }
  await page.mouse.up();
  const kills = await page.evaluate(() => Number(window.__THREE_GAME_DIAGNOSTICS__?.kills ?? 0));
  expect(kills, 'the sweep must kill before the death card renders').toBeGreaterThan(0);

  // Force the fall, then let the 0.85s slow-reveal timer open the card.
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('dead'));
  await page.waitForFunction(() => document.querySelector('#end-screen')?.classList.contains('visible'), null, { timeout: 5_000 });

  await expect(page.locator('#record-badge')).toBeVisible();
  await expect(page.locator('#end-subtitle')).toContainText(`격살 ${kills}`);
  const accText = await page.locator('#stat-acc').textContent();
  expect(accText ?? '').toMatch(/^\d+%$/);
  expect(await page.locator('#stat-time').textContent()).toMatch(/^\d+:\d{2}$/);
  const statKills = Number(await page.locator('#stat-kills').textContent());
  expect(statKills).toBe(kills);

  // Share falls back to clipboard in headless Chromium.
  await page.click('#share-button');
  await expect(page.locator('#toast')).toContainText('복사');
  const shared = await page.evaluate(() => (window as unknown as { __lastSharedText__?: string }).__lastSharedText__ ?? '');
  expect(shared).toContain('새벽까지');
  expect(shared).toContain(`격살 ${kills}`);
  expect(shared).toContain('명중률');

  // The score card lands as a non-trivial PNG download.
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
  await page.click('#shot-button');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('궁가의밤-전적.png');
  const path = await download.path();
  await testInfo.attach('score-card', { path, contentType: 'image/png' });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
