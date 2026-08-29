import * as THREE from 'three';
import { buildTileGableRoof } from './tileroof.js';

// 싸리문 잔가지 지터는 기본 Math.random 을 쓴다. 마을 재현 렌더(같은 seed → 픽셀 동일)를
// 위해 외부에서 시드 가능한 난수원으로 교체할 수 있다. 미교체 시 현행 동작 불변.
let _gateRand = Math.random;
export function setGateRandom(fn) { _gateRand = (typeof fn === 'function') ? fn : Math.random; }

// 대문 종류. 좌표계: 담장선 = X축, 통로 = Z축(+z 정면/바깥). 문은 원점 중심.
// buildGate('soseuldaemun'|'iljakmun'|'saripmun', { mats, seed, width? }) → THREE.Group
export function buildGate(type, { mats, seed = 1, width } = {}) {
  if (type === 'saripmun') return saripmun(mats, width);
  if (type === 'iljakmun') return iljakmun(mats, width);
  return soseuldaemun(mats, width);
}

// ── 사립문(싸리문): 초가. 통나무 기둥 2 + 싸리(잔가지) 엮은 문짝 2. 지붕 없음. ──
function saripmun(M, width = 1.6) {
  const g = new THREE.Group();
  g.name = 'saripmun';
  const open = width, postR = 0.09, postH = 1.75, half = open / 2 + postR;
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b5535, roughness: 1.0 });
  const twigMat = new THREE.MeshStandardMaterial({ color: 0x8a7346, roughness: 1.0 });
  for (const sx of [1, -1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR * 1.15, postH, 8), woodMat);
    post.position.set(sx * half, postH / 2, 0); post.castShadow = true; g.add(post);
  }
  // 상부 가로대
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, open + 0.3, 7), woodMat);
  top.rotation.z = Math.PI / 2; top.position.set(0, postH - 0.15, 0); g.add(top);
  // 싸리 문짝 2 (살짝 열림): 얇은 세로 잔가지 다발 + 가로 엮음
  for (const sx of [1, -1]) {
    const leaf = new THREE.Group();
    const lw = open / 2 - 0.05, lh = postH - 0.35;
    const nb = Math.max(5, Math.round(lw / 0.09));
    for (let i = 0; i <= nb; i++) {
      const x = -lw / 2 + lw * (i / nb) + (_gateRand() - 0.5) * 0.01;
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, lh, 5), twigMat);
      stick.position.set(x, lh / 2, 0); leaf.add(stick);
    }
    for (const yy of [0.15, lh * 0.5, lh - 0.15]) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, lw, 5), twigMat);
      bar.rotation.z = Math.PI / 2; bar.position.set(0, yy, 0); leaf.add(bar);
    }
    leaf.position.set(sx * (open / 4), 0.18, 0);
    leaf.rotation.y = sx * -0.14;
    leaf.children.forEach((c) => (c.castShadow = true));
    g.add(leaf);
  }
  return g;
}

function plankDoor(M, w, h) {
  const g = new THREE.Group();
  const board = M.woodBoard.clone();
  // 두 짝 판문 (살짝 열림)
  for (const sign of [1, -1]) {
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w / 2 - 0.03, h, 0.06), board);
    leaf.position.set(sign * (w / 4), h / 2, 0);
    leaf.rotation.y = sign * -0.12;
    leaf.castShadow = true;
    g.add(leaf);
    // 세로 널 이음 (음각 라인 대용, 얇은 각재 2줄)
    for (const lx of [-0.22, 0.22]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.03, h * 0.9, 0.08), M.woodDark);
      rib.position.set(sign * (w / 4) + sign * 0.0 + lx * 0.5, h / 2, 0.02);
      rib.rotation.y = sign * -0.12;
      g.add(rib);
    }
  }
  return g;
}

// ── 일각문: 기둥 2개 + 작은 맞배 지붕 ──
function iljakmun(M, width = 1.5) {
  const g = new THREE.Group();
  g.name = 'iljakmun';
  const open = width;
  const postR = 0.11, postH = 2.25;
  const half = open / 2 + postR;
  // 기둥
  for (const sx of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, postH, 0.22), M.wood);
    post.position.set(sx * half, postH / 2, 0);
    post.castShadow = true;
    g.add(post);
  }
  // 인방 (상부 가로 부재)
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(open + 0.5, 0.2, 0.2), M.woodDark);
  lintel.position.set(0, postH - 0.02, 0);
  lintel.castShadow = true;
  g.add(lintel);
  // 문지방 돌 + 판문
  const sill = new THREE.Mesh(new THREE.BoxGeometry(open + 0.1, 0.1, 0.5), M.stoneDark);
  sill.position.set(0, 0.05, 0);
  g.add(sill);
  const door = plankDoor(M, open, postH - 0.15);
  door.position.y = 0.08;
  g.add(door);
  // 지붕 (맞배, 용마루 담선 방향)
  const roof = buildTileGableRoof(M, {
    length: open + 0.6, halfSpan: 0.85, eaveY: postH + 0.05, ridgeY: postH + 0.85,
    overhangX: 0.32, overhangZ: 0.22, curve: 0.45, dots: true, gableEnds: true, ridgeR: 0.1,
  });
  g.add(roof);
  return g;
}

// ── 솟을대문: 가운데 칸 지붕이 한 단 높은 3칸 대문 ──
function soseuldaemun(M, centralWidth = 2.6) {
  const g = new THREE.Group();
  g.name = 'soseuldaemun';
  const c = centralWidth, s = 1.9;      // 중앙칸 / 협칸 폭
  const depth = 1.6;                    // 통로 깊이(z)
  const cPostH = 3.35, sPostH = 2.55;
  const cx = c / 2, ox = c / 2 + s;     // 기둥 x

  const beam = (w, y, x = 0, mat = M.woodDark, d = 0.2) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), mat);
    b.position.set(x, y, 0); b.castShadow = true; g.add(b);
  };

  // 중앙칸 기둥 4개(전후 2열)
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.24, cPostH, 0.24), M.wood);
    p.position.set(sx * cx, cPostH / 2, sz * (depth / 2));
    p.castShadow = true; g.add(p);
  }
  // 협칸 벽 (회벽 + 하부 화방벽) — 좌우
  for (const sx of [1, -1]) {
    const wall = new THREE.Group();
    const bandH = 1.05, wallTop = sPostH - 0.05;
    const hwa = new THREE.Mesh(new THREE.BoxGeometry(s, bandH, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x8f8578, roughness: 0.95 })); // 사고석 화방벽
    hwa.position.y = bandH / 2; hwa.castShadow = hwa.receiveShadow = true; wall.add(hwa);
    const pl = new THREE.Mesh(new THREE.BoxGeometry(s, wallTop - bandH, 0.42), M.plaster);
    pl.position.y = (bandH + wallTop) / 2; pl.castShadow = true; wall.add(pl);
    // 협칸 바깥 기둥
    const op = new THREE.Mesh(new THREE.BoxGeometry(0.22, sPostH, 0.22), M.wood);
    op.position.set(sx * (ox - 0.0), sPostH / 2, 0); op.castShadow = true; wall.add(op);
    wall.position.set(sx * (cx + s / 2), 0, 0);
    g.add(wall);
  }

  // 창방/도리 (기둥머리 가로 부재)
  beam(2 * ox, sPostH - 0.15, 0);       // 전체 하단 창방
  beam(c + 0.3, cPostH - 0.18, 0);      // 중앙 상단 창방

  // 중앙 판문
  const door = plankDoor(M, c - 0.1, cPostH - 0.5);
  door.position.y = 0.1;
  g.add(door);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(c, 0.12, depth * 0.7), M.stoneDark);
  sill.position.set(0, 0.06, 0); g.add(sill);

  // 협칸(낮은) 지붕 2단
  for (const sx of [1, -1]) {
    const sr = buildTileGableRoof(M, {
      length: s + 0.2, halfSpan: depth / 2 + 0.35, eaveY: sPostH, ridgeY: sPostH + 0.62,
      overhangX: 0.22, overhangZ: 0.25, curve: 0.4, dots: true, gableEnds: true, ridgeR: 0.09,
    });
    sr.position.x = sx * (cx + s / 2);
    g.add(sr);
  }
  // 중앙(솟은) 지붕
  const cr = buildTileGableRoof(M, {
    length: c + 0.4, halfSpan: depth / 2 + 0.5, eaveY: cPostH, ridgeY: cPostH + 0.95,
    overhangX: 0.28, overhangZ: 0.3, curve: 0.4, dots: true, gableEnds: true, ridgeR: 0.11,
  });
  g.add(cr);

  // 솟은 부분 정면 패널 + 노출 도리 마구리 (솟을대문 특징)
  for (const sz of [1, -1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(c + 0.2, cPostH - sPostH - 0.1, 0.08), M.plaster);
    panel.position.set(0, (cPostH + sPostH) / 2, sz * (depth / 2 + 0.02));
    panel.castShadow = true; g.add(panel);
    // 도리 마구리 3개 (흰 원)
    for (const bx of [-0.7, 0, 0.7]) {
      const end = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12),
        new THREE.MeshStandardMaterial({ color: 0xe9e4d6, roughness: 0.85 }));
      end.rotation.x = Math.PI / 2;
      end.position.set(bx, sPostH + 0.28, sz * (depth / 2 + 0.06));
      g.add(end);
    }
  }
  return g;
}
