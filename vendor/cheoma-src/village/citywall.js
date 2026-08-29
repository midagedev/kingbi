import * as THREE from 'three';
import { mergeStatic } from './instancing.js';
import {
  CITY_WALL_DIMENSIONS,
  cityGateStructureProfile,
  cityWallSegmentCapProfile,
  sampleCityWallSegments,
} from './citywall-contour.js';

// 성곽(도성 성벽) + 사대문(숭례·흥인·숙정·돈의) 렌더 — 한양 전용(#47).
//   스펙(순수 데이터)은 citywall-contour.planCityWall 이 만든다. 여기서는 그 단일 contour를 따라
//   화면 terrain-grid 삼각면에 밀착한 석성 리본을 두르고, 게이트 자리엔 문루(석축 홍예 +
//   기와 문루)를 세운다. 재질을 소수(석축·여장·기와·목·홍예그늘)로 통일해 병합 후 드로우콜을 억제.
//
//   buildCityWall(spec, site) → THREE.Group (스스로 큰 바운딩이라 컬링 이득은 적으나 드로우콜 소수).

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 지형을 따르는 사각 프리즘을 버퍼에 누적. 네 모서리마다 ground가 달라 경사면에서도 하단·상단이
// 일정한 노출 높이를 유지한다. 바닥은 땅속이라 생략하고, 기존 중복 top 삼각형도 만들지 않는다.
function pushTerrainPrism(P, I, corners, ground, bottomOffset, topOffset, {
  capStart = true,
  capEnd = true,
} = {}) {
  const base = P.length / 3;
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i], y = ground[i];
    P.push(p.x, y + bottomOffset, p.z);
    P.push(p.x, y + topOffset, p.z);
  }
  // 8 정점: 각 코너 (bottom, top) 쌍. index: corner i → base+i*2 (bot), +1 (top)
  const q = (a, b, cc, d) => I.push(a, b, cc, a, cc, d);
  // 옆면 4
  for (let i = 0; i < 4; i++) {
    if ((i === 0 && !capStart) || (i === 2 && !capEnd)) continue;
    const a = base + i * 2, b = base + ((i + 1) % 4) * 2;
    q(a, b, b + 1, a + 1);
  }
  // 윗면
  q(base + 1, base + 3, base + 5, base + 7);
}

// 문루 우진각 지붕(#78 근경 격상) — 평슬래브 대신 지붕 어휘로 읽히게: 처마 반전(코너 들림)·
//   처마 곡(중앙 처짐)·용마루(main ridge)·내림마루(hip ridges, 능선 끝→4코너). 저폴리 유지.
//   반환 THREE.Group(면=tileMat, 마루=ridgeMat). 문 4기 한정이라 병합 후 드로우콜 소폭↑ 허용.
//   roof-rank = city-gate (#150 C): 궁 잡상·취두 등 palace ornament를 절대 붙이지 않는다.
function buildGateRoof(w, d, h, M) {
  const g = new THREE.Group();
  g.name = 'city-gate-roof';
  g.userData.roofRank = 'city-gate';
  const hw = w / 2, hd = d / 2;
  const tw = w * 0.15;               // 용마루 반길이(짧은 능선)
  const cl = h * 0.20;               // 처마 반전(코너 들림) — 한식 지붕 실루엣
  const sag = h * 0.06;              // 처마 중앙 처짐(오목 곡선)
  const P = [], I = [];
  const add = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  const RL = add(-tw, h, 0), RR = add(tw, h, 0);              // 용마루 두 끝
  const flC = add(-hw, cl, hd), frC = add(hw, cl, hd), fMid = add(0, cl - sag, hd); // 앞 처마
  const blC = add(-hw, cl, -hd), brC = add(hw, cl, -hd), bMid = add(0, cl - sag, -hd); // 뒤 처마
  // 앞면(+z): 처마(fl·fMid·fr) → 용마루(RL·RR)
  I.push(flC, fMid, RL, fMid, RR, RL, fMid, frC, RR);
  // 뒷면(-z)
  I.push(brC, bMid, RR, bMid, RL, RR, bMid, blC, RL);
  // 좌·우 우진각 삼각
  I.push(flC, RL, blC);
  I.push(frC, brC, RR);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setIndex(I); geo.computeVertexNormals();
  const surf = new THREE.Mesh(geo, M.tileMat);
  surf.castShadow = surf.receiveShadow = true; g.add(surf);
  // 용마루: 능선 위 두툼한 어두운 기와마루.
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(tw * 2 + w * 0.05, h * 0.16, d * 0.11), M.ridgeMat);
  ridge.position.set(0, h + h * 0.04, 0); ridge.castShadow = true; g.add(ridge);
  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const [ex, ez] of [[hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd]]) {
    const rx = Math.sign(ex) * tw;                            // 능선 끝
    const dir = new THREE.Vector3(ex - rx, cl - h, ez);
    const len = dir.length(); dir.normalize();
    const hip = new THREE.Mesh(new THREE.BoxGeometry(len, h * 0.10, d * 0.07), M.ridgeMat);
    hip.quaternion.setFromUnitVectors(xAxis, dir);
    hip.position.set((rx + ex) / 2, (h + cl) / 2, ez / 2);
    hip.castShadow = true; g.add(hip);
  }
  return g;
}

export function buildCityWall(spec, site) {
  const group = new THREE.Group(); group.name = 'city-wall-work';
  if (!spec) { group.name = 'city-wall'; return group; }
  const { gates } = spec;
  const {
    bodyHeight: wallH,
    thickness: thk,
    foundationSink: sink,
    capHeight,
  } = CITY_WALL_DIMENSIONS;

  const stoneP = [], stoneI = [];      // 석축 몸통
  const capP = [], capI = [];          // 여장(윗단) — 약간 안쪽·짙게

  const segments = sampleCityWallSegments(spec, site, { thickness: thk });
  for (const segment of segments) {
    const caps = { capStart: !segment.joinedStart, capEnd: !segment.joinedEnd };
    pushTerrainPrism(stoneP, stoneI, segment.corners, segment.ground, -sink, wallH - sink, caps);
    // 여장(윗단): 살짝 얇게 벽 위에 얹어 성가퀴 느낌 + 그림자선.
    const cap = cityWallSegmentCapProfile(segment, thk * 0.7);
    pushTerrainPrism(capP, capI, cap.corners, cap.baseY, 0, capHeight, caps);
  }

  // DoubleSide: 수작업 스윕 벽면의 와인딩 불일치로 인한 컬링 구멍 방지(벽 두께라 비용 미미).
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8f887d, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x746c62, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const mk = (P, I, mat, name) => {
    if (!I.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.name = name;
    m.castShadow = true; m.receiveShadow = true; group.add(m);
  };
  mk(stoneP, stoneI, stoneMat, 'wall-stone');
  mk(capP, capI, capMat, 'wall-cap');

  // ── 사대문(석축 홍예 + 기와 문루) ── 소수 재질(석·홍예그늘·기와·목) 공유.
  const gateStoneMat = new THREE.MeshStandardMaterial({ color: 0x968d80, roughness: 1, metalness: 0 });
  const archMat = new THREE.MeshStandardMaterial({ color: 0x241f1b, roughness: 1, metalness: 0 });
  const tileMat = new THREE.MeshStandardMaterial({ color: linCol(0x3b4048), roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  const ridgeMat = new THREE.MeshStandardMaterial({ color: linCol(0x262b32), roughness: 0.85, metalness: 0 }); // 용마루·내림마루(짙은 기와마루)
  const woodMat = new THREE.MeshStandardMaterial({ color: linCol(0x8a4a3a), roughness: 0.9, metalness: 0 });
  for (const g of gates) {
    group.add(buildGate(g, site, { gateStoneMat, archMat, tileMat, ridgeMat, woodMat }));
  }
  // 벽·문의 다수 메시(문루 기둥·석축 등)를 재질별 병합 → ~7 드로우콜(정적이라 손실 없음).
  const merged = mergeStatic([group], 'city-wall');
  merged.userData.isCityWall = true;
  merged.userData.segmentCount = segments.length;
  return merged;
}

// 한 성문: 지형에 앉힌 석축 대(臺) + 홍예(아치 그늘) + 문루(기와 우진각 + 기둥).
function buildGate(gate, site, M) {
  const g = new THREE.Group(); g.name = `gate-${gate.name}`;
  const scale = gate.scale || 1;
  const w = gate.width, depth = CITY_WALL_DIMENSIONS.gateDepth * scale;
  // 문이 성벽 링에 직교하도록 회전 — dir(반경 방향)을 문루 정면(로컬 +z)으로.
  const rotY = Math.atan2(gate.dirX, gate.dirZ);
  // 기존 산길 높이는 유지하고 좌우 육축만 각자의 지반까지 내린다. 공통 상인방은 도로 유효고와
  // 높은 쪽 지반의 최소 노출을 만족하는 낮은 값이라, 평탄 축대·인공 램프·절벽 타워가 생기지 않는다.
  const structure = cityGateStructureProfile(gate, site);
  g.position.set(gate.x, 0, gate.z);
  g.rotation.y = rotY;

  // 석축 대: 통로 양옆 pierW 폭의 육축 두 덩이. 각 육축은 자기 footprint의 최저 지반까지
  // 독립적으로 내려 경사지에서도 떠 있지 않고, 공통 baseTopY에서 홍예 상인방과 만난다.
  const pierW = 5.5 * scale;
  const half = w / 2 + pierW / 2;
  for (const [index, sx] of [-1, 1].entries()) {
    const bottom = structure.piers[index].min
      - CITY_WALL_DIMENSIONS.gateFoundationSink * scale;
    const height = structure.baseTopY - bottom;
    const pier = new THREE.Mesh(new THREE.BoxGeometry(pierW, height, depth), M.gateStoneMat);
    pier.position.set(sx * half, bottom + height / 2, 0);
    pier.castShadow = pier.receiveShadow = true; g.add(pier);
  }
  // 홍예 상인방(문 위 석재) + 천장 그늘. 예전의 세로 검정 cuboid는 통로를 실제로 막았으므로,
  // 얕은 수평 soffit만 두어 문 너머 지형과 길은 보이면서 안쪽 깊이만 어둡게 읽히게 한다.
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(w + pierW, structure.lintelHeight, depth), M.gateStoneMat);
  lintel.position.set(0, structure.baseTopY - structure.lintelHeight / 2, 0); lintel.castShadow = true; g.add(lintel);
  const soffitH = 0.12 * scale;
  const soffit = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, soffitH, depth * 0.72), M.archMat);
  soffit.position.set(0, structure.archTopY - soffitH / 2, 0); g.add(soffit);

  // 문루 마루(대 위 목조 단): 낮은 난간 + 기둥 열.
  const deckY = structure.baseTopY + 0.2 * scale;
  const deckW = w + pierW * 2 + 1.5 * scale, deckD = depth + 2.0 * scale;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.5, deckD), M.gateStoneMat);
  deck.position.set(0, deckY, 0); deck.castShadow = deck.receiveShadow = true; g.add(deck);
  const colH = 3.4 * scale;
  for (const sx of [-1, -0.34, 0.34, 1]) for (const sz of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, colH, 6), M.woodMat);
    col.position.set(sx * deckW * 0.4, deckY + 0.25 + colH / 2, sz * deckD * 0.38);
    col.castShadow = true; g.add(col);
  }
  // 문루 지붕(기와 우진각) — 처마가 마루 밖으로. #78: 슬래브→지붕 어휘(용마루·내림마루·처마곡).
  const roofY = deckY + 0.25 + colH;
  const roof = buildGateRoof(deckW + 3.4 * scale, deckD + 3.4 * scale, (deckD + 3.4 * scale) * 0.42, M);
  roof.position.set(0, roofY, 0); g.add(roof);
  return g;
}
