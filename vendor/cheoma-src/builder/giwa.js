import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildSkeletonRoof } from '../layout/roof-skeleton.js';
import { giwaFootprint, giwaFootprintPolygon } from '../params.js';
import { giwaFrontRange } from '../layout/giwa-footprint.js';
import {
  giwaThroughPassage,
  isGiwaThroughPassageBay,
} from '../layout/giwa-through-passage.js';
import { buildGiwaMiddleGate } from './giwa-middle-gate.js';
import { planGiwaKitchenOpening } from '../layout/kitchen-opening-spatial.js';
import * as G from '../core/math/geom2.js';
import {
  OPENING_FACE_CLEARANCE,
  ROOF_SHELL_THICKNESS,
  overlayCenterOffset,
  sunkPrism,
} from '../core/surface-clearance.js';
import { buildRecessedKitchenHearth } from './kitchen-hearth.js';
import { planGiwaChimney } from './chimney-plan.js';
import { createResidentialOpeningDetails } from './residential-opening-details.js';
import { createPrimaryDoorPanelSegments } from './primary-door-panel.js';
import { planGiwaCeiling } from './ceiling-plan.js';

// 기와집(ㅡ/ㄱ/ㄷ 반가 안채): 공유 풋프린트 위에 스켈레톤 기와지붕 + 백골 목재 심벽 몸체.
// 몸체(기둥·심벽 회벽/판벽·띠살 분합문·대청·낮은 장대석 기단)를 이 경로에서 직접 만든다.
// 지붕은 buildSkeletonRoof(동결 API)로 만들고, 기와 밀도·적새·망와·와구토는 이 파일에서 후처리한다.

// 배흘림 기둥 프로파일
function colGeom(r, h, entasis) {
  const pts = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const bulge = 1 + entasis * 0.22 * Math.sin(Math.PI * Math.min(1, t / 0.66));
    const taper = 1 - 0.1 * t;
    pts.push(new THREE.Vector2(r * bulge * taper, h * t));
  }
  return new THREE.LatheGeometry(pts, 12);
}

// 평면별 변 인덱스가 달라도 의미는 좌표에서 파생한다: 안마당 면=분합문, 북측 후면=판벽,
// 바깥 측면=회벽. 이 분류를 쓰면 ㅡ/ㄱ/ㄷ이 동일한 벽체 루프를 공유한다.
function edgeRole(A, B, { planShape, a, b, w, c }) {
  const near = (x, y) => Math.abs(x - y) < 1e-7;
  const horizontal = near(A.z, B.z);
  const vertical = near(A.x, B.x);
  if (horizontal && near(A.z, -b)) return 'plank';
  if (horizontal && near(A.z, b)) return 'door';
  if (planShape !== 'single' && vertical
    && Math.min(A.z, B.z) >= b - 1e-7 && Math.max(A.z, B.z) <= b + c + 1e-7
    && (near(A.x, a - w) || near(A.x, -a + w))) return 'door';
  return 'wall';
}

function extrudeFootprint(points, bottom, top) {
  const shape = new THREE.Shape();
  points.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: top - bottom,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottom, 0);
  return geometry;
}

function addPodiumLayer(group, footprint, bottom, top, material, name, castShadow = true) {
  const mesh = new THREE.Mesh(extrudeFootprint(footprint, bottom, top), material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function addVerticalPodiumJoints(group, footprint, height, material) {
  const geometries = [];
  const spacing = 1.6;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i], b = footprint[(i + 1) % footprint.length];
    const edge = G.sub(b, a);
    const length = G.len(edge);
    const direction = G.norm(edge);
    const outward = G.perpL(direction); // footprint is CCW
    const rotation = -Math.atan2(direction.z, direction.x);
    for (let along = spacing; along < length - 0.2; along += spacing) {
      const geometry = new THREE.BoxGeometry(0.04, height * 0.9, 0.06);
      geometry.rotateY(rotation);
      geometry.translate(
        a.x + direction.x * along + outward.x * 0.005,
        height * 0.5,
        a.z + direction.z * along + outward.z * 0.005,
      );
      geometries.push(geometry);
    }
  }
  if (!geometries.length) return;
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  const joints = new THREE.Mesh(merged, material);
  joints.name = 'podium-vertical-joints';
  joints.receiveShadow = true;
  group.add(joints);
}

export function buildGiwa(P, M) {
  const root = new THREE.Group();
  root.name = 'building';
  const footprint = giwaFootprint(P);
  const throughPassage = giwaThroughPassage(P);
  const { a, b, w, c } = footprint;
  // 정규 풋프린트(기둥/벽 중심선): ㅡ/ㄱ/ㄷ 모두 같은 순수 생성기를 쓴다.
  // buildSkeletonRoof는 CW 감김에서 바깥 법선(윗면)이 나오도록 검증됨.
  const foot = giwaFootprintPolygon(P);
  const n = foot.length;
  const cen = foot.reduce((s, p) => ({ x: s.x + p.x, z: s.z + p.z }), { x: 0, z: 0 });
  cen.x /= n; cen.z /= n;

  const podH = P.podiumTierH;
  const colH = P.columnHeight, colR = footprint.columnRadius;
  const podTopY = podH, colTopY = podTopY + colH, eaveY = colTopY + 0.35;

  // ── 기단 (단일 ㄱ자 솔리드, 낮은 장대석 + 줄눈) ──
  const podium = new THREE.Group(); podium.name = 'podium';
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x6e675a, roughness: 1.0 });
  // 두 직사각형을 겹치면 교차부의 상면·줄눈·갑석이 정확히 중복된다. 같은 외곽을 한 번만
  // 압출해 깊이 소유자를 하나로 만들고, 최하단은 성토면 아래로 묻어 접지선도 안정시킨다.
  const podiumFoot = G.ensureCCW(foot);
  const lowerFoot = G.offsetPoly(podiumFoot, 0.70);
  const h0 = podH * 0.54;
  const foundation = sunkPrism(h0);
  addPodiumLayer(podium, lowerFoot, foundation.bottom, foundation.top, M.stone, 'podium-lower');
  // 갑석(podium-cap)이 기단 상면의 단일 depth owner다. 몸통 켜를 podH 까지 올리면 두 켜의
  //   상면이 정확히 같은 평면(y=podH)에 겹치는데, 갑석이 몸통을 XZ 로 완전히 덮으므로 그
  //   면 전체가 픽셀을 주고받는다 — 근경에서 기단 위가 밝은 돌/어두운 갑석 얼룩으로 깨진다.
  //   몸통 상면을 갑석 두께(0.1) 안으로 내려 면 소유자를 하나로 만든다.
  addPodiumLayer(
    podium, G.offsetPoly(podiumFoot, 0.65), h0 + 0.02, podH - OPENING_FACE_CLEARANCE,
    M.stone, 'podium-upper',
  );
  addPodiumLayer(
    podium, G.offsetPoly(podiumFoot, 0.70 + OPENING_FACE_CLEARANCE), h0 - 0.025, h0 + 0.025,
    jointMat, 'podium-course-joint', false,
  );
  addPodiumLayer(
    podium, G.offsetPoly(podiumFoot, 0.73), podH - 0.1, podH,
    M.stoneDark, 'podium-cap', false,
  );
  addVerticalPodiumJoints(podium, lowerFoot, h0, jointMat);
  root.add(podium);

  // ── 기둥 · 심벽 벽체 · 인방/창방 ──
  const colGeo = colGeom(colR, colH, P.entasis || 0.25);
  const columns = new THREE.Group(); columns.name = 'columns';
  const walls = new THREE.Group(); walls.name = 'walls';
  const T = 0.13, y0 = podTopY + 0.02;
  const yTopWall = colTopY - 0.06;        // 창방 밑 = 벽 상단
  const yMid = y0 + 1.12;                 // 중인방
  const lowerPanelTop = y0 + 0.42;         // 문짝 하부 청판 상단
  const doorBaseHeight = 2.05;            // residential heightK의 기와 기준 band
  const windowBaseBottom = y0 + 1.30;
  const windowBaseHeight = 0.62;           // 살창 기준 band

  // 목재 톤: 창방·기둥은 밝은 백골(M.wood), 인방 트림은 살짝 짙게 정의감 부여
  const woodTrim = M.wood.clone(); woodTrim.color = M.wood.color.clone().multiplyScalar(0.78);
  const seen = new Set();
  const addCol = (x, z) => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    if (seen.has(k)) return; seen.add(k);
    const m = new THREE.Mesh(colGeo, M.wood);
    m.position.set(x, podTopY, z);
    m.castShadow = m.receiveShadow = true; columns.add(m);
  };

  // 축 정렬 슬래브(벽 패널). alongX=true → x방향으로 뻗음(±z 면), false → z방향(±x 면).
  const slab = (cx, cz, len, yb, yt, mat, alongX, thick = T) => {
    const g = alongX ? new THREE.BoxGeometry(len, yt - yb, thick)
                     : new THREE.BoxGeometry(thick, yt - yb, len);
    const m = new THREE.Mesh(g, mat);
    m.position.set(cx, (yb + yt) / 2, cz);
    // 깊은 처마의 캐스트 그림자가 상부 회벽을 어두운 띠로 덮던 문제 → 벽면은 그림자 미수신.
    m.receiveShadow = false;
    walls.add(m);
    return m;
  };
  // 수평 인방/창방 목재 (변 전체 길이)
  const hbeam = (cx, cz, len, yc, alongX, mat, h = 0.13, thick = 0.17) => {
    const g = alongX ? new THREE.BoxGeometry(len, h, thick) : new THREE.BoxGeometry(thick, h, len);
    const m = new THREE.Mesh(g, mat);
    m.position.set(cx, yc, cz);
    m.castShadow = true; columns.add(m);
  };

  // 세로널 판벽 재질: 폭에 맞춰 널 반복 (그늘서도 검게 안 죽게 미량 emissive).
  //
  // 고증 수정(docs/architectural-authenticity.md §7.4-5): 공유 `M.pungpan` 캔버스 바탕은 절
  //   풍판용 #997048(r/g 1.37)이고, 반가에서 이 재질은 처마 아래를 **run 전 길이로 관통하는
  //   띠**가 된다. 실측 렌더 r/g 1.54 로 같은 프레임의 백골 기둥(1.21)·한지(1.16)보다 훨씬
  //   적색 우세해, ㅁ자 뜰집 근접 컷에서 "붉은 처마띠"로 읽혔다. 단청 누출은 아니지만(giwa
  //   팔레트는 단청 캔버스를 만들지 않는다) 이 문서 §5-4 의 "민가 창호는 백골 목재·한지 몸체와
  //   어울려야 한다"를 어긴다. §7.7-1 이 세운 판별식(r/g ≥ 1.6)에 1.54 로 **간신히 걸리지 않아**
  //   어떤 게이트도 보지 못했다.
  //   처방: 공유 캔버스·재질·텍스처를 그대로 두고 클론의 color 로만 적색 성분을 눌러 백골
  //   계열로 접는다. 절 풍판은 이 경로를 지나지 않으므로 불변이고 드로우콜 델타 0이다.
  const PLANK_DERED = new THREE.Color(0.76, 0.98, 1);
  const plankMat = (len) => {
    const m = M.pungpan.clone();
    m.map = M.pungpan.map.clone();
    m.map.repeat.set(Math.max(1, Math.round(len / 1.2)), 1); m.map.needsUpdate = true;
    m.color = PLANK_DERED.clone();
    m.emissive = new THREE.Color(0x1e1a12);
    return m;
  };
  // 문짝 하부 청판: 목재 + 미량 emissive. 종전 0x6b4e30 + emissive 0x1a1207 은 렌더 r/g 1.68 로
  //   §7.7-1 의 주칠 판별식(1.6)조차 넘었다 — 팔레트 항목이 아니라 빌더 로컬 클론이라
  //   순수 팔레트 위계 계약이 볼 수 없었던 두 번째 지점이다. 같은 명도의 덜 붉은 갈색으로 옮긴다.
  const lowerPanelMat = M.woodBoard.clone();
  lowerPanelMat.color = new THREE.Color(0x5f5136); lowerPanelMat.emissive = new THREE.Color(0x161510);
  // 살창(측벽 창): 실내가 완전 검게 죽지 않도록 미량 emissive. leafSurface=sal 전용.
  // 민가(giwa)는 궁 빗꽃살 주칠·뇌록 텍스처를 쓰지 않는다(palette applyDoorPattern / 띠살).
  const salMat = M.salchang.clone(); salMat.emissive = new THREE.Color(0x14100a);
  // 띠살 분합문 재질: detail plan이 정한 문짝 수를 texture에도 그대로 반복한다.
  // leafSurface=panel → 판문 solid board (궁 색 없음); sal → 기존 살문 맵.
  const doorMat = (detail) => {
    if (detail.leafSurface === 'panel') {
      const m = (M.woodBoard || M.planwall || M.woodDark).clone();
      m.emissive = new THREE.Color(0x161510);
      return m;
    }
    const leafCount = detail.leafCount || 1;
    const m = M.door.clone();
    m.map = M.door.map.clone(); m.map.repeat.set(leafCount, 1);
    m.map.wrapS = THREE.RepeatWrapping; m.map.needsUpdate = true;
    return m;
  };

  const openingDetails = createResidentialOpeningDetails('giwa', P, walls, {
    frame: woodTrim,
    hardware: M.hardware,
  }, {
    door: {
      bottomY: y0,
      height: doorBaseHeight,
      wallThickness: T,
      lowerPanelHeight: lowerPanelTop - y0,
      leafOutward: overlayCenterOffset(T, 0.10),
      footwear: {
        // The toenmaru slab is 12cm high and centered at podTopY + 0.42.
        // Anchor footwear on its upper face rather than through its center.
        y: podTopY + 0.42 + 0.06 - y0,
        outward: 0.78,
        surface: 'toenmaru',
      },
    },
    window: {
      bottomY: windowBaseBottom,
      height: windowBaseHeight,
      wallThickness: T,
    },
  });
  const firstDoor = openingDetails.plan.openings.find((opening) => opening.kind === 'door');
  const firstWindow = openingDetails.plan.openings.find((opening) => opening.kind === 'window');
  const doorBand = openingDetails.verticalProfile(firstDoor);
  const windowBand = openingDetails.verticalProfile(firstWindow);
  const yLintel = doorBand.topY;
  const winBot = windowBand.bottomY, winTop = windowBand.topY;

  const sidePanels = (opening, bayWidth, yb, yt, material, alongX) => {
    const side = Math.max(0, (bayWidth - opening.width) * 0.5);
    if (side <= 1e-7) return [];
    const offset = opening.width * 0.5 + side * 0.5;
    return [-1, 1].map((sign) => slab(
      opening.center.x + opening.tangent.x * offset * sign,
      opening.center.z + opening.tangent.z * offset * sign,
      side,
      yb,
      yt,
      material,
      alongX,
    ));
  };
  const visibleCenter = (opening, thickness) => {
    const offset = overlayCenterOffset(T, thickness);
    return {
      x: opening.center.x + opening.outward.x * offset,
      z: opening.center.z + opening.outward.z * offset,
    };
  };

  // The planner owns the actual aperture width. Host panels are split around
  // that width so an unselected bay remains a wall rather than a visual door.
  const wallWithWindow = (opening, bayWidth, alongX, hostMaterial) => {
    const { x, z } = opening.center;
    const hosts = [
      slab(x, z, bayWidth, y0, winBot, hostMaterial, alongX),
      slab(x, z, bayWidth, winTop, yTopWall, hostMaterial, alongX),
      ...sidePanels(opening, bayWidth, winBot, winTop, hostMaterial, alongX),
    ];
    const face = visibleCenter(opening, 0.10);
    const panel = slab(face.x, face.z, opening.width, winBot, winTop, salMat, alongX, 0.10);
    if (opening.surface === 'plank') {
      hosts[0].name = 'plank-wall-window-bay';
      panel.name = 'plank-opening';
    }
    openingDetails.add(opening, panel);
  };

  const centerBayOf = (nb) => Math.floor(nb / 2);
  const bay = footprint.bay;

  for (let i = 0; i < n; i++) {
    const A = foot[i], B = foot[(i + 1) % n];
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const nb = Math.max(1, Math.round(len / bay));
    const alongX = Math.abs(B.x - A.x) > Math.abs(B.z - A.z);
    const role = edgeRole(A, B, footprint);
    const cxE = (A.x + B.x) / 2, czE = (A.z + B.z) / 2;
    const cbay = centerBayOf(nb);

    // 기둥
    for (let k = 0; k <= nb; k++) {
      const t = k / nb; addCol(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
    }

    // 칸별 벽 채움
    for (let k = 0; k < nb; k++) {
      const tm = (k + 0.5) / nb;
      const cx = A.x + (B.x - A.x) * tm, cz = A.z + (B.z - A.z) * tm;
      const bw = len / nb - colR * 1.8;
      // 대청: 안마당을 향한 본채 정면 중앙 칸은 개방 (아래 대청 블록에서 처리).
      // Opt-in 중문채는 같은 중앙 칸을 반대쪽 외벽까지 관통시킨다.
      const mainFront = alongX && Math.abs(A.z - b) < 1e-7 && Math.abs(B.z - b) < 1e-7;
      if ((mainFront && k === cbay && nb >= 3)
        || isGiwaThroughPassageBay(A, B, k, nb, throughPassage)) continue;
      const opening = openingDetails.openingAt(i, k);

      if (opening?.kind === 'door') {
        const face = visibleCenter(opening, 0.10);
        sidePanels(opening, bw, y0, yTopWall, M.plaster, alongX);
        slab(opening.center.x, opening.center.z, opening.width,
          yLintel + 0.10, yTopWall, M.plaster, alongX);
        openingDetails.add(opening, (detail, placement) => {
          const leafMat = doorMat(detail);
          if (detail.primary && detail.anchors.pivot) {
            createPrimaryDoorPanelSegments({
              target: walls,
              plan: detail,
              placement,
              material: lowerPanelMat,
              panelHeight: lowerPanelTop - y0,
              depth: 0.10,
              activeName: 'primary-opening-lower-panel',
              fixedName: 'primary-opening-fixed-lower-panels',
            });
            return createPrimaryDoorPanelSegments({
              target: walls,
              plan: detail,
              placement,
              material: leafMat,
              panelBottom: lowerPanelTop - y0,
              panelHeight: yLintel - lowerPanelTop,
              depth: 0.10,
            }).active;
          }
          slab(face.x, face.z, opening.width,
            y0, lowerPanelTop, lowerPanelMat, alongX, 0.10);
          return slab(
            face.x,
            face.z,
            opening.width,
            lowerPanelTop,
            yLintel,
            leafMat,
            alongX,
            0.10,
          );
        });
      } else if (opening?.kind === 'window') {
        // Windows are fixed-window by default (sal leaf). panel surface is not used.
        wallWithWindow(opening, bw, alongX,
          role === 'plank' ? plankMat(bw) : M.plaster);
      } else if (role === 'plank') {
        slab(cx, cz, bw, y0, yTopWall, plankMat(bw), alongX);
      } else {
        slab(cx, cz, bw, y0, yTopWall, M.plaster, alongX);
      }
    }

    // 인방/창방 목재 프레임 (심벽: 목재가 회벽을 상하로 구획)
    hbeam(cxE, czE, len + 0.1, y0 + 0.07, alongX, woodTrim, 0.12, 0.16);          // 하인방
    if (role === 'door') hbeam(cxE, czE, len + 0.1, yLintel + 0.05, alongX, woodTrim, 0.13, 0.18); // 상인방
    else hbeam(cxE, czE, len + 0.1, yMid, alongX, woodTrim, 0.11, 0.16);          // 중인방
    hbeam(cxE, czE, len + 0.2, colTopY + 0.11, alongX, M.wood, 0.22, 0.18);       // 창방
  }
  openingDetails.finish();
  root.add(columns); root.add(walls);

  // ── 대청·툇마루 / 중문채 관통 통로 ──
  const mfloorY = podTopY + 0.42;   // 걸터앉는 마루 높이
  const dep = 1.25;                 // 툇마루 내밀기
  const front = giwaFrontRange(P);
  const mX0 = front.x0, mX1 = front.x1;
  const mW = mX1 - mX0, mcx = (mX0 + mX1) / 2, frontZ = front.z;
  const maruMat = () => { const m = M.maru.clone(); m.map = M.maru.map.clone(); m.map.repeat.set(4, 2); m.map.needsUpdate = true; return m; };

  if (throughPassage) {
    root.add(buildGiwaMiddleGate(throughPassage, {
      halfWidth: a,
      halfDepth: b,
      columnRadius: colR,
      podiumTopY: podTopY,
      materials: M,
    }));
  } else {
    // 툇마루(전면 걸터앉는 마루)
    const maru = new THREE.Mesh(new THREE.BoxGeometry(mW, 0.12, dep), maruMat());
    maru.name = 'toenmaru';
    maru.position.set(mcx, mfloorY, frontZ + dep / 2);
    maru.castShadow = maru.receiveShadow = true; root.add(maru);
    const dh = mfloorY - podTopY;
    for (let x = mX0 + 0.6; x <= mX1 - 0.4; x += 1.5) {
      const dong = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, dh, 8), M.wood);
      dong.position.set(x, podTopY + dh / 2, frontZ + dep - 0.18);
      dong.castShadow = true; root.add(dong);
    }

    // 대청: 중앙 개방칸 안쪽 우물마루 + 밝은 세로널 판벽 뒷벽(emissive로 실내 어둠 완화)
    const hallW = Math.min(2.2, Math.max(1.4, mW * 0.34));
    const hallCx = mcx;                  // 평면마다 달라지는 안마당 정면의 중앙 개방칸
    const hallFloorMat = M.maru.clone();
    hallFloorMat.map = M.maru.map.clone(); hallFloorMat.map.repeat.set(2, 3); hallFloorMat.map.needsUpdate = true;
    hallFloorMat.emissive = new THREE.Color(0x1c140b);   // 안쪽이 검게 죽지 않게 미량 자발광
    const hall = new THREE.Mesh(new THREE.BoxGeometry(hallW, 0.12, 2 * b - 0.3), hallFloorMat);
    hall.name = 'daecheong-floor';
    hall.position.set(hallCx, mfloorY, 0);
    hall.castShadow = hall.receiveShadow = true; root.add(hall);
    // 대청 뒷벽(세로널 판벽) — 밝은 목재 + emissive
    const backMat = M.pungpan.clone();
    backMat.map = M.pungpan.map.clone(); backMat.map.repeat.set(3, 2); backMat.map.needsUpdate = true;
    backMat.emissive = new THREE.Color(0x3a2c18);
    const planwall = new THREE.Mesh(new THREE.BoxGeometry(hallW, colH - 0.2, 0.1), backMat);
    planwall.position.set(hallCx, podTopY + (colH - 0.2) / 2, -b + 0.12);
    planwall.receiveShadow = true; root.add(planwall);
    // 대청 좌우 판벽(개방칸 옆면) — 공간감
    for (const sx of [-1, 1]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.1, colH - 0.4, 2 * b - 0.4), plankMat(2 * b));
      sw.position.set(hallCx + sx * hallW / 2, podTopY + (colH - 0.4) / 2, 0);
      sw.receiveShadow = true; root.add(sw);
    }
    // 대청 개방칸 상부 인방벽(상인방~창방 공백 채움) — 정면 개구부가 액자처럼 읽히게
    const transom = new THREE.Mesh(new THREE.BoxGeometry(hallW, yTopWall - (yLintel + 0.1), 0.1), M.plaster);
    transom.position.set(hallCx, (yLintel + 0.1 + yTopWall) / 2, frontZ - 0.02);
    transom.receiveShadow = true; root.add(transom);
    const lintelBeam = new THREE.Mesh(new THREE.BoxGeometry(hallW + 0.1, 0.16, 0.2), woodTrim);
    lintelBeam.position.set(hallCx, yLintel + 0.05, frontZ - 0.02);
    lintelBeam.castShadow = true; root.add(lintelBeam);

    // 계자난간: 툇마루 앞·옆 테두리 (난간대 + 동자기둥 + 치마널). 대청 앞은 비워 진입 확보.
    const railTopY = mfloorY + 0.52, railBotY = mfloorY + 0.08;
    const rz = frontZ + dep - 0.06;
    const railMat = M.wood, apronMat = woodTrim;
    const postGeo = new THREE.BoxGeometry(0.07, 0.5, 0.07);
    // 전면 난간(대청 앞 gap 제외) — 좌/우 두 구간
    const gapHalf = hallW / 2 + 0.2;
    const addFrontRail = (fx0, fx1) => {
      if (fx1 - fx0 < 0.12) return;
      const top = new THREE.Mesh(new THREE.BoxGeometry(fx1 - fx0, 0.08, 0.1), railMat);
      top.position.set((fx0 + fx1) / 2, railTopY, rz); top.castShadow = true; root.add(top);
      const apron = new THREE.Mesh(new THREE.BoxGeometry(fx1 - fx0, 0.16, 0.05), apronMat);
      apron.position.set((fx0 + fx1) / 2, railBotY + 0.12, rz); root.add(apron);
      for (let x = fx0 + 0.1; x <= fx1 - 0.05; x += 0.5) {
        const p = new THREE.Mesh(postGeo, railMat);
        p.position.set(x, mfloorY + 0.27, rz); p.castShadow = true; root.add(p);
      }
    };
    addFrontRail(mX0 + 0.1, hallCx - gapHalf);
    addFrontRail(hallCx + gapHalf, mX1 - 0.1);
    // 좌우 짧은 리턴 난간
    for (const zx of [mX0 + 0.1, mX1 - 0.1]) {
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, dep - 0.1), railMat);
      top.name = 'toenmaru-return-railing';
      top.position.set(zx, railTopY, frontZ + dep / 2); top.castShadow = true; root.add(top);
      for (let z = frontZ + 0.2; z <= frontZ + dep - 0.1; z += 0.5) {
        const p = new THREE.Mesh(postGeo, railMat);
        p.name = 'toenmaru-return-railing';
        p.position.set(zx, mfloorY + 0.27, z); p.castShadow = true; root.add(p);
      }
    }
  }

  // ── 지붕 (스켈레톤 L자 기와) ──
  const roof = buildSkeletonRoof(foot, {
    eaveY, eaveOverhang: P.eaveOverhang, riseScale: P.riseScale,
    profileCurve: P.profileCurve, cornerLift: P.cornerLift, planCurve: P.planCurve,
    ridgeH: P.ridgeH, mats: M, tileBump: 0.7,
    sugiwaRolls: true, rafters: true, junctionCaps: true,
  });
  roof.name = 'roof';
  const sk = roof.userData.skeleton;

  // 기와면 밀도 교정 + 자기그림자 회피 + 용마루 적새 re-skin.
  // roof-skeleton UV가 이미 (width/0.34)·(slopeLen/0.9)를 담고 tileSurfaceMaterial이 또
  // 같은 값으로 repeat 하여 밀도가 제곱으로 과반복 → 회색 뭉갬. repeat=(1,1)로 되돌려
  // 궁·절과 동일한 0.34m 기왓골 밀도를 복원한다.
  roof.traverse((o) => {
    if (!o.isMesh) return;
    const mat = o.material;
    if (mat && mat.map) {
      mat.map.repeat.set(1, 1); mat.map.needsUpdate = true;
      o.receiveShadow = false;  // 곡면 자기그림자(shadow acne) 방지 — 기존 동작 유지
    } else if (o.geometry && o.geometry.type === 'BoxGeometry' && mat === M.tileRidge) {
      // 용마루: 검은 각진 박스 → 적새(암키와 켜) 텍스처
      const len = o.geometry.parameters.depth;
      const jm = M.jeoksae.clone();
      jm.map = M.jeoksae.map.clone();
      jm.map.repeat.set(Math.max(2, Math.round(len / 0.5)), 1); jm.map.needsUpdate = true;
      o.material = jm;
    }
  });
  root.add(roof);
  // 조립 애니: 지붕은 시맨틱 청크(서까래→기와 통덩어리) 단위로 오른다. 아래 망와·와구토
  // 트림도 roof 그룹에 담아(root 직속이 아니라) 지붕 통덩어리와 한 몸으로 뜨게 한다.
  roof.userData.asmChunked = true;

  // Ceiling finish plan for the eventual interior pass (docs/ceiling.md).
  // Daecheong = yeondeung structure; remaining main-front bays = planned banja.
  {
    const front = giwaFrontRange(P);
    const hallW = Math.min(2.2, Math.max(1.4, (front.x1 - front.x0) * 0.34));
    const hallCx = (front.x0 + front.x1) / 2;
    const rooms = [];
    const leftX1 = hallCx - hallW / 2;
    const rightX0 = hallCx + hallW / 2;
    if (leftX1 - front.x0 > 0.4) {
      rooms.push({
        spaceId: 'room-front-west',
        bounds: { x0: front.x0, x1: leftX1, z0: -b, z1: front.z },
      });
    }
    if (front.x1 - rightX0 > 0.4) {
      rooms.push({
        spaceId: 'room-front-east',
        bounds: { x0: rightX0, x1: front.x1, z0: -b, z1: front.z },
      });
    }
    // Side wings (ㄱ/ㄷ) get planned banja over their full local footprint strip.
    if (P.planShape === 'l' || P.planShape === 'u') {
      rooms.push({
        spaceId: 'room-wing',
        bounds: { x0: -a * 0.15, x1: a, z0: b * 0.2, z1: b + c * 0.55 },
        notes: 'Wing range banja — bounds are planning hints until interior volumes exist',
      });
    }
    root.userData.ceilingPlan = planGiwaCeiling({
      podiumTopY: podTopY,
      columnTopY: colTopY,
      eaveY,
      shellThickness: ROOF_SHELL_THICKNESS,
      daecheong: throughPassage
        ? null
        : {
          bounds: {
            x0: hallCx - hallW / 2,
            x1: hallCx + hallW / 2,
            z0: -b + 0.15,
            z1: front.z - 0.05,
          },
        },
      rooms,
    });
  }

  // 용마루 끝 망와(둥근 끝막이 + 와당). 다른 마루와 안 만나는 용마루 끝점에만.
  const yOf = (h) => eaveY + h * P.riseScale;
  const ridgeCyOf = (h) => yOf(h) + P.ridgeH * 0.5;
  const endCount = new Map();
  const rkey = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
  for (const s of sk.ridges) for (const p of [s.a, s.b]) {
    const k = rkey(p); endCount.set(k, (endCount.get(k) || 0) + 1);
  }
  for (const s of sk.ridges) {
    for (const [p, other] of [[s.a, s.b], [s.b, s.a]]) {
      if (endCount.get(rkey(p)) !== 1) continue;   // 내부 절점(마루 교차)엔 안 붙임
      const dx = p.x - other.x, dz = p.z - other.z;
      const dl = Math.hypot(dx, dz) || 1; const ux = dx / dl, uz = dz / dl;
      const cy = ridgeCyOf(p.h);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), M.tileRidge);
      dome.scale.set(0.9, 0.82, 1.0);
      dome.position.set(p.x + ux * 0.04, cy, p.z + uz * 0.04);
      dome.castShadow = true; roof.add(dome);
      const wa = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16), M.wadang);
      // 원반 면이 바깥(마루 방향)을 향하도록 축을 마루방향(ux,uz)에 정렬
      wa.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(ux, 0, uz));
      wa.position.set(p.x + ux * 0.22, cy, p.z + uz * 0.22);
      wa.castShadow = true; roof.add(wa);
    }
  }

  // 와구토: 처마 끝 흰 회물림 반달 스트립. sk에서 처마선(마이터 오프셋+앙곡)을 재구성해
  // 지붕 밑 처마를 따라 얹는다(roof-skeleton과 동일 공식 → 앙곡 코너까지 정확히 밀착).
  const poly = sk.poly, edges = sk.edges, pn = poly.length;
  const nrm = (v) => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };
  const eaveVv = [], eaveLift = [];
  for (let i = 0; i < pn; i++) {
    const oPrev = { x: -edges[(i - 1 + pn) % pn].normal.x, z: -edges[(i - 1 + pn) % pn].normal.z };
    const oCur = { x: -edges[i].normal.x, z: -edges[i].normal.z };
    const sum = { x: oPrev.x + oCur.x, z: oPrev.z + oCur.z };
    const convex = edges[i].startConvex;
    const bis = nrm(sum);
    const extra = convex ? P.planCurve : 0;
    eaveVv.push({ x: poly[i].x + sum.x * P.eaveOverhang + bis.x * extra, z: poly[i].z + sum.z * P.eaveOverhang + bis.z * extra });
    eaveLift.push(convex ? P.cornerLift : 0);
  }
  for (const face of sk.faces) {
    if (face.polygon.length < 3) continue;
    const ei = face.edgeIndex;
    const Ae = eaveVv[ei], Be = eaveVv[(ei + 1) % pn];
    const liftA = eaveLift[ei], liftB = eaveLift[(ei + 1) % pn];
    const out = { x: -edges[ei].normal.x, z: -edges[ei].normal.z };
    const width = Math.hypot(Be.x - Ae.x, Be.z - Ae.z);
    const NU = 16, pos = [], uv = [], idx = [];
    for (let iu = 0; iu <= NU; iu++) {
      const t = iu / NU;
      const ex = Ae.x + (Be.x - Ae.x) * t + out.x * 0.03;
      const ez = Ae.z + (Be.z - Ae.z) * t + out.z * 0.03;
      const ends = Math.pow(Math.abs(2 * t - 1), 4.5);
      const eY = eaveY + (t < 0.5 ? liftA : liftB) * ends;
      pos.push(ex, eY + 0.04, ez, ex, eY - 0.10, ez);
      uv.push(t * (width / 0.34), 0, t * (width / 0.34), 1);
    }
    for (let iu = 0; iu < NU; iu++) { const A2 = iu * 2, B2 = A2 + 1, C2 = A2 + 2, D2 = A2 + 3; idx.push(A2, B2, C2, C2, B2, D2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const wm = M.waguto.clone(); wm.side = THREE.DoubleSide;
    const strip = new THREE.Mesh(geo, wm);
    strip.castShadow = true; roof.add(strip);
  }

  // ── 우측 독립 전돌 굴뚝 (name='chimney' + plan emission — smoke.js 앵커) ──
  // 반가 전돌 굴뚝: 회흑 전돌 켜쌓기 몸통 + 기와 갓지붕 + 연가(오지 토관) 여러 개.
  // 순수 chimney-plan 이 부엌 동측 개구와 처마 밖 방출점을 소유한다.
  const kitchenOpening = planGiwaKitchenOpening(a);
  const chimneyPlan = planGiwaChimney({ halfWidthA: a, halfDepthB: b, kitchen: kitchenOpening });
  const { base: cBase, body: cBody, cornice: cCornice, capRoof: cCap } = chimneyPlan;
  const cx0 = cBody.x, cz0 = cBody.z, chimH = cBody.height, cw = cBody.width;
  const chimney = new THREE.Group();
  chimney.name = 'chimney';
  chimney.userData.chimneyPlan = chimneyPlan;
  chimney.userData.smokeEmission = chimneyPlan.emission;
  // 굴뚝 밑 돌 기초(독립식이라 자체 지대)
  const cbase = new THREE.Mesh(
    new THREE.BoxGeometry(cBase.width, cBase.height, cBase.width),
    M.stoneDark,
  );
  cbase.position.set(cBase.x, cBase.y, cBase.z);
  cbase.castShadow = cbase.receiveShadow = true;
  chimney.add(cbase);
  // 전돌 몸통 (켜 수에 맞춰 텍스처 반복)
  const jm = M.jeondol.clone();
  jm.map = M.jeondol.map.clone();
  jm.map.repeat.set(2, Math.round(chimH / 0.36));  // 세로로 전돌 켜 반복
  jm.map.needsUpdate = true;
  const chim = new THREE.Mesh(new THREE.BoxGeometry(cw, chimH, cw), jm);
  chim.position.set(cBody.x, cBody.y, cBody.z);
  chim.castShadow = chim.receiveShadow = true;
  chimney.add(chim);
  // 상단 전돌 코니스(살짝 내밈)
  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(cCornice.width, cCornice.height, cCornice.width),
    jm,
  );
  cornice.position.set(cCornice.x, cCornice.y, cCornice.z);
  cornice.castShadow = true;
  chimney.add(cornice);
  // 기와 갓지붕(작은 사모지붕): 4모 피라미드 + 기와 톤
  const capRoof = new THREE.Mesh(
    new THREE.ConeGeometry(cCap.radius, cCap.height, 4),
    M.tileRidge,
  );
  capRoof.rotation.y = Math.PI / 4;                 // 모서리를 축에 맞춤
  capRoof.position.set(cCap.x, cCap.y, cCap.z);
  capRoof.castShadow = true;
  chimney.add(capRoof);
  // 연가(오지 토관 연통): plan 소유 좌표 — 원거리에서 개별 실루엣으로 읽히게
  // 슬렌더하게 세우고 간격 벌림 + 높이·굵기 미세 변주(결정론 고정값). 갓지붕에 하부를 묻어
  // 부양감 없이 위로 솟게 한다.
  const yBase = chimneyPlan.yeongaBaseY;
  for (const s of chimneyPlan.yeonga) {
    const yg = new THREE.CylinderGeometry(s.r * 0.88, s.r, s.h, 10);
    const y = new THREE.Mesh(yg, M.tileRidge);
    y.position.set(cx0 + s.dx, yBase + s.h / 2, cz0 + s.dz);
    y.castShadow = true;
    chimney.add(y);
    // 연가 갓(작은 기와 반구 마감)
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(s.r + 0.012, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      M.tileRidge,
    );
    cap.position.set(cx0 + s.dx, yBase + s.h + 0.004, cz0 + s.dz);
    cap.castShadow = true;
    chimney.add(cap);
  }
  root.add(chimney);

  // 부엌 화구는 굴뚝과 이어지는 살림채 끝방의 마당 높이 개구 안으로 물린다. 외부 기단에
  // 별도 부뚜막을 덧붙이던 중복 구현을 초가와 공유하는 생활 장면 조립기로 대체한다.
  root.add(buildRecessedKitchenHearth({
    mats: M,
    wallX: kitchenOpening.wallX,
    centerZ: kitchenOpening.centerZ,
    floorY: 0,
    openingWidth: kitchenOpening.openingWidth,
    openingHeight: kitchenOpening.openingHeight,
    frameThickness: kitchenOpening.frameThickness,
    lightRange: kitchenOpening.lightRange,
  }));

  return root;
}
