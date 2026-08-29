import { chromium } from '@playwright/test';

const BASE = process.env.INSPECT_URL || 'http://127.0.0.1:5188';

async function main() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  await page.goto(`${BASE}/?godmode=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#start-button')?.disabled, null, { timeout: 90_000 });

  const report = await page.evaluate(async () => {
    const mod = await import('/src/entities/Horde.ts');
    const proto = mod.Horde.prototype;
    const self = { partPush: proto.partPush, mergeParts: proto.mergeParts };
    const inspect = (label, geo) => {
      const pos = geo.attributes.position;
      const count = pos.count;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let headFront = 0;   // vertices in the face zone (y 1.05..1.2, z > 0.15)
      let faceZone = 0;    // vertices y 1.05..1.2 at all
      let belowHem = 0;    // skirt-bottom zone y < 0.2
      let lowY = Infinity;
      for (let i = 0; i < count; i += 1) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (y < lowY) lowY = y;
        if (y > 1.05 && y < 1.2) { faceZone += 1; if (z > 0.15) headFront += 1; }
        if (y < 0.2) belowHem += 1;
      }
      return { label, count, bounds: { minX, maxX, minY, maxY, minZ, maxZ }, headFront, faceZone, belowHem };
    };
    const torso = proto.buildTorsoGeometry.call(self);
    const arm = proto.buildArmGeometry.call(self);
    const leg = proto.buildLegGeometry.call(self);
    const tumor = proto.buildTumorGeometry.call(self);
    // Fingertip check: vertices below y -0.64 on the arm = claw tips.
    const armPos = arm.attributes.position;
    let clawTips = 0, clawSpan = 0;
    for (let i = 0; i < armPos.count; i += 1) {
      const y = armPos.getY(i);
      if (y < -0.64) { clawTips += 1; const x = armPos.getX(i); if (Math.abs(x) > clawSpan) clawSpan = Math.abs(x); }
    }
    return {
      torso: inspect('torso', torso),
      arm: inspect('arm', arm),
      leg: inspect('leg', leg),
      tumor: inspect('tumor', tumor),
      armClawTipsBelow064: clawTips,
      armClawMaxAbsX: clawSpan,
    };
  });

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
