import { smoothstep } from '../../core/math/scalar.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../../rng.js';
import { bakeSphericalNormals, canopyCenter, FOLIAGE_PROFILE, foliageLeafMass } from '../../core/foliage-geometry.js';
import { createValueNoise2D } from '../../core/math/value-noise2.js';
import { setupTreeOccluder } from '../../env/tree-occluder.js';
import { makeEcotoneField } from '../../village/forest.js';
import {
  foliageHillBias,
  foliageInstanceTint,
  makeEdgeWarp,
  makeNoise,
} from '../../village/forest-crunch.js';

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
export const SCATTER_TREE_VISUAL_RADIUS = Object.freeze({
  pine: 2.1,
  broad: 2.64, // Icosahedron radius 2.4 × authored horizontal scale 1.1
});

// ───────────────────────── 수목(숲·능선) ─────────────────────────
// hillAt 로 능선·산에만 밀집. mask(x,z)=true 인 자리(마을·도로·논)는 제외.
//
// 룩 복원 Phase 3.5 단계 0·1(docs/tree-look.md §5) + Phase 2 그루별 값 층화(#222).
//   원뿔 3층(=크리스마스트리 픽토그램)과 등축구 롤리팝을 동양화 잎덩이 어휘로 교체한다.
//   소나무는 굽은 줄기 + 층운형 잎덩이 3단(원리 ③), 활엽은 비대칭 덩이 뭉치(원리 ①).
//   캐노피에는 수관 매스 중심 기준 구체 노멀을 구워 수묵 모드의 내부 폴리곤 필선을 없앤다(§3.3)
//   — 재질의 flatShading 해제가 전제.
//   Phase 2: vertexColors 는 덩이별 절대색(한 나무 안 농담), instanceColor 는 forest 와 같은
//   그루별 곱틴트(고도·모자이크). 배치 rng 는 소비하지 않아 매트릭스 바이트·수용 집합 불변.
//   알파 카드 없음 → ink 노멀 오버라이드 함정·프로그램 패밀리 +2 회피.
// ★ 불변 계약: SCATTER_TREE_VISUAL_RADIUS(pine 2.1 / broad 2.64)를 넘지 않는다(배치 수용 판정 공유).
//   활엽 캐노피 하단은 2.09m 를 유지한다 — 급사면 접지 sink 식(#142)이 이 값을 상수로 갖는다.
//   삼각형: 소나무 62→72(굽은 줄기 2마디 비용), 활엽 100→60. 인스턴스 캡이 2050/3500 이라
//   합계 델타는 한양 부감에서 +1만 삼각 수준이다(예산 2M).
//   예산: 드로우콜 +0, 텍스처 +0, 삼각형 0. instanceColor 는 USE_INSTANCING_COLOR 정의만
//   켠다(vertexColors 재질 위에서 곱틴트) — 프로그램 패밀리는 기존 forest/bloom 과 공유 가능.

// 층운형 잎덩이 2덩이 — 층마다 값이 다른 녹(아래 짙고 위 밝게 = 위에서 오는 빛, 원리 ④·⑤).
//   각 덩이는 20면체를 위도 프로파일로 조각한 것이라 근경에서도 마름모·결정으로 읽히지 않는다.
const PINE_TIERS = [
  { hex: 0x243821, radius: 1.82, x: 0.24, y: 3.95, z: -0.10, up: 2.05, down: 2.10,
    profile: FOLIAGE_PROFILE.pine, jitter: 0.16, phase: 0.4, lean: 0.34, spin: 0.22 },
  { hex: 0x364c2d, radius: 1.30, x: 0.58, y: 5.60, z: 0.16, up: 1.05, down: 1.30,
    profile: FOLIAGE_PROFILE.broad, jitter: 0.18, phase: 1.3, lean: 0.22, spin: 1.05 },
];
// 비대칭 덩이 뭉치 — 주덩이 + 빛 받는 어깨 덩이(한 나무 안에서 농담이 갈린다).
const BROAD_LUMPS = [
  { hex: 0x445f2c, radius: 2.50, x: -0.10, y: 4.35, z: 0.06, up: 2.16, down: 2.26,
    profile: FOLIAGE_PROFILE.broad, jitter: 0.17, phase: 0.7, lean: 0.30, spin: 0.36 },
  { hex: 0x5b7a3a, radius: 1.36, x: 0.62, y: 5.05, z: -0.46, up: 1.15, down: 1.50,
    profile: FOLIAGE_PROFILE.broad, jitter: 0.18, phase: 2.1, lean: 0.20, spin: 0.95 },
];

// 굽은 줄기(적송): 두 마디를 누적 경사로 쌓아 수관 드리프트와 축을 맞춘다. 4분할 각기둥(마디 16 삼각)
//   — 반경 0.2m 대라 분할수를 늘려도 화면에 나타나지 않는다.
function bentTrunkParts(segments, hex) {
  const parts = [];
  for (const s of segments) {
    const g = new THREE.CylinderGeometry(s.rt, s.rb, s.len, 4);
    g.translate(0, s.len / 2, 0);
    if (s.tilt) g.rotateZ(s.tilt);
    g.translate(s.x, s.y, s.z);
    parts.push(tintGeo(g, hex));
  }
  return parts;
}
// 잎덩이를 만들고 수관 매스 중심 기준 구체 노멀을 구운 뒤 덩이별 색으로 틴트.
function tintedCanopy(lumps) {
  const center = canopyCenter(lumps);
  return lumps.map((l) => tintGeo(bakeSphericalNormals(foliageLeafMass(l), center), l.hex));
}
function makeTreeProtos() {
  // 소나무(상록): 굽은 갈색 줄기 + 짙은 청록 잎덩이 2덩이.
  const pine = [
    ...bentTrunkParts([
      { rt: 0.20, rb: 0.26, len: 1.85, x: 0, y: 0, z: 0, tilt: -0.05 },
      { rt: 0.13, rb: 0.20, len: 1.70, x: 0.10, y: 1.75, z: 0, tilt: -0.16 },
    ], 0x6a4a2e),
    ...tintedCanopy(PINE_TIERS),
  ];
  // 활엽(잡목): 곧은 줄기 + 비대칭 덩이 뭉치.
  const t2 = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 5); t2.translate(0, 1.2, 0);
  const broad = [tintGeo(t2, 0x6b5540), ...tintedCanopy(BROAD_LUMPS)];
  return {
    pine: mergeGeometries(pine, false),
    broad: mergeGeometries(broad, false),
  };
}
function tintGeo(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count, arr = new Float32Array(n * 3), c = linCol(hex);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
// 결정론적 저주파 value-noise(수목 군집 마스크) — site.js makeNoise 와 동형이되 이 함수 자립.
//   군집(숲)과 빈터가 교대하는 유기적 분포를 만든다(균일 담요 방지).

// warpInner: buildSiteTerrain 과 동일 값을 넘겨받아 나무를 메시와 같은 신축면에 앉힌다(#86).
export function scatterTrees(site, mask, seed, warpInner, treeDensityK = 1) {
  const group = new THREE.Group(); group.name = 'village-trees';
  const protos = makeTreeProtos();
  // flatShading 해제 — 프로토에 구운 구체 노멀을 살린다(docs/tree-look.md §3.6-3). 프로그램 수 불변.
  // vertexColors(덩이) × instanceColor(그루) 곱틴트 — material.color 는 기본 백색 유지.
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: false });
  const rng = makeRng(seed ^ 0x77ee);
  // 그루별 t 는 배치 rng 와 분리된 노이즈 — 배치 매트릭스·수용 집합 바이트 불변(#222).
  const tintNoise = makeNoise((seed ^ 0xc01a7e) >>> 0);
  const R = site.R;
  const TR = site.terrainR || R;
  const C = site.center, bowlR = site.bowlR, Hmax = site.Hmax;
  // 각 항목: { m: Matrix4, t, hillBias } — 색은 조립 시 instanceColor 로만 쓴다.
  const pine = [], broad = [];
  const M4 = () => new THREE.Matrix4();

  // ── 나무를 지형 메시면에 정확히 앉히는 격자 샘플러(부유 원천 차단, #86) ──
  //   메시(buildSiteTerrain)는 정사각 격자(gx,gz)를 warp 로 신축한 정점의 heightAt 를 잇는다.
  //   나무도 (a) 같은 warp 로 좌표를 신축하고(디스크 밖·코너 부유 제거) (b) 같은 격자정점 높이를
  //   이중선형 보간해 앉힌다(신축밴드 급사면 서브버텍스 부유 제거) → 나무=메시 표면 위 정확.
  const N = Math.max(150, Math.min(260, Math.round(TR / 1.4)));   // 메시와 동일 해상도
  const warp = makeEdgeWarp(site, warpInner);
  const vCache = new Map();
  const vert = (i, j) => {                       // 격자정점 (i,j) → 신축 월드XZ·메시높이(지연 캐시)
    const key = i * (N + 3) + j;
    let v = vCache.get(key);
    if (!v) {
      const gx = -TR + (2 * TR) * (i / N), gz = -TR + (2 * TR) * (j / N);
      const [wx, wz] = warp(gx, gz);
      v = { x: wx, z: wz, y: site.heightAt(wx, wz) };
      vCache.set(key, v);
    }
    return v;
  };
  const onMesh = (gu, gv) => {                   // 연속 격자좌표 → 메시면 위 점(월드)
    const i = Math.min(N - 1, Math.max(0, Math.floor(gu))), j = Math.min(N - 1, Math.max(0, Math.floor(gv)));
    const fu = gu - i, fv = gv - j;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    const lx = (p, q) => p + (q - p) * fu;
    const lerpXZ = (k) => (lx(a[k], b[k]) + (lx(c[k], d[k]) - lx(a[k], b[k])) * fv);
    return { x: lerpXZ('x'), y: lerpXZ('y'), z: lerpXZ('z') };
  };

  // ── 밀도장(#86): 마을 경계 밖에서 거리감쇠 + 군집 노이즈 + 능선 너머(가림) 컷 ──
  //   균일 담요(구 밀도=hillAt) → 마을 가까이 성글게·산기슭 군집·크레스트 성글되 실루엣 유지.
  const clump = createValueNoise2D((seed ^ 0x5c1a) >>> 0).noise;
  const CF = 1 / 46;                              // 군집 파장 ~46m
  const density = (x, z, hill) => {
    if (hill < 0.06) return 0;                    // 분지 평지: 나무 없음
    const rC = Math.hypot(x - C.x, z - C.z);
    const outBand = smoothstep(bowlR * 0.98, bowlR * 1.34, rC);          // 마을 경계 밖으로 램프
    const slope = smoothstep(0.06, 0.28, hill) * (1 - 0.4 * smoothstep(0.72, 1.0, hill)); // 크레스트 성글
    const grove = 0.15 + 0.85 * smoothstep(0.40, 0.72, clump(x * CF, z * CF)); // 숲/빈터 교대
    // #113 R4 역할 전환("숲은 면, 나무는 가장자리"): 캐노피 쉘이 사면을 연속 면으로 덮으므로, 사면 위
    //   개체 나무는 오직 능선 crest 실루엣(암봉 사이 짙은 침엽 — 레퍼런스 01·02)만 남긴다. 중·하사면
    //   싱글은 쉘 위에 떠 보이고 가을에 초록으로 계절 불일치(게이트 결함) → 전면 제거. crest 나무는 상록
    //   소나무라 사철 짙은 녹(가을에도 자연스러운 침엽 실루엣). 총수 ≤ 현행(대폭 감소).
    const crest = smoothstep(0.62, 0.9, hill);                         // 능선 상부만 보존
    return outBand * slope * grove * crest;
  };
  // #115 에코톤 점묘: 마을 가장자리 ~ 캐노피 쉘 시작선 사이 전이 밴드에 성긴 낱개 나무(숲 치마).
  //   #113 R4 가 사면 낱개 나무를 crest 로 물려 전이대가 텅 비었다("벽처럼 시작하는 숲") → 쉘 앞에
  //   소나무 위주 + 소량 활엽을 흩뿌려 숲이 마을로 자연스레 번지게. 쉘과 동일 필드로 시작선 정합.
  const ecoField = makeEcotoneField(site);
  const CF2 = 1 / 38;                                                  // 점묘 군집 파장(숲 치마 뭉치)
  const bandDensity = (x, z, hill) => {
    if (hill < 0.05) return 0;
    const f = ecoField(x, z);                                          // 0(마을)~1(숲 내부)
    // 쉘 시작 직전(f 낮~중)에 점묘, 숲 내부(f 높음)는 쉘이 덮으니 감쇠 — 전이 밴드에 집중.
    //   #115 재작업: 밴드 창 확대 + grove 하한↑ + 배율↑ 로 "성긴 숲" 인상 강화(전이대 채움).
    const band = smoothstep(0.02, 0.30, f) * (1 - smoothstep(0.54, 0.94, f));
    if (band <= 0) return 0;
    const grove = 0.42 + 0.58 * smoothstep(0.30, 0.68, clump(x * CF2 + 11, z * CF2 - 7));
    return band * grove * 1.15;                                        // 전이대 점묘 밀도 상향(0.7→1.15)
  };
  // 능선 너머(far downslope): 중심→점 사이에 더 높은 능선이 있으면 부감·아이레벨 모두 안 보임 → 0.
  //   실루엣에 기여하는 크레스트·근사면(사이에 더 높은 능선 없음)은 남긴다. 고지(hill↑)만 검사(비용).
  const hidden = (x, z, yHere) => {
    const dx = x - C.x, dz = z - C.z;
    let mx = -Infinity;
    for (let k = 1; k <= 4; k++) { const t = k / 5; const h = site.heightAt(C.x + dx * t, C.z + dz * t); if (h > mx) mx = h; }
    return mx > yHere + 1.5;
  };

  // 밀도 목표(상한). #86: 담요 대폭 감소 — 구(TR/120)²·320 대비 절반 수준 + 밀도장 추가 감쇠.
  //   hanyang(TR>480)은 3000→1600, capital 이하도 캡 하향.
  //   #91 나무 밀도 배율(treeDensityK, 기본 1=현행): 목표수만 배율하고 Math.min 캡은 유지 → 상한 고정
  //   (성능 파탄 방지). 나무는 자체 rng(seed^0x77ee)라 공유 시퀀스 미소비 → 밀도 변경이 배치·필지 불간섭.
  const tK = Math.min(2, Math.max(0, treeDensityK));
  //   #115(재작업): 전이 밴드 점묘 몫으로 목표수 상향(200→260, 캡↑). 밴드는 마을 인접 숲 치마라
  //   외곽 밀도 대폭 감소(#86, 먼 산) 기조와 무관 — crest 실루엣 나무는 그대로, 앞에 점묘만 더한다.
  const target = Math.min(TR > 480 ? 2050 : 3500, Math.round((TR / 138) ** 2 * 260 * tK));
  let attempts = 0;
  const pts = [];
  const minD = 4.8;
  // 최소간격 이웃검사 공간해시(O(n²) 회피). 셀=minD → 인접 9셀만 대조.
  const tgrid = new Map();
  const tkey = (x, z) => Math.floor(x / minD) * 92821 ^ Math.floor(z / minD);
  const tooClose = (x, z) => {
    const cx = Math.floor(x / minD), cz = Math.floor(z / minD);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const arr = tgrid.get(ix * 92821 ^ iz); if (!arr) continue;
      for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return true;
    }
    return false;
  };
  while (pts.length < target && attempts < target * 26) {
    attempts++;
    // 격자좌표로 샘플 → 자동으로 메시 디스크 안에 갇힘(코너 부유 제거).
    const gu = rng() * N, gv = rng() * N;
    const p = onMesh(gu, gv);
    const x = p.x, z = p.z;
    const hill = site.hillAt(x, z);
    const crestD = density(x, z, hill);
    const bandD = bandDensity(x, z, hill);            // #115 전이 밴드 점묘
    const dens = Math.min(1, crestD + bandD);
    if (rng() > dens) continue;                       // 거리감쇠·군집·에코톤 밴드 밀도장 기각
    if (mask && mask(x, z)) continue;
    if (tooClose(x, z)) continue;
    if (hill > 0.45 && hidden(x, z, p.y)) continue;   // 능선 너머(안 보임) → 심지 않음
    const isBand = bandD > crestD;                    // 이 점이 전이 밴드 점묘인지(밴드 우세)
    const s = rng.range(0.8, 1.5);
    // #115: crest 나무는 상록 소나무만(#113 R4, 사철 짙은 침엽 실루엣). 전이 밴드 점묘는 소나무 위주에
    //   소량(≈28%) 활엽 혼합 — 숲 치마의 혼효림 인상. 밴드 나무는 쉘 앞(맨 지면) 위라 가을 계절 불일치
    //   착시 없음(쉘 위에 뜬 게 아님). rng() 1회 소비는 기존 자리와 동일 → 시퀀스 정합 유지.
    const broadTree = (rng() < 0.34) && isBand;   // rng() 무조건 1회 소비 / 밴드 혼효림 활엽 비율 소폭↑
    // 급사면 시각 하드닝(#86 재라운드): 나무 밑동을 국소 경사에 비례해 지면에 박는다. 배치 y 는
    //   메시면 위(레이캐스트 검증 편차<0.1m)이나, 저각(grazing) 매끈한 사면에서는 다운슬로프 그림자
    //   오프셋과 겹쳐 '둥치가 떠 보이는' 착시가 난다 → 밑동을 묻어 둥치가 지면을 뚫고 나오게 한다.
    const e = 0.7;
    const su = onMesh(Math.min(N, gu + e), gv), sd = onMesh(Math.max(0, gu - e), gv);
    const sr = onMesh(gu, Math.min(N, gv + e)), sl = onMesh(gu, Math.max(0, gv - e));
    const runU = Math.hypot(su.x - sd.x, su.z - sd.z) || 1, runV = Math.hypot(sr.x - sl.x, sr.z - sl.z) || 1;
    const slopeR = Math.hypot((su.y - sd.y) / runU, (sr.y - sl.y) / runV);   // |∇높이| (rise/run)
    // #142 활엽 접지: 롤리팝 활엽은 캐노피 하단이 밑동보다 ~2.1·s 높다. 가는 줄기(원경 비가시) 위
    //   넓은 캐노피라 급사면에서 내리막 가장자리가 공중에 뜬다("공 부유", #137 잔여). 경사에 비례해
    //   나무 전체를 내려 앉혀 캐노피 하단을 사면에 밀착시킨다(완사면=롤리팝 유지, 급사면=지면 밀착 —
    //   크런치 활엽과 동조). 소나무는 종전대로 밑동 매립 하드닝만.
    let sink;
    if (broadTree) {
      // 프로토 수관 하단(스케일 반영). Phase 3.5 의 덩이 뭉치도 주덩이 아래 꼭지를 이 높이에 두어
      //   이 상수와 배치 y 를 그대로 유지한다(BROAD_LUMPS 주덩이 y 4.35 − down 2.26 = 2.09).
      const canopyBottom = 2.09 * s;
      // 완경사부터 캐노피 하단을 지면에 밀착(smoothstep 조기 포화) + 급사면 내리막 가장자리 매립 마진.
      sink = smoothstep(0.04, 0.22, slopeR) * canopyBottom + 1.4 * s * slopeR;
    } else {
      sink = Math.min(1.1, 1.0 * slopeR);
    }
    const m = M4().makeTranslation(x, p.y - sink, z);
    m.multiply(M4().makeRotationY(rng.range(0, 6.28)));
    m.multiply(M4().makeScale(s, s * rng.range(0.9, 1.2), s));
    // Anchor rejection stays before the RNG window for backward compatibility.
    // The footprint query runs only after scale/species/rotation have all consumed
    // their draws, so a newly blocked canopy cannot shift every later candidate.
    const visualRadius = s * (broadTree
      ? SCATTER_TREE_VISUAL_RADIUS.broad
      : SCATTER_TREE_VISUAL_RADIUS.pine);
    if (mask && mask(x, z, visualRadius)) continue;
    pts.push({ x, z });
    { const k = tkey(x, z); let arr = tgrid.get(k); if (!arr) { arr = []; tgrid.set(k, arr); } arr.push({ x, z }); }
    // 위치 기반 t(배치 rng 불침해) + forest 와 같은 hillBias 축.
    const t = tintNoise(x * 0.053 + 2.1, z * 0.053 - 4.7);
    const hBias = foliageHillBias(hill);
    (broadTree ? broad : pine).push({ m, t, hillBias: hBias });
  }
  for (const [proto, entries, name, deep] of [
    [protos.pine, pine, 'scatter-pine', true],
    [protos.broad, broad, 'scatter-broad', false],
  ]) {
    if (!entries.length) continue;
    const inst = new THREE.InstancedMesh(proto, mat, entries.length);
    inst.name = name;
    const col = new Float32Array(entries.length * 3);
    for (let i = 0; i < entries.length; i++) {
      inst.setMatrixAt(i, entries[i].m);
      const tint = foliageInstanceTint(entries[i].t, entries[i].hillBias, deep);
      col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b;
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    inst.instanceColor.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = false;
    group.add(inst);
  }
  // pure-check / 문서용: 그루별 값 층화가 실제로 붙었음을 노출(런타임 소비 없음).
  group.userData.instanceColorStratified = true;
  group.userData.count = pts.length;
  // 전경 나무 오클루더 페이드: 궤도 회전 중 카메라와 마을 중심 사이 근경 나무를 dithered 반투명화.
  // VillageHandle.updateLod(camera, target, dt)가 애니메이션 프레임당 정확히 한 번 구동한다. 후처리의
  // 추가 scene render마다 onBeforeRender가 재실행되면 비용·이징이 패스 수에 결합되므로 self-drive 금지.
  // 마을은 원점 기준 authored라 캐노피 월드좌표는 그룹 추가 전에도 인스턴스 행렬 그대로다.
  const occ = setupTreeOccluder();
  occ.register(group, { canopyY: 4.0 });
  group.userData.occluder = occ;
  return group;
}
