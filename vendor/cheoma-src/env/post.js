// 플래그십 룩 후처리 — 빛으로 뿌얘지는 대기 헤이즈 + 골든아워 림 라이트.
//
//   setupPost({ renderer, scene, camera })
//     → { composer, setTime(name), setSize(w,h), update(dt), setDof(bool),
//         setFocusPoint(worldPoint), setDofAmount(0..1), setEnabled(bool), bloomPass, rimPass }
//
// 이 앱의 메인 룩을 한 컴포저로 통합한다(기존 main.js DoF BokehPass 흡수):
//   RenderPass 는 MsaaRenderPass(msaa-render-pass.js) — 렌더러의 antialias 플래그는 기본
//   프레임버퍼 전용이라 컴포저 경로에서 무효이므로, 씬 렌더 전용 멀티샘플 타깃이 유일한
//   기하 에지 AA 소스다. samples=0(`?msaa=0`)이면 stock RenderPass 거동으로 되돌아간다.
//   fresnel(기본): RenderPass → GradePass(채도) → BokehPass(opt-in) → UnrealBloomPass
//                  → FlarePass → OutputPass(ACES+sRGB 1회)  + 재질 프레넬 림(rim.js)
//   pass(?rim=pass): RenderPass → RimPass(스크린스페이스 림+채도) → Bokeh → Bloom
//                  → FlarePass → OutputPass  (구 방식 — A/B·성능 비교용 폴백)
//
// 설계 원칙
//  - bloom·rim 은 톤매핑 전 선형 HDR 버퍼(EffectComposer 기본 HalfFloat)에서 동작.
//    OutputPass 가 마지막에 ACES 톤매핑+sRGB 를 한 번만 적용 → 이중 과노출 없음
//    (ACES 하이라이트 롤오프가 bloom·rim 가산분을 자연 흡수).
//  - 림(태스크 #76 도입·#101 전 오브젝트 확장): 기본은 재질 프레넬(rim.js) — 씬의 lit 재질 전반
//    (건물·나무·풀·소품·담장·동물; 하늘·물·지형·발광·입자·먹 제외) 셰이딩에
//    뷰벡터-노멀 프레넬 × 태양 역광 × 근경 거리 게이트로 태양색 가산. 자기 표면에만 발광하므로
//    가려진 뒷건물 윤곽이 앞 표면에 새는 X-ray 누출이 구조적으로 불가능하고, 매 프레임 씬 재렌더
//    (지오 2배 제출)가 없어 마을·hanyang 부감에서도 상시 ON 가능. 구 RimPass(노멀 하프해상도
//    재렌더 + 깊이-이차미분 엣지)는 ?rim=pass 로 유지(패리티·성능 비교 A/B).
//  - GradePass: 구 RimShader 말미의 전역 채도 그레이드(#R4 색분리)를 경량 풀스크린 패스로 분리
//    (림을 재질로 옮겨도 화면 채도 그레이드는 보존).
//  - 태양 글로우는 additive Sprite 를 scene 에 직접 추가 → bloom 시드 겸 대기 헤이즈.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  DEFAULT_SUNSET_LOOK,
  atmosphereProfileKey,
  normalizeSunsetLook,
  resolveAtmosphereProfile,
  resolvePostProfile,
} from './atmosphere-profiles.js';
import { resolveMoonBloomGate } from './moon-optics.js';
import { createFresnelRim, rimDistanceGateForFov } from './rim.js';
import { createDofController, DEFAULT_DOF_APERTURE } from './dof.js';
import { StableBokehPass } from './stable-bokeh-pass.js';
import {
  MsaaRenderPass,
  MSAA_SAMPLES_DESKTOP,
  resolveMsaaSamples,
} from './msaa-render-pass.js';

// 태양 글로우 스프라이트를 놓을 반경(카메라 far=500·최원경 능선 r≈470 안쪽).
const SUN_GLOW_DIST = 430;

// 시간대별 튜닝. bloom(강도/반경/임계), 림(강도/색/프레넬 지수), 태양 글로우(강도/크기/색).
//  - bloomThreshold: 선형 HDR 휘도 임계. "광원성 요소만" 피어나게 하늘 배경 휘도보다 높게
//    잡는다(하늘 배경 선형 휘도 ≈ day 0.71 / sunset 0.53 / dawn 0.65 → 그 위로).
//    벽·기와·하늘이 뿌얘지면 실패(화면 전체 물안개 금지) → 임계를 높게.
//  - sunGlowSize: 스프라이트 월드 크기. 태양까지 거리 430·FOV 28° 기준으로 하늘을 덮지
//    않게 작게(코어만 밝고 헤일로는 은은). sunset 금빛 최대, day 절제, night 없음.
// rimWrap 은 태양 '반대쪽' 실루엣 에지에 남기는 잔여 림(0=완전 소거). 낮게 잡아 태양 쪽
// 가장자리만 빛나고 반대편은 어둡게 — 광학적 역광. 정오·순광 소거는 setTime 의 altGate 와
// material Fresnel 경로의 역광·직사광 판정은 rim.js가 실제 directional light로 담당한다.
// 여기 rim 값은 저고도 시간 프로필의 최대 에너지이며, pass 폴백만 화면 역광 게이트를 쓴다.
// sat: R4 색분리용 채도 그레이드(선형 HDR·ACES 전, RimPass 말미 적용). 조명 스플릿으로 hue
// 다양성을 확보한 뒤 살짝 끌어올려 웜·쿨을 함께 또렷하게. 1.0=무변(day/night 무드 보존).
// 단독으로는 단색조를 더 주황으로 만들 뿐이라 반드시 조명 스플릿 이후의 보정 역할만 한다.
// flare: 태양 렌즈 플레어(#67) '역광일 때의 최대 강도'. 고스트·헤일로·아나모픽 스트릭의 공통
//   상한이며, 실제 강도는 update() 에서 (가림율 vis × 태양 고도 altMul × 날씨 wxMul) 로 스케일.
//   sunset 최대(역광 기본 뷰), day 미세(정오 순광은 altMul 이 더 눌러줌), night 0. 절제 원칙상
//   낮게 잡아 처마 끝 킥이 "어? 예쁘다" 수준에 머물게 한다(화면 가로지르는 과한 스트릭 금지).
// flareColor: 고스트·헤일로 틴트(sRGB→선형, rimColor 와 동일 경로). sunset 웜골드, day 중성.
// Time/look values live in atmosphere-profiles.js beside the matching sky and light profile.

// 태양 글로우 텍스처: 흰-온기 코어 → 투명 방사 그라디언트(색은 material.color 로 시간대 틴트).
function makeSunGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  grad.addColorStop(0.10, 'rgba(255,248,232,0.86)');
  grad.addColorStop(0.32, 'rgba(255,228,186,0.34)');
  grad.addColorStop(0.66, 'rgba(255,212,156,0.09)');
  grad.addColorStop(1.00, 'rgba(255,204,146,0.0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- 골든아워 림 패스 ----------
// 씬을 MeshNormalMaterial 로 하프 해상도 재렌더 → 뷰공간 노멀·깊이.
// 프레넬(1-N.z)^p 로 실루엣 가장자리를 잡고, 화면투영 노멀이 태양쪽을 향한 면만
// 강조(mix(wrap,1,side)), 근경 거리 게이트로 원경 능선·달을 제외한다.
const RimShader = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse, tNormal, tDepth;
    uniform vec2 texSize;        // 노멀·깊이 타깃 해상도(반해상도) — 이웃 픽셀 샘플 간격
    uniform float cameraNear, cameraFar;
    uniform vec3 rimColor;
    uniform vec2 sunScreenDir;   // 화면상 태양 방향(정규화 xy)
    uniform float rimStrength, rimPower, rimWrap, backlit, rimNear, rimFar, sat;

    float worldDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x;
      float ndc = z * 2.0 - 1.0;
      return (2.0 * cameraNear * cameraFar) /
             (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
    }

    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      float dz = texture2D(tDepth, vUv).x;
      vec3 col = base.rgb;

      // 솔리드 표면(하늘·빈 영역 제외)에만 림 가산.
      if (dz < 0.9999) {
        vec3 N = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
        float nz = clamp(N.z, 0.0, 1.0);
        float graze = pow(1.0 - nz, rimPower);                // 실루엣(그레이징)에서 최대

        // 실루엣 에지 판별(깊이 불연속). 평평한 지면·지붕면은 카메라가 기울면 그레이징이라
        // graze 가 커지지만 깊이가 '연속'(선형 경사)이라 이차미분≈0 → 림 제외. 진짜 외곽은
        // 이웃이 배경으로 급락해 이차미분이 크다 → 림 허용. 지면이 금빛으로 물드는 것 방지.
        float cD = worldDepth(vUv);
        vec2 px = 1.0 / texSize;
        float dR = worldDepth(vUv + vec2(px.x, 0.0));
        float dL = worldDepth(vUv - vec2(px.x, 0.0));
        float dU = worldDepth(vUv + vec2(0.0, px.y));
        float dD = worldDepth(vUv - vec2(0.0, px.y));
        float curv = max(abs(dR + dL - 2.0 * cD), abs(dU + dD - 2.0 * cD));
        float edge = smoothstep(0.6, 4.0, curv);

        float side = clamp(dot(normalize(N.xy + vec2(1e-5)), sunScreenDir), 0.0, 1.0);
        float rim = graze * edge * mix(rimWrap, 1.0, side);

        float distFade = 1.0 - smoothstep(rimNear, rimFar, cD); // 근경만(원경 능선·달 제외)
        rim *= distFade * rimStrength * backlit;
        col += rimColor * rim;
      }

      // R4 채도 그레이드: 선형 HDR(ACES 전)에서 휘도 기준 채도만 살짝 스케일. 하늘·지면·건물
      // 모두 동일 적용 → 스플릿된 웜/쿨 색이 함께 또렷해진다. sat=1.0 이면 완전 무변.
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, sat);

      gl_FragColor = vec4(col, base.a);
    }
  `,
};

class RimPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.normalMaterial = new THREE.MeshNormalMaterial();

    const dt = new THREE.DepthTexture(1, 1);
    dt.type = THREE.UnsignedIntType;
    dt.minFilter = dt.magFilter = THREE.NearestFilter;
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,   // 하프 해상도 노멀을 부드럽게 업샘플(림이 소프트)
      magFilter: THREE.LinearFilter,
      depthTexture: dt,
    });

    this.uniforms = {
      tDiffuse: { value: null },
      tNormal: { value: null },
      tDepth: { value: null },
      texSize: { value: new THREE.Vector2(1, 1) },
      cameraNear: { value: camera.near },
      cameraFar: { value: camera.far },
      rimColor: { value: new THREE.Color(0xff9d52) },
      sunScreenDir: { value: new THREE.Vector2(0, 1) },
      rimStrength: { value: 1.0 },
      rimPower: { value: 2.2 },
      rimWrap: { value: 0.3 },
      backlit: { value: 1.0 },
      rimNear: { value: 24.0 },
      rimFar: { value: 210.0 },
      sat: { value: 1.0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: RimShader.vertexShader,
      fragmentShader: RimShader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    // 하프 해상도 노멀·깊이(림은 부드러운 표면 그라디언트라 해상도에 둔감).
    this.normalTarget.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }

  render(renderer, writeBuffer, readBuffer) {
    // 1) 노멀 + 깊이 오프스크린. 반투명(헤이즈·태양 글로우·달무리·파티클)은 제외해
    //    가짜 실루엣/노멀을 막는다(솔리드만 림 대상).
    const prevOverride = this.scene.overrideMaterial;
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    const hidden = [];
    this.scene.traverse((o) => {
      if (o.visible && (o.isMesh || o.isSprite || o.isPoints)
          && o.material && o.material.transparent) {
        o.visible = false; hidden.push(o);
      }
    });
    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;
    this.scene.fog = null;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.normalTarget);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;
    this.scene.fog = prevFog;
    for (const o of hidden) o.visible = true;

    // 2) 림 합성.
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tNormal.value = this.normalTarget.texture;
    this.uniforms.tDepth.value = this.normalTarget.depthTexture;
    this.uniforms.texSize.value.set(this.normalTarget.width, this.normalTarget.height);
    this.uniforms.cameraNear.value = this.camera.near;
    this.uniforms.cameraFar.value = this.camera.far;

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
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

// ---------- 채도 그레이드 패스 (#R4 색분리 보존) ----------
// 림을 재질 프레넬(rim.js)로 옮기면 구 RimShader 말미의 전역 채도 그레이드가 사라진다.
// 그 그레이드만 담당하는 경량 풀스크린 패스(선형 HDR·ACES 전). sat=1.0 이면 완전 무변.
const GradeShader = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float sat;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = base.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, sat);
      gl_FragColor = vec4(col, base.a);
    }
  `,
};

class GradePass extends Pass {
  constructor() {
    super();
    this.uniforms = { tDiffuse: { value: null }, sat: { value: 1.0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: GradeShader.vertexShader,
      fragmentShader: GradeShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this.enabled = false;   // sat=1 기본 상태는 완전한 항등 패스 — 불필요한 fullscreen read/write 생략.
  }
  setSaturation(value) {
    this.uniforms.sat.value = value;
    this.enabled = Math.abs(value - 1) > 1e-4;
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); if (this.clear) renderer.clear(); }
    this.fsQuad.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

// ---------- 태양 렌즈 플레어 패스 (#67) ----------
// 골든아워 역광에서 태양이 처마선 뒤로 살짝 드러나는 순간, 광학 플레어가 처마 끝을 스치게 한다.
// 구성: (1) 태양 주변 소프트 헤일로 — 처마 위로 번지는 빛의 킥, (2) 미세 아나모픽 스트릭(수평,
//   짧고 옅게), (3) 화면 중심 대칭축을 따라 저채도·저불투명 고스트 3~4개. 전부 additive 가산.
// 가림 판정: 하프해상도 solid depth(불투명만·반투명 제외)를 태양 스크린 위치 주변에서 소형
//   디스크로 다중 샘플 → 하늘(depth≈1) 비율 = 가시율. 처마·능선에 가려질수록 부드럽게 감쇠,
//   완전히 가리면 0, 처마 끝을 straddle 하면 절반 → '스침' 페이드의 핵심.
//   depth 소스(#76):
//     - fresnel 모드(기본): FlarePass 가 자체 하프해상도 depth 를 렌더(반투명 숨김·colorWrite off).
//       플레어가 실제로 그려지는 프레임(amt>0·태양 전방)에서만 렌더 → 저지오(focus·단일건물)
//       상황에서만 동작(engine 이 flare 를 focus 에서만 켬)하므로 비용 미미. rim 과 독립 →
//       구 방식의 'rim OFF 시 스테일 depth' 결합 함정(#75) 소멸.
//     - pass 모드(?rim=pass): 구 방식대로 rimPass.normalTarget.depthTexture 재사용.
//   태양 화면 밖·뒤면 소멸.
const FlareShader = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 sunUV;        // 화면상 태양 위치(uv 0..1). 화면 밖일 수 있음.
    uniform float aspect;      // width/height — 고스트·헤일로를 화면상 원형으로 유지
    uniform vec3 flareColor;   // 선형 HDR 웜 틴트
    uniform float flareAmt;    // 최종 강도(시간대×고도×날씨). 0 이면 무연산 조기 반환.
    uniform float sunFront;    // 태양이 카메라 전방이면 1
    uniform float eyeDamp;     // 아이레벨(1인칭 walk) 감쇠(#119): 지상 수평 시선서 태양향 헤일로가
                               //   거대 적색 블롭이 되는 것을 억제. 부감·히어로(내려봄)=0 → 처마킥 불변.

    // 해당 uv 가 하늘이면 1, 불투명 표면이면 0. 화면 밖은 가림 없음(1)으로 취급.
    float sky(vec2 uv) {
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
      return step(0.9995, texture2D(tDepth, uv).x);
    }

    // 소프트 디스크(중심 1 → 가장자리 0). 화면상 원형이 되게 x 를 aspect 로 보정.
    float disc(vec2 uv, vec2 c, float size) {
      vec2 d = (uv - c); d.x *= aspect;
      return smoothstep(1.0, 0.0, length(d) / size);
    }
    // 소프트 링(반경 size, 두께 w).
    float ring(vec2 uv, vec2 c, float size, float w) {
      vec2 d = (uv - c); d.x *= aspect;
      return smoothstep(w, 0.0, abs(length(d) / size - 1.0));
    }
    vec3 desat(vec3 c, float k) {
      return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, k);
    }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (flareAmt < 0.001 || sunFront < 0.5) { gl_FragColor = base; return; }

      // 태양 코어 주변 소형 디스크 다중 샘플 → 하늘 비율 = 가시율(부분 가림 페이드).
      // x 오프셋을 aspect 로 나눠 화면상 원형 디스크(반경 ≈ 태양 코어).
      float r = 0.018;
      float vis = sky(sunUV);
      vis += sky(sunUV + vec2( r / aspect, 0.0));
      vis += sky(sunUV + vec2(-r / aspect, 0.0));
      vis += sky(sunUV + vec2( 0.0, r));
      vis += sky(sunUV + vec2( 0.0, -r));
      vis += sky(sunUV + vec2( r * 0.7 / aspect,  r * 0.7));
      vis += sky(sunUV + vec2(-r * 0.7 / aspect,  r * 0.7));
      vis += sky(sunUV + vec2( r * 0.7 / aspect, -r * 0.7));
      vis += sky(sunUV + vec2(-r * 0.7 / aspect, -r * 0.7));
      vis /= 9.0;
      vis = smoothstep(0.04, 0.9, vis);   // 완전 가림≈0, straddle≈절반, 완전 노출≈1

      float amt = flareAmt * vis;
      if (amt < 0.001) { gl_FragColor = base; return; }

      // 화면 밖 페이드: 프레임을 벗어나도 즉시 끊지 않고 헤일로·글로우가 가장자리로 스며들게 넓게
      //   감쇠(골든아워 역광은 태양이 프레임 살짝 위/옆에 있을 때 빛이 위에서 번지는 것이 정석).
      //   0.55 uv 이상 벗어나면 소멸. 안쪽은 완전 유지.
      float ox = max(max(-sunUV.x, sunUV.x - 1.0), 0.0);
      float oy = max(max(-sunUV.y, sunUV.y - 1.0), 0.0);
      amt *= 1.0 - smoothstep(0.0, 0.55, max(ox, oy));
      if (amt < 0.001) { gl_FragColor = base; return; }

      vec2 uv = vUv;
      vec2 center = vec2(0.5);
      vec2 toC = center - sunUV;        // 태양 → 화면중심(고스트 대칭축)
      vec3 flare = vec3(0.0);

      // (1) 헤일로: 태양 주변 소프트 글로우(처마 위로 번지는 킥). 코어 타이트 + 넓은 은은.
      //   넓은 항은 대기 글로우처럼 자연스럽되 화면을 뒤덮지 않게 낮게(절제).
      {
        vec2 d = (uv - sunUV); d.x *= aspect;
        float rr = dot(d, d);
        // 아이레벨(walk)에서 넓은 헤일로가 화면을 뒤덮는 적색 블롭이 되는 것을 강하게 억제(#119).
        //   타이트 코어는 절제된 감쇠(태양 핫스팟 자체는 남김). 부감·히어로(eyeDamp=0)는 불변.
        flare += flareColor * exp(-rr / (2.0 * 0.045 * 0.045)) * 0.55 * (1.0 - eyeDamp * 0.45);
        flare += flareColor * exp(-rr / (2.0 * 0.125 * 0.125)) * 0.12 * (1.0 - eyeDamp * 0.82);
      }

      // (2) 아나모픽 스트릭: 수평으로 짧고 옅게(화면 가로지르지 않게 x 시그마 제한).
      {
        vec2 d = (uv - sunUV);
        float sx = exp(-(d.x * d.x) / (2.0 * 0.15 * 0.15));
        float sy = exp(-(d.y * d.y) / (2.0 * 0.006 * 0.006));
        flare += flareColor * sx * sy * 0.20 * (1.0 - eyeDamp * 0.5);
      }

      // (3) 고스트: 중심 대칭축을 따라 저채도·저불투명. 태양-중심 사이 1개 + 반대편 3개.
      //   렌즈 고스트는 하늘 위에서만 자연스럽다. 화려한 전경(공포·단청) 위에 저채도 고스트를
      //   얹으면 채도를 죽여 칙칙한 원형 얼룩으로 읽히므로(#75 클로즈업 중앙 어두운 링), 각 고스트를
      //   그 중심의 하늘 노출도 sky()로 게이트한다 — 솔리드 피사체 위면 소멸, 하늘 위면 은은히.
      //   본체(헤일로·스트릭)는 게이트하지 않아 처마 킥은 불침해.
      vec3 gWarm = desat(flareColor, 0.6);
      vec3 gCool = desat(mix(flareColor, vec3(0.5, 0.72, 1.0), 0.5), 0.7);
      vec2 g0 = sunUV + toC * 0.62, g1 = sunUV + toC * 1.18;
      vec2 g2 = sunUV + toC * 1.55, g3 = sunUV + toC * 1.98;
      flare += gWarm * disc(uv, g0, 0.052) * 0.05  * sky(g0);
      flare += gCool * ring(uv, g1, 0.15, 0.30) * 0.045 * sky(g1);
      flare += gWarm * disc(uv, g2, 0.085) * 0.055 * sky(g2);
      flare += gCool * ring(uv, g3, 0.20, 0.45) * 0.026 * sky(g3);

      gl_FragColor = vec4(base.rgb + flare * amt, base.a);
    }
  `,
};

// FlarePass: solid depth 로 가림율을 판정한 뒤 플레어를 tDiffuse 위에 가산.
//   fresnel 모드(scene·camera 주입): 자체 하프해상도 solid depth 를 렌더(플레어 그려질 때만).
//   pass 모드(rimPass 주입): rimPass 가 채운 solid depth 재사용(구 방식).
class FlarePass extends Pass {
  constructor({ rimPass = null, scene = null, camera = null } = {}) {
    super();
    this.rimPass = rimPass;
    this.scene = scene;
    this.camera = camera;
    this.selfDepth = !rimPass && !!scene;   // fresnel 모드
    if (this.selfDepth) {
      // 깊이만 필요(colorWrite off → 프래그먼트 셰이딩 최소). 반투명은 render 시 숨김.
      this._depthMat = new THREE.MeshBasicMaterial();
      this._depthMat.colorWrite = false;
      const dt = new THREE.DepthTexture(1, 1);
      dt.type = THREE.UnsignedIntType;
      dt.minFilter = dt.magFilter = THREE.NearestFilter;
      this.depthTarget = new THREE.WebGLRenderTarget(1, 1, { depthTexture: dt });
    }
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      sunUV: { value: new THREE.Vector2(0.5, 0.7) },
      aspect: { value: 1.0 },
      flareColor: { value: new THREE.Color(0xffc078) },
      flareAmt: { value: 0.0 },
      sunFront: { value: 0.0 },
      eyeDamp: { value: 0.0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: FlareShader.vertexShader,
      fragmentShader: FlareShader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    if (this.selfDepth) this.depthTarget.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }

  // 자체 solid depth 렌더(fresnel 모드). 반투명(글로우·달무리·구름·파티클)을 숨겨 가짜 가림 방지.
  _renderDepth(renderer) {
    const s = this.scene;
    const prevOverride = s.overrideMaterial, prevBg = s.background, prevFog = s.fog;
    const hidden = [];
    s.traverse((o) => {
      if (o.visible && (o.isMesh || o.isSprite || o.isPoints) && o.material && o.material.transparent) {
        o.visible = false; hidden.push(o);
      }
    });
    s.overrideMaterial = this._depthMat; s.background = null; s.fog = null;
    const prevT = renderer.getRenderTarget();
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(s, this.camera);
    s.overrideMaterial = prevOverride; s.background = prevBg; s.fog = prevFog;
    for (const o of hidden) o.visible = true;
    renderer.setRenderTarget(prevT);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.selfDepth) {
      // 플레어가 실제로 그려지는 프레임에서만 depth 렌더(태양 전방·amt>0). 그 외엔 조기반환하므로
      //   스테일 depth 무해(셰이더가 amt<0.001 이면 base 그대로 반환).
      if (this.uniforms.flareAmt.value > 0.001 && this.uniforms.sunFront.value > 0.5) this._renderDepth(renderer);
      this.uniforms.tDepth.value = this.depthTarget.depthTexture;
    } else {
      this.uniforms.tDepth.value = this.rimPass.normalTarget.depthTexture;
    }
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
    if (this.depthTarget) this.depthTarget.dispose();
    if (this._depthMat) this._depthMat.dispose();
  }
}

export function setupPost({ renderer, scene, camera, msaaSamples = MSAA_SAMPLES_DESKTOP }) {
  const size = renderer.getSize(new THREE.Vector2());

  // ---- 태양 글로우 스프라이트 (bloom 시드 + 대기 헤이즈). scene 에 직접 추가. ----
  const glowTex = makeSunGlowTexture();
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffb066, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
  }));
  sunGlow.name = 'sunGlow';
  sunGlow.renderOrder = -40;   // 불투명 뒤·달무리 근처
  sunGlow.visible = false;
  // This broad atmospheric sprite intentionally stays out of the packed-depth
  // source contract. Writing its translucent tail as one opaque plane would
  // occlude unrelated bokeh; the rendered broad-source fixture proves that its
  // image-space compact evidence stays zero.
  scene.add(sunGlow);

  // 림 구현 선택(#76): 기본 'fresnel'(재질 프레넬), ?rim=pass 면 구 RimPass(A/B·성능 비교).
  const _q = (typeof location !== 'undefined') ? new URLSearchParams(location.search) : new URLSearchParams();
  const RIM_MODE = _q.get('rim') === 'pass' ? 'pass' : 'fresnel';
  const useFresnel = RIM_MODE === 'fresnel';

  // ---- 컴포저 ----
  const composer = new EffectComposer(renderer);   // 기본 HalfFloat → HDR bloom
  let composerPixelRatio = renderer.getPixelRatio();
  // 기하 에지 MSAA(#AA). 렌더러의 antialias 플래그는 컴포저 경로에서 무효이므로 씬 렌더 전용
  //   멀티샘플 타깃이 유일한 AA 소스다(msaa-render-pass.js 헤더 주석). `?msaa=N` 은 같은
  //   빌드에서 회귀 상태(0)와 수정본을 A/B 하는 게이트 훅 — 소비자 인자보다 우선한다.
  const msaaOverride = _q.get('msaa');
  const samples = resolveMsaaSamples(renderer, msaaOverride !== null ? msaaOverride : msaaSamples);
  const renderPass = new MsaaRenderPass(scene, camera, { samples });
  composer.addPass(renderPass);

  // fresnel: 재질 프레넬 림(rim.js, 패스 없음) + 채도 그레이드 패스. pass: 구 RimPass(림+채도 통합).
  const fresnelRim = useFresnel ? createFresnelRim(scene) : null;
  const gradePass = useFresnel ? new GradePass() : null;
  const rimPass = useFresnel ? null : new RimPass(scene, camera);
  composer.addPass(useFresnel ? gradePass : rimPass);

  // DoF(피사계 심도) — 기존 main.js BokehPass 흡수. 기본 off, setDof 로 토글.
  const bokehPass = new StableBokehPass(scene, camera, {
    focus: 40, aperture: DEFAULT_DOF_APERTURE, maxblur: 0.01,
  });
  bokehPass.enabled = false;
  const dof = createDofController({ camera, pass: bokehPass, aperture: DEFAULT_DOF_APERTURE });
  composer.addPass(bokehPass);

  // Optical blur precedes sensor bloom: a tiny HDR source first forms one aperture
  // image, then bloom adds its continuous halo instead of being scattered again.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(size.x, size.y), 0.6, 0.75, 0.6,
  );
  composer.addPass(bloomPass);

  // 태양 렌즈 플레어(#67): DoF·bloom 뒤·OutputPass(ACES) 앞에 가산. bloom 이후라 고스트가
  //   블러로 뭉개지지 않고 렌즈 아티팩트로 또렷이 얹힌다. fresnel 은 자체 depth, pass 는 rimPass
  //   depth 재사용. 기본 ON — 태양 고도·프레임 내 여부·날씨·sky 게이트가 이미 대부분의 프레임에서
  //   발현을 막으므로 디바이스 분기를 두지 않는다. 소비자는 setFlareEnabled 로 토글한다
  //   (종전의 lowPerf 파라미터는 어떤 호출자도 넘기지 않는 죽은 인자였다 —
  //   docs/mobile-effects-audit.md M10).
  const flarePass = useFresnel ? new FlarePass({ scene, camera }) : new FlarePass({ rimPass });
  composer.addPass(flarePass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);
  composer.setSize(size.x, size.y);

  let disposed = false;
  let enabled = true;
  let rimOn = true;                 // setRimEnabled 마스터(부감 OFF·focus ON). fresnel=uRimScale, pass=rimPass.enabled
  let rimBase = 0;                  // cur.rim × altGate(저고도); 실제 역광 기하는 rim.js 소유
  let scanTick = 0;                 // fresnel 재질 self-heal 스캔 카운터(마을 리롤·focus-in 새 재질 포착)
  function updateRimScale() { if (fresnelRim) fresnelRim.setScale((enabled && rimOn) ? 1 : 0); }
  let glowIntensity = 0;
  const _v = new THREE.Vector3();
  const _sunProj = new THREE.Vector3();
  // 플레어 날씨 감쇠(0..1, 1=맑음). setWeather 로 명시 지정 시 목표로 이징(#50 팟 금지). 앱에서
  //   명시 배선이 없어도 update() 가 window.__wx(rain/snow/accum)를 읽어 자동 게이트한다.
  let flareWx = 1, flareWxTarget = 1;

  // ── 시간대 크로스페이드(태스크 #50) ────────────────────────────────────────
  // POST_TUNING 수치 + 태양 방향을 목표 상태로 트윈. sky 의 태양 스윕과 결이 맞게 DUR/이징 일치.
  //   첫 적용(초기 로드)·shot 은 즉시 스냅(started 게이트) → 캡처 재현성·로드 시 트윈-인 방지.
  //   같은 시간대 재적용(모드 토글 등)은 스냅(멱등). 전환 중 재다이얼은 현재 보간값에서 리타깃.
  //   update() 는 dt 인자가 없어 내부 클록으로 dt 산출(pbr 프레임마다 호출).
  const DUR_POST = 1.8;
  const easeInOut = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  const makePS = () => ({
    bloomStrength: 0, bloomRadius: 0, bloomThreshold: 0,
    rim: 0, rimPower: 0, rimWrap: 0, rimColor: new THREE.Color(), sat: 1,
    sunGlow: 0, sunGlowSize: 0, sunGlowColor: new THREE.Color(), dir: new THREE.Vector3(0.6, 0.5, 0.5).normalize(),
    flare: 0, flareColor: new THREE.Color(),
  });
  let sunsetLook = DEFAULT_SUNSET_LOOK;
  function resolvePS(out, name) {
    const T = resolvePostProfile(name, sunsetLook);
    out.bloomStrength = T.bloomStrength; out.bloomRadius = T.bloomRadius; out.bloomThreshold = T.bloomThreshold;
    out.rim = T.rim; out.rimPower = T.rimPower; out.rimWrap = T.rimWrap;
    // r185의 숫자형 색 입력은 이미 sRGB→working-linear 변환된다. 명시적 색공간만 남겨 이중 디코드 방지.
    out.rimColor.setHex(T.rimColor, THREE.SRGBColorSpace);
    out.sat = T.sat ?? 1.0;
    out.sunGlow = T.sunGlow; out.sunGlowSize = T.sunGlowSize; out.sunGlowColor.set(T.sunGlowColor);
    out.flare = T.flare ?? 0; out.flareColor.setHex(T.flareColor ?? 0xffffff, THREE.SRGBColorSpace);
    const d = resolveAtmosphereProfile(name, sunsetLook).sunDir;
    out.dir.set(d[0], d[1], d[2]).normalize();
    return out;
  }
  function copyPS(dst, src) {
    dst.bloomStrength = src.bloomStrength; dst.bloomRadius = src.bloomRadius; dst.bloomThreshold = src.bloomThreshold;
    dst.rim = src.rim; dst.rimPower = src.rimPower; dst.rimWrap = src.rimWrap; dst.rimColor.copy(src.rimColor); dst.sat = src.sat;
    dst.flare = src.flare; dst.flareColor.copy(src.flareColor);
    dst.sunGlow = src.sunGlow; dst.sunGlowSize = src.sunGlowSize; dst.sunGlowColor.copy(src.sunGlowColor); dst.dir.copy(src.dir);
  }
  function lerpPS(out, a, b, k) {
    const L = (x, y) => x + (y - x) * k;
    out.bloomStrength = L(a.bloomStrength, b.bloomStrength); out.bloomRadius = L(a.bloomRadius, b.bloomRadius);
    out.bloomThreshold = L(a.bloomThreshold, b.bloomThreshold); out.rim = L(a.rim, b.rim);
    out.rimPower = L(a.rimPower, b.rimPower); out.rimWrap = L(a.rimWrap, b.rimWrap);
    out.rimColor.copy(a.rimColor).lerp(b.rimColor, k); out.sat = L(a.sat, b.sat);
    out.sunGlow = L(a.sunGlow, b.sunGlow); out.sunGlowSize = L(a.sunGlowSize, b.sunGlowSize);
    out.sunGlowColor.copy(a.sunGlowColor).lerp(b.sunGlowColor, k); out.dir.copy(a.dir).lerp(b.dir, k).normalize();
    out.flare = L(a.flare, b.flare); out.flareColor.copy(a.flareColor).lerp(b.flareColor, k);
  }
  const cur = makePS(), from = makePS(), to = makePS();
  resolvePS(cur, 'day');
  let curName = 'day';
  let curKey = atmosphereProfileKey('day', sunsetLook);
  let tw = null;             // { t, dur, name, key }
  let started = false;       // 첫 update 전 setTime 은 즉시 스냅
  let lastNow = (typeof performance !== 'undefined' ? performance.now() : 0);

  // cur 를 패스·태양 글로우에 적용(트윈 매 프레임·스냅 공통). 림 저고도 게이트는 cur.dir 로 매번 산출.
  function applyPS() {
    bloomPass.strength = cur.bloomStrength;
    bloomPass.radius = cur.bloomRadius;
    // A hard 0.01-wide cutoff made the telephoto Moon lose most of its bloom in
    // one frame as a cloud crossed the threshold. Treat the authored night value
    // as the midpoint of a restrained soft knee instead. Day/sunset retain the
    // stock narrow gate so ordinary plaster and foliage do not become emitters.
    const bloomGate = resolveMoonBloomGate(cur.bloomThreshold);
    bloomPass.threshold = bloomGate.threshold;
    bloomPass.highPassUniforms.smoothWidth.value = bloomGate.smoothWidth;
    // Bloom may softly affect a broad warm surface, but optical source discs are
    // reserved for a much smaller HDR set. Keeping this threshold above ordinary
    // sunlit plaster prevents roofs, foliage, and contrast edges from becoming a
    // field of expensive pseudo-emitters; authored lantern/window cores remain HDR.
    bokehPass.uniforms.highlightThreshold.value = Math.max(
      1.2,
      cur.bloomThreshold * 1.25,
    );
    // 저고도 게이트: 림은 태양이 낮을 때(골든아워)만 성립하고 정오로 갈수록 소거된다.
    const altGate = 1.0 - THREE.MathUtils.smoothstep(cur.dir.y, 0.20, 0.52);
    rimBase = cur.rim * altGate;
    if (useFresnel) {
      // 재질 프레넬: 색·지수는 여기서, 기본 강도와 태양 뷰방향은 update() 에서.
      // wrap setter는 하위호환 API지만 물리 rim 에는 암부 잔광을 더하지 않는다.
      // 지수 remap: 뷰벡터 프레넬(1-N·V)은 스크린 노멀 그레이징(1-N.z)보다 넓게 잡히므로(면 전체가
      //   그레이징으로 물듦) POST_TUNING.rimPower 에 오프셋을 더해 실루엣 에지에 집중시킨다.
      //   강도는 지수 상향에 따른 총 에너지 감소를 보정해 살짝 올린다(처마 킥 인상 유지).
      fresnelRim.setColor(cur.rimColor);
      fresnelRim.setPower(cur.rimPower + 3.2);
      // wrap(태양 비대면·수직 그레이징 잔여)을 구 값보다 낮춘다: 프레넬은 실루엣이 아닌 그레이징
      //   전반을 잡으므로, 기단 윗면 같은 태양 수직 평면이 광역으로 물드는 것을 억제(태양 대면
      //   실루엣 킥은 side≈1 이라 불변). 구 RimPass 는 깊이-엣지 게이트로 평면을 뺐지만 프레넬엔 없음.
      fresnelRim.setWrap(cur.rimWrap * 0.4);
      gradePass.setSaturation(cur.sat);   // sat≈1이면 항등 fullscreen 패스를 자동 생략.
    } else {
      rimPass.uniforms.rimStrength.value = rimBase;
      rimPass.uniforms.rimPower.value = cur.rimPower;
      rimPass.uniforms.rimWrap.value = cur.rimWrap;
      rimPass.uniforms.rimColor.value.copy(cur.rimColor);
      rimPass.uniforms.sat.value = cur.sat;
    }
    glowIntensity = cur.sunGlow;
    sunGlow.material.opacity = cur.sunGlow;
    sunGlow.material.color.copy(cur.sunGlowColor);
    sunGlow.scale.set(cur.sunGlowSize, cur.sunGlowSize, 1);
    sunGlow.position.copy(camera.position).addScaledVector(cur.dir, SUN_GLOW_DIST);
    sunGlow.visible = enabled && glowIntensity > 0.001;
    // 플레어 틴트는 시간대 트윈값(정적). 강도·스크린 위치는 update() 가 카메라·가림에 맞춰 매 프레임.
    flarePass.uniforms.flareColor.value.copy(cur.flareColor);
  }

  function setTime(name, opts = {}) {
    const key = atmosphereProfileKey(name, sunsetLook);
    resolvePS(to, name);
    if (opts.immediate || !started) { copyPS(cur, to); curName = name; curKey = key; tw = null; applyPS(); return; }
    if (tw) {
      if (key === tw.key) return;                 // 진행 중 트윈과 같은 프로필 목표 → 계속
      copyPS(from, cur); tw = { t: 0, dur: DUR_POST, name, key }; // 현재 보간값에서 리타깃
      return;
    }
    if (key === curKey) { copyPS(cur, to); applyPS(); return; }    // 같은 프로필 재적용 → 스냅(멱등)
    copyPS(from, cur); tw = { t: 0, dur: DUR_POST, name, key };
  }

  function setSunsetLook(name, opts = {}) {
    const next = normalizeSunsetLook(name);
    if (next === sunsetLook && curName !== 'sunset' && tw?.name !== 'sunset') return next;
    sunsetLook = next;
    if (curName === 'sunset' || tw?.name === 'sunset') setTime('sunset', opts);
    return sunsetLook;
  }

  // 매 프레임(pbr): 시간대 트윈 진행 + 카메라 이동에 따른 화면상 태양 방향·역광 계수 갱신.
  //   dtOverride(초): 결정론 하네스가 sim dt 를 직접 넘길 때 사용. 미지정이면 내부 벽시계(앱 경로).
  function update(dtOverride) {
    started = true;
    if (tw) {
      let dt;
      if (typeof dtOverride === 'number') { dt = dtOverride; lastNow = (typeof performance !== 'undefined' ? performance.now() : lastNow); }
      else {
        const now = (typeof performance !== 'undefined' ? performance.now() : lastNow + 16);
        dt = (now - lastNow) / 1000; lastNow = now;
      }
      if (dt > 0.05) dt = 0.05; else if (dt < 0) dt = 0;
      tw.t += dt;
      lerpPS(cur, from, to, easeInOut(tw.t / tw.dur));
      applyPS();
      if (tw.t >= tw.dur) { copyPS(cur, to); curName = tw.name; curKey = tw.key; tw = null; }
    } else {
      lastNow = (typeof performance !== 'undefined' ? performance.now() : lastNow + 16);
    }
    camera.updateMatrixWorld();
    // Celestial sprites are angular scenery. Following camera translation removes
    // parallax and keeps the sun inside the sky shell at every village scale.
    sunGlow.position.copy(camera.position).addScaledVector(cur.dir, SUN_GLOW_DIST);
    _v.copy(cur.dir).transformDirection(camera.matrixWorldInverse); // 뷰공간 태양 방향(단위)
    // 구 스크린 패스만 카메라 전방 역광 게이트를 소비한다. 물리 재질 rim은
    // directionalLights[0]의 실제 방향을 프래그먼트별로 판정하므로 cur.dir 기반 최소값을 더하지 않는다.
    const passBacklit = THREE.MathUtils.smoothstep(-_v.z, 0.06, 0.5);
    if (useFresnel) {
      // 재질 프레넬: 뷰공간 태양 방향 + 시간대 기본 강도만 공유 uniform 에.
      //   FRES_STR_MUL: 지수 상향(에지 집중)에 따른 총 에너지 감소를 보정하는 배율.
      //   1.85 — hero settle(~7°/170 m) 처마 실선이 에너지 캡에 더 잘 붙도록 인상. 피크는
      //   RIM_BASE_ENERGY_CAP×groupMul 이 여전히 상한을 잡는다(check:rim sunset peak 계약).
      fresnelRim.setSunViewDir(_v);
      fresnelRim.setStrength(enabled ? rimBase * 1.85 : 0);
      // Live FOV distance gate: hero 7° dolly (~170 m) must keep the subject inside the
      // full-strength band. Parcel-only scaling left settle at ~33% rim (dead eave kick).
      const gate = rimDistanceGateForFov(camera.fov);
      fresnelRim.setNearFar(gate.near, gate.far);
      // Neighbour rim under DoF → bokeh sparkle. Axial depth = BokehPass focus; amount 0 inert.
      fresnelRim.setDofGate({
        focusDepth: dof.focus,
        amount: (enabled && bokehPass.enabled) ? dof.amount : 0,
      });
      // 새 재질(마을 리롤·focus-in 오버레이·단일건물 rebuild) self-heal 패치. 대략 0.4s 주기.
      if ((++scanTick % 24) === 0) fresnelRim.apply(scene);
    } else {
      const len = Math.hypot(_v.x, _v.y);
      if (len > 1e-4) rimPass.uniforms.sunScreenDir.value.set(_v.x / len, _v.y / len);
      rimPass.uniforms.backlit.value = passBacklit;
    }

    // ── 태양 렌즈 플레어(#67): 스크린 위치·강도 갱신 ─────────────────────────
    // 강도 = cur.flare(시간대) × altMul(고도) × wxMul(날씨) × enabled. 실제 가림·화면가장자리
    //   페이드는 셰이더가 depth·sunUV 로 판정. 애니메이션 항 없음 → 같은 카메라·시간 = 같은 픽셀(결정론).
    let dtFlare;
    if (typeof dtOverride === 'number') dtFlare = dtOverride;
    else dtFlare = 1 / 60;
    if (dtFlare > 0.05) dtFlare = 0.05; else if (dtFlare < 0) dtFlare = 0;
    // 날씨 감쇠: 명시 setWeather 목표로 이징 + window.__wx 자동 판독(둘 중 강한 소멸 채택).
    flareWx += (flareWxTarget - flareWx) * Math.min(1, dtFlare * 3.0);
    let wxMul = flareWx;
    if (typeof window !== 'undefined' && window.__wx) {
      const wx = window.__wx;
      const rain = typeof wx.rain === 'number' ? wx.rain : 0;       // 옵션 getter(없으면 0)
      const snow = typeof wx.snow === 'number' ? wx.snow : 0;       // 옵션 getter(없으면 0)
      const accum = typeof wx.accum === 'number' ? wx.accum : 0;    // 적설 진행(항상 존재)
      const auto = (1 - 0.92 * THREE.MathUtils.smoothstep(rain, 0.05, 0.5))
                 * (1 - 0.92 * THREE.MathUtils.smoothstep(snow, 0.05, 0.5))
                 * (1 - 0.85 * THREE.MathUtils.smoothstep(accum, 0.08, 0.55));
      wxMul = Math.min(wxMul, auto);
    }
    // 태양이 카메라 전방일 때만(뒤면 소멸). -_v.z 를 전방 게이트로 재사용.
    const front = -_v.z;
    let amt = 0;
    if (enabled && front > 0.02 && cur.flare > 0.001) {
      // 스크린 투영: 태양 방향 원거리 점을 project → uv. front 게이트가 뒤편 특이점을 차단.
      _sunProj.copy(cur.dir).multiplyScalar(1e5).project(camera);
      flarePass.uniforms.sunUV.value.set(_sunProj.x * 0.5 + 0.5, _sunProj.y * 0.5 + 0.5);
      // 고도 게이트: 골든아워 저각 최대, 정오 고각으로 갈수록 미세하게(림 altGate 와 결이 맞게).
      const altMul = THREE.MathUtils.lerp(1.0, 0.32, THREE.MathUtils.smoothstep(cur.dir.y, 0.20, 0.55));
      amt = cur.flare * altMul * wxMul;
    }
    flarePass.uniforms.flareAmt.value = amt;
    flarePass.uniforms.sunFront.value = front > 0.02 ? 1 : 0;
    // 아이레벨 게이트(#119): 카메라 전방 벡터의 y(피치)로 1인칭 walk(지상 수평 시선, fy≈0)를 판별.
    //   부감(fy≈-0.36)·focus(-0.66)·히어로 랜딩(-0.10~-0.12)은 모두 아래를 향하므로 eyeDamp=0 →
    //   처마킥·역광 헤일로 불변. 수평(walk)에서만 1 로 올라가 태양향 거대 적색 블롭을 억제한다.
    const fy = -camera.matrixWorld.elements[9];   // world forward.y (getWorldDirection 과 동일)
    flarePass.uniforms.eyeDamp.value = THREE.MathUtils.smoothstep(fy, -0.09, -0.02);
  }

  // CSS-pixel composer size last passed to setSize. fillScale multiplies only the
  // device pixel ratio so orbit can drop fill-rate without changing the canvas.
  let composerCssW = size.x;
  let composerCssH = size.y;
  let fillScale = 1;

  function applyComposerResolution() {
    const pixelRatio = renderer.getPixelRatio() * fillScale;
    if (pixelRatio !== composerPixelRatio) {
      composerPixelRatio = pixelRatio;
      composer.setPixelRatio(pixelRatio);
    }
    composer.setSize(composerCssW, composerCssH);   // 각 패스(bloom·bokeh·rim)에 device px 전파
    flarePass.uniforms.aspect.value = (composerCssH > 0 ? composerCssW / composerCssH : 1.0);
  }

  function setSize(w, h) {
    composerCssW = Math.max(1, w);
    composerCssH = Math.max(1, h);
    applyComposerResolution();
  }

  /**
   * Adaptive fill budget for camera motion. Multiplies the renderer's pixel
   * ratio for the EffectComposer only (canvas CSS size stays fixed). Callers
   * should switch this at mode boundaries (stable ↔ moving), not every frame —
   * setPixelRatio reallocates every pass target.
   */
  function setFillScale(scale) {
    const next = Number.isFinite(scale) ? Math.max(0.5, Math.min(1, scale)) : 1;
    if (Math.abs(next - fillScale) < 1e-4) return fillScale;
    fillScale = next;
    applyComposerResolution();
    return fillScale;
  }

  function setDof(on) { return dof.setEnabled(on); }
  function setDofAmount(weight) { return dof.setAmount(weight); }
  function setDofAperture(value) { return dof.setAperture(value); }
  // 틸트시프트 초점면 다이얼(0 = 보통 렌즈). 선명 밴드를 좁히고 이탈 램프를 급하게 만든다 —
  //   조리개를 건드리지 않고 디오라마 성격만 강화하는 축(docs/dof-cinematic-research.md §4.7).
  function setDofTilt(value) { return dof.setTilt(value); }
  // 부감 DoF 하한. 부감만 amount=0 을 요청하므로 이 하한이 곧 "부감도 심도를 갖는다"다.
  function setDofAmountFloor(value) { return dof.setAmountFloor(value); }
  function setFocus(dist) { return dof.setFocus(dist); }
  function setFocusPoint(point) { return dof.focusAt(point); }

  function setEnabled(v) {
    enabled = !!v;
    // 태양 글로우는 scene 자식 → ink 컴포저 렌더에도 잡히므로 pbr·post 일 때만 노출.
    sunGlow.visible = enabled && glowIntensity > 0.001;
    if (!enabled) flarePass.uniforms.flareAmt.value = 0;
    // fresnel 림은 재질 셰이딩이라(ink 컴포저 렌더에도 잡힘) post OFF 시 강도·마스터를 즉시 0 으로.
    if (useFresnel) { if (!enabled) fresnelRim.setStrength(0); updateRimScale(); }
  }

  // 날씨 명시 지정(선택): 'clear'|'rain'|'snow'. 앱 엔진이 배선하지 않아도 window.__wx 자동
  //   판독이 백업하지만, 명시 호출 시 즉시 목표를 잡아 결정론·정밀 제어가 필요한 데모/하네스에 쓴다.
  function setWeather(name) {
    flareWxTarget = (name === 'rain' || name === 'snow') ? 0.1 : 1.0;
  }
  // 플레어 패스 온/오프(부감 OFF·A/B 검증). 기본값 ON.
  function setFlareEnabled(v) { flarePass.enabled = !!v; }
  // 림 온/오프(부감 OFF·focus ON). 계약 불변(engine setPostFocus 가 호출).
  //   fresnel(기본): uRimScale 마스터만 토글 — 매 프레임 씬 재렌더가 없어 성능 부담 없음
  //     (구 방식의 'RimPass OFF = 지오 2배 제출 회피' 이유 소멸). flare depth 는 rim 과 독립
  //     (FlarePass 자체 렌더)이라 rim OFF 시 flare 스테일 depth 결합 함정(#75)도 없음.
  //   pass(?rim=pass): 구 방식 rimPass.enabled 토글 — 이 경우 rim OFF 시 flare depth 스테일이라
  //     engine 이 flare 도 동반 OFF 해야 한다(setPostFocus 가 이미 그렇게 함).
  function setRimEnabled(on) {
    rimOn = !!on;
    if (useFresnel) updateRimScale();
    else rimPass.enabled = !!on;
  }

  // 초기 재질 패치(scene 에 이미 건물이 있으면 즉시). 이후 update() 의 throttle 스캔이 self-heal.
  if (useFresnel) fresnelRim.apply(scene);

  // 검증 하네스 훅(window.__wx 패턴과 동일). 결정론 캡처에서 날씨·강도를 직접 구동·판독.
  let flareDebug = null;
  let rimDebug = null;
  let aaDebug = null;
  if (typeof window !== 'undefined') {
    flareDebug = {
      setWeather,
      get sunUV() { const u = flarePass.uniforms.sunUV.value; return [u.x, u.y]; },
      get amt() { return flarePass.uniforms.flareAmt.value; },
      get front() { return flarePass.uniforms.sunFront.value; },
      setEnabled: setFlareEnabled,
    };
    window.__flare = flareDebug;
    // #76/#101 검증 훅: 림 모드·강도·패치수·재질군 커버리지·마스터 스케일 판독 + 재스캔 강제.
    rimDebug = {
      mode: RIM_MODE,
      get patched() { return fresnelRim ? fresnelRim.patchedCount : 0; },
      get coverage() { return fresnelRim ? fresnelRim.coverage : null; },  // + cloudShadow/cloudRoof composition
      get groupMultipliers() { return fresnelRim ? fresnelRim.groupMultipliers : null; },
      get strength() { return useFresnel ? fresnelRim.uniforms.uRimStrength.value : (rimPass ? rimPass.uniforms.rimStrength.value : 0); },
      get scale() { return useFresnel ? fresnelRim.uniforms.uRimScale.value : (rimPass && rimPass.enabled ? 1 : 0); },
      get near() { return useFresnel ? fresnelRim.uniforms.uRimNear.value : null; },
      get far() { return useFresnel ? fresnelRim.uniforms.uRimFar.value : null; },
      setEnabled: setRimEnabled,
      rescan() { if (fresnelRim) fresnelRim.apply(scene); },
      drawCalls() { return renderer.info.render.calls; },
    };
    window.__rim = rimDebug;
    // AA 판독 훅: 게이트가 samples·타깃 할당·해상도를 같은 URL 에서 직접 읽는다(`?msaa=0` A/B).
    aaDebug = {
      get samples() { return renderPass.samples; },
      get allocated() { return renderPass.allocated; },
      get resolveCount() { return renderPass.resolveCount; },
      get sampleBytes() { return renderPass.sampleBytes; },
      get pixelRatio() { return renderer.getPixelRatio(); },
      get width() { return renderPass.target?.width ?? composer.renderTarget1.width; },
      get height() { return renderPass.target?.height ?? composer.renderTarget1.height; },
      maxSamples: renderer.capabilities?.maxSamples ?? 0,
      // 같은 페이지에서 회귀 상태를 뒤집는 A/B 훅 — 재로딩 짝은 도착 돌리·구름 표류가 달라져
      //   AA 만의 차이를 분리하지 못한다(msaa-render-pass.js setSamples 주석).
      setSamples: (n) => renderPass.setSamples(resolveMsaaSamples(renderer, n)),
    };
    window.__aa = aaDebug;
  }

  return {
    composer, setTime, setSunsetLook, setSize, setFillScale, update,
    // 기하 에지 MSAA 판독(게이트·하네스). 0 = stock RenderPass 회귀 상태.
    //   setSamples 로 런타임 교체될 수 있으므로 라이브 getter 다.
    get msaaSamples() { return renderPass.samples; },
    get fillScale() { return fillScale; },
    setDof, setDofAmount, setDofAperture, setDofTilt, setDofAmountFloor,
    setFocus, setFocusPoint,
    setEnabled, setWeather, setFlareEnabled, setRimEnabled,
    renderPass, gradePass, bloomPass, rimPass, flarePass, bokehPass, outputPass,
    sunGlow, fresnelRim,
    dof,
    get sunsetLook() { return sunsetLook; },
    // 마을 리롤·focus-in 오버레이 직후 명시 재패치용(선택 — update() throttle 스캔이 이미 self-heal).
    rimRescan(root = scene) { if (fresnelRim) fresnelRim.apply(root); },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(sunGlow);
      renderPass.dispose();
      if (rimPass) rimPass.dispose();
      if (gradePass) gradePass.dispose();
      if (fresnelRim) fresnelRim.dispose();
      flarePass.dispose();
      bloomPass.dispose();
      bokehPass.dispose();
      outputPass.dispose();
      glowTex.dispose();
      sunGlow.material.dispose();
      composer.dispose();
      if (typeof window !== 'undefined') {
        if (window.__flare === flareDebug) delete window.__flare;
        if (window.__rim === rimDebug) delete window.__rim;
        if (window.__aa === aaDebug) delete window.__aa;
      }
    },
  };
}
