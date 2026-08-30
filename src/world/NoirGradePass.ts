import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * 수묵 목판화 그레이드 — the indie commitment: the whole world renders as
 * a night painting on hanji. Silhouettes get inked edges (Sobel lines, the
 * woodblock cut), blacks are paper-toned ink rather than void, paper fiber
 * grain, and only the seal red survives — like a 낙관 stamp on the print.
 * Runs after the cheoma OutputPass on the sRGB buffer (perceptual space).
 */
const NoirGradeShader = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    uTime: { value: 0 },
    uResolution: { value: [1280, 720] },
    // Event-driven chromatic aberration (impacts, slow-mo). Decays in World.
    uAberration: { value: 0 },
    // Blood Night: the world itself turns red when the gate is failing.
    uBloodNight: { value: 0 },
    // 새벽 장 — the dawn ceremony wash: gold paper, amber air. Animated in
    // World toward setTimeOfDay's target so the break eases in and out.
    uDawn: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uAberration;
    uniform float uBloodNight;
    uniform float uDawn;
    varying vec2 vUv;

    float hashNoise(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    float luma(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec2 q0 = (vUv - 0.5) * vec2(1.15, 1.0);
      // Brief radial RGB split, strongest at the frame edge — an impact
      // lens kick, never a permanent smear.
      float split = uAberration * 0.006 * dot(q0, q0) * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + q0 * split).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - q0 * split).b;

      // ── Ink cut: forward-difference edges that carve woodblock lines
      // where silhouettes meet. Two extra taps — a print, not a photo
      // filter, and cheap enough for the DPR-2 buffer. ──
      vec2 texel = 1.0 / uResolution;
      float l0 = luma(col);
      float lx1 = luma(texture2D(tDiffuse, vUv + vec2(texel.x * 1.5, 0.0)).rgb);
      float ly1 = luma(texture2D(tDiffuse, vUv + vec2(0.0, texel.y * 1.5)).rgb);
      float gx = lx1 - l0;
      float gy = ly1 - l0;
      float edge = clamp((abs(gx) + abs(gy)) * 3.4 - 0.05, 0.0, 1.0);
      edge = edge * edge;

      // ── Warm-neon family: seal reds AND demon magentas/violets survive
      // the print (KDH demon palette); greens, cyans and whites fall to
      // ink. Dominance is R-over-G, so magenta keeps its violet edge. ──
      float mx = max(col.r, max(col.g, col.b));
      float mn = min(col.r, min(col.g, col.b));
      float sat = mx - mn;
      float warmDom = (col.r - col.g) / max(mx, 1e-4);
      float keep = smoothstep(0.16, 0.42, sat) * smoothstep(0.20, 0.52, warmDom);

      // ── Ink on hanji: paper-toned ink, not void. Highlights carry the
      // warmth of aged paper; the print breathes. The toe stays open enough
      // that unlit facades read as silhouettes, not holes (the old pivot
      // crushed every input under ~0.12 luma into paper-black). ──
      float y = luma(col);
      y = y * 1.38 + 0.12;
      float g = clamp((y - 0.235) * 1.26 + 0.26, 0.0, 1.0);
      g = g * g * (3.0 - 2.0 * g);
      // The carve: strong edges inked toward black, mid edges left to the
      // print so faces and ground stay soft brushwork.
      g = mix(g, g * 0.22, edge);
      vec3 paper = vec3(1.02, 0.99, 0.93);
      vec3 mono = vec3(g) * paper;

      // ── Blood Night: when the gate is failing, the inversion the whole
      // look has been promising — the print drowns in red. Whites survive
      // as bone-white so silhouettes stay readable. ──
      vec3 blood = vec3(g) * vec3(1.35, 0.22, 0.18) + vec3(0.05, 0.0, 0.0);
      mono = mix(mono, blood, clamp(uBloodNight, 0.0, 1.0) * 0.85);

      // ── 새벽 장: first light on the same print — gold hanji, amber air.
      // The woodblock survives; the paper warms AND lifts (night pixels
      // get a sunlit floor, not a tint) so the break reads in one glance. ──
      float gd = clamp(g * 1.18 + 0.15, 0.0, 1.0);
      vec3 dawnTint = gd * vec3(1.08, 0.9, 0.66) + vec3(0.05, 0.02, 0.0);
      mono = mix(mono, dawnTint, clamp(uDawn, 0.0, 1.0) * 0.94);

      // Kept neon is enriched — hotter than the source pixel, but the
      // violet channel survives so collars read magenta, blood stays red.
      // At dawn the neon calms toward sunlight so it stays part of the
      // same world instead of fighting the wash.
      vec3 neon = col * mix(vec3(1.35, 0.55, 1.0), vec3(1.22, 0.95, 0.86), uDawn);

      vec3 graded = mix(mono, neon, keep * mix(0.96, 0.82, uDawn));

      // ── Vignette: the print's margin, brushed dark. ──
      vec2 q = (vUv - 0.5) * vec2(1.15, 1.0);
      float vig = 1.0 - smoothstep(0.42, 1.3, dot(q, q) * 2.6);
      vec3 vigColor = mix(vec3(0.42, 0.42, 0.42), vec3(0.55, 0.1, 0.1), clamp(uBloodNight, 0.0, 1.0));
      vigColor = mix(vigColor, vec3(0.55, 0.44, 0.32), clamp(uDawn, 0.0, 1.0));
      graded *= mix(vigColor, vec3(1.0), vig);

      // ── Paper fiber grain: two crossed noises, salted heavier in the
      // shadows — hanji tooth instead of film hiss. ──
      float grain = hashNoise(vUv * uResolution + vec2(uTime * 127.1, uTime * 311.7));
      float fiber = hashNoise(vUv * uResolution * vec2(0.22, 1.0) + vec2(uTime * 89.0, 0.0));
      graded += (grain - 0.5) * 0.05 * (1.0 - g * 0.55);
      graded += (fiber - 0.5) * 0.02 * (1.0 - g * 0.7);

      gl_FragColor = vec4(clamp(graded, 0.0, 1.0), 1.0);
    }
  `,
};

export type NoirGradePass = ShaderPass & {
  uniforms: {
    tDiffuse: { value: unknown };
    uTime: { value: number };
    uResolution: { value: [number, number] | { x: number; y: number } };
    uAberration: { value: number };
    uBloodNight: { value: number };
    uDawn: { value: number };
  };
};

export function createNoirGradePass(): NoirGradePass {
  return new ShaderPass(NoirGradeShader) as NoirGradePass;
}

export function updateNoirGradePass(pass: NoirGradePass, dt: number): void {
  pass.uniforms.uTime.value += dt;
  // Aberration decays toward zero; events spike it via setAberration.
  const current = pass.uniforms.uAberration.value;
  pass.uniforms.uAberration.value = Math.max(0, current - dt * 2.6);
}

/** Spike the impact chromatic kick (adds to the current value, capped). */
export function setAberration(pass: NoirGradePass, amount: number): void {
  pass.uniforms.uAberration.value = Math.min(2.4, pass.uniforms.uAberration.value + amount);
}

export function setNoirGradeResolution(pass: NoirGradePass, width: number, height: number): void {
  pass.uniforms.uResolution.value = [Math.max(1, width), Math.max(1, height)];
}
