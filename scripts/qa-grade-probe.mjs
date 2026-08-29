import { chromium, devices } from '@playwright/test';

async function probe(label, context) {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4188/?msaa=0&godmode=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 180_000 });
  await page.click('#start-button');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('stress'));
  await page.waitForTimeout(9000);
  const stats = await page.evaluate(() => {
    const canvas = document.querySelector('#game-canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const w = 128, h = 128;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const region = (y0, y1) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; n += 1;
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    };
    // readPixels origin = bottom-left: "top" of screen = high y in buffer.
    return { screenTop: region(h - 24, h), screenMid: region(52, 76), screenBottom: region(0, 24) };
  });
  console.log(label, JSON.stringify(stats));
  await page.close();
  return stats;
}

const browser = await chromium.launch({ channel: 'chromium' });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await probe('desktop', desktop);
const mobile = await browser.newContext({ ...devices['iPhone 13'] });
await probe('mobile ', mobile);
await browser.close();
