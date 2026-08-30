import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4190/kingbi/', { waitUntil: 'domcontentloaded' });
const r = await page.evaluate(async () => {
  const out = [];
  for (const u of ['/kingbi/assets/index-v6h_x5CI.js', 'assets/index-v6h_x5CI.js', '/kingbi/textures/zombie-rag.jpg']) {
    try {
      const res = await fetch(u);
      out.push({ u, status: res.status, type: res.headers.get('content-type') });
    } catch (e) { out.push({ u, err: String(e).slice(0, 120) }); }
  }
  return out;
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
