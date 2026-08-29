import { smoothstep } from './scalar.js';
import { makeRng } from '../../rng.js';

// 비정형 월드 외곽선의 순수 수학 커널. THREE와 DOM에 의존하지 않는다.

function makeAngularProfile(seed, harmonics) {
  const rng = makeRng(seed >>> 0);
  const harm = [];
  let peak = 0;
  for (let o = 0; o < harmonics; o++) {
    const amp = Math.pow(0.66, o) * rng.range(0.6, 1.0);
    harm.push({ freq: 2 + o + rng.int(0, 1), amp, phase: rng.range(0, Math.PI * 2) });
    peak += amp;
  }
  return (theta) => {
    let v = 0;
    for (const h of harm) v += h.amp * Math.sin(h.freq * theta + h.phase);
    return v / peak;
  };
}

export function makeWorldEdge({
  cx = 0, cz = 0, radius = 152, seed = 0x7ed9e,
  amp = 0.15, harmonics = 4, band = 0.24,
} = {}) {
  const profile = makeAngularProfile(seed, harmonics);
  const edgeRadiusAt = (theta) => {
    const p = profile(theta);
    const shaped = Math.sign(p) * Math.pow(Math.abs(p), 0.85);
    return radius * (1 + amp * shaped);
  };
  const edgeK = (x, z) => {
    const dx = x - cx, dz = z - cz;
    const r = Math.hypot(dx, dz);
    const th = Math.atan2(dz, dx);
    const R = edgeRadiusAt(th);
    return smoothstep(R * (1 - band), R, r);
  };
  return { cx, cz, radius, amp, band, edgeRadiusAt, edgeK };
}
