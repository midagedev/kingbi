// 컴포저 경로 MSAA 복원 — 기하 에지 안티에일리어싱.
//
// 배경(회귀): `new THREE.WebGLRenderer({ antialias: true })` 는 **기본 프레임버퍼에만** MSAA 를
//   건다. 컴포저가 켜지면 씬은 오프스크린 렌더타깃에 그려지고 캔버스에는 톤매핑된 풀스크린
//   쿼드만 얹히므로, 렌더러의 antialias 플래그는 아무 일도 하지 않는다. three 의
//   `EffectComposer` 는 기본 타깃을 `{ type: HalfFloatType }` 로만 만들고 `samples` 를 주지
//   않는다(three 0.185.1 `EffectComposer.js` 생성자) → samples=0 → 제품 화면 전체가 AA 없이
//   렌더된다. 이 패스가 그 구멍을 막는다.
//
// 왜 컴포저 핑퐁 타깃에 samples 를 주지 않는가:
//   `EffectComposer` 는 rt1/rt2 를 번갈아 쓰고, `renderTarget2 = renderTarget.clone()` 이라
//   생성자에 멀티샘플 타깃을 넘기면 **두 타깃 모두** 멀티샘플이 된다. 그러면 씬 렌더뿐 아니라
//   Grade/Bokeh/Bloom/Flare/Outline 의 모든 풀스크린 쿼드가 멀티샘플 타깃에 쓰이고 매번
//   resolve 가 붙는다(픽셀당 write 4배 + resolve read/write). 에지가 없는 풀스크린 쿼드에는
//   아무 이득이 없는 순수 낭비다. 그래서 **씬 렌더 전용** 멀티샘플 타깃 하나만 소유하고,
//   resolve 결과를 stock `RenderPass` 와 동일한 버퍼에 한 번 blit 한다.
//
// 계약 보존: three 의 `RenderPass` 는 `needsSwap = false` 이고 씬을 **readBuffer** 에 그린다
//   (three 0.185.1 `RenderPass.render`: `renderer.setRenderTarget(this.renderToScreen ? null : readBuffer)`).
//   이 패스도 최종적으로 readBuffer 에 해상된 씬을 남기고 스왑하지 않으므로, 뒤에 어떤 패스가
//   어디에 삽입되어도(수묵 sourcePass·OutlinePass·DoF CoC) 종전과 동일하게 동작한다.
//   추가 비용은 풀해상도 blit 1회뿐이다.
//
// samples=0 이면 stock 경로로 완전히 되돌아간다(회귀 상태 A/B·게이트 기준선).
import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// 디바이스 프로파일 기본값. 데스크톱 4x, 폰(compact) 2x.
//   폰을 2 로 두는 이유는 필레이트가 아니라 메모리다: 멀티샘플 컬러 renderbuffer 는
//   픽셀당 8B(HalfFloat RGBA) × samples 로, DPR 2 × 4x 면 씬 타깃 하나가 그림자맵보다 커진다.
//   iOS Safari 의 문서화되지 않은 WebGL 메모리 상한(engine.js SHADOW_SIZE 주석과 같은 제약)에서
//   컨텍스트 소실 위험이 있어 폰은 2x 로 멈춘다.
export const MSAA_SAMPLES_DESKTOP = 4;
export const MSAA_SAMPLES_COMPACT = 2;

/** 요청 샘플 수를 하드웨어 상한으로 클램프. 0/음수/NaN → 0(MSAA 비활성). */
export function resolveMsaaSamples(renderer, requested) {
  const want = Math.floor(Number(requested));
  if (!Number.isFinite(want) || want <= 1) return 0;
  const max = renderer?.capabilities?.maxSamples;
  const cap = Number.isFinite(max) ? Math.floor(max) : 0;
  if (cap <= 1) return 0;
  return Math.min(want, cap);
}

// 해상된 멀티샘플 텍스처를 그대로 옮기는 패스스루. 톤매핑·색공간 변환 청크를 포함하지 않으므로
//   선형 HDR 값이 비트 그대로 넘어간다(OutputPass 가 마지막에 한 번만 ACES+sRGB 를 적용하는
//   계약 불침해).
const ResolveShader = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
  `,
};

export class MsaaRenderPass extends RenderPass {
  constructor(scene, camera, { samples = 0 } = {}) {
    super(scene, camera);
    const want = Math.floor(Number(samples));
    this.samples = Number.isFinite(want) && want > 1 ? want : 0;
    this._width = 1;
    this._height = 1;
    this._target = null;          // 지연 할당 — samples=0 이면 영구 미할당
    this._resolveUniforms = null;
    this._resolveMaterial = null;
    this._resolveQuad = null;
    this._resolveCount = 0;
  }

  /** 게이트·하네스 판독용. */
  get allocated() { return !!this._target; }
  get target() { return this._target; }
  get resolveCount() { return this._resolveCount; }
  /** 멀티샘플 컬러 renderbuffer 의 바이트 추정(깊이·resolve 텍스처 제외). */
  get sampleBytes() {
    if (!this._target || this.samples <= 0) return 0;
    return this._target.width * this._target.height * 8 * this.samples;
  }

  setSize(width, height) {
    this._width = Math.max(1, Math.floor(width));
    this._height = Math.max(1, Math.floor(height));
    if (this._target) this._target.setSize(this._width, this._height);
  }

  /**
   * 샘플 수를 런타임에 교체한다(검증 A/B 전용).
   *
   * A/B 증거의 통제변수 때문에 필요하다: `?msaa=0` 재로딩으로 짝을 찍으면 두 컷 사이에 마을
   * 도착 돌리와 구름 표류가 각각 다른 실시간만큼 진행되어 카메라 구도와 구름 그림자가 함께
   * 달라진다(그 상태로는 AA 만의 차이를 분리할 수 없다). 같은 페이지에서 이 훅으로 뒤집으면
   * 두 컷이 수십 ms 안에 찍혀 카메라·구름·환경 트윈이 실질적으로 동일하다.
   *
   * samples 는 타깃 할당에 굳어 있으므로 타깃만 버리고 다음 프레임에 재할당한다. 풀스크린
   * 쿼드·재질은 유지하므로 프로그램이 죽어 재컴파일되지 않는다(오버레이 프로그램 수명 규칙).
   */
  setSamples(samples) {
    const want = Math.floor(Number(samples));
    const next = Number.isFinite(want) && want > 1 ? want : 0;
    if (next === this.samples) return this.samples;
    this.samples = next;
    if (this._target) { this._target.dispose(); this._target = null; }
    return this.samples;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // 화면 직접 렌더(체인의 마지막 유효 패스)에는 기본 프레임버퍼의 렌더러 antialias 가
    //   이미 살아 있으므로 stock 경로가 맞다.
    if (this.samples <= 0 || this.renderToScreen || !readBuffer) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const target = this._ensureTarget(readBuffer);
    // stock RenderPass 의 clearColor/clearAlpha/overrideMaterial/autoClear 처리를 그대로 재사용.
    //   목적지만 멀티샘플 타깃으로 바꿔 넘긴다.
    super.render(renderer, writeBuffer, target, deltaTime, maskActive);
    // setRenderTarget 이 멀티샘플 FBO 를 풀 때 three 가 glBlitFramebuffer 로 resolve 한다
    //   (WebGLTextures.updateMultisampleRenderTarget). 여기서는 해상된 텍스처를 읽는다.
    this._resolveUniforms.tDiffuse.value = target.texture;
    renderer.setRenderTarget(readBuffer);
    this._resolveQuad.render(renderer);
    this._resolveCount++;
  }

  _ensureTarget(readBuffer) {
    if (this._target) return this._target;
    const texture = readBuffer.texture;
    // 컴포저 핑퐁 버퍼와 포맷을 정확히 일치시킨다. HalfFloat 선형 HDR 이 bloom 의 전제이므로
    //   여기서 포맷을 낮추면 플래그십 룩이 깨진다(post.js 컴포저 주석).
    this._target = new THREE.WebGLRenderTarget(this._width, this._height, {
      type: texture.type,
      format: texture.format,
      colorSpace: texture.colorSpace,
      minFilter: texture.minFilter,
      magFilter: texture.magFilter,
      depthBuffer: readBuffer.depthBuffer !== false,
      stencilBuffer: readBuffer.stencilBuffer === true,
      samples: this.samples,
    });
    this._target.texture.name = 'MsaaRenderPass.scene';
    if (this._resolveQuad) return this._target;   // setSamples 재할당 — 쿼드/프로그램은 유지
    this._resolveUniforms = { tDiffuse: { value: null } };
    this._resolveMaterial = new THREE.ShaderMaterial({
      uniforms: this._resolveUniforms,
      vertexShader: ResolveShader.vertexShader,
      fragmentShader: ResolveShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._resolveQuad = new FullScreenQuad(this._resolveMaterial);
    return this._target;
  }

  dispose() {
    if (this._target) { this._target.dispose(); this._target = null; }
    if (this._resolveQuad) { this._resolveQuad.dispose(); this._resolveQuad = null; }
    if (this._resolveMaterial) { this._resolveMaterial.dispose(); this._resolveMaterial = null; }
    this._resolveUniforms = null;
  }
}
