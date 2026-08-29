// 순수 좌표 검증. 실행: node src/layout/skeleton.test.mjs
import { computeSkeleton, footprints } from './skeleton.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL:', msg); }
}
const approx = (a, b, e = 1e-3) => Math.abs(a - b) < e;
function hasNode(sk, x, z, h) {
  return sk.nodes.some((n) => approx(n.x, x) && approx(n.z, z) && (h === undefined || approx(n.h, h)));
}
function hasSeg(list, ax, az, bx, bz) {
  return list.some((s) =>
    (approx(s.a.x, ax) && approx(s.a.z, az) && approx(s.b.x, bx) && approx(s.b.z, bz)) ||
    (approx(s.a.x, bx) && approx(s.a.z, bz) && approx(s.b.x, ax) && approx(s.b.z, az)));
}

// ── 1. 직사각형 8×5 ──
// hip roof: 용마루 z=2.5, x=2.5..5.5, 높이 2.5. 코너로 4 hip.
{
  const sk = computeSkeleton(footprints.rect(8, 5));
  console.log('[rect 8x5] nodes:', sk.nodes.map((n) => `(${n.x.toFixed(2)},${n.z.toFixed(2)},h${n.h.toFixed(2)})`).join(' '));
  ok(hasNode(sk, 2.5, 2.5, 2.5), 'rect ridge end (2.5,2.5,h2.5)');
  ok(hasNode(sk, 5.5, 2.5, 2.5), 'rect ridge end (5.5,2.5,h2.5)');
  ok(hasSeg(sk.ridges, 2.5, 2.5, 5.5, 2.5), 'rect main ridge segment');
  ok(sk.hips.length === 4, `rect has 4 hips (got ${sk.hips.length})`);
  ok(sk.valleys.length === 0, `rect has 0 valleys (got ${sk.valleys.length})`);
  ok(sk.faces.length === 4, `rect 4 faces (got ${sk.faces.length})`);
}

// ── 2. ㄱ자 (L): arm=4, wing=2 → 외곽 [0,8]? 아니고 footprints.L(4,2) ──
// 정점: (0,0)(8,0)(8,2)(2,2)(2,8)(0,8). 손계산 skeleton:
//   중앙 junction (1,1,h1), 아래팔 마루끝 (7,1,h1), 왼팔 마루끝 (1,7,h1)
//   회첨: 반사코너 (2,2) → (1,1)
{
  const sk = computeSkeleton(footprints.L(4, 2));
  console.log('[L] nodes:', sk.nodes.map((n) => `(${n.x.toFixed(2)},${n.z.toFixed(2)},h${n.h.toFixed(2)})`).join(' '));
  console.log('[L] valleys:', sk.valleys.map((s) => `(${s.a.x.toFixed(1)},${s.a.z.toFixed(1)})-(${s.b.x.toFixed(1)},${s.b.z.toFixed(1)})`).join(' '));
  ok(hasNode(sk, 1, 1, 1), 'L junction (1,1,h1)');
  ok(hasNode(sk, 7, 1, 1), 'L bottom-arm ridge end (7,1,h1)');
  ok(hasNode(sk, 1, 7, 1), 'L left-arm ridge end (1,7,h1)');
  ok(hasSeg(sk.valleys, 2, 2, 1, 1), 'L valley (2,2)-(1,1)');
  ok(hasSeg(sk.ridges, 1, 1, 7, 1), 'L bottom ridge (1,1)-(7,1)');
  ok(hasSeg(sk.ridges, 1, 1, 1, 7), 'L left ridge (1,1)-(1,7)');
  ok(sk.valleys.length === 1, `L exactly 1 valley (got ${sk.valleys.length})`);
  ok(sk.faces.length === 6, `L 6 faces (got ${sk.faces.length})`);
}

// ── 3. ㄷ자 (U): W=6,D=5, notch [2,4]×[2,5] ──
// 정점:(0,0)(6,0)(6,5)(4,5)(4,2)(2,2)(2,5)(0,5). 반사코너 (4,2),(2,2).
//   바닥슬래브(z<2) 아래 마루 z=1. 두 회첨: (4,2)→(5,1)?  손계산:
//   왼프롱[0,2]×[0,5] 마루 x=1; 오른프롱[4,6]×[0,5] 마루 x=5; 바닥[0,6]×[0,2]와 겹침.
//   반사코너 (2,2): 이등분선 방향 (+1,-1)? 내측으로 → (3,1) 방향. (4,2):(-1,-1)→(3,1).
//   실제 junction은 (1,1),(5,1) 및 회첨이 거기로. 아래에서 실측 출력 확인.
{
  const sk = computeSkeleton(footprints.U(6, 5, 2, 4, 2));
  console.log('[U] nodes:', sk.nodes.map((n) => `(${n.x.toFixed(2)},${n.z.toFixed(2)},h${n.h.toFixed(2)})`).join(' '));
  console.log('[U] valleys:', sk.valleys.map((s) => `(${s.a.x.toFixed(1)},${s.a.z.toFixed(1)})-(${s.b.x.toFixed(1)},${s.b.z.toFixed(1)})`).join(' '));
  console.log('[U] ridges:', sk.ridges.map((s) => `(${s.a.x.toFixed(1)},${s.a.z.toFixed(1)})-(${s.b.x.toFixed(1)},${s.b.z.toFixed(1)})`).join(' '));
  ok(sk.valleys.length === 2, `U exactly 2 valleys (got ${sk.valleys.length})`);
  ok(hasSeg(sk.valleys, 2, 2, 1, 1), 'U valley from (2,2) to (1,1)');
  ok(hasSeg(sk.valleys, 4, 2, 5, 1), 'U valley from (4,2) to (5,1)');
  ok(hasNode(sk, 1, 1, 1), 'U junction (1,1,h1)');
  ok(hasNode(sk, 5, 1, 1), 'U junction (5,1,h1)');
  ok(hasNode(sk, 1, 4, 1), 'U left-prong apex (1,4,h1)');
  ok(hasNode(sk, 5, 4, 1), 'U right-prong apex (5,4,h1)');
  ok(hasSeg(sk.ridges, 1, 1, 5, 1), 'U slab ridge (1,1)-(5,1)');
  ok(hasSeg(sk.ridges, 1, 1, 1, 4), 'U left-prong ridge (1,1)-(1,4)');
  ok(hasSeg(sk.ridges, 5, 1, 5, 4), 'U right-prong ridge (5,1)-(5,4)');
  ok(sk.ridges.length === 3, `U 3 ridges (got ${sk.ridges.length})`);
  ok(sk.hips.length === 6, `U 6 hips (got ${sk.hips.length})`);
  ok(sk.faces.length === 8, `U 8 faces (got ${sk.faces.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
