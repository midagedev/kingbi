import * as THREE from 'three';
import { markSharedResource } from '../core/three-resources.js';
import * as G from '../core/math/geom2.js';
import { FIELDSTONE_TILE } from '../builder/palette.js';
import { hashString, makeRng } from '../rng.js';
import {
  villageWallLayout,
} from './wall-contract.js';
import { buildMudWallSurfaceGeometry } from './mud-wall-geometry.js';
import { planMudWallSurface } from './mud-wall-surface-plan.js';
import {
  JANGDOK_JAR_INSET,
  JANGDOK_JAR_JS_MIN,
  JANGDOK_JAR_JS_SPAN,
  JANGDOK_JAR_PITCH,
  JANGDOK_JAR_R,
  yardClotheslineLayout,
  yardHardPlacements,
} from './yard-layout.js';
export { pickWallType } from './variants.js';   // 담 유형 선택은 순수 로직(variants.js)에 둔다

// 마을 담장 어휘 — 신분·성격별 담 유무·유형을 확률(variants.pickWallType R-P3)로 뽑아 세운다.
//   조사(docs/village-walls-parcels.md Q3·Q4): "모든 집에 담"은 고증 오류. 서민은 개방 마당·울(생울/싸리)이
//   흔했다. wallType 6종:
//     'tile'  (반가·상급 기와): 사괴석 하단 + 회벽 상단 + 기와 지붕띠 + 솟을대문 힌트
//     'stone' (여염 돌담): 막돌 fieldstone + 몸채지붕 일치 coping(초가=이엉/기와=기와띠) + 평대문
//     'mud'   (토담): 흙+짚 다짐 박스 + 몸채지붕 일치 coping + 평대문
//     'brush' (싸리/바자울): 통나무 기둥 + 수직 스틱 열 + 가로 엮음(어깨 높이) + 사립문 힌트
//     'hedge' (생울/산울타리): 관목 열(탱자·개나리 감각) — 담 아닌 식재 경계
//     'open'  (개방 마당): 담 링 생략 — 사립문 기둥 + 텃밭 힌트만(서민 반개방)
//   담 지붕(coping)=몸채 지붕 일치(R-P4): opts.kind 로 초가(이엉)/기와(기와띠) 분기.
//   모든 스타일은 단일 공유 재질셋(wallMats)만 써서 병합 후 드로우콜이 "재질 수" 규모로 눌린다.
//
// 좌표 규약: 로컬 +z = 집의 남향 앞마당, -z = 뒤. 도로 대문은 parcel.access가 지정한 실제
//   road-side edge에 나며, 접근 정보가 없는 코어·위성 필지만 +z 앞변 중앙을 기본으로 쓴다.
//   담은 필지 배치 변환(parcelMatrix) 전 로컬 y=0(성토 패드 상면)에 선다.
//   필지는 부정형 다각형(parcels.js localParcelShape) — 담은 변(edge) 단위로 세운다. 앞변은 직선.

const DEG = Math.PI / 180;

// 생울(관목) 공유 재질·지오 — 모든 필지 공유 1벌이라 병합 후 1 드로우콜.
const HEDGE_MAT = markSharedResource(new THREE.MeshStandardMaterial({
  color: 0x4d6a33, roughness: 0.96, metalness: 0, flatShading: true,
}));
const HEDGE_GEO = markSharedResource(new THREE.IcosahedronGeometry(1, 0));
// 옹기(장독) 공유 지오 — 둥근 항아리 근사(스케일로 개체차). 병합 대상이라 재질은 wallMats 재사용.
// 반경·군집 피치·단 인셋은 yard-layout.js 장독 계약(JANGDOK_JAR_*)과 동기.
const JAR_GEO = markSharedResource(new THREE.SphereGeometry(JANGDOK_JAR_R, 10, 8));

// 막돌 면 UV 를 실치수로 환산: 담 한 면이 텍스처 한 장으로 늘어나던 것을 고정 월드 스케일
//   (FIELDSTONE_TILE)로 타일링해 돌 하나가 어느 담·기단에서나 20~35cm로 읽히게 한다.
//   BoxGeometry 면 순서는 +x,-x,+y,-y,+z,-z 이고 각 면의 [u축,v축] 은 아래 표와 같다.
//   공유 재질의 map.repeat 을 건드리지 않으므로 재질·텍스처·드로우콜 델타 0이고, mergeStatic 이
//   UV 를 그대로 굽기 때문에 병합 후에도 유지된다.
const FS_FACE_AXES = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]];
function fieldstoneBox(w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const per = uv.count / 6;
  const dims = [w, h, d];
  for (let face = 0; face < 6; face++) {
    const su = dims[FS_FACE_AXES[face][0]] / FIELDSTONE_TILE.w;
    const sv = dims[FS_FACE_AXES[face][1]] / FIELDSTONE_TILE.h;
    for (let i = face * per; i < (face + 1) * per; i++) {
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

// 담+마당(어휘 격상) — populate 가 parcelMatrix 로 배치 후 병합. wallMats 는 전 필지 공유 1벌.
//   shape: { pts:[{x,z}...](로컬), roles:[...], edges?:[{role,heightK,share}] } — parcels.js 산출.
//   opts: { style, kind, seed, char01, aux, auxRequested, plotW, plotD }
// `auxRequested` preserves the historical yard-RNG window even when the pure
// planner rejects an unsafe request. The independent building itself is planned
// once and rendered through parcel.auxiliary; `aux` is the accepted UI state.
export function buildVillageWall(shape, wallMats, opts = {}) {
  const style = opts.style || 'stone';
  const kind = opts.kind === 'giwa' ? 'giwa' : 'choga';
  const seed = (opts.seed | 0) || 7;
  const rng = makeRng((seed ^ 0x51de) >>> 0);
  const plotW = opts.plotW, plotD = opts.plotD;
  const M = wallMats;
  const layout = villageWallLayout(shape, opts, rng);
  const { pts, gateEdge, gateT } = layout;
  const n = pts.length;
  // 마당 소품 배치는 담과 같은 폴리곤을 읽어야 한다. 편집 오버레이가 소품 유무·담 유형을
  // 덮어쓸 수 있으므로 opts 값을 parcel 위에 올려 실제 렌더 의도대로 해석한다.
  const yardPlacements = yardHardPlacements({
    ...(opts.parcel || {}),
    shape,
    kind,
    plotW,
    plotD,
    wallType: style,
    jangdok: opts.jangdok,
    yardStack: opts.yardStack,
    clothesline: opts.clothesline,
    vegBed: opts.vegBed,
    aux: opts.aux,
  });

  const g = new THREE.Group();
  g.name = `wall-${style}`;
  g.userData.gate = { edge: gateEdge, t: gateT, point: G.lerp(pts[gateEdge], pts[(gateEdge + 1) % n], gateT) };

  // 개방 마당(open): 담 링 없음 — 사립문 기둥 + 텃밭 힌트만(서민 반개방 실루엣).
  if (style === 'open') {
    placeGatePosts(g, pts[gateEdge], pts[(gateEdge + 1) % n], layout.gate.centerT,
      layout.gate.gap, layout.gate.height, M.mud, M.jipjul, 'brush');
    // 개방 마당의 정체성(텃밭) — 항상. 앉을 자리가 없으면(placed=false) 담 밖으로 밀어내지 않는다.
    if (yardPlacements.openGarden?.placed) g.add(makeGardenPatch(yardPlacements.openGarden, M));
    if (opts.auxRequested ?? opts.aux) consumeLegacyAuxVariation(rng);
    g.add(makeYardProps(yardPlacements, { ...opts, vegBed: false }, M, rng));  // 장독대·낟가리·빨래줄
    return g;
  }

  // 담 높이: 유형 기본 × 성격 × (연속 변주 wallHeightK[부유 상관] 또는 rng 폴백).
  const coping = style === 'tile' ? 'tile' : (kind === 'giwa' ? 'tile' : 'thatch');
  const th = layout.thickness;

  // 변 단위 run. 실제 road-side edge만 대문으로 분할하고, 남측 front가 다른 변이면 일반 담으로
  // 닫는다. 높이 차등(edge.heightK) + 밀착 담 공유(edge.share)도 같은 edge 메타를 소비한다.
  for (const edge of layout.edgeLayouts) {
    for (let runIndex = 0; runIndex < edge.runs.length; runIndex++) {
      const run = edge.runs[runIndex];
      g.add(makeEdgeRun(
        style, coping, run.a, run.b, edge.height, th, run,
        layout.centerX, layout.centerZ, M, rng, {
          enabled: opts.mudSurface !== false,
          seed: mudSurfaceRunSeed(seed, edge.index, runIndex, run),
        },
      ));
    }
    if (edge.gate) {
      const a = pts[edge.index], b = pts[(edge.index + 1) % n];
      if (style === 'brush' || style === 'hedge') {
        placeGatePosts(g, a, b, edge.gate.centerT, edge.gate.gap, edge.gate.height,
          M.mud, M.jipjul, 'brush');
      } else {
        placeGatePosts(g, a, b, edge.gate.centerT, edge.gate.gap, edge.gate.height,
          M.wood, M.wood, style === 'tile' ? 'tile' : 'stone', M);
      }
    }
  }

  // 모서리 기둥(솔리드): 실 모서리(인접 변 역할이 다른 꼭짓점)에만 — 뒷변 꺾임점 제외.
  if (style === 'stone' || style === 'mud' || style === 'tile') {
    for (const post of layout.cornerPosts) {
      cornerPostAt(
        g, post.point.x, post.point.z, post.height, post.thickness, style, M,
        post.bottomOffset || 0,
      );
    }
  }

  // The former renderer-only shed consumed two values before the later yard
  // props. Preserve that window so promoting it into a pure parcel plan does
  // not reshuffle jars, stacks, clotheslines, or garden details.
  if (opts.auxRequested ?? opts.aux) consumeLegacyAuxVariation(rng);

  // 마당 부속 소품(장독대·낟가리·빨래줄·텃밭) — 공유 재질 병합(0 신규 드로우콜).
  g.add(makeYardProps(yardPlacements, opts, M, rng));

  return g;
}

// 임의의 로컬 변(a→b)에 담 한 run 을 앉힌다 — run 로컬 +X=변 방향, +Z=바깥 법선(두께).
//   style 별 run 지오는 기존 헬퍼 재사용(makeSolidRun/makeBrushRun/makeHedgeRun).
function makeEdgeRun(style, coping, a, b, H, th, run, cx, cz, M, rng, mudSurface) {
  const ex = b.x - a.x, ez = b.z - a.z;
  const L = Math.hypot(ex, ez);
  if (L < 0.05) return new THREE.Group();
  let dx = ex / L, dz = ez / L;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  // 바깥 법선 perpR(e)=(-dz,dx) 가 centroid 반대(바깥)를 향하게 변 방향 정렬
  if ((-dz) * (mx - cx) + dx * (mz - cz) < 0) { dx = -dx; dz = -dz; }
  const rotY = Math.atan2(-dz, dx);                        // +X→(dx,dz), +Z→perpR(e)=바깥
  const solid = style !== 'brush' && style !== 'hedge';
  const grow = solid ? (run.grow || 0) : 0;                // 모서리·단차 겹침(이음새 가림)
  const bottomOffset = solid ? (run.bottomOffset || 0) : 0;
  const topOffset = solid ? (run.topOffset || 0) : 0;
  const runHeight = H + topOffset - bottomOffset;
  // 싸리울 살 변주는 run 고유 seed 로만 흔든다(공유 rng 스트림 불침해). mudSurface.seed 는
  //   이미 run 기하에서 파생된 결정론 해시라 그대로 재사용한다.
  const child = style === 'brush'
    ? makeBrushRun(L + grow, H, M.mud, M.jipjul, rng, mudSurface?.seed || 0)
    : style === 'hedge' ? makeHedgeRun(L + grow, H, rng)
    : makeSolidRun(style, coping, L + grow, runHeight, th, M, rng, mudSurface);
  child.position.set(mx, bottomOffset, mz); child.rotation.y = rotY;
  return child;
}

function mudSurfaceRunSeed(seed, edgeIndex, runIndex, run) {
  const metric = (value) => Number(value || 0).toFixed(6);
  return hashString([
    'mud-wall-run-v1',
    seed >>> 0,
    edgeIndex,
    runIndex,
    metric(run.a?.x),
    metric(run.a?.z),
    metric(run.b?.x),
    metric(run.b?.z),
    metric(run.bottomOffset),
    metric(run.topOffset),
  ].join('|'));
}

function placeGatePosts(g, a, b, t, gap, H, postMat, barMat, style, M) {
  const length = G.dist(a, b) || 1;
  const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
  const center = G.lerp(a, b, t);
  const holder = new THREE.Group();
  gatePosts(holder, gap, 0, H, postMat, barMat, style, M);
  holder.position.set(center.x, 0, center.z);
  holder.rotation.y = Math.atan2(-dz, dx);
  g.add(holder);
}

// 솔리드 담 한 스팬(로컬 X=길이). stone=막돌 돌담, mud=토담(흙+짚), tile=사괴석+회벽.
//   coping: 'tile'(기와 지붕띠) | 'thatch'(이엉 지붕띠) | 'none'. 몸채 지붕과 일치(R-P4).
function makeSolidRun(style, coping, L, H, th, M, rng, mudSurface = null) {
  const s = new THREE.Group();
  const wallTop = H - 0.18;
  if (style === 'stone') {
    // 막돌 돌담: fieldstone 텍스처 박스.
    const body = new THREE.Mesh(fieldstoneBox(L, wallTop, th), M.fieldstone);
    body.position.y = wallTop / 2; body.castShadow = body.receiveShadow = true; s.add(body);
  } else if (style === 'mud') {
    // 토담: 흙+짚 다짐(mud 톤) + 낮은 막돌 밑동(비 튐 방지 굽) — 하부 fieldstone 굽.
    const foot = Math.min(0.4, H * 0.22);
    const base = new THREE.Mesh(fieldstoneBox(L, foot, th * 1.04), M.fieldstone);
    base.position.y = foot / 2; base.castShadow = base.receiveShadow = true; s.add(base);
    let body;
    let fibreGeometry = null;
    if (mudSurface?.enabled !== false) {
      const surface = planMudWallSurface({
        length: L,
        height: wallTop,
        footHeight: foot,
        seed: mudSurface?.seed ?? 0,
      });
      const geometry = buildMudWallSurfaceGeometry(surface, th);
      fibreGeometry = geometry.fibres;
      if (!M.mud.vertexColors) {
        M.mud.vertexColors = true;
        M.mud.needsUpdate = true;
      }
      body = new THREE.Mesh(geometry.body, M.mud);
      body.userData.mudWallSurface = {
        enabled: true,
        schema: surface.schema,
        seed: surface.seed,
        lifts: surface.lifts.length,
        joints: surface.joints.length,
        fibres: surface.fibres.length,
        damp: surface.damp.length,
      };
    } else {
      body = new THREE.Mesh(new THREE.BoxGeometry(L, wallTop - foot, th), M.mud);
      body.position.y = (foot + wallTop) / 2;
      body.userData.mudWallSurface = { enabled: false };
    }
    body.name = 'mud-wall-body';
    body.castShadow = body.receiveShadow = true;
    // Keep the structural body as child 1: stepped-wall verification and edit
    // tooling use the established base/body ordering.
    s.add(body);
    if (fibreGeometry) {
      const surface = body.userData.mudWallSurface;
      const fibres = new THREE.Mesh(fibreGeometry, M.jipjul);
      fibres.name = 'mud-wall-fibres';
      fibres.castShadow = fibres.receiveShadow = true;
      fibres.userData.mudWallSurface = {
        schema: surface.schema,
        seed: surface.seed,
        fibres: surface.fibres,
      };
      s.add(fibres);
    }
  } else {
    // tile(반가): 사괴석 하단 + 회벽 상단.
    const baseH = Math.min(0.72, H * 0.36);
    const base = new THREE.Mesh(fieldstoneBox(L, baseH, th * 1.04), M.fieldstone);
    base.position.y = baseH / 2; base.castShadow = base.receiveShadow = true; s.add(base);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(L, wallTop - baseH, th * 0.9), M.plaster);
    upper.position.y = (baseH + wallTop) / 2; upper.castShadow = upper.receiveShadow = true; s.add(upper);
  }
  if (coping === 'tile') s.add(makeTileCoping(L, wallTop, th, M));
  else if (coping === 'thatch') s.add(makeThatchCoping(L, wallTop, th, M));
  return s;
}

// 이엉 지붕띠(초가 필지 담 coping, R-P4): 짚 두께층 + 짚 마루 + 마루를 눌러 감은 집줄(새끼줄) 띠.
//   종전엔 매끈한 대형 반원 튜브 하나여서 담 높이의 1/3을 차지한 발포 튜브·방수포로 읽혔다
//   (docs/architectural-authenticity.md §7.5 W3-2). 고치는 축은 둘이다.
//   ① 단면 반경을 내려 담 몸체가 프레임의 주체로 남게 한다.
//   ② 초가 지붕이 이미 쓰는 M.jipjul 로 마루를 감은 새끼줄 링을 일정 간격으로 걸어 결을 만든다
//      (새 재질·텍스처 0). 링은 마루를 감싸는 토러스라 곡면에서 뜨지 않는다.
//   담 한 변은 여러 run 으로 쪼개져 맞닿으므로 run 끝을 테이퍼하지 않는다 — 이음마다 거짓 단절이 생긴다.
function makeThatchCoping(L, eaveY, th, M) {
  const c = new THREE.Group();
  const w = th + 0.32;
  const body = new THREE.Mesh(new THREE.BoxGeometry(L + 0.06, 0.18, w), M.thatch);
  body.position.y = eaveY + 0.09; body.castShadow = true; c.add(body);
  const r = w * 0.27;
  const ridgeY = eaveY + 0.18 + r * 0.62;
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L + 0.04, 9), M.thatch);
  ridge.rotation.z = Math.PI / 2; ridge.position.y = ridgeY; ridge.castShadow = true; c.add(ridge);
  const nRope = Math.max(2, Math.min(16, Math.round(L / 0.8)));
  for (let i = 0; i < nRope; i++) {
    const rope = new THREE.Mesh(
      new THREE.TorusGeometry(r + 0.012, 0.021, 5, 9), M.jipjul,
    );
    rope.rotation.y = Math.PI / 2;                      // 토러스 평면을 마루 축(X)에 직교
    rope.position.set(-L / 2 + L * ((i + 0.5) / nRope), ridgeY, 0);
    rope.castShadow = true; c.add(rope);
  }
  return c;
}

// 생울 한 run(로컬 X=길이): 관목 덩어리 열. 공유 재질·지오(HEDGE_*) → 병합 1 드로우콜.
function makeHedgeRun(L, H, rng) {
  const s = new THREE.Group();
  const n = Math.max(2, Math.round(L / 1.05));
  for (let i = 0; i <= n; i++) {
    const x = -L / 2 + L * (i / n) + (rng() - 0.5) * 0.12;
    const r = 0.52 + rng() * 0.18;
    const blob = new THREE.Mesh(HEDGE_GEO, HEDGE_MAT);
    blob.scale.set(r * 1.15, H * 0.5 * (0.88 + rng() * 0.24), r);
    blob.position.set(x, H * 0.5, (rng() - 0.5) * 0.08);
    blob.castShadow = blob.receiveShadow = true;
    s.add(blob);
  }
  return s;
}

// 텃밭 힌트(개방 마당): 앞마당 한쪽 흙 이랑 몇 줄. 공유 재질.
// layout 은 yard-layout.js#yardHardPlacements 가 실제 필지 폴리곤에 맞춰 결정한 배치다
// (여기서 plotW×plotD 직사각형을 다시 추정하면 담 밖으로 나간다).
function makeGardenPatch(layout, M) {
  const g = new THREE.Group(); g.name = 'garden';
  const w = layout.width, d = layout.depth, cx = layout.x, cz = layout.z;
  const soil = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), M.stoneDark);
  soil.position.set(cx, 0.04, cz); soil.receiveShadow = true; g.add(soil);
  const rows = 3;
  for (let i = 0; i < rows; i++) {
    const row = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.07, 0.14), M.mud);
    row.position.set(cx, 0.11, cz - d * 0.3 + i * (d * 0.3)); g.add(row);
  }
  return g;
}

// ── 마당 부속 소품(#55): 장독대·낟가리·빨래줄·텃밭 ──────────────────────────────
//   집집이 마당 살림이 다르게. 전부 공유 wallMats 재질만 써서 병합 후 드로우콜 불변(0 신규).
//   구역 분할(로컬 +z=앞·도로, -z=뒤안): 장독대=뒤안 좌, 낟가리=뒤안 우(부속채와 배타),
//   빨래줄=앞마당 좌, 텃밭=앞마당 우. 신분(부유도)·rng 로 규모·유무가 상관 샘플됨(variants.js).
// placements = yardHardPlacements(...) — 렌더와 예약(yardHardObstacles)이 반드시 같은
//   좌표를 읽어야 하므로 이 함수는 배치를 계산하지 않고 소비만 한다. placed=false 인
//   소품은 앉을 자리가 없다는 뜻이라 잘라 넣지 않고 생략한다.
function makeYardProps(placements, opts, M, rng) {
  const g = new THREE.Group(); g.name = 'yard-props';

  // 장독대: 뒤안 좌측 낮은 돌단 + 옹기 열(규모 jangdok 0~3 → 열·항아리 수).
  //   rng 소비량은 배치 성공 여부와 무관하게 유지한다 — 기하 판정이 뒤 소품의 표본을
  //   흔들면 같은 필지가 배치 결과에 따라 다른 낟가리·빨래줄을 갖게 된다.
  const jangdok = placements.jangdok;
  if ((opts.jangdok || 0) > 0 && jangdok) {
    const rows = jangdok.rows, perRow = jangdok.perRow;
    const platW = jangdok.width, platD = jangdok.depth;
    const px = jangdok.x, pz = jangdok.z;
    if (jangdok.placed) {
      const plat = new THREE.Mesh(fieldstoneBox(platW, 0.14, platD), M.fieldstone);
      plat.position.set(px, 0.07, pz); plat.receiveShadow = true; g.add(plat);
    }
    for (let r = 0; r < rows; r++) {
      const n = Math.max(1, perRow - r);            // 뒤열일수록 큰 독 적게
      for (let c = 0; c < n; c++) {
        // RNG 소비량·순서는 placed 여부와 무관(아래 continue 앞). js 상한은
        // yard-layout 피치/인셋 계약과 같다 — 최대 지름 기준으로 침투·돌출 0.
        const js = JANGDOK_JAR_JS_MIN + rng() * JANGDOK_JAR_JS_SPAN;
        const jarScaleY = js * (1.05 + rng() * 0.35);
        if (!jangdok.placed) continue;
        const jar = new THREE.Mesh(JAR_GEO, M.onggi);      // 옹기(어두운 유약) — 문틀과 분리된 전용 색
        jar.scale.set(js, jarScaleY, js);
        const jx = px + (n === 1
          ? 0
          : (-platW / 2 + JANGDOK_JAR_INSET
            + c * (platW - 2 * JANGDOK_JAR_INSET) / (n - 1)));
        jar.position.set(
          jx,
          0.14 + 0.26 * js,
          pz - platD / 2 + JANGDOK_JAR_INSET + r * JANGDOK_JAR_PITCH,
        );
        jar.castShadow = jar.receiveShadow = true; g.add(jar);
      }
    }
  }

  // 낟가리(볏가리): 뒤안 우측 뭉툭한 짚 원뿔 + 눌림 마루. 부속채(같은 구석)와 배타 배치.
  //   예약 봉투는 반경 상한(maxRadius)이라, 실제 원뿔은 그 봉투 안에서만 흔들린다.
  const stack = placements.stack;
  if (opts.yardStack && !opts.aux && stack) {
    const R = 0.7 + rng() * 0.35, H = 1.5 + rng() * 0.6;
    const slack = stack.maxRadius - R;
    const cx = stack.x + slack, cz = stack.z - slack;
    if (stack.placed) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(R, H, 9), M.thatch);
      cone.position.set(cx, H / 2, cz); cone.castShadow = cone.receiveShadow = true; g.add(cone);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.5, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.jipjul);
      cap.position.set(cx, H, cz); cap.castShadow = true; g.add(cap);
    }
  }

  // 빨래줄: 앞마당 좌측 통나무 기둥 2 + 줄 + 널린 천 몇 폭(흰 회벽 재질 재사용).
  const clothesline = placements.clothesline;
  if (opts.clothesline && clothesline) {
    const ang = (rng() - 0.5) * 0.5;
    const heading = yardClotheslineLayout(opts.plotW, opts.plotD, ang);
    const span = clothesline.span, ph = clothesline.height;
    const lx = clothesline.x, lz = clothesline.z;        // 앞마당 좌(폴리곤 해석 결과)
    const dx = heading.dx, dz = heading.dz;
    if (clothesline.placed) {
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, ph, 6), M.wood);
        post.position.set(lx + dx * s * span / 2, ph / 2, lz + dz * s * span / 2);
        post.castShadow = true; g.add(post);
      }
      const line = new THREE.Mesh(new THREE.BoxGeometry(span, 0.02, 0.02), M.wood);
      line.position.set(lx, ph - 0.05, lz); line.rotation.y = -ang; g.add(line);
    }
    const nCloth = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < nCloth; i++) {
      const t = (i + 0.7) / (nCloth + 0.4) - 0.5;
      const ch = 0.5 + rng() * 0.4;
      if (!clothesline.placed) continue;
      const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.42, ch, 0.03), M.plaster);
      cloth.position.set(lx + dx * t * span, ph - 0.08 - ch / 2, lz + dz * t * span);
      cloth.rotation.y = -ang; cloth.castShadow = cloth.receiveShadow = true; g.add(cloth);
    }
  }

  // 텃밭: 앞마당 우측 흙 이랑 몇 줄(makeGardenPatch 재사용 배치).
  if (opts.vegBed && placements.vegBed?.placed) {
    g.add(makeGardenPatch(placements.vegBed, M));
  }

  return g;
}

// 담 위 기와 지붕띠: 얕은 맞배(양면 기왓골) + 용마루. 처마가 담두께보다 살짝 나온다.
function makeTileCoping(L, eaveY, th, M) {
  const c = new THREE.Group();
  const over = 0.16;                       // 처마 내밀기(z)
  const halfSpan = th / 2 + over;
  const rise = 0.28;                        // 용마루 솟음
  const ridgeY = eaveY + rise;
  // 처마 단(어두운 띠) — 양쪽 처마선
  for (const sz of [1, -1]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(L + 0.1, 0.07, 0.06), M.eaveBand);
    band.position.set(0, eaveY + 0.02, sz * halfSpan); c.add(band);
  }
  // 양면 기왓골(경사 판) — tileConvex 밝은 기와톤
  const slope = Math.atan2(rise, halfSpan);
  const planeLen = Math.hypot(halfSpan, rise) + 0.02;
  for (const sz of [1, -1]) {
    const plane = new THREE.Mesh(new THREE.BoxGeometry(L + 0.08, 0.05, planeLen), M.tileConvex);
    plane.position.set(0, (eaveY + ridgeY) / 2 - 0.01, sz * halfSpan / 2);
    plane.rotation.x = sz * slope;         // 용마루→처마로 흘러내림
    plane.castShadow = true; c.add(plane);
  }
  // 용마루(적층 마루) — 어두운 마루톤 각봉
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(L + 0.06, 0.14, 0.16), M.tileRidge);
  ridge.position.y = ridgeY; ridge.castShadow = true; c.add(ridge);
  return c;
}

// 싸리울(바자울) 한 run — 통나무 기둥 + 세로 싸리 가지 열 + 가로 엮음 3줄.
//
// 고증 수정(docs/architectural-authenticity.md §7.4-10, docs/village-walls-parcels.md):
//   종전 구현은 어휘는 맞았으나 **모든 살이 같은 높이·같은 굵기·완전 직립**이고 가로재가
//   run 전 길이를 관통하는 곧은 원기둥 2줄이었다. 그래서 서양식 정원 피켓 펜스로 읽혔다.
//
//   국립민속박물관 한국민속대백과사전 「싸리울」은 싸리울을 "싸리나무 혹은 그 가지 여러 개를
//   일정한 간격으로 길게 엮어 만든 울타리", "세로로 나란히 세워 **발처럼 길게 엮어** 만든"
//   것으로 서술하고, 「담」·「담장」은 재료를 "나뭇가지·풀대·싸리나무·수수깡"으로 든다.
//   즉 출처가 확인하는 것은 (ㄱ) 세로살을 나란히 세운다 (ㄴ) 가로로 **엮어 발을 만든다**
//   (ㄷ) 재료가 다듬은 각재가 아니라 자연 나뭇가지다 — 이 셋이다.
//
//   출처는 살 간격을 "일정한 간격"이라 하므로 간격 자체는 무작위화하지 않는다(감사가 제시한
//   "등간격은 시대착오"라는 진술은 1차 자료가 지지하지 않는다). 대신 규격 피켓과 갈라지는
//   축은 두 개다:
//     1. 재료가 자연 가지이므로 **높이·굵기가 개체마다 다르고 위끝이 들쭉날쭉하다** —
//        살 하나하나를 instanceMatrix 스케일로 변주한다(드로우콜 0 증가).
//     2. 가로재는 곧은 레일이 아니라 **엮음**이므로 살의 앞뒤를 번갈아 지나야 한다 —
//        3줄을 교대 오프셋 튜브로 만든다.
//   살 간격·줄 수·굵기 수치는 어느 기관 자료에도 없으므로(명시적 증거 공백) 이 값들은
//   제품 판독성 선택이며 실측 복원이 아니다.
//
// 결정론: 새 변주는 run 고유 seed 로 만든 지역 rng(brng)만 쓴다. 공유 `rng` 소비 횟수·순서는
//   종전과 동일해서 뒤따르는 마당 소품(장독·낟가리·빨래줄) 스트림이 이동하지 않는다.
const BRUSH_WEAVE_COURSES = 3;
// 엮음 한 주기(앞→뒤→앞)가 세로살 몇 칸을 지나는가. 살 간격의 4배에서 사람이 "엮였다"로
//   읽는다 — 더 길면 곧은 레일, 더 짧으면 지그재그 장식으로 읽혔다.
const BRUSH_STICK_PITCH = 0.085;
const BRUSH_WEAVE_PERIOD = BRUSH_STICK_PITCH * 4;
function makeBrushRun(L, H, postMat, twigMat, rng, runSeed = 0) {
  const s = new THREE.Group();
  const brng = makeRng((hashString(`brush-run-v1|${runSeed >>> 0}`) ^ 0x2c9a) >>> 0);
  const postR = 0.07;
  const nPosts = Math.max(2, Math.round(L / 2.2));
  for (let i = 0; i <= nPosts; i++) {
    const x = -L / 2 + L * (i / nPosts);
    const ph = H + 0.12;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR * 1.15, ph, 6), postMat);
    post.position.set(x, ph / 2, 0); post.castShadow = true; s.add(post);
  }
  // 세로 싸리 가지 — 나란히·일정 간격(출처)이지만 길이·굵기·기울기는 개체차(자연 재료).
  //   가지 밑동이 굵고 끝이 가늘도록 테이퍼 방향을 바로잡았다(종전은 위가 더 굵었다).
  //   밀도: 종전 0.22m 간격은 살 굵기(≈0.04m)의 5배 간격이라 그 자체로 살대 울이 아니라
  //   피켓 열로 읽혔다. 출처가 말하는 "발처럼" 엮인 면이 되도록 간격을 좁힌다(수치는 출처가
  //   주지 않으므로 판독성 선택). 드로우콜은 InstancedMesh 1개라 불변.
  const nStick = Math.max(6, Math.round(L / BRUSH_STICK_PITCH));
  const stickH = H - 0.1;
  const geo = new THREE.CylinderGeometry(0.011, 0.017, stickH, 5);
  const im = new THREE.InstancedMesh(geo, twigMat, nStick);
  const m = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const axis = new THREE.Vector3(0, 0, 1);
  const tops = new Float32Array(nStick);
  for (let i = 0; i < nStick; i++) {
    // 공유 rng 소비는 종전과 같은 3회. 값의 진폭만 넓힌다.
    const jitterX = (rng() - 0.5) * 0.03;
    const lean = (rng() - 0.5) * 0.11;
    const jitterZ = (rng() - 0.5) * 0.02;
    const x = -L / 2 + L * ((i + 0.5) / nStick) + jitterX;
    // 가지 다발은 낱개가 아니라 몇 개씩 같이 눕는다 — 저주파 성분을 더해 다발감을 만든다.
    const bundle = Math.sin((i / nStick) * Math.PI * 2.7 + brng() * 6.283) * 0.04;
    const heightK = 0.84 + brng() * 0.26;      // 위끝이 들쭉날쭉해지는 핵심 축
    const girthK = 0.74 + brng() * 0.7;        // 굵기 개체차
    scale.set(girthK, heightK, girthK);
    quaternion.setFromAxisAngle(axis, lean + bundle);
    position.set(x, stickH * heightK * 0.5 + 0.04, jitterZ);
    m.compose(position, quaternion, scale);
    im.setMatrixAt(i, m);
    tops[i] = stickH * heightK + 0.04;
  }
  im.instanceMatrix.needsUpdate = true; im.castShadow = true; s.add(im);
  im.userData.brushStickTops = tops;
  // 가로 엮음 3줄 — 곧은 레일이 아니라 살의 앞뒤를 번갈아 지나는 "발" 엮음(출처: 「싸리울」
  //   "발처럼 길게 엮어"). 반주기가 살 2칸이라 실루엣에서 앞뒤 교대가 실제로 읽힌다. 인접 줄은
  //   위상을 반대로 둔다 — 같은 위상이면 세 줄이 함께 굽어 곡선 레일로 되돌아간다.
  const weaveHalf = 0.038;
  const halfPeriods = Math.max(4, Math.round(L / (BRUSH_WEAVE_PERIOD * 0.5)));
  for (let course = 0; course < BRUSH_WEAVE_COURSES; course++) {
    const yy = H * (0.26 + course * 0.28);
    const phase = course % 2 === 0 ? 1 : -1;
    const points = [];
    for (let seg = 0; seg <= halfPeriods; seg++) {
      const t = seg / halfPeriods;
      points.push(new THREE.Vector3(
        -L / 2 + L * t,
        yy + (brng() - 0.5) * 0.014,
        phase * (seg % 2 === 0 ? weaveHalf : -weaveHalf),
      ));
    }
    const weave = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), halfPeriods * 2, 0.014, 5),
      twigMat,
    );
    weave.castShadow = true;
    s.add(weave);
  }
  return s;
}

// 모서리 기둥(솔리드 담 마감) — 로컬 (x,z) 한 꼭짓점. tile=회벽+기와 캡, stone=돌 기둥.
function cornerPostAt(g, x, z, H, th, style, M, bottomOffset = 0) {
  const p = new THREE.Group();
  if (style === 'tile') {
    const baseH = Math.min(0.72, H * 0.36), top = H - 0.1;
    const b = new THREE.Mesh(fieldstoneBox(th * 1.2, baseH, th * 1.2), M.fieldstone);
    b.position.y = baseH / 2; b.castShadow = true; p.add(b);
    const u = new THREE.Mesh(new THREE.BoxGeometry(th * 1.1, top - baseH, th * 1.1), M.plaster);
    u.position.y = (baseH + top) / 2; u.castShadow = true; p.add(u);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(th * 0.95, 0.3, 4), M.tileRidge);
    cap.rotation.y = Math.PI / 4; cap.position.y = top + 0.12; cap.castShadow = true; p.add(cap);
  } else {
    const b = new THREE.Mesh(fieldstoneBox(th * 1.15, H * 0.98, th * 1.15), M.fieldstone);
    b.position.y = H * 0.49; b.castShadow = true; p.add(b);
  }
  p.position.set(x, bottomOffset, z);
  g.add(p);
}

// 대문 힌트: 기둥 2 + 상방. tile=솟을(높은 기둥+작은 기와 지붕), stone=평대문(판문틀), brush=사립문(가는 통나무).
function gatePosts(g, gap, hd, H, postMat, barMat, style, M) {
  const raise = style === 'tile' ? H * 0.45 : style === 'brush' ? 0.15 : 0.2;
  const pH = H + raise;
  const pr = style === 'brush' ? 0.09 : 0.13;
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr * 1.1, pH, style === 'brush' ? 7 : 8), postMat);
    post.position.set(sx * gap / 2, pH / 2, hd); post.castShadow = true; g.add(post);
  }
  // 인방은 기둥과 같은 백골 목재(M.wood). 담 병합 그룹의 재질 집합을 늘리지 않으려고 woodDark 대신
  //   이미 기둥이 쓰는 M.wood 로 접는다(옹기가 전용 재질을 쓰는 대가를 상계 → 드로우콜 델타 0).
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(gap + 0.34, style === 'brush' ? 0.08 : 0.2, 0.2),
    style === 'brush' ? barMat : M.wood);
  lintel.position.set(0, pH - 0.18, hd); lintel.castShadow = true; g.add(lintel);
  if (style === 'tile') {
    // 솟을대문 힌트: 상방 위 작은 기와 지붕(용마루 + 양면 골)
    const cap = makeTileCoping(gap + 0.7, pH + 0.05, 0.5, M);
    cap.position.set(0, 0, hd);
    g.add(cap);
  }
}

function consumeLegacyAuxVariation(rng) {
  rng(); // former body height
  rng(); // former yaw
}
