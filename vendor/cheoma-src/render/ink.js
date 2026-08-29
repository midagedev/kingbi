// 수묵화(먹) NPR 렌더 파이프라인.
//
// 기준: 정선 「인왕제색도」의 적묵 농담 + 안개 여백, 「금강전도」의 필선 성격.
// 그레이 필터가 아니라 수묵화 "문법"을 목표로 한다:
//   1. 먹선  — 깊이 불연속(실루엣) 굵은 선 + 노멀 불연속(내부 윤곽) 가는 선.
//   2. 농담  — 휘도 4~5단계 양자화 워시, 채도 거의 제거, 단계 사이 디더로 번짐.
//   3. 한지  — 절차 생성 종이 텍스처(미색 + 섬유 노이즈 + 비네팅).
//   4. 여백  — 밝은 영역·원경은 종이색으로 수렴(안개=여백).
//   5. 계화  — 건축은 자로 긋고 자연은 붓으로 쓴다(아래 「이중 필법」).
//   6. 조명  — 역광면 실루엣은 굵고 순광면은 얇다(태양 방향 1개 uniform).
//
// 이중 필법(界畫 / 남종화법)에 대하여:
// 「동궐도」는 한 화면에서 건축·담장을 자로 그은 직선 선묘로, 배경 산수를 남종화법의
// 부드러운 필치로 그린다(docs/oriental-painting-research.md §7.1). 이 pass 는 스크린
// 스페이스라 per-object role 을 읽을 수 없으므로 — 그리고 role 채널은 프로그램 축을
// 하나 더 부르므로 — 이미 있는 노멀 버퍼에서 그 구분을 근사한다. 판별식은
// "이 화소를 지나는 화면 방향 중 노멀이 붙어 있는 축이 하나라도 있는가"다.
// 목조 건축의 벽·지붕면·담장·기둥·기단은 전부 평면 또는 선직면(ruled surface)이므로
// 자재를 따라가는 축 하나에서 노멀이 정지한다 — 그 축이 곧 화원이 자를 대는 방향이다.
// 수관·암괴·초가 이엉은 어느 축으로도 노멀이 붙지 않아 붓질 쪽에 남는다.
//
// 사용:  const ink = setupInk(renderer, scene, camera);  ink.composer.render();
//        리사이즈 시 ink.setSize(w, h). 노이즈 시드 고정 → 스크린샷 결정론.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { contributesDofDepth } from '../env/dof.js';
import { INST_FADE_PROGRAM_VERSION, patchInstFadeShader } from '../env/inst-fade-shader.js';
import {
  hasLodScreenDoor,
  LOD_SCREEN_DOOR_PROGRAM_VERSION,
  patchLodScreenDoorMaterial,
} from './lod-screen-door.js';

// 팔레트 (sRGB). 순흑이 아닌 짙은 먹색과 따뜻한 미색 한지.
export const INK_PALETTE = {
  ink: 0x1f1b18,       // 짙은 먹색 (먹선·최농)
  paper: 0xe9e2d2,     // 한지 미색 (여백·최담)
};

// ---------- 절차 한지 텍스처 ----------
// 고정 시드 RNG(mulberry32)로 미색 바탕 + 섬유 결 + 얼룩을 그린다.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makePaperTexture(size = 1024, seed = 20260716) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(seed);

  // 미색 바탕: 미세한 톤 차의 큰 얼룩 (수제 종이의 불균질). 은은하게.
  ctx.fillStyle = '#e9e2d2';
  ctx.fillRect(0, 0, size, size);
  const blotches = 90;
  for (let i = 0; i < blotches; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = size * (0.05 + rnd() * 0.18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() > 0.5;
    const a = 0.008 + rnd() * 0.014;
    g.addColorStop(0, warm ? `rgba(120,100,70,${a})` : `rgba(210,214,205,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // 섬유 결: 아주 얕은 알파의 짧은 획을 대각으로 뿌린다.
  const fibers = Math.floor(size * 9);
  for (let i = 0; i < fibers; i++) {
    const x = rnd() * size, y = rnd() * size;
    const ang = (rnd() - 0.5) * 0.5 + (rnd() > 0.5 ? 0 : Math.PI / 2);
    const len = 4 + rnd() * 26;
    const dark = rnd() > 0.5;
    ctx.strokeStyle = dark
      ? `rgba(90,82,66,${0.02 + rnd() * 0.04})`
      : `rgba(255,252,244,${0.03 + rnd() * 0.05})`;
    ctx.lineWidth = rnd() < 0.85 ? 1 : 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  // 고운 반점(입자).
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // 화면 전면 매핑, 이음선 없음
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------- 먹 합성 셰이더 ----------
const InkShader = {
  uniforms: {
    tDiffuse: { value: null },   // 뷰티(조명 결과, 선형)
    tBeauty: { value: null },    // RenderPass 직후의 안정된 선형 HDR 농담 원본
    tNormal: { value: null },    // 뷰공간 노멀(0.5 인코딩)
    tDepth: { value: null },     // 깊이(비선형 [0,1])
    tPaper: { value: null },     // 한지 텍스처
    resolution: { value: new THREE.Vector2() },
    // Device pixel ratio for the buffer behind `resolution`. Brush/dither fbm is
    // authored in CSS px; without this, retina (dpr=2) doubles fbm periods across
    // the same screen and the grain goes chalky. Edge sampling still uses `resolution`.
    pixelRatio: { value: 1.0 },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 500 },
    inkColor: { value: new THREE.Color(INK_PALETTE.ink) },
    paperColor: { value: new THREE.Color(INK_PALETTE.paper) },
    levels: { value: 5.0 },        // 농담 단계
    silhouetteWidth: { value: 2.6 }, // 실루엣 먹선 두께(px)
    silhouetteBoost: { value: 1.0 },
    normalEdge: { value: 0.24 },   // 내부 윤곽선은 처마/기둥 암시만 — 저폴리 수목 면선 억제
    depthEdge: { value: 0.78 },    // 실루엣도 벡터 외곽선보다 붓 농담에 종속
    // 농담 입력은 선형 HDR 뷰티를 Reinhard key 로 접은 뒤 [washLow, washHigh] 로
    // 5단을 주소지정한다. 고정 sRGB 구간은 앱 day focus 에서 band3≈60% 중회 평탄
    // (연필 스케치)을 만들었다. key + unlitWash 가 day 소핏 농묵·여백을 복원한다.
    washKey: { value: 0.16 },      // Reinhard key (linear lum); 작을수록 여백 쪽
    washLow: { value: 0.02 },      // keyed 하한 — 이 아래는 적묵(최농)
    washHigh: { value: 0.62 },     // keyed 상한 — 이 위는 여백(최담)
    unlitWash: { value: 0.36 },    // 역광·그늘 면의 소핏 농묵 하한 (0=항등)
    gyehwa: { value: 1.0 },        // 이중 필법 강도(0=단일 필법으로 회귀)
    gyehwaRadius: { value: 12.0 }, // 평판 판별 반경(화면 px). 크면 근경 건축만 남는다
    normalScale: { value: 0.75 },  // 노멀/깊이 타깃 축소율 — 반경을 화면 px 로 고정한다
    gyehwaPlateLo: { value: 0.998 },  // 평판 판정 하한(dot) — 이 아래는 산수 붓질
    gyehwaPlateHi: { value: 0.9995 }, // 평판 판정 상한(dot) — 이 위는 완전한 계화
    gyehwaCrease: { value: 2.35 }, // 건축 내부 먹선(기와 골·처마·공포) 배율
    sansuCrease: { value: 0.74 },  // 자연 내부선 감쇠 — 저폴리 면선을 톤 덩어리로
    sunViewDir: { value: new THREE.Vector3(0, 0, 1) }, // 뷰공간 표면→태양
    sunLight: { value: 0.0 },      // 태양 방향 유효(1) / 씬에 태양 없음(0)
    litWidth: { value: 0.80 },     // 순광면 선 굵기 배율
    unlitWidth: { value: 1.36 },   // 역광면 선 굵기 배율
    ditherAmt: { value: 0.55 },    // 단계 사이 디더(번짐)
    chromaKeep: { value: 0.07 },   // 잔여 채도 (5~10%)
    fogNear: { value: 38.0 },      // 여백 페이드 시작 (월드 거리, 씬 fog와 동기화)
    fogFar: { value: 150.0 },      // 여백 페이드 끝 (월드 거리)
    aerial: { value: 1.0 },        // 원경 여백 수렴 강도
    seed: { value: 11.0 },         // 고정 노이즈 시드
    mixAmount: { value: 1.0 },     // 제품 PBR↔수묵 크로스페이드
    acesOutput: { value: 0.0 },    // OutputPass ACES 앞에서 목표 한지색 역보정
    toneMappingExposure: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse, tBeauty, tNormal, tDepth, tPaper;
    uniform vec2 resolution;
    uniform float pixelRatio;
    uniform float cameraNear, cameraFar;
    uniform vec3 inkColor, paperColor;
    uniform float levels, silhouetteWidth, silhouetteBoost, normalEdge, depthEdge;
    uniform float ditherAmt, chromaKeep, fogNear, fogFar, aerial, seed;
    uniform float mixAmount, acesOutput, toneMappingExposure;
    uniform float washKey, washLow, washHigh, unlitWash;
    uniform float gyehwa, gyehwaRadius, gyehwaCrease, sansuCrease;
    uniform float gyehwaPlateLo, gyehwaPlateHi, normalScale;
    uniform vec3 sunViewDir;
    uniform float sunLight, litWidth, unlitWidth;

    // 값 노이즈 (해시 기반, 스크린 좌표의 결정론적 함수 → 시드 고정).
    float hash(vec2 p){
      p = fract(p * vec2(123.34, 345.45) + seed);
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm(vec2 p){
      float s = 0.0, a = 0.5;
      for(int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; }
      return s;
    }

    // 원근 깊이 → 월드 선형 깊이(양수 거리).
    float worldDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x;
      float ndc = z * 2.0 - 1.0;
      return (2.0 * cameraNear * cameraFar) /
             (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
    }
    // Sobel용 정규 깊이 [0,1] (임계 튜닝 안정화).
    float linDepth(vec2 uv){
      return clamp((worldDepth(uv) - cameraNear) / (cameraFar - cameraNear), 0.0, 1.0);
    }

    // 계화 판별용 노멀 조회와 축 검사. 한 축의 양쪽 모두에서 노멀이 붙어 있어야
    // "자를 댈 수 있는 평판"이다 — 한쪽만 보면 작은 패싯 하나에 속아 수관이 건축이 된다.
    vec3 nAt(vec2 uv){ return texture2D(tNormal, uv).rgb * 2.0 - 1.0; }
    float plateAxis(vec3 nc, vec2 uv, vec2 d){
      return min(dot(nc, nAt(uv + d)), dot(nc, nAt(uv - d)));
    }

    // 앱의 OutputPass는 ACES+sRGB를 정확히 한 번, 마지막에 적용한다. 수묵 결과도
    // 같은 선형-HDR 체인 안에서 섞기 위해 목표 display-linear 한지색을 ACES 이전 값으로
    // 되돌린다. standalone NoToneMapping 경로는 이 함수를 건너뛴다.
    vec3 inverseRRTAndODTFit(vec3 y){
      vec3 A = y * 0.983729 - 1.0;
      vec3 B = y * 0.4329510 - 0.0245786;
      vec3 C = y * 0.238081 + 0.000090537;
      vec3 disc = max(B * B - 4.0 * A * C, vec3(0.0));
      return max((-B - sqrt(disc)) / (2.0 * A), vec3(0.0));
    }
    vec3 beforeOutputToneMapping(vec3 target){
      if (acesOutput < 0.5) return target;
      const mat3 invACESOutputMat = mat3(
        vec3(0.64303825, 0.05926869, 0.00596190),
        vec3(0.31118675, 0.93143649, 0.06392902),
        vec3(0.04577546, 0.00929492, 0.93011838)
      );
      const mat3 invACESInputMat = mat3(
        vec3( 1.76474097, -0.14702785, -0.03633683),
        vec3(-0.67577768,  1.16025151, -0.16243644),
        vec3(-0.08896329, -0.01322366,  1.19877327)
      );
      vec3 fitted = max(invACESOutputMat * clamp(target, 0.0, 0.995), vec3(0.0));
      vec3 aces = inverseRRTAndODTFit(fitted);
      return max(invACESInputMat * aces * (0.6 / max(toneMappingExposure, 1e-4)), vec3(0.0));
    }

    void main(){
      vec2 px = 1.0 / resolution;
      float dc = linDepth(vUv);
      float wz = worldDepth(vUv);          // 월드 거리 (씬 안개와 같은 단위)
      bool sky = wz > cameraFar * 0.9;

      // 붓 흔들림: 선 굵기·농도·경로를 미세 변주 (필선 느낌).
      // CSS-px frequency: resolution is device-buffer size (css × dpr × normalScale),
      // so divide by pixelRatio. dpr=1 keeps the authored grain; dpr=2 no longer doubles it.
      vec2 brushPx = vUv * resolution.xy / max(pixelRatio, 1e-4);
      float brush = fbm(brushPx * 0.06);
      float brushFine = fbm(brushPx * 0.25 + 7.0);

      // ---- 노멀 버퍼 (내부 윤곽 + 계화 판별의 공용 입력) ----
      vec3 n0 = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
      vec3 nl = nAt(vUv + vec2(-px.x, 0.0));
      vec3 nr = nAt(vUv + vec2( px.x, 0.0));
      vec3 nu = nAt(vUv + vec2(0.0,  px.y));
      vec3 nd = nAt(vUv + vec2(0.0, -px.y));
      float ne = (1.0 - max(dot(n0, nl), 0.0)) + (1.0 - max(dot(n0, nr), 0.0))
               + (1.0 - max(dot(n0, nu), 0.0)) + (1.0 - max(dot(n0, nd), 0.0));

      // ---- 계화(界畫) 판별: 건축은 자로, 자연은 붓으로 ----
      // (1) ruled — 반경 gyehwaRadius 의 여덟 화면 축(22.5° 간격) 중 하나에서 양쪽 노멀이
      //     정지하면 큰 평판/선직면이다. 벽·지붕면·담장·기둥·기단이 여기 걸리고,
      //     수관·암괴·이엉은 어느 축에서도 노멀이 회전해 걸리지 않는다. 반경이 화면 px 라
      //     원경 건축은 자연히 탈락한다 — 근경 선묘/원경 붓질이라는 문법과 같은 방향이다.
      //     축을 45° 간격 4개로 줄이면 비스듬히 흐르는 기와 골·처마선이 축과 최대 22.5°
      //     어긋나 판정이 끊기고 먹선이 점선이 된다. 8축은 그 어긋남을 절반으로 줄인다.
      // (2) hard — 자가 만드는 모서리는 각지다. 지형·수관의 완만한 패싯 경계(수 도)는
      //     제외해 저폴리 면분할이 펜선으로 드러나지 않게 한다(ink-landscape 원칙 3).
      // 반경은 화면 px 다. 노멀 타깃이 축소돼 있으므로 그 비율을 곱해 되돌린다 —
      // 그러지 않으면 0.5 배 타깃(모바일)에서 판별 반경이 화면상 두 배가 되어
      // 같은 프레임에서 계화가 더 적게 걸린다.
      vec2 ar = px * gyehwaRadius * normalScale;
      float plate = plateAxis(n0, vUv, vec2(ar.x, 0.0));
      plate = max(plate, plateAxis(n0, vUv, vec2(ar.x *  0.9239, ar.y * 0.3827)));
      plate = max(plate, plateAxis(n0, vUv, vec2(ar.x *  0.7071, ar.y * 0.7071)));
      plate = max(plate, plateAxis(n0, vUv, vec2(ar.x *  0.3827, ar.y * 0.9239)));
      plate = max(plate, plateAxis(n0, vUv, vec2(0.0, ar.y)));
      plate = max(plate, plateAxis(n0, vUv, vec2(ar.x * -0.3827, ar.y * 0.9239)));
      plate = max(plate, plateAxis(n0, vUv, vec2(ar.x * -0.7071, ar.y * 0.7071)));
      plate = max(plate, plateAxis(n0, vUv, vec2(ar.x * -0.9239, ar.y * 0.3827)));
      float ruled = smoothstep(gyehwaPlateLo, gyehwaPlateHi, plate);
      float dmin = min(min(dot(n0, nl), dot(n0, nr)), min(dot(n0, nu), dot(n0, nd)));
      float hard = 1.0 - smoothstep(0.01, 0.55, dmin);
      // (3) nearSide — 불연속의 가까운 쪽만 자를 댄다. 이 게이트가 없으면 수관 실루엣
      //     뒤의 평탄한 지형 화소가 "평판 + 각진 모서리"를 동시에 만족해 계화로 오인된다
      //     (나무 테두리에 철사선이 도는 경로). 건축은 자기 실루엣의 가까운 쪽이므로 무해.
      float wNear = min(min(worldDepth(vUv + vec2(-px.x, 0.0)), worldDepth(vUv + vec2(px.x, 0.0))),
                        min(worldDepth(vUv + vec2(0.0, px.y)), worldDepth(vUv + vec2(0.0, -px.y))));
      float nearSide = 1.0 - smoothstep(0.05, 0.6, wz - wNear);
      float archi = gyehwa * ruled * hard * nearSide * (sky ? 0.0 : 1.0);

      // ---- 조명 종속 선 굵기 (§6, TCD lit/unlit outline) ----
      // 역광이 이 앱의 기본 프레이밍이므로 그 역광을 선으로 번역한다: 해를 등진 면은
      // 굵고 짙게, 해를 받는 면은 얇게. 태양이 없는 씬에서는 sunLight=0 으로 항등이다.
      float lambert = max(dot(normalize(n0), sunViewDir), 0.0);
      float lightGate = sunLight * (sky ? 0.0 : 1.0);
      float lightW = mix(1.0, mix(unlitWidth, litWidth, lambert), lightGate);
      // 농도는 굵기와 같은 두 knob 에서 파생한다 — litWidth=unlitWidth=1 이면 이 항 전체가
      // 항등이 되어 조명 종속을 한 쌍의 uniform 으로 완전히 끌 수 있다(격리 검증 경로).
      float lightInk = mix(1.0, mix(1.0 + (unlitWidth - 1.0) * 0.4,
                                    1.0 - (1.0 - litWidth) * 0.5, lambert), lightGate);

      // ---- 실루엣 먹선 (깊이 불연속, 굵은 선) ----
      // 붓 노이즈로 두께를 흔든 오프셋으로 3x3 깊이 소벨.
      // 계화 대상은 그 흔들림을 걷어 자로 그은 직선에 가깝게 만든다.
      float w = silhouetteWidth * mix(0.7 + 0.7 * brush, 1.0, archi * 0.85) * lightW;
      vec2 o = px * w;
      float d0 = dc;
      float dl = linDepth(vUv + vec2(-o.x, 0.0));
      float dr = linDepth(vUv + vec2( o.x, 0.0));
      float du = linDepth(vUv + vec2(0.0,  o.y));
      float dd = linDepth(vUv + vec2(0.0, -o.y));
      float ddg = linDepth(vUv + o) + linDepth(vUv - o)
                + linDepth(vUv + vec2(o.x, -o.y)) + linDepth(vUv + vec2(-o.x, o.y));
      float depthDiff = abs(dl - d0) + abs(dr - d0) + abs(du - d0) + abs(dd - d0)
                      + 0.5 * abs(ddg - 4.0 * d0);
      // 근경일수록 임계 낮춰 확실히 잡고, 원경은 완만히.
      float thr = 0.0016 + dc * 0.02;
      float sil = smoothstep(thr, thr * 4.0, depthDiff) * depthEdge * silhouetteBoost;
      // 실루엣은 산수(능선)도 함께 쓰는 채널이라 계화 가중을 절제한다 — 굵기 흔들림만
      // 걷고 농도는 소폭. 능선 실루엣이 자로 그은 선이 되면 남종화법이 깨진다.
      sil *= mix(1.0, 1.16, archi) * lightInk;

      // ---- 내부 윤곽선 (노멀 불연속, 가는 선) ----
      // 이 채널이 이중 필법의 본체다: 건축의 처마·공포·기와 골·담장 상단은 짙은 선묘로,
      // 자연의 저폴리 면선은 더 거두어 톤 덩어리로 남긴다.
      float crease = smoothstep(0.28, 0.7, ne) * normalEdge
                   * mix(sansuCrease, gyehwaCrease, archi);
      if (sky) crease = 0.0;               // 하늘엔 윤곽선 없음

      // 원경 먹선은 안개(여백)로 사라진다 → 바닥이 시선에 스치는 지평선·원반
      // 가장자리의 가짜 실루엣 선을 제거하고, 근경 처마·지붕 선만 또렷이 남긴다.
      // (씬 안개와 같은 월드 거리로 페이드해 좌표계 불일치 아티팩트 방지)
      float far = smoothstep(fogNear, fogFar, wz);
      sil *= (1.0 - far);
      // 원경의 수많은 저폴리 수관·기와를 철사처럼 모두 따지 않는다. 진경산수의 원경은
      // 개별 폴리곤선보다 수평 점묘/먹 덩어리로 읽혀야 하므로 내부 윤곽을 먼저 거둔다.
      float detailFar = smoothstep(70.0, 230.0, wz);
      crease *= (1.0 - far) * (1.0 - dc * 0.3) * (1.0 - detailFar);
      sil *= mix(1.0, 0.42, detailFar);

      // 붓 농도 변주 + 미세 끊김 → 순수한 벡터선이 아닌 필선.
      // 계화 선은 그 변주 폭을 좁혀 균일한 농도로(자·붓의 차이가 여기서 보인다).
      float inkAmt = max(sil, crease);
      inkAmt *= mix(0.55 + 0.7 * brushFine, 0.94 + 0.12 * brushFine, archi);
      inkAmt *= smoothstep(0.02, 0.16, inkAmt + brush * 0.05); // 얇은 끝 자연 소멸
      inkAmt = clamp(inkAmt, 0.0, mix(0.92, 0.97, archi));

      // ---- 농담 워시 (휘도 양자화) ----
      vec3 lin = texture2D(tDiffuse, vUv).rgb;
      // PBR fullscreen pass가 sleep해도 농담 원본은 RenderPass 직후 texture로 고정된다.
      // mixAmount=1에서 tDiffuse는 최종 수묵색에 관여하지 않아 sleep 경계의 색/농담 pop이 없다.
      vec3 beautyLin = texture2D(tBeauty, vUv).rgb;
      // 잔여 채도는 display-referred 추정에서만 뽑는다(워시 본체와 분리).
      vec3 srgb = pow(max(beautyLin, 0.0), vec3(1.0 / 2.2));
      float srgbLum = dot(srgb, vec3(0.299, 0.587, 0.114));
      vec3 chroma = srgb - srgbLum;

      // 선형 HDR 휘도 → Reinhard key (ink-landscape 원칙 8, #225).
      float linLum = max(dot(max(beautyLin, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)), 0.0);
      float keyed = linLum / (linLum + max(washKey, 1e-3));

      // 소핏·그늘 농묵 하한. 제품 hemi/fill 이 처마 밑 beauty 를 들어 올려 순수 휘도만
      // 으로는 적묵에 닿지 않는다. 선 굵기와 같은 sun gate 의 역광 면을 keyed 아래로
      // 끌어 골든 컷의 "처마 밑 먹 덩어리"를 복원한다. unlitWash=0 이면 항등.
      float unlit = (1.0 - lambert) * lightGate * (sky ? 0.0 : 1.0);
      keyed = max(keyed * (1.0 - unlitWash * unlit) - unlitWash * 0.08 * unlit, 0.0);

      // 양자화 + 저주파 디더: 밴드 경계를 유기적으로 흔들어 먹 번짐/평붓 자국을 낸다.
      // (고주파가 아니라 큰 얼룩 → 픽셀 노이즈가 아닌 물감 고임 느낌)
      float dth = (fbm(brushPx * 0.014 + 3.0) - 0.5) * ditherAmt;
      float washT = clamp((keyed - washLow) / max(washHigh - washLow, 1e-3), 0.0, 1.0);
      float lv = washT * levels;
      float fl = floor(lv);
      float fr = fract(lv);
      float e = smoothstep(0.5 - 0.30, 0.5 + 0.30, fr + dth); // 부드러운 밴드 전이
      float band = (fl + e) / levels;
      // 톤 곡선: 중회 평탄을 피하고 상단을 여백으로 연다. (pow 0.9 는 day 연필 스케치.)
      float tone = clamp(band, 0.0, 1.0);
      tone = clamp((tone - 0.42) * 1.28 + 0.42, 0.0, 1.0);
      tone = smoothstep(0.02, 0.97, tone);

      // 워시 = 먹색↔종이색 사이 톤 + 잔여 채도.
      vec3 wash = mix(inkColor, paperColor, tone);
      wash += chroma * chromaKeep * (0.4 + tone);

      // ---- 한지 바탕 ----
      // 화면 전면 매핑(이음선 없음). 결은 밝은(여백) 영역에서 더 드러나고
      // 먹이 짙게 덮인 곳에선 잦아든다 — 실제 종이 위 먹처럼.
      vec3 paperTex = texture2D(tPaper, vUv).rgb;
      float grain = dot(paperTex, vec3(0.333)) / max(dot(paperColor, vec3(0.333)), 1e-3);
      grain = mix(1.0, grain, mix(0.15, 0.55, tone));

      vec3 col = wash * grain;

      // 하늘·여백은 순수 종이.
      col = mix(col, paperColor * grain, sky ? 1.0 : 0.0);

      // 먹선 합성 (종이 결이 배어나오도록 살짝 남김).
      col = mix(col, inkColor * mix(1.0, grain, 0.5), inkAmt);

      // ---- 안개 = 여백 (거리 기반 종이색 수렴) ----
      float aer = smoothstep(fogNear, fogFar, wz) * aerial;
      col = mix(col, paperColor * grain, aer);

      // 비네팅: 가장자리를 살짝 눌러 종이 가장자리 느낌.
      vec2 q = vUv - 0.5;
      float vig = 1.0 - dot(q, q) * 0.5;
      vig = mix(1.0, vig, 0.5);
      col *= vig;

      // 종이 최고 밝기 제한 없이 미색 유지.
      col = clamp(col, 0.0, 1.0);

      // source와 수묵 모두 선형-HDR로 유지하고 OutputPass가 톤매핑·sRGB를 한 번만 맡는다.
      // mix=0은 비트맵을 건드리지 않는 항등이라 전환 시작/종료에 색상 팝이 없다.
      gl_FragColor = vec4(mix(lin, beforeOutputToneMapping(col), mixAmount), 1.0);
    }
  `,
};

const BeautyCopyShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
  `,
};

// RenderPass 직후의 raw linear-HDR beauty를 보존한다. 이후 grade/bloom/DoF/flare가
// composer ping-pong target을 바꿔도 InkPass의 농담 입력은 이 texture 하나로 안정된다.
export class InkBeautyCapturePass extends Pass {
  constructor({ resolutionScale = 0.75 } = {}) {
    super();
    this.needsSwap = false;
    this.resolutionScale = Math.min(1, Math.max(0.35, resolutionScale));
    this.captureCount = 0;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BeautyCopyShader.uniforms),
      vertexShader: BeautyCopyShader.vertexShader,
      fragmentShader: BeautyCopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.target.setSize(
      Math.max(1, Math.round(width * this.resolutionScale)),
      Math.max(1, Math.round(height * this.resolutionScale)),
    );
  }

  render(renderer, writeBuffer, readBuffer) {
    this.captureCount++;
    const previous = renderer.getRenderTarget();
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.target);
    this.fsQuad.render(renderer);
    renderer.setRenderTarget(previous);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

// 안정된 raw beauty + 노멀/깊이를 함께 처리하는 커스텀 Pass.
// InkBeautyCapturePass가 농담 원본을 보존하고, 이 Pass가 노멀·깊이와 최종 합성을 맡는다.
export class InkPass extends Pass {
  constructor(scene, camera, paperTexture, { resolutionScale = 0.75, beautyTexture = null } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;

    this.normalMaterial = new THREE.MeshNormalMaterial();
    this.instFadeNormalMaterial = new THREE.MeshNormalMaterial();
    this.instFadeNormalMaterial.allowOverride = false;
    this.instFadeNormalMaterial.onBeforeCompile = (shader) => {
      patchInstFadeShader(shader);
      // MeshNormalMaterial's fragment shader is the one stock material without
      // <common>; provide the varying declaration after its NORMAL define.
      if (!shader.fragmentShader.includes('varying float vInstFade;')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#define NORMAL',
          '#define NORMAL\nvarying float vInstFade;',
        );
      }
    };
    this.instFadeNormalMaterial.customProgramCacheKey = () => `cheoma-ink-normal|${INST_FADE_PROGRAM_VERSION}`;
    this.lodScreenDoorNormalMaterial = new THREE.MeshNormalMaterial();
    this.lodScreenDoorNormalMaterial.allowOverride = false;
    patchLodScreenDoorMaterial(this.lodScreenDoorNormalMaterial);
    const lodCompile = this.lodScreenDoorNormalMaterial.onBeforeCompile;
    this.lodScreenDoorNormalMaterial.onBeforeCompile = function onBeforeCompile(shader, renderer) {
      lodCompile.call(this, shader, renderer);
      // MeshNormalMaterial's fragment shader has no <common> chunk.
      if (!shader.fragmentShader.includes('varying float vLodScreenDoor;')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#define NORMAL',
          '#define NORMAL\nvarying float vLodScreenDoor;',
        );
      }
    };
    this.lodScreenDoorNormalMaterial.customProgramCacheKey = () =>
      `cheoma-ink-normal|${LOD_SCREEN_DOOR_PROGRAM_VERSION}`;
    this.resolutionScale = Math.min(1, Math.max(0.35, resolutionScale));
    // Sticky: EffectComposer.setSize only passes device width/height, so keep the last
    // explicit dpr from createInkPass/setupInk rather than resetting brush to device-px.
    this._pixelRatio = 1;
    this.hiddenForNormal = [];
    this.materialsForNormal = [];
    this.normalExcludedCount = 0;
    this.normalDitheredCount = 0;
    this.instFadeNormalCount = 0;
    this.lodScreenDoorNormalCount = 0;
    this.normalDrawCalls = 0;
    // 조명 종속 선 굵기용. 씬의 태양을 이 pass 가 직접 읽으므로 소비자 배선이 없다
    // (앱·하네스 모두 같은 계약). 그림자 캐스터 DirectionalLight 를 태양으로 보고,
    // 없으면 가장 센 DirectionalLight, 그것도 없으면 항등(sunLight=0).
    this.sunSourceCount = 0;
    this._sunWorld = new THREE.Vector3();
    this._sunTargetWorld = new THREE.Vector3();
    this._viewBasis = new THREE.Matrix3();

    const dt = new THREE.DepthTexture(1, 1);
    dt.type = THREE.UnsignedIntType;
    dt.minFilter = dt.magFilter = THREE.NearestFilter;
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: dt,
    });

    this.uniforms = THREE.UniformsUtils.clone(InkShader.uniforms);
    this.uniforms.tPaper.value = paperTexture;
    this.uniforms.tBeauty.value = beautyTexture;
    this.useExternalBeauty = !!beautyTexture;
    this.uniforms.normalScale.value = this.resolutionScale;
    this.uniforms.cameraNear.value = camera.near;
    this.uniforms.cameraFar.value = camera.far;
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: InkShader.vertexShader,
      fragmentShader: InkShader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height, pixelRatio) {
    // width/height are device pixels (css × dpr), matching EffectComposer propagation.
    // Optional pixelRatio keeps fbm brush/dither in CSS px across retina.
    if (pixelRatio != null && Number.isFinite(pixelRatio) && pixelRatio > 0) {
      this._pixelRatio = pixelRatio;
    }
    const w = Math.max(1, Math.round(width * this.resolutionScale));
    const h = Math.max(1, Math.round(height * this.resolutionScale));
    this.normalTarget.setSize(w, h);
    this.uniforms.resolution.value.set(w, h);
    this.uniforms.pixelRatio.value = this._pixelRatio;
  }

  render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
    // 1) 노멀 + 깊이 오프스크린. 배경·안개는 노멀 렌더에서 제거.
    const prevOverride = this.scene.overrideMaterial;
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    // 반투명 객체(안개 띠·대기 레이어)는 솔리드 실루엣이 아니므로 깊이/노멀
    // 버퍼에서 제외한다. overrideMaterial이 이들을 불투명으로 만들면 가짜
    // 깊이 벽이 생겨 지평선에 헛 먹선이 돈다. (뷰티에는 그대로 렌더돼 여백처럼 밝아짐)
    const hidden = this.hiddenForNormal;
    const materials = this.materialsForNormal;
    hidden.length = 0;
    materials.length = 0;
    let instFadeNormalCount = 0;
    let lodScreenDoorNormalCount = 0;
    let sunLight = null;
    let sunSourceCount = 0;
    this.scene.traverseVisible((o) => {
      const renderable = o.isMesh || o.isPoints || o.isLine || o.isSprite;
      const contributes = renderable && contributesDofDepth(o);
      if (renderable && !contributes) hidden.push(o);
      if (contributes && o.isMesh && o.geometry?.getAttribute?.('instFade')) {
        materials.push(o, o.material, this.instFadeNormalMaterial);
        instFadeNormalCount++;
      } else if (contributes && o.isMesh && hasLodScreenDoor(o)) {
        materials.push(o, o.material, this.lodScreenDoorNormalMaterial);
        lodScreenDoorNormalCount++;
      }
      if (!o.isDirectionalLight || o.intensity <= 0) return;
      sunSourceCount++;
      if (!sunLight
        || (o.castShadow && !sunLight.castShadow)
        || (o.castShadow === sunLight.castShadow && o.intensity > sunLight.intensity)) sunLight = o;
    });
    this.sunSourceCount = sunSourceCount;
    for (const o of hidden) o.visible = false;
    for (let i = 0; i < materials.length; i += 3) materials[i].material = materials[i + 2];
    this.normalExcludedCount = hidden.length;
    this.normalDitheredCount = materials.length / 3;
    this.instFadeNormalCount = instFadeNormalCount;
    this.lodScreenDoorNormalCount = lodScreenDoorNormalCount;
    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;
    this.scene.fog = null;
    const prevTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.normalTarget);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      this.normalDrawCalls = renderer.info.render.calls;
    } finally {
      this.scene.overrideMaterial = prevOverride;
      this.scene.background = prevBg;
      this.scene.fog = prevFog;
      for (let i = 0; i < materials.length; i += 3) materials[i].material = materials[i + 1];
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
      materials.length = 0;
    }

    // 태양 방향은 위 renderer.render 가 월드 행렬과 camera.matrixWorldInverse 를 갱신한
    // 뒤에 읽는다. 방향만 필요하므로 뷰 행렬의 회전(3x3)만 적용한다.
    if (sunLight) {
      const dir = sunLight.getWorldPosition(this._sunWorld)
        .sub(sunLight.target.getWorldPosition(this._sunTargetWorld));
      if (dir.lengthSq() > 1e-8) {
        dir.normalize().applyMatrix3(this._viewBasis.setFromMatrix4(this.camera.matrixWorldInverse));
        this.uniforms.sunViewDir.value.copy(dir).normalize();
        this.uniforms.sunLight.value = 1;
      } else {
        this.uniforms.sunLight.value = 0;
      }
    } else {
      this.uniforms.sunLight.value = 0;
    }

    // 2) 먹 합성.
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (!this.useExternalBeauty) this.uniforms.tBeauty.value = readBuffer.texture;
    this.uniforms.tNormal.value = this.normalTarget.texture;
    this.uniforms.tDepth.value = this.normalTarget.depthTexture;
    this.uniforms.cameraNear.value = this.camera.near;
    this.uniforms.cameraFar.value = this.camera.far;
    if (this.scene.fog?.isFog) {
      this.uniforms.fogNear.value = this.scene.fog.near;
      this.uniforms.fogFar.value = this.scene.fog.far;
    }
    this.uniforms.acesOutput.value = renderer.toneMapping === THREE.ACESFilmicToneMapping ? 1 : 0;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.normalTarget.dispose();
    this.normalMaterial.dispose();
    this.instFadeNormalMaterial.dispose();
    this.lodScreenDoorNormalMaterial.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

// 공개 API: renderer/scene/camera → 재사용 가능한 먹 컴포저.
// 반환: { composer, inkPass, paperTexture, setSize, dispose }
export function setupInk(renderer, scene, camera, options = {}) {
  const paperTexture = options.paperTexture || makePaperTexture();
  const beautyPass = new InkBeautyCapturePass(options);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(beautyPass);
  const inkPass = new InkPass(scene, camera, paperTexture, {
    ...options,
    beautyTexture: beautyPass.target.texture,
  });
  if (options.uniforms) {
    for (const [k, v] of Object.entries(options.uniforms)) {
      if (inkPass.uniforms[k]) inkPass.uniforms[k].value = v;
    }
  }
  composer.addPass(inkPass);
  composer.addPass(new OutputPass());

  const setSize = (w, h) => {
    composer.setSize(w, h);
    // composer.setSize가 각 Pass.setSize를 호출하지만, DPR 반영 위해 명시적으로도 세팅.
    const dpr = renderer.getPixelRatio();
    beautyPass.setSize(w * dpr, h * dpr);
    inkPass.setSize(w * dpr, h * dpr, dpr);
  };
  const size = renderer.getSize(new THREE.Vector2());
  setSize(size.x, size.y);

  return {
    composer,
    beautyPass,
    inkPass,
    paperTexture,
    setSize,
    dispose() {
      inkPass.dispose();
      beautyPass.dispose();
      paperTexture.dispose();
      composer.dispose();
    },
  };
}

// Unified-composer adapter: consumers that already own Render→…→Output insert sourcePass
// immediately after Render and pass immediately before Output instead of creating a second composer.
export function createInkPass(scene, camera, options = {}) {
  const paperTexture = options.paperTexture || makePaperTexture(options.paperSize, options.paperSeed);
  const beautyPass = new InkBeautyCapturePass(options);
  const inkPass = new InkPass(scene, camera, paperTexture, {
    ...options,
    beautyTexture: beautyPass.target.texture,
  });
  if (options.uniforms) {
    for (const [key, value] of Object.entries(options.uniforms)) {
      if (inkPass.uniforms[key]) inkPass.uniforms[key].value = value;
    }
  }
  return {
    sourcePass: beautyPass,
    pass: inkPass,
    paperTexture,
    setSize(width, height, pixelRatio = 1) {
      beautyPass.setSize(width * pixelRatio, height * pixelRatio);
      inkPass.setSize(width * pixelRatio, height * pixelRatio, pixelRatio);
    },
    dispose() {
      beautyPass.dispose();
      inkPass.dispose();
      if (!options.paperTexture) paperTexture.dispose();
    },
  };
}
