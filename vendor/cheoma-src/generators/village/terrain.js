import { smoothstep } from '../../core/math/scalar.js';
import * as THREE from 'three';
import { createValueNoise2D } from '../../core/math/value-noise2.js';
import {
  GRANITE, makeEcotoneField, makeEdgeWarp, makeRockExposure,
} from '../../village/forest-crunch.js';
import {
  streamSurfaceHeightAt,
  terrainGridSize,
} from '../../village/terrain-grid.js';
import { injectWaterLook } from '../../env/water.js';
import {
  CLOUD_SHADOW_FRAG_DECL, CLOUD_SHADOW_FRAG_BODY,
  CLOUD_SHADOW_VERT_DECL, CLOUD_SHADOW_VERT_BODY,
} from '../../env/clouds.js';

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
// #211 U1: capital/hanyang 부감에서 scene fog near=R*2.2 가 terrainR 밖이라 절단면이 fog 에
//   안 걸린다. 외곽 밴드의 지형색→대기색 믹스를 높여 하드컷 원반을 로컬 셰이더로 녹인다.
//   0.62 는 아이레벨에선 충분했으나 석양 돔 대비 부감에선 절단 실루엣이 남았다.
const V_EDGE_HAZE_AMT = 0.92;

// ───────────────────────── 지형 메시 ─────────────────────────
// site.heightAt 를 격자로 샘플 → vertexColors(마당·풀·숲·물가·원경 대기). terrain.js 톤 계열.
//   + 비정형 외곽선(site.edge): warpInner 밖 최외곽 정점만 edgeRadiusAt(theta) 로 신축(내부 불변).
//   + 엣지 소실 헤이즈(aEdge) + 흐르는 구름 그림자(cloudU) 셰이더 패치(단일 씬 terrain.js 와 동형).
// 반환 { mesh, setHaze(color) } — setHaze 는 엣지 헤이즈색을 대기(fog)색과 동기화(어댑터 fog 훅이 호출).
export function buildSiteTerrain(site, cloudU, warpInner, clearDist) {
  const R = site.R;
  const TR = site.terrainR || R;               // 지형 메시 범위(마을보다 넓게)
  const edge = site.edge;
  const N = terrainGridSize(site);
  const cCourt = linCol(0x8a7f66);   // 마을 바닥(밟힌 흙)
  const cGrass = linCol(0x676f45);   // 초지
  const cGrassDry = linCol(0x7a7c4c);   // 볕 좋은 마른 초지(#115 모틀링) — 균일 초록 원반(어두운 타원) 깨기
  const cForest = linCol(0x435a2a);  // 숲(능선) — 산 덩어리가 읽히되 사면이 검게 안 죽게
  const cScrub = linCol(0x566a38);   // 초지↔숲 사이 관목 올리브(#115 재작업) — 접합부 3단 페더로 경계 완화
  const cFar = linCol(0x6a7c70);     // 원경 대기 감쇠
  const cBank = linCol(0x6d6249);    // 물가 축축한 흙
  const cFloodplain = linCol(0x788164); // 큰 물길의 충적 완사면(초지보다 옅고 습함)
  const cGranite = linCol(GRANITE);  // 화강암 밝은 회백(급경사·상부 노출, #113) — forest.js 와 공유 톤
  // #137 이끼 낀 회록 화강암 — 순수 화강암 100%가 아니라 숲색 쪽으로 살짝 섞어(레퍼런스: 바위에 낀 이끼)
  //   회색 노출이 너무 죽지 않게. 실제 페인트는 이 색을 기준으로 rock 강도만큼 섞는다.
  const cGraniteMoss = linCol(GRANITE).lerp(cForest, 0.26);
  const cWinterDry = linCol(0x8a8168); // 겨울 마른 갈회(#115 F) — 초지·완사면을 갈회로 이동(겨울감)
  const tmp = new THREE.Color();
  const tmpW = new THREE.Color();
  // #115 에코톤 공유 필드(캐노피 쉘과 동일) — 숲 톤 onset 을 쉘 시작선과 일치시킨다(색·기하 경계 일치).
  const ecotone = makeEcotoneField(site);
  // 마을 흙터(court) 가장자리 노이즈 페더 — 밟힌 흙 원반이 깔끔한 원으로 읽히지 않게(전용 시드, 공유 rng 불침해).
  const courtN = createValueNoise2D(((site.seed || 0) ^ 0xc0f7) >>> 0).noise;
  // 해석 경사 |∇높이| — 화강암 노출 게이트(상부 급경사만). forest.js makeSlopeAt 과 동형.
  const slopeAt = (x, z) => {
    const d = 2.0;
    const hx = (site.heightAt(x + d, z) - site.heightAt(x - d, z)) / (2 * d);
    const hz = (site.heightAt(x, z + d) - site.heightAt(x, z - d)) / (2 * d);
    return Math.hypot(hx, hz);
  };
  // #137 화강암 노출장 — forest-crunch 와 "같은" 함수(동일 site.seed 파생). 지형 회색 페인트가 여기서
  //   칠하는 곳 = 나무 rockAvoid 가 걷는 곳으로 정확히 일치한다(나무 걷힌 자리에 회색이 드러남).
  const rockExp = makeRockExposure(site);

  // 비정형 외곽선 신축(공유 헬퍼 makeEdgeWarp): warpInner 안쪽 고정, 바깥 밴드만 유기적 재매핑.
  //   scatterTrees 도 같은 warp 로 나무를 앉혀 메시-수목 신축면이 정확히 일치한다(#86 부유 차단).
  const warp = makeEdgeWarp(site, warpInner);

  const pos = [], col = [], edgeK = [];
  const idx = [];
  const stream = site.stream;
  const streamDistK = (x, z) => {
    if (!stream) return 0;
    const cz = site.streamZat(x);
    return smoothstep(site.streamHalf + 6, site.streamHalf * 0.4, Math.abs(z - cz));
  };
  // outBase 에 기본(봄·여름·가을) 색을, outWinter(있으면)에 겨울 갈회 버퍼 색을 쓴다.
  const colorAt = (x, z, outBase, outWinter) => {
    const hill = site.hillAt(x, z);
    const rC = Math.hypot(x - site.center.x, z - site.center.z);
    // #115: 밟힌 흙(court)을 반경 원반 → "구조물로부터의 거리"(clearDist) 기반으로 전환. 황토가 집·길
    //   윤곽을 따라 앉아(비원형) 원형 마을터 인상을 해소한다. 노이즈 페더로 경계선을 흔든다.
    //   clearDist 없을 때(하위호환)만 구 반경식 폴백.
    const cw = (courtN(x / 24, z / 24) - 0.5) * 9;   // 페더(m)
    let court;
    if (clearDist) {
      const cd = clearDist(x, z);
      court = smoothstep(22 + cw, 2 + cw, cd) * (1 - hill);   // cd 작음(구조물 인접)=황토, 멀면 초지
    } else {
      const cwR = (courtN(x / 24, z / 24) - 0.5) * site.bowlR * 0.14;
      court = smoothstep(site.bowlR * 0.42 + cwR, site.bowlR * 0.08, rC) * (1 - hill);
    }
    outBase.copy(cGrass).lerp(cCourt, court * 0.55);
    // #115 초지 모틀링: 개활 초지에 저주파 마른-초지 얼룩을 섞어 균일 초록 원반(어두운 타원)을 깬다.
    //   황토(court) 위·깊은 숲 아래에서만 약하게(hill/court 로 게이트) — 지형 색 비정형화.
    const mott = smoothstep(0.36, 0.72, courtN(x / 68 + 40, z / 68 - 25));
    outBase.lerp(cGrassDry, mott * (1 - court) * (1 - smoothstep(0.28, 0.6, hill)) * 0.5);
    // #115 에코톤: 숲 톤 전이를 순수 hill 게이트에서 쉘과 동일한 에코톤 필드(반경+노이즈)로 교체 —
    //   색 경계가 캐노피 쉘 시작선과 일치(두드러진 원형 경계 해소). 평지 녹패치 방지 hillGate 로 게이트하고,
    //   깊은 능선(고지)은 반경 무관 완전 숲 톤 보장(max).
    const eco = ecotone(x, z);
    const hillGate = smoothstep(0.04, 0.20, hill);
    const forestT = Math.max(eco * hillGate, smoothstep(0.45, 0.72, hill));
    // #115 재작업: 초지→관목(scrub)→숲 3단 페더 — 접합부가 좁은 선으로 읽히지 않게 전이 폭 확대.
    //   두 겹침 램프(0~0.55, 0.30~1.0)로 넓고 완만한 그라데이션. 깊은 숲(forestT→1)은 최종 cForest.
    outBase.lerp(cScrub, smoothstep(0.0, 0.55, forestT));
    outBase.lerp(cForest, smoothstep(0.30, 1.0, forestT));
    // 화강암 노출(#137 재균형): 구 연속 회색 띠(smoothstep(0.58,1.25,slope)·(0.44,0.74,hill))가 상부
    //   사면을 넓게 회색으로 칠해 "민짜 암벽"으로 읽혔다 → rockExp 로 노이즈 게이트된 불규칙 줄무늬 패치
    //   (상부 지릉·골, 표면 ~10–20%)로 교체하고 이끼 낀 회록으로 섞는다. 나무 rockAvoid 와 동일 필드라
    //   나무가 걷힌 자리에만 회색이 드러난다(정합). 하부 사면·완사면·평지 무변(순수 숲).
    if (hill > 0.55) {
      const rock = rockExp(x, z, slopeAt(x, z), hill);
      if (rock > 0) outBase.lerp(cGraniteMoss, Math.min(1, rock) * 0.86);
    }
    // 물가
    const bank = streamDistK(x, z);
    if (stream?.kind === 'river') {
      const distance = Math.abs(z - site.streamZat(x));
      const floodplain = smoothstep(stream.floodplainHalf, stream.half * 0.8, distance);
      outBase.lerp(cFloodplain, floodplain * (1 - bank) * 0.34);
    }
    if (bank > 0) outBase.lerp(cBank, bank * 0.7);
    // 원경 대기(먼 능선일수록 옅게). #211: 부감 절단면 대비를 낮추려 far 램프를 소폭 강화.
    const far = smoothstep(TR * 0.55, TR, Math.hypot(x, z)) * 0.55;
    outBase.lerp(cFar, far);
    // 겨울 버퍼(#115 F): 기저색을 마른 갈회로 이동. 분지 초지·완사면 강, 깊은 숲(상록 잔존) 약, 물가 유지.
    //   지형 정점색은 정적이므로 forest.js 계절 버퍼 방식과 동형으로 겨울 전용 버퍼를 만들어 setSeason 스왑.
    if (outWinter) {
      const wAmt = 0.55 * (1 - 0.5 * forestT) * (1 - 0.7 * bank) * (1 - far);
      outWinter.copy(outBase).lerp(cWinterDry, wAmt);
    }
  };

  const colW = [];   // 겨울 전용 정점색 버퍼(#115 F)
  const grid = [];
  for (let i = 0; i <= N; i++) {
    grid[i] = [];
    for (let j = 0; j <= N; j++) {
      const gx = -TR + (2 * TR) * (i / N);
      const gz = -TR + (2 * TR) * (j / N);
      const [x, z] = warp(gx, gz);               // 외곽만 유기적으로 신축(내부는 그대로)
      const y = site.heightAt(x, z);
      pos.push(x, y, z);
      colorAt(x, z, tmp, tmpW);
      col.push(tmp.r, tmp.g, tmp.b);
      colW.push(tmpW.r, tmpW.g, tmpW.b);
      edgeK.push(edge ? edge.edgeK(x, z) : 0);   // 외곽 밴드 0(안)→1(경계선) — 엣지 소실 마스크
      grid[i][j] = i * (N + 1) + j;
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = grid[i][j], b = grid[i][j + 1], c = grid[i + 1][j], d = grid[i + 1][j + 1];
    idx.push(a, b, c, b, d, c);   // 상향 법선(윗면이 정면)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const colBaseArr = new Float32Array(col), colWinterArr = new Float32Array(colW);
  geo.setAttribute('color', new THREE.BufferAttribute(colBaseArr.slice(), 3));   // 라이브 버퍼(계절 스왑)
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeK, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });

  // ── 셰이더 패치: 흐르는 구름 그림자 + 엣지 소실 헤이즈 ──────────────────────
  // 단일 씬 terrain.js 와 동형(고유 심볼 uCloud*/vEdge/uEdgeHazeV). 마을 지형엔 현재 계절·적설
  // 패치가 없어 체인 충돌은 없으나, 향후 패치가 얹혀도 color_fragment '뒤'에 삽입되도록 앵커 사용.
  const uEdgeHaze = { value: new THREE.Vector3(0.8, 0.8, 0.85) };  // 대기색 — setHaze 가 갱신
  const useCloud = !!cloudU;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uEdgeHazeV = uEdgeHaze;
    if (useCloud) {
      shader.uniforms.uCloudTime = cloudU.uCloudTime;
      shader.uniforms.uCloudStr = cloudU.uCloudStr;
      shader.uniforms.uCloudBlobs = cloudU.uCloudBlobs;   // 빌보드 대응 그림자 블롭(#68)
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\nattribute float aEdge;\nvarying float vEdgeV;\n${useCloud ? CLOUD_SHADOW_VERT_DECL : ''}`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>\nvEdgeV = aEdge;\n${useCloud ? CLOUD_SHADOW_VERT_BODY : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nuniform vec3 uEdgeHazeV;\nvarying float vEdgeV;\n${useCloud ? CLOUD_SHADOW_FRAG_DECL : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${useCloud ? CLOUD_SHADOW_FRAG_BODY : ''}
        {
          // 엣지 소실: 외곽 밴드(vEdgeV)에서 지형색을 대기(fog)색으로 밀어 여백으로 녹임(mist).
          // #211: 램프를 더 일찍·더 꽉 채워 부감 절단면이 하드 실루엣으로 남지 않게 한다.
          float e = smoothstep(0.04, 0.88, vEdgeV);
          diffuseColor.rgb = mix(diffuseColor.rgb, uEdgeHazeV, ${V_EDGE_HAZE_AMT.toFixed(3)} * e);
        }`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'village-terrain';
  mesh.receiveShadow = true;
  // Vector3.copy(Color)=NaN 함정 회피 → 채널 직접 대입.
  const setHaze = (c) => { if (c) uEdgeHaze.value.set(c.r, c.g, c.b); };
  // 계절 정점색 스왑(#115 F): 겨울만 마른 갈회 버퍼, 그 외(봄·여름·가을)는 기저 버퍼(현행 색 불변).
  const colAttr = geo.getAttribute('color');
  let shownWinter = false;
  const setSeason = (name) => {
    const w = name === 'winter';
    if (w === shownWinter) return;
    colAttr.array.set(w ? colWinterArr : colBaseArr);
    colAttr.needsUpdate = true;
    shownWinter = w;
  };
  return { mesh, setHaze, setSeason };
}


// 배산 능선 물안개 앵커 — 뒤(북) 반원 각 방위에서 site.center(분지 중심) 기준으로 밖으로 표고를
//   스캔해 목표 중턱높이의 "안쪽(분지를 바라보는) 사면" 첫 교차점을 찾는다(원점 아닌 center 기준 —
//   분지가 북으로 물려 있어 원점 스캔은 능선 먼 쪽에 놓여 근사면에 가려짐). 그 지형면 살짝 위에
//   카메라 대면 뱅크를 얹고 분지쪽으로 조금 당겨 아이레벨 진입 시점에서 능선에 걸친 원경 물안개로 읽힌다.
//   두 단(段)으로 쌓는다: 능선 중턱 밴드(원경) + 그 앞 낮은 밴드(중경). 아이레벨 근접 focus 는
//   배산임수 규약상 항상 북쪽 산을 배경으로 두는데(집이 남향이므로 카메라는 남에서 북을 본다),
//   마을 fog 는 부감용으로 near=R*2.2 까지 밀려 있어 그 배경 사면에 대기 원근이 하나도 걸리지 않는다.
//   결과가 처마선 위를 가득 메운 맨 사면이다 — 골든이 안개로 소실시켜 여백으로 읽히게 했던 자리.
//   수평 운해 링을 안으로 되돌리면 부감이 다시 탁해지므로(rIn 0.58 회귀), 아이레벨 전용인 이
//   직립 빌보드가 그 몫을 갖는다. 부감에서는 카메라 대면 평면이 거의 엣지온이라 기여가 미미하다.
export function computeRidgeMistAnchors(site) {
  const R = site.R, Hmax = site.Hmax;
  const C = site.center;
  const arc = [Math.PI * 1.12, Math.PI * 1.9]; // center 기준 북(-z) 중심 뒤쪽 호
  const rMax = R * 1.35;
  const anchors = [];
  const band = (targetH, count, spec) => {
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0.5;
      const th = arc[0] + (arc[1] - arc[0]) * t;
      const cxu = Math.cos(th), czu = Math.sin(th);
      // center 에서 밖으로 스캔 → 표고가 targetH 를 처음 넘는 반경(분지쪽 근사면).
      let hitR = null;
      for (let r = R * 0.35; r <= rMax; r += R * 0.02) {
        if (site.heightAt(C.x + cxu * r, C.z + czu * r) >= targetH) { hitR = r; break; }
      }
      if (hitR == null) continue;               // 이 방위에 뚜렷한 능선 없음(개활) → 생략
      const x = C.x + cxu * hitR, z = C.z + czu * hitR;
      const gy = site.heightAt(x, z);
      // 분지쪽으로 살짝 당겨(뱅크가 사면 앞에 걸리게) + 지형 위 소량 리프트.
      const pull = R * spec.pull;
      anchors.push({
        x: x - cxu * pull, y: gy + Hmax * spec.lift, z: z - czu * pull,
        w: R * spec.w, h: Hmax * spec.h, op: spec.op,
      });
    }
  };
  // 원경 밴드(능선 중턱) — #20 운무 절단: 중턱 높이·폭은 유지하되 약간 낮고 짙게 두어 봉우리가
  //   안개 위로 솟는 층을 강화. 키/개수를 크게 올리면 부감에서 산 사면에 회색 얼룩(A/B 실측:
  //   count 5 · h 0.74 는 능선 매스를 지웠다)이 되므로 소폭만.
  band(Hmax * 0.32, R > 150 ? 4 : 3, { pull: 0.05, lift: 0.07, w: 0.74, h: 0.58, op: 0.42 });
  // 중경 밴드(분지 안쪽 낮은 어깨) — 배경 사면과 마을 사이에 한 겹을 더 넣어 3단 원근을 만든다.
  //   낮고 옅게: 이 겹이 진해지면 근접 프레임이 통째로 흐려진다.
  band(Hmax * 0.15, R > 150 ? 3 : 2, { pull: 0.10, lift: 0.04, w: 0.54, h: 0.28, op: 0.22 });
  return anchors;
}

// ───────────────────────── 개울(명당수) ─────────────────────────
// env/water.js 의 injectWaterLook 을 재사용해 앱 물과 같은 하늘 반사·글린트 룩.
export function buildWaterRibbon(site, uniforms) {
  if (!site.stream) return null;
  const pts = site.stream.pts;
  const pos = [], uv = [], col = [], idx = [];
  const N = pts.length - 1;
  const lanes = site.stream.kind === 'river'
    ? [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
    : [-1, -0.52, 0, 0.52, 1];
  const tmpT = new THREE.Vector3();
  const deep = linCol(0x376f82);
  const bank = linCol(0x78928a);
  const tone = new THREE.Color();
  for (let i = 0; i <= N; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
    tmpT.set(b.x - a.x, 0, b.z - a.z).normalize();
    const nx = -tmpT.z, nz = tmpT.x;
    const hw = Number.isFinite(p.half) ? p.half : site.streamWaterHalf;
    const y = streamSurfaceHeightAt(site, p.x, p.z);
    for (const lane of lanes) {
      pos.push(p.x + nx * hw * lane, y, p.z + nz * hw * lane);
      uv.push((lane + 1) * 0.5, i / N * 10);
      tone.copy(deep).lerp(bank, smoothstep(0.28, 1, Math.abs(lane)) * 0.58);
      col.push(tone.r, tone.g, tone.b);
    }
  }
  const stride = lanes.length;
  for (let i = 0; i < N; i++) for (let lane = 0; lane < stride - 1; lane++) {
    const a = i * stride + lane, b = a + 1;
    const c = (i + 1) * stride + lane, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0,
    roughness: site.stream.kind === 'river' ? 0.5 : 0.38,
  });
  mat.onBeforeCompile = (shader) => injectWaterLook(shader, uniforms, {
    reflection: site.stream.kind === 'river' ? 0.42 : 0.58,
    ripple: site.stream.kind === 'river' ? 0.30 : 0.48,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'village-stream';
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  return mesh;
}

// ───────────────────────── 개울 물 시간대 톤 ─────────────────────────
// env/water.js 셰이더(injectWaterLook)는 uSky(프레넬 하늘반사)·uGlint(반짝임)를 additive
// emissive 로 더한다. 그런데 이 값들이 시간대 무연동이면 밤·석양의 어두운 씬에서도 낮 밝기로
// 남아 bloom(night threshold 0.32)에 흰 띠로 피어오른다(uiv-env-night·uiv-sunset-capital).
//   → 시간대별로 하향: 야간은 달빛 은은(어둠에 가라앉되 존재감), 석양은 시안 대신 금빛 은은.
//   env WATER_GLINT 계열 색을 참고하되, 마을 개울이 길고 부감에서 grazing(프레넬↑)이라 강도를
//   더 눌러 bloom 임계 아래로 유지한다. env/water.js 는 수정 금지 — 여기 uniform 만 갈아끼운다.
const V_WATER_GLINT = {
  dawn:   [0.44, 0.42, 0.36],
  day:    [0.85, 0.74, 0.48],   // 기존 낮 룩 유지(회귀 없음)
  sunset: [0.58, 0.38, 0.20],   // 금빛 윤슬(시안 아님) — 흰 blowout 은 uRough 로 잡고 emissive 는 금빛 유지
  // U2: slightly stronger cool moonlight ribbon under night aerial, still below bloom blowout.
  night:  [0.14, 0.18, 0.28],
};
const V_WATER_SKY = {
  dawn:   0x7a8496,
  day:    0xaecbe0,             // WATER_SKY(기존 낮 하늘반사) 유지
  sunset: 0x6e5643,             // 따뜻한 저채도 → 금빛 반사 은은(살짝 더 눌러 흰띠 방지)
  night:  0x28364c,             // 어두운 달빛 청 — slight lift so stream reads under moonlight
};
// 시간대별 거칠기 가산(env/water.js uRough, 0=기본). 야간·석양 부감에서 저각 광원(달빛·석양)이
// 저거칠기 수면에 뾰족한 스펙큘러 리본을 만들어 bloom 을 타므로, 그 시간대만 수면을 거칠게 해
// 하이라이트를 넓고 은은한 시트로 퍼뜨린다(peak↓ → bloom 임계 아래). 낮·새벽은 기존 하이라이트
// 유지(0). 마을 개울은 길고 부감 grazing 이라 이 완화가 특히 필요(단일 씬 env 물은 불변).
const V_WATER_ROUGH = {
  dawn:   0.0,
  day:    0.0,
  sunset: 0.30,                 // 금빛 윤슬은 남기되 흰 blowout 리본만 완화
  night:  0.45,                 // soft moonlight sheet (was 0.55 — keep weak specular readable)
};
export function setVillageWaterTime(waterU, name) {
  if (!waterU) return;
  const g = V_WATER_GLINT[name] || V_WATER_GLINT.day;
  waterU.uGlint.value.set(g[0], g[1], g[2]);
  const skyHex = (name in V_WATER_SKY) ? V_WATER_SKY[name] : V_WATER_SKY.day;
  waterU.uSky.value.setHex(skyHex, THREE.SRGBColorSpace);
  waterU.uRough.value = (name in V_WATER_ROUGH) ? V_WATER_ROUGH[name] : 0.0;
}
