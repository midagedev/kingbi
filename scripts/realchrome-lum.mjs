// Measure rendered canvas luminance in REAL Chrome (GPU) over CDP.
import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('kingbi')) ?? (await ctx.newPage());
if (!page.url().includes('kingbi')) await page.goto('https://midagedev.github.io/kingbi/?godmode=1');
await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });
await page.evaluate(() => document.querySelector('#start-button')?.click());
for (const t of [4000, 6000]) {
  await page.waitForTimeout(t === 4000 ? 4000 : 2000);
  const r = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const cv = document.querySelector('#game-canvas');
    const gl = cv.getContext('webgl2');
    const c2 = document.createElement('canvas');
    c2.width = 96; c2.height = 54;
    const c = c2.getContext('2d');
    c.drawImage(cv, 0, 0, 96, 54);
    const data = c.getImageData(0, 0, 96, 54).data;
    let sum = 0, n = 0, mn = 999, mx = -1;
    for (let i = 0; i < data.length; i += 4) {
      const l = (data[i] + data[i+1] + data[i+2]) / 3;
      sum += l; n += 1;
      mn = Math.min(mn, data[i], data[i+1], data[i+2]);
      mx = Math.max(mx, data[i], data[i+1], data[i+2]);
    }
    return { frame: d?.frame, lum: +(sum/n).toFixed(1), mn, mx,
      renderer: gl.getParameter(gl.RENDERER), dpr: window.devicePixelRatio };
  });
  console.log('real-chrome', JSON.stringify(r));
}
await browser.close();
