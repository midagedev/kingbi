import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from '../rng.js';
import { bakeSphericalNormals, FOLIAGE_PROFILE, foliageLeafMass } from '../core/foliage-geometry.js';
import { parcelMatrix } from '../generators/shared/parcel-transform.js';
import * as G from '../core/math/geom2.js';

// 봄 개화 관목(#107) — 진달래(산비탈 군집)·개나리(담장가·길가 띠). 봄을 가을 단풍만큼의 백미로.
//   buildSpringBloom(plan, site, warp, mask) → { group, setSeason, drawCalls, azalea, forsythia }
//
// 설계 요지:
//   · 진달래: 마을 뒷산 사면에 연분홍~자주 군락. scatterTrees 와 "동일한" 지형 규약 —
//       공유 warp(makeEdgeWarp, populate 가 넘김) + 격자 이중선형(onMesh)으로 지형 메시면에 정확히
//       앉힌다(#86 부유 차단). 마을 인접 근사면에 확 피고, 먼 능선은 헤이즈라 약하게(band).
//   · 개나리: 길가(도로 양 가장자리)와 필지 담장 밖(대문 옆)에 노랑 띠. 마당 안 금지.
//   · 계절: 봄에만 가시(setSeason). blossom(gardens.js #41) 과 동일 취지 — 봄만 visible, 그 외 숨김.
//   · 성능: 종별 단일 InstancedMesh + instanceColor(개체 색 변주) → 신규 +2 드로우콜, 신규 재질 1개.
//   · 결정론: 전용 rng(seed^0x51009 파생). 기존 rng 소비 순서 불침해(플랜·나무·플로라 앵커 불변).

const TAU = Math.PI * 2;
const M4 = () => new THREE.Matrix4();
const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 진달래 연분홍~자주 / 개나리 노랑 팔레트(instanceColor 곱, SRGB→linear). 스타일라이즈드 산수화 무드.
const AZALEA_COLORS = [0xe77fb3, 0xd9679e, 0xee95c4, 0xcf5b93, 0xe070a8].map((h) => linCol(h));
const FORSYTHIA_COLORS = [0xffd54f, 0xffc107, 0xffcc33, 0xf7c948, 0xffd966].map((h) => linCol(h));

// 관목 프로토(로우폴리 ico 덩어리 병합). 단색(재질 흰색×instanceColor) → 개체마다 색을 달리한다.
//   진달래=낮고 둥근 무덤(꽃 무리), 개나리=성글고 높은 분수형(휘어진 가지 인상).
// 룩 복원 Phase 3.5(docs/tree-look.md §5) — 관목 덩이도 등축구가 아니라 불규칙 붓점 덩이로 굽고,
//   관목 매스 중심에서 구체 노멀을 전사한다. look-grammar §2-2 가 금지한 "기와는 골까지 파면서
//   관목이 8면체" 상태를 해소하고, 수묵 모드에서 관목 내부 폴리곤 필선이 사라진다.
//   최대 XZ 반경(|x| + r×1.08)은 구 ico 와 동일 — 봄 개화 띠의 배치·간격 계약 불변.
function mergeBlobs(specs, sy0) {
  const blobs = [];
  for (const [i, [r, x, y, z, sy]] of specs.entries()) {
    const g = foliageLeafMass({
      radius: r, up: r * 0.85, down: r * 0.85, profile: FOLIAGE_PROFILE.shrub,
      jitter: 0.2, phase: i * 1.1 + 0.2, spin: i * 0.9, lean: r * 0.1,
    });
    g.applyMatrix4(M4().makeTranslation(x, y, z).multiply(M4().makeScale(1.08, sy != null ? sy : sy0, 1.08)));
    blobs.push(g);
  }
  const m = mergeGeometries(blobs, false);
  m.deleteAttribute('uv');
  return bakeSphericalNormals(m);
}
function makeAzaleaProto() {
  return mergeBlobs([
    [0.42, 0, 0.30, 0, 0.78],
    [0.30, 0.26, 0.20, 0.10, 0.80],
    [0.28, -0.22, 0.24, -0.12, 0.82],
  ]);
}
function makeForsythiaProto() {
  return mergeBlobs([
    [0.32, 0, 0.52, 0, 1.15],
    [0.26, 0.30, 0.36, 0.06, 1.00],
    [0.25, -0.28, 0.34, -0.07, 1.00],
    [0.20, 0.05, 0.20, 0.26, 0.90],
  ]);
}

// 결정론적 저주파 value-noise(군락 마스크) — populate.js makeClump 과 동형(자립 순수 함수).
function makeClump(seed) {
  const rng = makeRng(seed);
  const base = new Uint8Array(256), perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = base[i]; base[i] = base[j]; base[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  const lat = (ix, iz) => perm[(perm[ix & 255] + (iz & 255)) & 255] / 255;
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const v00 = lat(x0, z0), v10 = lat(x0 + 1, z0), v01 = lat(x0, z0 + 1), v11 = lat(x0 + 1, z0 + 1);
    const sx = sm(fx), sz = sm(fz);
    const a = v00 + (v10 - v00) * sx, b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sz;
  };
}

// 지형 메시면 위 정확 배치를 위한 격자 이중선형 샘플러(scatterTrees onMesh 와 동형, warp 공유).
//   메시(buildSiteTerrain)는 정사각 격자(gx,gz)를 warp 로 신축한 정점 heightAt 를 잇는다. 관목도
//   같은 warp·같은 격자정점 높이를 보간해 앉혀 부유(디스크 밖·급사면 서브버텍스)를 원천 차단(#86).
function makeTerrainSampler(site, warp) {
  const TR = site.terrainR || site.R;
  const N = Math.max(150, Math.min(260, Math.round(TR / 1.4)));   // 메시와 동일 해상도
  const cache = new Map();
  const vert = (i, j) => {
    const key = i * (N + 3) + j;
    let v = cache.get(key);
    if (!v) {
      const gx = -TR + (2 * TR) * (i / N), gz = -TR + (2 * TR) * (j / N);
      const [wx, wz] = warp(gx, gz);
      v = { x: wx, z: wz, y: site.heightAt(wx, wz) };
      cache.set(key, v);
    }
    return v;
  };
  const onMesh = (gu, gv) => {
    const i = Math.min(N - 1, Math.max(0, Math.floor(gu))), j = Math.min(N - 1, Math.max(0, Math.floor(gv)));
    const fu = gu - i, fv = gv - j;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    const lx = (p, q) => p + (q - p) * fu;
    const k = (key) => lx(a[key], b[key]) + (lx(c[key], d[key]) - lx(a[key], b[key])) * fv;
    return { x: k('x'), y: k('y'), z: k('z') };
  };
  return { N, onMesh };
}

// ───────────────────────── 진달래(산비탈 군집) ─────────────────────────
function scatterAzalea(site, warp, mask, seed) {
  const R = site.R, TR = site.terrainR || R;
  const C = site.center, bowlR = site.bowlR, Hmax = site.Hmax || 68;
  const { N, onMesh } = makeTerrainSampler(site, warp);
  const rng = makeRng(seed);
  const clump = makeClump((seed ^ 0x5c1a) >>> 0);
  const CF = 1 / 34;   // 군락 파장 ~34m(나무 군집보다 촘촘 — 진달래 군락 밀집)

  // 밀도장: 근~중 사면 링(band) × 하~중 사면 선호(slope) × 군락 패치(patch).
  //   먼 능선(band 감쇠)·급경사 숲 크레스트(slope 감쇠)는 약하게 — 마을을 감싼 개활 비탈에 확 핀다.
  const density = (x, z, hill) => {
    if (hill < 0.05) return 0;
    const rC = Math.hypot(x - C.x, z - C.z);
    // #115: 산자락 전이대(마을~숲 치마)에 진달래가 확 피게 밴드 안쪽을 조금 당기고(0.76→0.72) 바깥을 넓힘.
    const band = smoothstep(bowlR * 0.72, bowlR * 1.00, rC) * (1 - smoothstep(bowlR * 1.48, bowlR * 1.86, rC));
    if (band <= 0) return 0;
    const slope = smoothstep(0.05, 0.16, hill) * (1 - smoothstep(0.42, 0.66, hill));   // 하~중 사면(급벽 배제)
    const patch = smoothstep(0.36, 0.70, clump(x * CF, z * CF));
    return band * slope * (0.34 + 0.66 * patch);   // #115 밀도↑: 성긴 자리도 진하게(봄 백미) — 군락 대비 유지
  };
  // 능선 너머(가림): 중심→점 사이 더 높은 능선이 있으면 부감·아이레벨 안 보임 → 심지 않음.
  const hidden = (x, z, yHere) => {
    const dx = x - C.x, dz = z - C.z;
    let mx = -Infinity;
    for (let t = 1; t <= 4; t++) { const s = t / 5, h = site.heightAt(C.x + dx * s, C.z + dz * s); if (h > mx) mx = h; }
    return mx > yHere + 1.5;
  };

  const target = Math.min(TR > 480 ? 2100 : 3200, Math.round((TR / 145) ** 2 * 330));  // #115 봄 백미: 밀도 상향
  const minD = 1.7;
  const grid = new Map();
  const key = (x, z) => Math.floor(x / minD) * 92821 ^ Math.floor(z / minD);
  const tooClose = (x, z) => {
    const cx = Math.floor(x / minD), cz = Math.floor(z / minD);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const arr = grid.get(ix * 92821 ^ iz); if (!arr) continue;
      for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return true;
    }
    return false;
  };

  const mats = [], colors = [], positions = [];
  let attempts = 0;
  while (mats.length < target && attempts < target * 32) {
    attempts++;
    const gu = rng() * N, gv = rng() * N;
    const p = onMesh(gu, gv);
    const hill = site.hillAt(p.x, p.z);
    if (rng() > density(p.x, p.z, hill)) continue;
    if (mask && mask(p.x, p.z)) continue;
    if (tooClose(p.x, p.z)) continue;
    if (hill > 0.4 && hidden(p.x, p.z, p.y)) continue;
    // 거친 미세지형(격자 메시가 매끈하게 근사한 자리)은 배제 — 메시면(onMesh)과 해석 heightAt 의 괴리가
    //   큰 곳에 앉으면 부감에서 접지가 어긋난다. 괴리 상한 0.28m 로 컷(관목은 낮아 소수 컷이 무해).
    const hA = site.heightAt(p.x, p.z);
    if (Math.abs(p.y - hA) > 0.28) continue;
    // 국소 경사(4샘플 |∇높이|)로 밑동을 살짝 묻는다(급사면 접지). 상한 0.14 → 괴리(≤0.28)+sink < 0.5m.
    const e = 0.7;
    const su = onMesh(Math.min(N, gu + e), gv), sd = onMesh(Math.max(0, gu - e), gv);
    const sr = onMesh(gu, Math.min(N, gv + e)), sl = onMesh(gu, Math.max(0, gv - e));
    const runU = Math.hypot(su.x - sd.x, su.z - sd.z) || 1, runV = Math.hypot(sr.x - sl.x, sr.z - sl.z) || 1;
    const slopeR = Math.hypot((su.y - sd.y) / runU, (sr.y - sl.y) / runV);
    const sink = Math.min(0.14, 0.06 + 0.4 * slopeR);
    const s = rng.range(0.72, 1.35);
    const y = p.y - sink;
    mats.push(M4().makeTranslation(p.x, y, p.z).multiply(M4().makeRotationY(rng() * TAU)).multiply(M4().makeScale(s, s * rng.range(0.85, 1.15), s)));
    const c = AZALEA_COLORS[(rng() * AZALEA_COLORS.length) | 0].clone();
    const j = 0.92 + rng() * 0.16; c.multiplyScalar(j);
    colors.push(c);
    positions.push({ x: p.x, y, z: p.z });
    { const k = key(p.x, p.z); let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push({ x: p.x, z: p.z }); }
  }
  return { mats, colors, positions };
}

// ───────────────────────── 개나리(담장가·길가 띠) ─────────────────────────
function scatterForsythia(plan, site, seed) {
  const rng = makeRng(seed);
  const mats = [], colors = [], positions = [];
  const noise = makeClump((seed ^ 0x0f01) >>> 0);

  const push = (x, z, y, s, sink) => {
    const yy = y - (sink || 0.06);
    mats.push(M4().makeTranslation(x, yy, z).multiply(M4().makeRotationY(rng() * TAU)).multiply(M4().makeScale(s, s * rng.range(0.85, 1.2), s)));
    const c = FORSYTHIA_COLORS[(rng() * FORSYTHIA_COLORS.length) | 0].clone();
    c.multiplyScalar(0.92 + rng() * 0.16);
    colors.push(c);
    positions.push({ x, y: yy, z });
  };

  // ── 1) 길가: 도로 양 가장자리를 따라 클러스터(고샅 가장자리). 노이즈 게이트로 성긴 띠(연속 울타리 아님) ──
  const STEP = 3.0;
  for (const road of (plan.roads || [])) {
    const pts = road.pts;
    if (!pts || pts.length < 2) continue;
    const line = G.resample(pts, STEP);
    const hw = road.width / 2;
    const nSeg = line.length - 1;
    for (let i = 0; i <= nSeg; i++) {
      const p = line[i];
      const a = line[Math.max(0, i - 1)], b = line[Math.min(nSeg, i + 1)];
      const tan = G.norm(G.sub(b, a));
      const nx = -tan.z, nz = tan.x;
      // 아크길이 따라 노이즈 게이트 — 뭉치(군락)와 빈틈이 교대. 촘촘도는 규모 무관(도로 길이 비례).
      const along = noise(i * 0.5, road.width);
      if (along < 0.34) continue;                   // #115: 길가 개나리 띠 더 자주(0.42→0.34)
      for (const side of [-1, 1]) {
        if (rng() > 0.82) continue;                 // #115: 양쪽 keep 82%(0.72→) — 노랑 띠 밀도↑
        const off = hw + rng.range(0.5, 1.15);
        const jx = (rng() * 2 - 1) * 0.5, jz = (rng() * 2 - 1) * 0.5;
        const x = p.x + nx * side * off + jx, z = p.z + nz * side * off + jz;
        push(x, z, site.heightAt(x, z), rng.range(0.7, 1.1));
      }
    }
  }

  // ── 2) 담장 밖: 필지 대문 담(로컬 +z=도로쪽) 바깥 좌·우(대문 중앙 비움)에 소량 군락 ──
  //   전용 per-parcel rng(도로 소비 순서 불침해). 히어로는 랜딩 프레임 정돈 위해 제외.
  for (const p of (plan.parcels || [])) {
    if (p.hero || !p.plotW) continue;
    const prng = makeRng((p.seed ^ 0x51f0) >>> 0);
    if (prng() > 0.90) continue;                    // #115: 담장 밖 개나리 군락 집 비율↑(80%→90%)
    const pm = parcelMatrix(p);
    const out = p.plotD / 2 + 1.3;                   // 담(+z) + 성토 패드 턱(PAD_MARGIN) 밖 자연지면
    const sides = prng() < 0.55 ? [-1, 1] : [prng() < 0.5 ? -1 : 1];
    for (const sx of sides) {
      const n = 1 + ((prng() * 2) | 0);              // 1~2 그루 작은 뭉치
      for (let k = 0; k < n; k++) {
        const lx = sx * p.plotW * (0.26 + prng() * 0.12) + (prng() * 2 - 1) * 0.5;
        const lz = out + (prng() * 2 - 1) * 0.6;
        const v = new THREE.Vector3(lx, 0, lz).applyMatrix4(pm);
        push(v.x, v.z, site.heightAt(v.x, v.z), 0.7 + prng() * 0.4);
      }
    }
  }
  return { mats, colors, positions };
}

// ───────────────────────── 최상위 ─────────────────────────
export function buildSpringBloom(plan, site, warp, mask) {
  const group = new THREE.Group(); group.name = 'village-bloom';
  const seed = ((plan.seed || 0) ^ 0x51009) >>> 0;

  const az = scatterAzalea(site, warp, mask, (seed ^ 0xa2) >>> 0);
  const fo = scatterForsythia(plan, site, (seed ^ 0xf0) >>> 0);

  // 공유 재질 1개(흰색 × instanceColor). flatShading 해제 — 구운 구체 노멀로 관목이 하나의 둥근
  //   덩이로 셰이딩된다(패싯 소멸, 역광 림 연속화). 프로그램 수 불변.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, flatShading: false });

  const meshes = [];
  const mk = (proto, data, name) => {
    if (!data.mats.length) return;
    const inst = new THREE.InstancedMesh(proto, mat, data.mats.length);
    for (let i = 0; i < data.mats.length; i++) { inst.setMatrixAt(i, data.mats[i]); inst.setColorAt(i, data.colors[i]); }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.name = name; inst.castShadow = false; inst.receiveShadow = false;
    inst.frustumCulled = false;   // 산개 배치라 인스턴스 바운딩이 전 지형을 덮음 — 통째 컬링 오판 방지
    group.add(inst); meshes.push(inst);
  };
  mk(makeAzaleaProto(), az, 'bloom-azalea');
  mk(makeForsythiaProto(), fo, 'bloom-forsythia');

  function setSeason(name) {
    const vis = name === 'spring';
    for (const m of meshes) m.visible = vis;
  }
  setSeason('summer');   // 기본 숨김 — 어댑터가 진입 시 실제 계절로 setSeason 호출.

  return {
    group, setSeason,
    drawCalls: meshes.length,
    azalea: { count: az.mats.length, positions: az.positions },
    forsythia: { count: fo.mats.length, positions: fo.positions },
  };
}
