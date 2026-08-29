import * as THREE from 'three';
import { createAudioScope, makeWhiteNoise, playBuffer, poissonInterval } from './synth.js';

// 개울 물소리 — 위치성(PositionalAudio). 징검다리/개울 중심선 앵커에 앉힌다.
//   createStream(listener, { anchor, getAnchor, rand }) →
//     { object, setEnabled(v), setVolume(v), setWeather(name), update(dt), start(), dispose() }
//
// anchor: 초기 월드 좌표(정적). getAnchor: 라이브 getter(마을 모드 — 카메라/포커스 근처 개울 점).
// 개 짖음(dog.js)과 같이 getAnchor 가 있으면 update() 마다 panner 위치를 따라간다.
// getAnchor 가 null 을 주면 앵커 없음 → 게인 0 (드라이 마을·개울 없는 씬).
//
// 합성: 밴드패스 노이즈 물바닥(600~2500Hz, 흐름 요동 LFO) + 드문 물방울 플럭(짧은 사인 핑).
// refDistance 짧게(4) + 높은 rolloff → 개울 근처에서만 뚜렷, 멀어지면 빠르게 잦아든다.

// 물바닥(bed) 합성 그래프를 dest 에 연결. 실시간/오프라인(OfflineAudioContext) 공용.
// 반환 start() 로 노이즈·LFO 소스를 기동한다.
export function buildStreamBed(ctx, dest, { rand = Math.random } = {}) {
  const scope = createAudioScope();
  const noise = makeWhiteNoise(ctx, 2.5, 1);
  const src = playBuffer(ctx, noise, null, { loop: true });

  // 대역 한정: 저역 웅웅거림·고역 쉬익 제거 → 600~2500Hz 개울 대역만
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 600;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2500;
  // 흐르는 물의 중심 대역을 넓게 통과(낮은 Q)
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.7;
  const bedGain = ctx.createGain();
  bedGain.gain.value = 0.55;

  src.connect(hp); hp.connect(lp); lp.connect(bp); bp.connect(bedGain); bedGain.connect(dest);

  // 흐름 요동: 밴드패스 중심 주파수를 느리게 흔들어 물결의 살아있는 웅성임
  const fLfo = ctx.createOscillator();
  fLfo.frequency.value = 0.13 + rand() * 0.05;
  const fDepth = ctx.createGain();
  fDepth.gain.value = 320;
  fLfo.connect(fDepth); fDepth.connect(bp.frequency);

  // 게인 요동(잔물결 세기)
  const gLfo = ctx.createOscillator();
  gLfo.frequency.value = 0.21 + rand() * 0.06;
  const gDepth = ctx.createGain();
  gDepth.gain.value = 0.12;
  gLfo.connect(gDepth); gDepth.connect(bedGain.gain);
  scope.trackVoice([src, fLfo, gLfo], [hp, lp, bp, bedGain, fDepth, gDepth]);

  let started = false;
  let disposed = false;
  return {
    start() {
      if (started || disposed) return;
      started = true;
      src.start(); fLfo.start(); gLfo.start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scope.dispose();
    },
  };
}

export function createStream(listener, { anchor = null, getAnchor = null, rand = Math.random } = {}) {
  const ctx = listener.context;
  const scope = createAudioScope();

  const pa = new THREE.PositionalAudio(listener);
  pa.setDistanceModel('inverse');
  pa.setRefDistance(4);      // 개울 바로 곁에서 가장 크게
  pa.setRolloffFactor(1.4);  // 멀어지면 빠르게 감쇠(국소음)
  pa.setMaxDistance(60);

  // out = setNodeSource 대상(상시 연결). 물바닥·물방울이 모두 여기로 모인다.
  const out = ctx.createGain();
  out.gain.value = 0;
  pa.setNodeSource(out);
  scope.track(out, pa.panner, pa.gain);
  // Static seed position (solo-house path). Live path refreshes via getAnchor in update().
  let anchored = false;
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) && Number.isFinite(anchor.z)) {
    pa.position.copy(anchor);
    pa.updateMatrixWorld(true);
    anchored = true;
  }

  const bed = buildStreamBed(ctx, out, { rand });

  let started = false;
  let disposed = false;
  let enabled = false;   // 전체 사운드 ON && env ON 일 때만 true
  let volume = 1;        // ambience 볼륨 종속
  let weatherMul = 1;    // 눈(결빙) 시 0.25
  const BASE = 0.5;      // 개울 기본 레벨

  function target() { return (enabled && anchored) ? BASE * volume * weatherMul : 0; }
  function push() { if (!disposed) out.gain.setTargetAtTime(target(), ctx.currentTime, 0.3); }

  // 물방울 플럭 — 짧은 사인 핑, 드문드문
  let nextPlink = 0.6 + rand() * 1.2;
  function plink() {
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1500 + rand() * 1400, t);
    const g = ctx.createGain();
    const amp = 0.06 * volume * weatherMul * (0.6 + rand() * 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.004);
    g.gain.setTargetAtTime(0.0001, t + 0.006, 0.035);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + 0.25);
    scope.trackVoice([osc], [g]);
  }

  function syncAnchor() {
    if (!getAnchor) return;
    const a = getAnchor();
    if (a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)) {
      pa.position.set(a.x, a.y, a.z);
      if (!anchored) { anchored = true; push(); }
    } else if (anchored && !anchor) {
      // Live-only path lost its water (wave swap / dry site) — silence until re-anchored.
      anchored = false;
      push();
    }
  }

  function update(dt) {
    if (!started || disposed) return;
    syncAnchor();
    pa.updateMatrixWorld();
    if (enabled && anchored && weatherMul > 0.01) {
      nextPlink -= dt;
      if (nextPlink <= 0) { plink(); nextPlink = poissonInterval(1.1, 0.35, 3.0, rand); }
    }
  }

  return {
    object: pa,
    getState() {
      return {
        started, disposed, enabled, anchored,
        gain: +out.gain.value.toFixed(6), target: +target().toFixed(6),
        volume: +volume.toFixed(4), weatherMul,
        position: {
          x: +pa.position.x.toFixed(3),
          y: +pa.position.y.toFixed(3),
          z: +pa.position.z.toFixed(3),
        },
      };
    },
    setEnabled(v) { if (disposed) return; enabled = !!v; push(); },
    setVolume(v) { if (disposed) return; volume = Math.max(0, v); push(); },
    setWeather(name) { if (disposed) return; weatherMul = name === 'snow' ? 0.25 : 1; push(); },
    update,
    start() {
      if (started || disposed) return;
      started = true;
      syncAnchor();
      bed.start();
      push();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      try { out.gain.setValueAtTime(0, ctx.currentTime); } catch {}
      bed.dispose();
      try { pa.disconnect(); } catch {}
      pa.removeFromParent();
      scope.dispose();
    },
  };
}
