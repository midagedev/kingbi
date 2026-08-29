import * as THREE from 'three';
import { getPropMaterials } from '../props/materials.js';
import { boulderGeometry } from '../props/geom.js';
import { makeRng } from '../rng.js';

// 돌다리 — 개울을 가로지르는 화강석 다리. 두 형식을 파라미터로 선택.
//   type:'slab' 판석교(널돌+교각, 소박)  |  type:'arch' 홍예교(무지개 아치, 격식)
//   돌 질감·팔레트는 props(석탑·석등·석축 등)와 통일하려고 getPropMaterials()
//   (granite/graniteDark/graniteWarm/graniteMoss)와 boulderGeometry 를 재사용한다.
//
// 로컬 좌표: X = 개울을 건너는 방향(span), Z = 통행 방향(width), y=0 = 수면.
//   호출부가 개울 교차점에 맞춰 회전·이동한다.
// buildBridge(opts) → THREE.Group.

export function buildBridge(opts = {}) {
  const type = opts.type === 'arch' ? 'arch' : 'slab';
  return type === 'arch' ? buildArchBridge(opts) : buildSlabBridge(opts);
}

// ── 판석교 ─────────────────────────────────────────────────────────
// 낮은 화강석 교각 위에 긴 널돌(판석)을 걸친 소박한 다리. 널돌 2열.
export function buildSlabBridge(opts = {}) {
  const { seed = 7, span = 4.5, width = 1.5, deckY = 0.55, piers = 2 } = opts;
  const rng = makeRng(seed);
  const P = getPropMaterials();
  const g = new THREE.Group();
  g.name = 'bridge-slab';

  const slabThk = 0.16;
  const segN = piers + 1;
  const segLen = span / segN;
  const bedY = -0.4;                 // 개울 바닥(교각 밑)

  // 교각(중간 지점) — 물에 잠긴 낮은 각석 기둥 + 갑석
  for (let i = 1; i < segN; i++) {
    const x = -span / 2 + i * segLen;
    const pierTop = deckY - slabThk;
    const pierH = pierTop - bedY;
    const pier = new THREE.Mesh(new THREE.BoxGeometry(0.52, pierH, width * 0.86), P.granite);
    pier.position.set(x, bedY + pierH / 2, 0); pier.castShadow = pier.receiveShadow = true; g.add(pier);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, width * 0.98), P.graniteWarm);
    cap.position.set(x, pierTop - 0.05, 0); cap.castShadow = true; g.add(cap);
    // 물가름(뱃머리) 돌 — 상류측 삼각
    const cut = new THREE.Mesh(new THREE.BoxGeometry(0.3, pierH * 0.8, 0.3), P.graniteDark);
    cut.position.set(x - 0.3, bedY + pierH * 0.4, 0); cut.rotation.y = Math.PI / 4; g.add(cut);
  }

  // 양안 둑돌(자연석 무리) — 다리 끝을 땅에 자연스럽게 앉힘
  for (const s of [-1, 1]) {
    const bx = s * (span / 2 + 0.05);
    const abut = new THREE.Mesh(new THREE.BoxGeometry(0.6, deckY + 0.5, width * 0.95), P.graniteDark);
    abut.position.set(bx, (deckY - 0.5) / 2, 0); abut.castShadow = abut.receiveShadow = true; g.add(abut);
    for (let k = 0; k < 3; k++) {
      const r = 0.28 + rng() * 0.16;
      const rock = new THREE.Mesh(boulderGeometry(rng, r, 1, 0.8),
        rng() > 0.5 ? P.granite : P.graniteMoss);
      rock.position.set(bx + s * (0.3 + rng() * 0.3), r * 0.5, (rng() - 0.5) * width * 1.1);
      rock.rotation.y = rng() * Math.PI; rock.castShadow = true; g.add(rock);
    }
  }

  // 널돌(판석) — 세그먼트마다 2열
  for (let i = 0; i < segN; i++) {
    const x0 = -span / 2 + i * segLen;
    const cx = x0 + segLen / 2;
    for (const row of [-1, 1]) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(segLen * 1.04, slabThk, width * 0.46),
        rng() > 0.5 ? P.granite : P.graniteWarm);
      slab.position.set(
        cx + (rng() - 0.5) * 0.05,
        deckY - slabThk / 2 + (rng() - 0.5) * 0.02,
        row * width * 0.25);
      slab.rotation.y = (rng() - 0.5) * 0.03;
      slab.castShadow = slab.receiveShadow = true; g.add(slab);
    }
  }

  g.userData = { kind: 'bridge', type: 'slab', span, width };
  return g;
}

// ── 홍예교(무지개다리) ──────────────────────────────────────────────
// 반원 홍예(아치) 위로 노면이 봉긋하게 넘어가는 격식 있는 돌다리.
//   ExtrudeGeometry 로 옆면 실루엣(홍예 개구 포함)을 단면으로 뽑아 통돌 몸체를 만들고,
//   홍예석 이음선·낮은 난간·둑돌을 덧댄다.
export function buildArchBridge(opts = {}) {
  const { seed = 9, span = 4.6, width = 1.6 } = opts;
  const rng = makeRng(seed);
  const P = getPropMaterials();
  const g = new THREE.Group();
  g.name = 'bridge-arch';

  const R = span * 0.4;              // 홍예 반경(반원)
  const springY = 0.05;             // 홍예가 솟는 높이(수면 바로 위)
  const halfLen = span / 2;         // 몸체 반폭
  const baseY = -0.25;              // 몸체 바닥(개울 바닥/둑에 묻힘)
  const crownY = springY + R;       // 홍예 정점(내면)
  const deckCenterY = crownY + 0.42;
  const deckEndY = springY + R * 0.42 + 0.3;
  const deckY = (x) => deckEndY + (deckCenterY - deckEndY) * (1 - Math.pow(Math.abs(x) / halfLen, 2)); // 봉긋한 노면

  // 옆면 단면(XY): 바깥 경계가 홍예 내면(반원)을 파고들어 개구를 만든다.
  const shape = new THREE.Shape();
  shape.moveTo(-halfLen, baseY);
  shape.lineTo(-R, baseY);
  shape.lineTo(-R, springY);                 // 좌측 홍예 받침(abutment) 수직면
  const AN = 16;
  for (let i = 0; i <= AN; i++) {            // 홍예 내면 반원: 좌 → 정점 → 우
    const a = Math.PI - (i / AN) * Math.PI;
    shape.lineTo(Math.cos(a) * R, springY + Math.sin(a) * R);
  }
  shape.lineTo(R, baseY);                     // 우측 받침 수직면 내려감
  shape.lineTo(halfLen, baseY);
  shape.lineTo(halfLen, deckEndY);           // 우측 바깥면
  const DN = 12;
  for (let i = 0; i <= DN; i++) {            // 봉긋한 노면(우 → 좌)
    const x = halfLen - (i / DN) * (halfLen * 2);
    shape.lineTo(x, deckY(x));
  }
  shape.lineTo(-halfLen, baseY);             // 좌측 바깥면 닫기

  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, steps: 1 });
  geo.translate(0, 0, -width / 2);
  geo.computeVertexNormals();
  const bodyMat = P.granite.clone(); bodyMat.side = THREE.DoubleSide; // 통돌 몸체(안팎 안전)
  const body = new THREE.Mesh(geo, bodyMat);
  body.castShadow = body.receiveShadow = true; g.add(body);

  // 홍예석 이음선(방사형) — 양면에 얕은 쐐기돌 경계
  const nVous = 9;
  for (let i = 0; i <= nVous; i++) {
    const a = Math.PI - (i / nVous) * Math.PI;
    for (const zf of [-1, 1]) {
      const joint = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.03), P.graniteDark);
      joint.position.set(Math.cos(a) * (R + 0.14), springY + Math.sin(a) * (R + 0.14), zf * (width / 2 + 0.005));
      joint.rotation.z = a - Math.PI / 2; g.add(joint);
    }
  }

  // 낮은 난간(양쪽 노면 가) — 짧은 엄지기둥 + 갑석 곡선
  for (const zf of [-1, 1]) {
    const z = zf * (width / 2 - 0.06);
    const NP = 7;
    for (let i = 0; i <= NP; i++) {
      const x = -halfLen + (i / NP) * (halfLen * 2);
      const y = deckY(x);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), P.graniteWarm);
      post.position.set(x, y + 0.17, z); post.castShadow = true; g.add(post);
    }
    // 갑석(난간 윗돌) — 노면 곡선을 따라 판석 조각들
    for (let i = 0; i < NP; i++) {
      const x0 = -halfLen + (i / NP) * (halfLen * 2);
      const x1 = -halfLen + ((i + 1) / NP) * (halfLen * 2);
      const xm = (x0 + x1) / 2;
      const seg = new THREE.Mesh(new THREE.BoxGeometry((x1 - x0) * 1.02, 0.1, 0.18), P.granite);
      seg.position.set(xm, deckY(xm) + 0.38, z);
      seg.rotation.z = Math.atan2(deckY(x1) - deckY(x0), x1 - x0);
      seg.castShadow = true; g.add(seg);
    }
  }

  // 양안 둑돌(자연석) — 다리 끝을 땅에 앉힘
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const r = 0.3 + rng() * 0.18;
      const rock = new THREE.Mesh(boulderGeometry(rng, r, 1, 0.8),
        rng() > 0.5 ? P.graniteDark : P.graniteMoss);
      rock.position.set(s * (halfLen + 0.15 + rng() * 0.3), r * 0.4, (rng() - 0.5) * (width + 0.6));
      rock.rotation.y = rng() * Math.PI; rock.castShadow = rock.receiveShadow = true; g.add(rock);
    }
  }

  g.userData = { kind: 'bridge', type: 'arch', span, width, height: deckCenterY + 0.5 };
  return g;
}
