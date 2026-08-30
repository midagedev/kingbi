// Compare day→night fade completion between engines at t=2/6/12/20s.
import { chromium, webkit } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';

async function run(name, launch) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(name, '[pageerror]', e.message.slice(0, 200)));
  await page.goto('https://midagedev.github.io/kingbi/?godmode=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
  await page.evaluate(() => document.querySelector('#start-button')?.click());
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, { timeout: 30_000 });
  for (const t of [2000, 4000, 6000, 8000]) {
    await page.waitForTimeout(t === 2000 ? 2000 : 2000);
    await page.screenshot({ path: `/tmp/${name}-${t}.png` });
    const png = PNG.sync.read(fs.readFileSync(`/tmp/${name}-${t}.png`));
    let sum = 0, n = 0;
    for (let i = 0; i < png.data.length; i += 4 * 131) {
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n += 1;
    }
    console.log(`${name} t+${(t / 1000)}s lum=${(sum / n).toFixed(0)}`);
  }
  await browser.close();
}
await run('chromium', () => chromium.launch({ channel: 'chromium' }));
await run('webkit', () => webkit.launch());
