import * as THREE from 'three';
import { createAudioScope, makeWhiteNoise, poissonInterval } from './synth.js';

// 마당 개 짖는 소리 — 위치성(PositionalAudio). 개의 라이브 위치(getAnchor)를 따라다닌다.
//   createDog(listener, { getAnchor, getState, rand }) →
//     { object, setEnabled(v), setVolume(v), bark(), update(dt), start(), dispose() }
//
// 근거리용으로 톤 정리: 딜레이 리버브를 옅게(짧은 테일)만 남기고, 성대 톤(2 디튠 톱니)에
// 포먼트(peaking 700Hz)로 "몸통"을 주어 시골 마당 개의 "월! 월!" 2~3연.
// 촉발: dogState 가 'sitting' 으로 바뀐 직후 60% 확률 + 그 외 포아송 평균 60s(드물게).

export function createDog(listener, { getAnchor, getState, rand = Math.random } = {}) {
  const ctx = listener.context;
  const scope = createAudioScope();

  const pa = new THREE.PositionalAudio(listener);
  pa.setDistanceModel('inverse');
  pa.setRefDistance(5);
  pa.setRolloffFactor(1.2);
  pa.setMaxDistance(50);

  const out = ctx.createGain();
  out.gain.value = 0;
  pa.setNodeSource(out);

  // 드라이 버스 + 옅은 리버브 테일(근거리라 원경 에코는 절제)
  const barkBus = ctx.createGain();
  barkBus.gain.value = 1;
  barkBus.connect(out);
  const delay = ctx.createDelay(0.5);
  delay.delayTime.value = 0.11;
  const fb = ctx.createGain(); fb.gain.value = 0.12;
  const wet = ctx.createGain(); wet.gain.value = 0.18;
  barkBus.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(out);

  // 성대 톤 포먼트 체인(몸통감)
  const voiceLP = ctx.createBiquadFilter();
  voiceLP.type = 'lowpass'; voiceLP.frequency.value = 1600;
  const voicePk = ctx.createBiquadFilter();
  voicePk.type = 'peaking'; voicePk.frequency.value = 700; voicePk.Q.value = 1; voicePk.gain.value = 6;
  voiceLP.connect(voicePk); voicePk.connect(barkBus);
  scope.track(out, pa.panner, pa.gain, barkBus, delay, fb, wet, voiceLP, voicePk);

  function woof(when, amp, pitch) {
    const sources = [];
    const nodes = [];
    // 성대: 2 디튠 톱니, 피치 컨투어(빠른 상승 후 하강) — "워우"
    for (const det of [1, 1.006]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(pitch * 0.8 * det, when);
      osc.frequency.linearRampToValueAtTime(pitch * 1.15 * det, when + 0.03);
      osc.frequency.exponentialRampToValueAtTime(pitch * 0.62 * det, when + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(amp, when + 0.012);
      g.gain.setTargetAtTime(0.0001, when + 0.06, 0.05);
      osc.connect(g); g.connect(voiceLP);
      osc.start(when); osc.stop(when + 0.4);
      sources.push(osc);
      nodes.push(g);
    }
    // 어택 노이즈("워"의 자음) — 포먼트 우회, 짧고 또렷
    const nb = ctx.createBufferSource();
    nb.buffer = makeWhiteNoise(ctx, 0.05, 1);
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass'; nbp.frequency.value = 1100; nbp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, when);
    ng.gain.linearRampToValueAtTime(amp * 0.5, when + 0.004);
    ng.gain.setTargetAtTime(0.0001, when + 0.01, 0.02);
    nb.connect(nbp); nbp.connect(ng); ng.connect(barkBus);
    nb.start(when); nb.stop(when + 0.06);
    sources.push(nb);
    nodes.push(nbp, ng);
    scope.trackVoice(sources, nodes);
  }

  function barkPhrase() {
    const n = 2 + Math.floor(rand() * 2);          // 2~3연
    const pitch = 250 + rand() * 90;               // 개체 음역
    let when = ctx.currentTime + 0.03;
    for (let i = 0; i < n; i++) {
      const amp = 0.22 * (1 - i * 0.12) * (0.85 + rand() * 0.15); // 뒤로 갈수록 살짝 여림
      woof(when, amp, pitch * (0.97 + rand() * 0.06));
      when += 0.28 + rand() * 0.16;
    }
  }

  let started = false;
  let disposed = false;
  let enabled = false;
  let volume = 1;
  let prevState = null;
  let nextBg = 30 + rand() * 40; // 배경 포아송 카운트다운(초)
  const pending = [];            // 짖을 절대 시각(ctx time) 큐

  function push() { if (!disposed) out.gain.setTargetAtTime(enabled ? volume : 0, ctx.currentTime, 0.2); }

  function update(dt) {
    if (!started || disposed) return;
    // 개가 걸어다니므로 매 프레임 panner 위치 갱신(라이브 앵커)
    const a = getAnchor && getAnchor();
    if (a) { pa.position.copy(a); pa.updateMatrixWorld(); }
    if (!enabled) { prevState = getState && getState(); return; }

    // 앉는 순간(walking→sitting) 60% 확률로 곧 짖는다(개가 자리 잡고 경계)
    const s = getState && getState();
    if (prevState !== 'sitting' && s === 'sitting' && rand() < 0.6) {
      pending.push(ctx.currentTime + 0.4 + rand() * 0.9);
    }
    prevState = s;

    // 배경(상태 무관) 드문 짖음
    nextBg -= dt;
    if (nextBg <= 0) { pending.push(ctx.currentTime + 0.05); nextBg = poissonInterval(60, 25, 120, rand); }

    while (pending.length && ctx.currentTime >= pending[0]) { barkPhrase(); pending.shift(); }
  }

  return {
    object: pa,
    getState() {
      return {
        started, disposed, enabled,
        gain: +out.gain.value.toFixed(6), volume: +volume.toFixed(4),
        pending: pending.length,
      };
    },
    setEnabled(v) { if (disposed) return; enabled = !!v; push(); },
    setVolume(v) { if (disposed) return; volume = Math.max(0, v); push(); },
    bark() { if (!disposed) barkPhrase(); }, // 테스트용 즉시 짖음
    update,
    start() { if (started || disposed) return; started = true; push(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      enabled = false;
      pending.length = 0;
      try { out.gain.setValueAtTime(0, ctx.currentTime); } catch {}
      try { pa.disconnect(); } catch {}
      pa.removeFromParent();
      scope.dispose();
    },
  };
}
