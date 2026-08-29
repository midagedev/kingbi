import { smoothstep } from '../core/math/scalar.js';
import * as THREE from 'three';
import { makeWorldEdge } from './worldedge.js';
import { createValueNoise2D } from '../core/math/value-noise2.js';
import {
  CLOUD_SHADOW_FRAG_DECL, CLOUD_SHADOW_FRAG_BODY,
  CLOUD_SHADOW_VERT_DECL, CLOUD_SHADOW_VERT_BODY,
} from './clouds.js';


// sRGB hex → 선형 THREE.Color (vertexColors 속성은 선형값을 기대)
const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 엣지 처리 스타일별 강도(수묵 헤이즈 mix 계수). 지형 재질 fragment 에 컴파일타임 상수로 박힌다.
//   ink    : 외곽으로 갈수록 지형색을 대기(fog)색으로 크게 밀어 여백(하늘)으로 녹임(순수 수묵 소실).
//   mist   : 중간 헤이즈 + 저층 안개 링(별도 메시)이 능선 밑단을 감아 소실.
//   diorama: 헤이즈 최소 — 절단면(절벽 스커트) 지층이 엣지를 맡는다.
// mist 는 마을 지형 V_EDGE_HAZE_AMT(0.92) 와 같은 U1 목표 — 단일 씬 부감 절단면 동일 정책.
const EDGE_HAZE_AMT = { ink: 0.95, mist: 0.92, diorama: 0.22 };

// 지형: 건물 주변 평탄한 마당(박석) → 바깥으로 완만히 솟는 언덕(시드 노이즈).
//   + 남서(-x)로 파인 얕은 계곡(개울·다랑이 논의 토대).
//   + 비정형 월드 외곽선(worldedge) + 인상적 엣지 처리(edgeStyle) + 흐르는 구름 그림자(cloudUniforms).
// 반환 { group, heightAt(x,z), R, material, valley, edge, setSeason, update, setEdgeHaze } —
//   heightAt은 나무 배치가 표면에 앉도록 공유하고, valley 는 paddies/water 정렬용, edge 는
//   마을/필지가 같은 외곽선을 공유하도록 노출한다.
export function buildTerrain({
  seed = 424242, clearance = 18,
  cloudUniforms = null, edgeStyle = 'mist', getHaze = null,
} = {}) {
  const { fbm } = createValueNoise2D(seed, { signed: true });
  const R = 152;                     // 마당+언덕 반경(평균) — 유기적 외곽선의 기준 반경
  const flatEnd = clearance + 6;     // 여기까지 완전 평탄
  const maxRise = 13;                // 완만한 언덕 (능선이 뒤로 보이도록 낮게)
  const noiseAmp = 6;                // 언덕 굴곡

  // 비정형 외곽선: 씬 중심(건물=원점) 기준 반경 R 을 저주파 각도 노이즈로 변조.
  // 마을(site.js)도 같은 makeWorldEdge 로 외곽선을 공유한다(반경·중심 파라미터화).
  const edge = makeWorldEdge({ cx: 0, cz: 0, radius: R, seed: seed ^ 0x9e37, amp: 0.15, band: 0.30 });
  const tInner = 0.72;               // 이 안쪽(마당·계곡·논)은 world 좌표 고정, 바깥만 유기적으로 신축

  // ---------- 계곡 축 (남서 -x) ----------
  const valley = {
    xStart: -(flatEnd + 2),
    xEnd: -R * 0.78,
    tWide(x) { return smoothstep(this.xStart, this.xEnd, x); },
    centerZ(x) {
      return 11 * Math.sin((x + 18) * 0.021) + 5.5 * Math.sin((x - 46) * 0.052);
    },
    halfWidth(x) { return 9 + 20 * this.tWide(x); },
    floorY(x) { return -0.8 - 3.2 * smoothstep(-30, -72, x); },
    gate(x) { return smoothstep(-28, -44, x) * (1 - smoothstep(-108, -122, x)); },
    carve(x, z) {
      const g = this.gate(x);
      if (g <= 0.001) return 0;
      const hw = this.halfWidth(x);
      const d = Math.abs(z - this.centerZ(x));
      return g * smoothstep(hw, hw * 0.2, d);
    },
  };

  function heightAt(x, z) {
    const r = Math.hypot(x, z);
    if (r <= flatEnd) return 0;
    const ramp = smoothstep(flatEnd, R * 0.9, r);        // 0(마당)→1(가장자리)
    const back = 0.7 + 0.3 * smoothstep(-30, -110, z);   // -z쪽 언덕 강조
    const base = maxRise * ramp * back;
    const lump = fbm(x * 0.014, z * 0.014, 4) * noiseAmp * ramp;
    const fine = fbm(x * 0.05 + 10, z * 0.05 - 7, 3) * 1.6 * ramp;
    let h = Math.max(0, base + lump + fine);
    const carve = valley.carve(x, z);
    if (carve > 0) {
      const floor = valley.floorY(x);
      h = h * (1 - carve) + floor * carve;
      h -= carve * (fbm(x * 0.09, z * 0.13, 2) * 0.5 + 0.5) * 0.35;
    }
    return h;
  }

  // 방사형 그리드. 바깥 rings(t>tInner)를 유기적 외곽선까지 신축해 비정형 테두리를 만든다.
  // 예산: 88×128 이하.
  const NR = 88, NS = 128;
  const positions = [];
  const colors = [];
  const cCourt = linCol(0x7a7060);   // 박석/마당
  const cGrass = linCol(0x646d43);   // 마당 가장자리 풀
  const cForest = linCol(0x415428);  // 언덕 숲
  const cFar = linCol(0x66786b);     // 원경 옅은 대기 감쇠
  const cBank = linCol(0x6d6249);    // 계곡 바닥·물가
  const tmp = new THREE.Color();

  const meadowAt = (x, z, r) => {
    const grass = smoothstep(flatEnd - 2, flatEnd + 12, r);
    const forest = smoothstep(flatEnd + 12, 78, r);
    const m = grass * (1 - 0.72 * forest);
    return Math.max(0, m * (1 - valley.carve(x, z)));
  };

  // 그리드 반경 매핑: t<=tInner 는 균등(내부 고정), 바깥은 유기적 경계 Redge 까지 신축.
  const radiusAt = (t, th) => {
    if (t <= tInner) return t * R;
    const Redge = edge.edgeRadiusAt(th);
    return R * tInner + (t - tInner) / (1 - tInner) * (Redge - R * tInner);
  };
  const vy = (ir, is) => {
    const t = ir / NR;
    const th = (is / NS) * Math.PI * 2;
    const r = radiusAt(t, th);
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    return { x, y: heightAt(x, z), z, r };
  };
  const colorAt = (x, y, z, r) => {
    const gramp = smoothstep(flatEnd, flatEnd + 16, r);
    tmp.copy(cCourt).lerp(cGrass, gramp);
    const framp = smoothstep(flatEnd + 12, 78, r);
    tmp.lerp(cForest, framp);
    const far = smoothstep(105, R, r) * 0.35;
    tmp.lerp(cFar, far);
    const bank = valley.carve(x, z);
    if (bank > 0) tmp.lerp(cBank, bank * 0.7);
    const n = (fbm(x * 0.08, z * 0.08, 2) * 0.5 + 0.5);
    tmp.multiplyScalar(0.9 + 0.2 * n);
    return tmp;
  };

  const grid = [];
  for (let ir = 0; ir <= NR; ir++) {
    grid[ir] = [];
    for (let is = 0; is <= NS; is++) {
      const p = vy(ir, is === NS ? 0 : is);
      grid[ir][is] = p;
    }
  }
  const grounds = [];
  const meadows = [];
  const edges = [];                  // aEdge: 외곽 밴드 0(안)→1(경계선). 엣지 처리·구름 그림자 무관.
  const idx = [];
  let vcount = 0;
  const pushV = (p) => {
    positions.push(p.x, p.y, p.z);
    const c = colorAt(p.x, p.y, p.z, p.r);
    colors.push(c.r, c.g, c.b);
    grounds.push(smoothstep(flatEnd - 2, flatEnd + 12, p.r));
    meadows.push(meadowAt(p.x, p.z, p.r));
    edges.push(edge.edgeK(p.x, p.z));
    return vcount++;
  };
  const ringIdx = [];
  for (let ir = 0; ir <= NR; ir++) {
    ringIdx[ir] = [];
    for (let is = 0; is <= NS; is++) ringIdx[ir][is] = pushV(grid[ir][is]);
  }
  for (let ir = 0; ir < NR; ir++) {
    for (let is = 0; is < NS; is++) {
      const a = ringIdx[ir][is], b = ringIdx[ir][is + 1];
      const c = ringIdx[ir + 1][is], d = ringIdx[ir + 1][is + 1];
      idx.push(a, b, c, b, d, c);   // 상향 법선 (윗면이 정면)
    }
  }

  // ---------- 디오라마 절단면(부유섬) 스커트 ----------
  // edgeStyle==='diorama' 일 때만: 최외곽 링에서 지층(strata) 색 절벽을 아래로 떨어뜨린다.
  if (edgeStyle === 'diorama') {
    const skirtY = -34;
    const cStrataA = linCol(0x6b5e49), cStrataB = linCol(0x8a795c), cStrataC = linCol(0x574a38);
    const rimBase = [];
    for (let is = 0; is <= NS; is++) {
      const top = grid[NR][is];
      // 상단(림) 정점 복제(스커트 상단) + 하단 정점
      const topI = vcount;
      positions.push(top.x, top.y, top.z);
      colors.push(...cStrataB.toArray());
      grounds.push(0); meadows.push(0); edges.push(1);
      vcount++;
      const botI = vcount;
      positions.push(top.x, skirtY, top.z);
      colors.push(...cStrataC.toArray());
      grounds.push(0); meadows.push(0); edges.push(1);
      vcount++;
      rimBase.push({ topI, botI });
    }
    for (let is = 0; is < NS; is++) {
      const a = rimBase[is].topI, b = rimBase[is].botI;
      const c = rimBase[is + 1].topI, d = rimBase[is + 1].botI;
      idx.push(a, c, b, b, c, d);   // 바깥을 향하는 벽면
    }
    // 지층 띠: 중간 링을 하나 더 넣어 층을 나눈다.
    void cStrataA;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aGround', new THREE.Float32BufferAttribute(grounds, 1));
  geo.setAttribute('aMeadow', new THREE.Float32BufferAttribute(meadows, 1));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });

  // ---------- 셰이더 패치: 들판 금빛 + 흐르는 구름 그림자 + 엣지 소실 ----------
  // seasons.patchTerrain 보다 먼저 걸리므로(문자열 치환 순서상) 본 color 코드는 seasons 곱연산·
  // weather 적설 '뒤'에 삽입돼 최종 색을 만진다 → 구름 그림자·엣지 헤이즈가 계절·눈 위에 얹힌다.
  const uAutumnField = { value: 0 };
  const uEdgeHaze = { value: new THREE.Vector3(0.8, 0.8, 0.85) };  // 대기(fog)색 — update 가 매 프레임 갱신
  const hazeAmt = EDGE_HAZE_AMT[edgeStyle] ?? EDGE_HAZE_AMT.mist;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAutumnField = uAutumnField;
    shader.uniforms.uEdgeHaze = uEdgeHaze;
    const useCloud = !!cloudUniforms;
    if (useCloud) {
      shader.uniforms.uCloudTime = cloudUniforms.uCloudTime;
      shader.uniforms.uCloudStr = cloudUniforms.uCloudStr;
      shader.uniforms.uCloudBlobs = cloudUniforms.uCloudBlobs;   // 빌보드 대응 그림자 블롭(#68)
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\nattribute float aMeadow;\nvarying float vMeadow;\nattribute float aEdge;\nvarying float vEdge;\n${useCloud ? CLOUD_SHADOW_VERT_DECL : ''}`)
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>\nvMeadow = aMeadow;\nvEdge = aEdge;\n${useCloud ? CLOUD_SHADOW_VERT_BODY : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nuniform float uAutumnField;\nvarying float vMeadow;\nuniform vec3 uEdgeHaze;\nvarying float vEdge;\n${useCloud ? CLOUD_SHADOW_FRAG_DECL : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // 가을 들판 금빛(aMeadow 마스크). 명도는 지형 결로, 채도는 고정 금빛 색조로.
          float baseL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          vec3 fieldGold = vec3(0.52, 0.42, 0.155) * (0.72 + 0.85 * baseL);
          diffuseColor.rgb = mix(diffuseColor.rgb, fieldGold, clamp(uAutumnField, 0.0, 1.0) * vMeadow);
        }
        ${useCloud ? CLOUD_SHADOW_FRAG_BODY : ''}
        {
          // 엣지 소실: 외곽 밴드(vEdge)에서 지형색을 대기(fog)색으로 밀어 여백으로 녹임.
          // #211: 마을 지형과 동일 램프 — 부감 절단면 하드 실루엣 완화.
          float e = smoothstep(0.04, 0.88, vEdge);
          diffuseColor.rgb = mix(diffuseColor.rgb, uEdgeHaze, ${hazeAmt.toFixed(3)} * e);
        }`);
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  const group = new THREE.Group();
  group.name = 'terrain';
  group.add(mesh);

  // ---------- 저층 안개 링 (edgeStyle==='mist') ----------
  // 유기적 외곽선을 따라 도는 넓고 낮은 소프트 밴드 — 능선 밑단을 감아 지형이 안개에 잠겨 소실.
  let mistRing = null;
  if (edgeStyle === 'mist') {
    mistRing = buildEdgeMist(edge, R);
    group.add(mistRing.mesh);
  }

  // 계절 상태(자체 보간): autumn 만 금빛.
  let goldGoal = 0;
  const RATE = 2.6;
  function setSeason(name, opts = {}) {
    goldGoal = name === 'autumn' ? 1 : 0;
    if (opts.immediate) uAutumnField.value = goldGoal;
  }
  // 엣지 헤이즈 색을 대기(fog)색과 동기화. index.js 가 getHaze(()=>scene.fog.color)를 넘기면
  // 시간대·#50 크로스페이드 중에도 매 프레임 따라간다. (Vector3.copy(Color)=NaN 함정 → 채널 직접 대입)
  function setEdgeHaze(c) { if (c) uEdgeHaze.value.set(c.r, c.g, c.b); }
  function update(dt) {
    uAutumnField.value += (goldGoal - uAutumnField.value) * Math.min(1, dt * RATE);
    if (getHaze) setEdgeHaze(getHaze());
    if (mistRing) mistRing.update(getHaze ? getHaze() : null);
  }

  return { group, heightAt, R, material: mat, valley, edge, setSeason, update, setEdgeHaze };
}

// 유기적 외곽선을 따라 도는 저층 안개 밴드(수평 애뉼러스). 반경 방향 알파 그라디언트로
// 안쪽·바깥 투명, 가운데 불투명 — 능선 밑단이 안개에 잠긴 듯. 색은 대기색을 살짝 밝힌 톤.
function buildEdgeMist(edge, R) {
  const NS = 128;
  const pos = [], uv = [], idx = [];
  const yMid = 7.5;
  for (let is = 0; is <= NS; is++) {
    const th = (is / NS) * Math.PI * 2;
    const Redge = edge.edgeRadiusAt(th);
    const cx = Math.cos(th), cz = Math.sin(th);
    // 3줄(안·중·밖) — 중앙이 불투명
    const rIn = Redge * 0.80, rMid = Redge * 0.99, rOut = Redge * 1.14;
    pos.push(cx * rIn, yMid + 2.0, cz * rIn); uv.push(is / NS, 0);
    pos.push(cx * rMid, yMid, cz * rMid); uv.push(is / NS, 0.5);
    pos.push(cx * rOut, yMid - 1.5, cz * rOut); uv.push(is / NS, 1);
  }
  for (let is = 0; is < NS; is++) {
    const a = is * 3, b = is * 3 + 3;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // 가로(반경) 알파 그라디언트 텍스처: 가운데 불투명.
  const c = document.createElement('canvas');
  c.width = 8; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 8, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.56, depthWrite: false,
    side: THREE.DoubleSide, fog: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'edge-mist';
  mesh.renderOrder = 2;

  const _c = new THREE.Color();
  const _white = new THREE.Color(0xffffff);
  function update(fogColor) {
    // 안개색: 대기색을 아주 살짝만 밝혀 원경 여백처럼(과한 유백색 방지). 없으면 기본 유지.
    if (fogColor) { _c.copy(fogColor).lerp(_white, 0.11); mat.color.copy(_c); }
  }
  return { mesh, update };
}
