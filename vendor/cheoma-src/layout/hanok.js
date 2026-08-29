import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { computeSkeleton } from './skeleton.js';
import { buildSkeletonRoof } from './roof-skeleton.js';
import {
  COURTYARD_SURFACE_LIFT,
  OPENING_FACE_CLEARANCE,
  beddedStone,
  sunkPrism,
} from '../core/surface-clearance.js';
import { mergeOwnedGeometries } from '../core/merge-owned-geometries.js';
import { planOpeningDetail } from '../builder/opening-detail-plan.js';
import { createOpeningDetailAssembler } from '../builder/opening-details.js';
import { createPrimaryDoorPanelSegments } from '../builder/primary-door-panel.js';

// 다각형 풋프린트(rect/ㄱ자/ㄷ자) 기와집 몸채: 기단 + 기둥 + 회벽 + straight-skeleton 곡면 지붕.
// 백골(무단청) 반가 톤. buildBuilding(궁·절·초가)과 별개로, 꺾인 평면 살림집을 만든다.
//
// buildHanok({ footprint, seed, mats, wallH, podiumH, roofOpts }) → THREE.Group
//   footprint: 기둥열 2D 다각형 [{x,z}], 원점 기준. (원점 정렬은 호출측 책임)
export function buildHanok({
  footprint, seed = 1, mats, wallH = 2.7, podiumH = 0.5, roofOpts = {},
} = {}) {
  const rng = makeRng(seed);
  const M = mats;
  const g = new THREE.Group();
  g.name = 'hanok';

  // ── 조립(시공) 파트 그룹 ──
  // src/anim/assembly.js 는 부재 이름(podium/columns/walls/brackets/roof)으로 파트를 찾아
  //   시공 순서 스태거를 만든다. 마을 giwa(builder/giwa.js)는 이 그룹을 만들지만 히어로 종가는
  //   만들지 않아, 엔진 컴파운드 경로가 몸채를 **통째로** 리프트했다("집이 통짜로 바닥에서
  //   올라온다" 2026-07-26). 같은 이름 규약을 여기서도 세워 종가가 마을 집과 동일한 문법으로
  //   지어지게 한다. 그룹은 THREE.Group 하나 = 드로우콜 0 증가.
  // 담김 규칙(giwa.js 와 동일): 기단 켜·댓돌 → podium / 기둥·인방·창방(골조) → columns /
  //   회벽·창호·굴뚝 → walls / 지붕 → roof. 반가(민도리집)는 공포가 없어 brackets 는 비어 있고,
  //   playAssembly 는 없는 파트를 그냥 건너뛴다(고증: 궁·절만 공포).
  const podium = new THREE.Group(); podium.name = 'podium';
  const columns = new THREE.Group(); columns.name = 'columns';
  const walls = new THREE.Group(); walls.name = 'walls';
  g.add(podium); g.add(columns); g.add(walls);

  // 방향 판정용 CCW 보정
  const poly = footprint.map((p) => ({ x: p.x, z: p.z }));
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area += a.x * b.z - b.x * a.z;
  }
  if (area < 0) poly.reverse();
  const n = poly.length;

  const shapeFrom = (pts) => {
    const s = new THREE.Shape();
    pts.forEach((p, i) => (i ? s.lineTo(p.x, -p.z) : s.moveTo(p.x, -p.z)));
    s.closePath();
    return s;
  };
  const extrudeY = (shape, depth) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // (x, -z, d) → (x, d, z)
    return geo;
  };

  // ── 기단 (장대석 두벌대: 지대석 + 기단 몸통 + 갑석 + 앞 댓돌) ──
  // 반가 기단은 다듬은 장대석을 두어 켜 쌓고 위에 넓은 갑석(甲石)을 얹는다. 근접에서 집이
  //   땅에 붙지 않고 단정히 앉아 보이게 한다(#139). 지대석은 살짝 넓게(단 그림자), 갑석은
  //   기단 몸통보다 조금 내밀어 처마 그늘에서도 밝은 돌 선이 읽히게 한다.
  // 지대석: 바닥에 살짝 넓게 깔리는 어두운 밑돌 켜(단 그림자)
  const zidaeBounds = sunkPrism(0.14);
  const zidae = new THREE.Mesh(
    extrudeY(shapeFrom(offsetPoly(poly, 0.92)), zidaeBounds.height),
    M.stoneDark,
  );
  zidae.name = 'foundation-base';
  zidae.position.y = zidaeBounds.bottom;
  zidae.receiveShadow = zidae.castShadow = true; podium.add(zidae);
  // 기단 몸통(장대석): 갑석이 podiumH 까지 채우므로 회벽·기둥은 그대로 podiumH 에 앉는다.
  //   몸통을 podiumH 까지 올리면 몸통 상면과 갑석 상면이 같은 평면에 겹치고, 갑석이 몸통보다
  //   넓어 그 면 전체가 depth 를 다툰다 — 상면 소유자는 갑석 하나여야 한다.
  const pod = new THREE.Mesh(
    extrudeY(shapeFrom(offsetPoly(poly, 0.7)), podiumH - OPENING_FACE_CLEARANCE), M.stone);
  pod.name = 'foundation-body';
  pod.receiveShadow = true; pod.castShadow = true;
  podium.add(pod);
  // 갑석: 기단 상단을 덮는 넓은 마감석(몸통보다 내밀어 처마 그늘에도 밝은 돌 선)
  const gapseok = new THREE.Mesh(extrudeY(shapeFrom(offsetPoly(poly, 0.84)), 0.11), M.stone);
  gapseok.name = 'foundation-gapseok';
  gapseok.position.y = podiumH - 0.11;
  gapseok.receiveShadow = gapseok.castShadow = true; podium.add(gapseok);
  // 기단 상면(회벽 앉는 자리) 어두운 면 — 벽 밑동 그늘
  const cap = new THREE.Mesh(extrudeY(shapeFrom(offsetPoly(poly, 0.5)), 0.05), M.stoneDark);
  cap.name = 'foundation-top';
  cap.position.y = podiumH; podium.add(cap);
  // 앞(남, +z) 댓돌: 대청 앞 계단돌 2벌. 마당 표면 위로 각 0.16m 씩 솟고 밑동은 지면 아래로
  //   묻는다(beddedStone). 예전에는 아래 돌 밑면이 지면(y=0)에 정확히 닿고 위 돌은 그 위
  //   0.16m 에 떠 있어, 밑면이 대문 디딤돌 밑면과 같은 평면을 공유했다.
  {
    let maxZ = -Infinity, sx = 0, cnt = 0;
    for (const p of poly) if (p.z > maxZ) maxZ = p.z;
    for (const p of poly) if (p.z > maxZ - 0.5) { sx += p.x; cnt++; }
    const fcx = cnt ? sx / cnt : 0;
    for (let i = 0; i < 2; i++) {
      const bed = beddedStone(COURTYARD_SURFACE_LIFT, 0.1 + i * 0.16);
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.9 - i * 0.3, bed.height, 0.55), M.stone);
      step.name = 'stepping-stone';
      step.position.set(fcx, bed.center, maxZ + 1.35 - i * 0.5);
      step.castShadow = step.receiveShadow = true; podium.add(step);
    }
  }

  // ── 회벽 (풋프린트 압출) ──
  const wallGeo = extrudeY(shapeFrom(poly), wallH - podiumH);
  const plaster = new THREE.Mesh(wallGeo, M.plaster);
  plaster.position.y = podiumH;
  plaster.castShadow = plaster.receiveShadow = true;
  walls.add(plaster);
  // 인방 띠(중방) + 하부 심벽 톤
  const midGeo = extrudeY(shapeFrom(offsetPoly(poly, 0.02)), 0.12);
  const mid = new THREE.Mesh(midGeo, M.woodDark);
  mid.position.y = podiumH + (wallH - podiumH) * 0.55;
  columns.add(mid);                        // 중인방=골조 부재 → 기둥과 같은 파트 창(giwa.js 규약)

  // ── 기둥 (모서리 + 변 중간, 벽 앞면에 살짝 돌출) ──
  const colGeo = new THREE.CylinderGeometry(0.16, 0.17, wallH - podiumH, 12);
  colGeo.translate(0, (wallH - podiumH) / 2, 0);
  const colMat = M.wood;
  const placeCol = (x, z) => {
    const c = new THREE.Mesh(colGeo, colMat);
    c.position.set(x, podiumH, z); c.castShadow = true; columns.add(c);
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    placeCol(a.x, a.z);
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.round(segLen / 2.5));
    for (let j = 1; j < k; j++) {
      placeCol(a.x + (b.x - a.x) * (j / k), a.z + (b.z - a.z) * (j / k));
    }
  }
  // 창방 (기둥머리 가로 부재) — 풋프린트 상단 테
  const beamGeo = extrudeY(shapeFrom(poly), 0.16);
  const beam = new THREE.Mesh(beamGeo, M.woodDark);
  beam.position.y = wallH - 0.16;
  columns.add(beam);                       // 창방=기둥머리 결구 → columns 파트(공포 없는 민도리집)

  // ── 창호·문 (마당 향한 면 최소 개구 보장) ──
  const openings = addHanokOpenings(walls, poly, M, seed, wallH, podiumH);

  // ── 지붕 ──
  // 히어로 종가 전용 근접 격상(#139): 수키와 볼록 롤·겹처마 서까래·접합 캡 + heroDetail(막새 열·
  //   적새 용마루·망와). buildHanok 은 마을 인스턴스가 아닌 히어로/focus 경로 전용이라(마을 giwa 는
  //   builder/giwa.js) 이 플래그들을 켜도 마을 드로우콜은 불변. 편집 파라미터(riseScale 등)는 ...roofOpts
  //   가 뒤에 펼쳐져 그대로 오버라이드된다.
  const eaveOverhang = roofOpts.eaveOverhang ?? 1.15;
  const roof = buildSkeletonRoof(poly, {
    eaveY: wallH, eaveOverhang, riseScale: 1.18, profileCurve: 0.5,
    cornerLift: 0.42, planCurve: 0.26, ridgeH: 0.44, mats: M,
    sugiwaRolls: true, rafters: true, junctionCaps: true, heroDetail: true,
    ...roofOpts,
  });
  roof.name = 'roof';                      // 조립 파트 이름(buildSkeletonRoof 기본명은 'skeleton-roof')
  roof.userData.asmChunked = true;          // 서까래→기와 통덩어리→망와 청크 단위(giwa.js 와 동일)
  g.add(roof);

  // ── 부엌 날개채 굴뚝 (연기 발원) ──
  addHanokChimney(walls, poly, M, rng, eaveOverhang);   // 굴뚝=부엌 마감 → walls 파트

  g.userData = { skeleton: computeSkeleton(poly), footprint: poly };
  return g;
}

// ── 부엌 날개채 서측 독립 전돌 굴뚝 (반가) ──
// name='chimney' — smoke.js(setupSmoke)가 이 그룹의 월드 bbox 상단 중심을 밥짓는 연기 anchor 로 탐지한다.
//   그래서 몸통은 좌우 대칭으로 두어 anchor 가 처마선 밖에 오게 한다(연기가 지붕을 태우지 않게).
// 고증: 아궁이(부엌)→구들→굴뚝. 회흑 전돌 켜쌓기 몸통 + 코르벨 2단 코니스 + 작은 기와 갓지붕 +
//   연가(오지 토관) 3개. 반가 굴뚝은 아미산 궁 굴뚝과 달리 무문양 소박형(전돌 켜만).
//   처마선 밖(x = minX − eaveOverhang − 여유)에 독립식으로 세워 연기가 곧게 오른다.
// 드로우콜 억제: 재질별 지오메트리 병합 → 전돌(몸통+코니스) 1 · 기와(갓+연가) 1 · 돌 기초 1 = 3.
function addHanokChimney(g, poly, M, rng, eaveOverhang) {
  // 서측 벽(x≈minX) 정점들의 z 범위 → 남쪽(부엌 날개) 쪽으로 굴뚝을 앉힌다.
  let minX = Infinity;
  for (const p of poly) minX = Math.min(minX, p.x);
  let zWmin = Infinity, zWmax = -Infinity;
  for (const p of poly) if (Math.abs(p.x - minX) < 0.6) { zWmin = Math.min(zWmin, p.z); zWmax = Math.max(zWmax, p.z); }
  const cw = 0.46;                                       // 전돌 몸통 한 변
  const chimH = 2.85;                                    // 몸통 높이(처마 위로 실루엣이 서게)
  const cz0 = zWmin + (zWmax - zWmin) * 0.76;            // 날개 남측(부엌)
  const cx0 = minX - (eaveOverhang + 0.7) - cw / 2;      // 처마선 밖으로 이격(연기 anchor 여유)

  const chimney = new THREE.Group();
  chimney.name = 'chimney';
  chimney.position.set(cx0, 0, cz0);                     // 이하 지오메트리는 로컬 원점 기준

  // 1) 자연석 기초(독립식 자체 지대)
  const baseH = 0.26;
  const base = new THREE.Mesh(new THREE.BoxGeometry(cw + 0.28, baseH, cw + 0.28), M.stoneDark);
  base.position.y = baseH / 2;
  base.castShadow = base.receiveShadow = true;
  chimney.add(base);

  // 2) 전돌 몸통 + 코르벨 2단 코니스 → 병합(전돌 재질 1 드로우콜)
  const jm = M.jeondol.clone();
  jm.map = M.jeondol.map.clone();
  jm.map.repeat.set(2, Math.round(chimH / 0.34));        // 세로로 전돌 켜 반복
  jm.map.needsUpdate = true;
  const cTop = baseH + chimH;
  const jeon = [];
  const body = new THREE.BoxGeometry(cw, chimH, cw); body.translate(0, baseH + chimH / 2, 0); jeon.push(body);
  const cornLo = new THREE.BoxGeometry(cw + 0.09, 0.09, cw + 0.09); cornLo.translate(0, cTop - 0.02, 0); jeon.push(cornLo);
  const cornHi = new THREE.BoxGeometry(cw + 0.17, 0.11, cw + 0.17); cornHi.translate(0, cTop + 0.08, 0); jeon.push(cornHi);
  const brick = new THREE.Mesh(mergeGeometries(jeon, false), jm);
  brick.castShadow = brick.receiveShadow = true;
  chimney.add(brick);

  // 3) 기와 갓지붕(작은 사모) + 연가(오지 토관 3개) + 연가 갓 → 병합(기와 재질 1 드로우콜)
  const capY = cTop + 0.14;
  const tile = [];
  const cap = new THREE.ConeGeometry(cw * 1.0, 0.34, 4); cap.rotateY(Math.PI / 4); cap.translate(0, capY + 0.17, 0); tile.push(cap);
  const yBase = capY + 0.30;
  // 연가: 갓 위 오지 토관 3개(결정론 미세 변주). 뭉툭한 항아리형 + 간격 벌림 → 개별 실루엣.
  const spots = [{ dx: -0.13, dz: -0.05 }, { dx: 0.13, dz: -0.04 }, { dx: 0.0, dz: 0.14 }];
  for (const s of spots) {
    const h = 0.20 + rng() * 0.09;                       // 0.20~0.29 (뭉툭)
    const r = 0.080 + rng() * 0.018;                     // 0.080~0.098 (통통)
    const tube = new THREE.CylinderGeometry(r * 0.9, r, h, 10); tube.translate(s.dx, yBase + h / 2, s.dz); tile.push(tube);
    const dome = new THREE.SphereGeometry(r + 0.014, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2); dome.translate(s.dx, yBase + h, s.dz); tile.push(dome);
  }
  const cap3 = new THREE.Mesh(mergeGeometries(tile, false), M.tileRidge);
  cap3.castShadow = true;
  chimney.add(cap3);

  g.add(chimney);
}

// ── 반가 안채 창호·문 (마당·안뜰 향한 면에 최소 개구 보장) ──
// 진단(#99): buildHanok 은 회벽·기둥·창방·지붕만 만들고 창호가 전무해 히어로 종가가 늘 무개구 회벽으로
//   생성됐다("최초 진입 집에 문·창 없음"). 여기서 마당(+z 남)·안뜰(ㄱ/ㄷ자 오목 꼭짓점 인접 면)을 향한
//   벽면에 대청 분합문 + 방 살창을 얹어 개구를 보장한다. 문 ≥1·창 ≥1 최소 보장, 칸 수·짝수는 평면 파생.
// 재질: 팔레트의 M.door(빗꽃살+한지) 단일 클론을 문·창 공용으로 쓰고(청판 노출·짝수는 per-panel UV),
//   userData.hanjiGlow(0.18) 가 클론에 전파돼 #66 야간 발광이 자동 발현된다. 머름/문틀은 기존 M.woodDark.
//   창호는 재질별 병합 1콜·머름 1콜(기존 woodDark 그룹에 접힘) → 종가 mergeStatic 드로우콜 억제.
function addHanokOpenings(g, poly, M, seed, wallH, podiumH) {
  const n = poly.length;
  if (n < 3 || !M.door || !M.door.map) return;
  // 개구 전용 rng(굴뚝 rng 불침해) — 방 창 폭 등 시드 파생 변주.
  const rng = makeRng((seed || 1) * 131 + 7);

  // 개구 수직 구간: 기단 위 ~ 창방(wallH-0.16) 밑.
  const oy0 = podiumH + 0.10;
  const oy1 = (wallH - 0.16) - 0.03;
  const T = 0.10, faceOff = 0.075;   // 벽면 바깥으로 살짝 돌출한 응용 창호
  const colClear = 0.30;             // 칸 폭에서 기둥 회피 여유
  const VSILL = 96 / 512;            // 문 텍스처 하부 청판 경계(flipY 기본: 청판=v∈[0,0.1875])
  const sillTop = oy0 + 0.82;        // 방 창 하부 머름 상단

  // 살문 공용 창호 재질(단일 클론 → 병합 1콜, hanjiGlow 전파). 판문은 solid board 별도.
  // giwa 팔레트 door 맵은 민가 띠살/정자살이지 궁 주칠·뇌록이 아니다.
  const salMat = M.door.clone();
  salMat.map = M.door.map.clone();
  salMat.map.wrapS = salMat.map.wrapT = THREE.RepeatWrapping;
  salMat.map.needsUpdate = true;
  const panelMat = (M.woodBoard || M.planwall || M.woodDark).clone();

  const panels = [];   // secondary 살문 패널 병합 대상
  const panelPanels = []; // secondary 판문 패널(재질 분리, 드로우콜 +0~1)
  let primaryPanel = null;
  let primaryFixedPanel = null;
  const details = [];
  const openingDetails = createOpeningDetailAssembler(g, {
    frame: M.woodDark,
    hardware: M.hardware,
  });
  let doorN = 0, winN = 0, primaryDoor = false;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const winW = (w) => w * (0.80 + rng() * 0.14);   // 방 창 폭 변주(칸 폭의 0.80~0.94)
  // 한 개구 패널을 병합 목록에 추가. kind: 'door'(전 높이·청판 포함) | 'win'(머름 위·청판 제외).
  // primary 문짝만 별도 mesh로 남겨 후속 interaction이 전체 창호 batch가 아닌 실제 문짝을 소유하게 한다.
  const addPanel = (inf, opening, w, kind, primary = false) => {
    const yb = kind === 'door' ? oy0 + 0.02 : sillTop + 0.04;
    const yt = oy1;
    const h = yt - yb;
    if (w < 0.55 || h < 0.4) return false;
    const leaves = kind === 'door'
      ? clamp(Math.round(w / 0.6), 2, 4)   // 분합문: 좁은 살문 여러 짝
      : (w > 1.7 ? 2 : 1);                 // 방 창: 1~2짝
    const vmin = kind === 'win' ? VSILL : 0;    // 창은 청판 잘라내고 살+한지만
    const plan = planOpeningDetail({
      kind: kind === 'door' ? 'door' : 'window',
      style: 'giwa',
      seed: `hanok:${seed}:${details.length}:${kind}`,
      width: w,
      height: h,
      wallThickness: T,
      leafCount: leaves,
      primary,
      ...(kind === 'door'
        ? { lowerPanelHeight: h * VSILL }
        : { meoreumHeight: sillTop - oy0 }),
      footwear: primary ? {
        y: podiumH + 0.05 - yb,
        outward: 0.92,
        surface: 'podium-step',
      } : null,
    });
    const placement = {
      center: { x: opening.cx, z: opening.cz },
      bottomY: yb,
      tangent: inf.e,
      outward: inf.N,
    };
    const leafMat = plan.leafSurface === 'panel' ? panelMat : salMat;
    if (primary && plan.anchors.pivot) {
      ({ active: primaryPanel, fixed: primaryFixedPanel } = createPrimaryDoorPanelSegments({
        target: g, plan, placement, material: leafMat,
        panelHeight: h, depth: T, uRepeats: leaves, vMin: vmin,
      }));
    } else {
      const geo = new THREE.BoxGeometry(w, h, T);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setX(i, uv.getX(i) * leaves);          // 가로로 leaves 만큼 반복(짝 사이 문틀선)
        uv.setY(i, vmin + uv.getY(i) * (1 - vmin));
      }
      uv.needsUpdate = true;
      geo.rotateY(inf.theta);
      geo.translate(opening.cx, (yb + yt) / 2, opening.cz);
      if (plan.leafSurface === 'panel') panelPanels.push(geo);
      else panels.push(geo);
    }
    if (kind === 'door') {
      doorN++;
      if (primary) primaryDoor = true;
    } else winN++;
    details.push({
      plan,
      primary,
      placement,
    });
    return true;
  };

  // 엣지 형상: 방향 e·바깥 법선 N(=(e.z,-e.x), offsetPoly 규약)·회전각·길이·칸수.
  const edgeInfo = (i) => {
    const a = poly[i], b = poly[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1e-3;
    const e = { x: dx / len, z: dz / len };
    const N = { x: e.z, z: -e.x };
    const theta = Math.atan2(N.x, N.z);           // 로컬 +z → 월드 N
    const k = Math.max(1, Math.round(len / 2.5));
    return { a, e, N, theta, len, k };
  };
  // 칸 j 중심(벽면 바깥 오프셋) + 유효 폭.
  const bay = (inf, j) => {
    const tc = (j + 0.5) / inf.k;
    const bx = inf.a.x + inf.e.x * inf.len * tc;
    const bz = inf.a.z + inf.e.z * inf.len * tc;
    return {
      wallCx: bx,
      wallCz: bz,
      cx: bx + inf.N.x * faceOff,
      cz: bz + inf.N.z * faceOff,
      w: inf.len / inf.k - colClear,
    };
  };

  // 오목(reflex) 꼭짓점 판정 — ㄱ/ㄷ자 안뜰 면 식별(CCW: cross<0).
  const reflex = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], c = poly[i], q = poly[(i + 1) % n];
    const cr = (c.x - p.x) * (q.z - c.z) - (c.z - p.z) * (q.x - c.x);
    if (cr < 0) reflex[i] = true;
  }

  // 엣지 분류: front(마당 남향 N.z>0.35) / inner(오목 꼭짓점 인접·안뜰 향, 뒷면 아님).
  const fronts = [], inners = [];
  for (let i = 0; i < n; i++) {
    const inf = edgeInfo(i);
    if (inf.N.z > 0.35) fronts.push(inf);
    else if ((reflex[i] || reflex[(i + 1) % n]) && inf.N.z > -0.15) inners.push(inf);
  }
  // 마당면이 없으면(비-남향 평면 방어) N.z 최대 엣지를 앞면으로.
  if (fronts.length === 0) {
    let best = edgeInfo(0);
    for (let i = 1; i < n; i++) { const inf = edgeInfo(i); if (inf.N.z > best.N.z) best = inf; }
    fronts.push(best);
  }
  // 주 정면 = 가장 긴 남향 면(대청). 나머지 남향 면은 부 정면.
  fronts.sort((p, q) => q.len - p.len);
  const primary = fronts[0];
  const secondary = fronts.slice(1);

  // 주 정면: 중앙 칸 = 대청 분합문, 좌우 칸 = 방 창.
  {
    const mid = Math.floor(primary.k / 2);
    for (let j = 0; j < primary.k; j++) {
      const bj = bay(primary, j);
      addPanel(primary, bj, j === mid ? bj.w : winW(bj.w), j === mid ? 'door' : 'win', j === mid);
    }
  }
  // 부 정면·안뜰 면: 방 창. 넉넉한 면(칸 폭>1.6) 중 최장 면 중앙엔 방문 하나 더.
  const rest = [...secondary, ...inners];
  let doorEdge = null, doorEdgeLen = 1.6;
  for (const inf of rest) { const w0 = inf.len / inf.k - colClear; if (w0 > 1.6 && inf.len > doorEdgeLen) { doorEdge = inf; doorEdgeLen = inf.len; } }
  for (const inf of rest) {
    const mid = Math.floor(inf.k / 2);
    for (let j = 0; j < inf.k; j++) {
      const bj = bay(inf, j);
      const isDoor = inf === doorEdge && j === mid;
      addPanel(inf, bj, isDoor ? bj.w : winW(bj.w), isDoor ? 'door' : 'win');
    }
  }

  // 최소 보장: 문 0 이면 주 정면 중앙에 강제, 창 0 이면 주 정면 첫 칸에 강제.
  if (doorN === 0 || !primaryDoor) {
    const bj = bay(primary, Math.floor(primary.k / 2));
    addPanel(primary, bj, Math.max(0.9, bj.w), 'door', true);
  }
  if (winN === 0) {
    const bj = bay(primary, 0);
    addPanel(primary, bj, Math.max(0.7, bj.w * 0.86), 'win');
  }

  const disposeLeafMats = () => {
    salMat.map?.dispose();
    salMat.dispose();
    panelMat.dispose();
  };
  if (panels.length) {
    let geometry;
    try {
      geometry = mergeOwnedGeometries(panels, 'Hanok opening panels');
    } catch (error) {
      primaryPanel?.geometry?.dispose();
      primaryFixedPanel?.geometry?.dispose();
      for (const geo of panelPanels) geo.dispose();
      disposeLeafMats();
      throw error;
    }
    const m = new THREE.Mesh(geometry, salMat);
    m.name = 'changho';
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
  if (panelPanels.length) {
    let geometry;
    try {
      geometry = mergeOwnedGeometries(panelPanels, 'Hanok panel-door openings');
    } catch (error) {
      primaryPanel?.geometry?.dispose();
      primaryFixedPanel?.geometry?.dispose();
      disposeLeafMats();
      throw error;
    }
    const m = new THREE.Mesh(geometry, panelMat);
    m.name = 'changho-panel';
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
  for (const detail of details) {
    if (detail.primary) openingDetails.addPrimaryRecess(detail.plan, detail.placement, T);
    openingDetails.add(detail.plan, detail.placement, detail.primary ? primaryPanel : null);
  }
  openingDetails.finish();
}

// 다각형을 바깥으로 d 만큼 마이터 오프셋 (볼록/반사 모두)
function offsetPoly(poly, d) {
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
    const e1 = norm({ x: cur.x - prev.x, z: cur.z - prev.z });
    const e2 = norm({ x: next.x - cur.x, z: next.z - cur.z });
    // 바깥 법선(우측, CCW 기준 외측) = (e.z, -e.x)
    const o1 = { x: e1.z, z: -e1.x }, o2 = { x: e2.z, z: -e2.x };
    const bis = norm({ x: o1.x + o2.x, z: o1.z + o2.z });
    const cosH = Math.max(0.4, bis.x * o1.x + bis.z * o1.z);
    out.push({ x: cur.x + bis.x * d / cosH, z: cur.z + bis.z * d / cosH });
  }
  return out;
}
const norm = (a) => { const l = Math.hypot(a.x, a.z) || 1; return { x: a.x / l, z: a.z / l }; };
