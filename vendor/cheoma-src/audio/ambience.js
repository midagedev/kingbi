import { createAudioScope, makePinkNoise, makeWhiteNoise, playBuffer, poissonInterval } from './synth.js';

// 환경음 — 전부 합성. 시간대·날씨·바람 세기에 따라 각 레이어의 목표 레벨이 바뀌고
// update(dt)에서 부드럽게 이징한다. 지속음(바람·비·귀뚜라미)은 native LFO 로 흔들고,
// 간헐음(새·소쩍새·낙숫물·개)은 update()의 포아송 스케줄러로 촉발한다.
//
//   createAmbience(listener, { layout, rand, destination }) →
//     { setTime(name), setWeather(name), setWindiness(w), update(dt), start(), dispose() }
//   destination: 이 레이어 전체가 연결될 노드(환경음 마스터 게인).

export function createAmbience(listener, { layout, rand = Math.random, destination } = {}) {
  const ctx = listener.context;
  const out = destination || ctx.destination;
  const scope = createAudioScope();

  let started = false;
  let disposed = false;
  let windiness = 0.15;
  let time = 'day';
  let weather = 'clear';

  // 각 레이어: cur(현재 레벨), tgt(목표 레벨). update 에서 tau 로 수렴.
  const layers = [];
  function ease(cur, tgt, dt, tau) { return cur + (tgt - cur) * Math.min(1, dt / tau); }

  // ---------- 바람 (핑크 노이즈 + lowpass, LFO 로 게인·컷오프 요동) ----------
  const wind = (() => {
    const buf = makePinkNoise(ctx, 3, 2);
    const src = playBuffer(ctx, buf, null, { loop: true });
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(lp); lp.connect(g); g.connect(out);

    // 컷오프 LFO(느린 숨결) — 400~760Hz 사이 요동
    const cutLfo = ctx.createOscillator();
    cutLfo.frequency.value = 0.07;
    const cutDepth = ctx.createGain();
    cutDepth.gain.value = 180;
    cutLfo.connect(cutDepth); cutDepth.connect(lp.frequency);
    scope.trackVoice([src, cutLfo], [lp, g, cutDepth]);

    return {
      start() { src.start(); cutLfo.start(); },
      cur: 0, tgt: 0,
      update(dt) {
        // 목표: windiness 로 게인/컷오프 상향
        this.tgt = 0.04 + windiness * 0.32;
        this.cur = ease(this.cur, this.tgt, dt, 1.2);
        g.gain.setTargetAtTime(this.cur, ctx.currentTime, 0.1);
        cutLfo.frequency.setTargetAtTime(0.05 + windiness * 0.12, ctx.currentTime, 0.5);
      },
    };
  })();
  layers.push(wind);

  // ---------- 새소리 (낮·새벽 간헐 치프) ----------
  // 짧은 FM 스윕(2.6~3.6kHz), 2~3회 프레이즈, 좌우 랜덤 패닝.
  const birds = (() => {
    let level = 0, tgt = 0, nextT = 0;
    function chirp(when, pan, f0) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const t = when;
      osc.frequency.setValueAtTime(f0 * 0.82, t);
      osc.frequency.linearRampToValueAtTime(f0 * 1.12, t + 0.03);
      osc.frequency.linearRampToValueAtTime(f0 * 0.95, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16 * level, t + 0.006);
      g.gain.setTargetAtTime(0.0001, t + 0.02, 0.03);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      osc.connect(g); g.connect(p); p.connect(out);
      osc.start(t); osc.stop(t + 0.2);
      scope.trackVoice([osc], [g, p]);
    }
    function phrase() {
      const pan = (rand() * 2 - 1) * 0.8;
      const f0 = 2600 + rand() * 1000;
      const n = 2 + Math.floor(rand() * 2);
      const now = ctx.currentTime + 0.02;
      for (let i = 0; i < n; i++) chirp(now + i * (0.11 + rand() * 0.08), pan, f0 * (1 + i * 0.02));
    }
    return {
      set tgt(v) { tgt = v; }, get tgt() { return tgt; },
      cur: 0,
      update(dt) {
        level = ease(level, tgt, dt, 1.5); this.cur = level;
        if (level < 0.02) return;
        if (ctx.currentTime >= nextT) {
          phrase();
          // 활동이 높을수록 촘촘히
          const mean = 6.5 - level * 4;
          nextT = ctx.currentTime + poissonInterval(mean, 1.2, 14, rand);
        }
      },
    };
  })();
  layers.push(birds);

  // ---------- 귀뚜라미 (밤) — 고정 4.2kHz 진폭변조 펄스열 ----------
  const crickets = (() => {
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(out);
    scope.track(master);
    const sources = [];
    // 두 개체 살짝 디튠
    for (const f of [4180, 4270]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const vca = ctx.createGain();
      vca.gain.value = 0;
      // 빠른 스트리듈레이션(트릴) LFO
      const trill = ctx.createOscillator();
      trill.type = 'square';
      trill.frequency.value = 26 + rand() * 4;
      const trillDepth = ctx.createGain();
      trillDepth.gain.value = 0.5;
      const trillOff = ctx.createConstantSource();
      trillOff.offset.value = 0.5;
      trill.connect(trillDepth); trillDepth.connect(vca.gain); trillOff.connect(vca.gain);
      osc.connect(vca); vca.connect(master);
      sources.push(osc, trill, trillOff);
      scope.trackVoice([osc, trill, trillOff], [vca, trillDepth]);
    }
    let level = 0, tgt = 0;
    return {
      start() { for (const source of sources) source.start(); },
      set tgt(v) { tgt = v; }, get tgt() { return tgt; },
      cur: 0,
      update(dt) { level = ease(level, tgt, dt, 2.0); this.cur = level; master.gain.setTargetAtTime(level * 0.06, ctx.currentTime, 0.2); },
    };
  })();
  layers.push(crickets);

  // ---------- 소쩍새 풍 (밤) — 낮은 2음 "후- 후-" ----------
  const owl = (() => {
    let level = 0, tgt = 0, nextT = 0;
    function hoot(when, f) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, when);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.12 * level, when + 0.05);
      g.gain.setTargetAtTime(0.0001, when + 0.12, 0.12);
      osc.connect(g); g.connect(out);
      osc.start(when); osc.stop(when + 0.7);
      scope.trackVoice([osc], [g]);
    }
    return {
      set tgt(v) { tgt = v; }, get tgt() { return tgt; },
      cur: 0,
      update(dt) {
        level = ease(level, tgt, dt, 2.0); this.cur = level;
        if (level < 0.05) return;
        if (ctx.currentTime >= nextT) {
          const now = ctx.currentTime + 0.05;
          hoot(now, 430); hoot(now + 0.42, 400); // 두 음, 두 번째 살짝 낮게
          nextT = ctx.currentTime + poissonInterval(11, 5, 26, rand);
        }
      },
    };
  })();
  layers.push(owl);

  // ---------- 비 (광대역 노이즈 샤워 + highshelf 감쇠) ----------
  const rain = (() => {
    const buf = makeWhiteNoise(ctx, 2.5, 2);
    const src = playBuffer(ctx, buf, null, { loop: true });
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 7000; lp.Q.value = 0.4;
    const hs = ctx.createBiquadFilter();
    hs.type = 'highshelf'; hs.frequency.value = 3500; hs.gain.value = -14; // 거센 고역 감쇠
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 400;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(hs); hs.connect(g); g.connect(out);
    scope.trackVoice([src], [hp, lp, hs, g]);
    let level = 0, tgt = 0;
    return {
      start() { src.start(); },
      set tgt(v) { tgt = v; }, get tgt() { return tgt; },
      cur: 0,
      update(dt) { level = ease(level, tgt, dt, 0.9); this.cur = level; g.gain.setTargetAtTime(level * 0.2, ctx.currentTime, 0.15); },
    };
  })();
  layers.push(rain);

  // ---------- 처마 낙숫물 (비올 때) — 짧은 밴드패스 핑 ----------
  const drips = (() => {
    let level = 0, tgt = 0, nextT = 0;
    function plink(when) {
      const src = ctx.createBufferSource();
      src.buffer = makeWhiteNoise(ctx, 0.06, 1);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200 + rand() * 1400;
      bp.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.09 * level, when + 0.002);
      g.gain.setTargetAtTime(0.0001, when + 0.004, 0.03);
      const p = ctx.createStereoPanner();
      p.pan.value = (rand() * 2 - 1) * 0.7;
      src.connect(bp); bp.connect(g); g.connect(p); p.connect(out);
      src.start(when); src.stop(when + 0.08);
      scope.trackVoice([src], [bp, g, p]);
    }
    return {
      set tgt(v) { tgt = v; }, get tgt() { return tgt; },
      cur: 0,
      update(dt) {
        level = ease(level, tgt, dt, 0.9); this.cur = level;
        if (level < 0.05) return;
        if (ctx.currentTime >= nextT) {
          plink(ctx.currentTime + 0.01);
          nextT = ctx.currentTime + poissonInterval(0.5, 0.08, 1.6, rand); // 촘촘한 낙숫물
        }
      },
    };
  })();
  layers.push(drips);

  // 개 짖는 소리는 마당의 실제 개 위치(env.dogAnchor)에서 나는 위치성 사운드로 분리되어
  // src/audio/dog.js 가 담당한다(여기서는 무지향 개 레이어를 두지 않는다).

  // ---------- 시간대·날씨 → 레이어 목표 ----------
  function applyTargets() {
    const byTime = {
      dawn:   { birds: 0.9,  crickets: 0.12, owl: 0.15 },
      day:    { birds: 0.55, crickets: 0.0,  owl: 0.0 },
      sunset: { birds: 0.18, crickets: 0.28, owl: 0.25 },
      night:  { birds: 0.0,  crickets: 0.7,  owl: 0.7 },
    }[time] || {};
    const raining = weather === 'rain';
    const snowing = weather === 'snow';
    // 비/눈 오면 새·귀뚜라미는 잦아든다
    const damp = raining ? 0.25 : snowing ? 0.55 : 1;
    birds.tgt = (byTime.birds || 0) * damp;
    crickets.tgt = (byTime.crickets || 0) * damp;
    owl.tgt = (byTime.owl || 0) * damp;
    rain.tgt = raining ? 1 : 0;
    drips.tgt = raining ? 1 : 0;
  }

  // 무음 진단용 레이어 레벨 스냅샷(귀 없이 "환경음이 실제로 나고 있나"를 판정한다).
  const namedLayers = { wind, birds, crickets, owl, rain, drips };

  return {
    getState() {
      const levels = {};
      for (const [key, layer] of Object.entries(namedLayers)) levels[key] = +(layer.cur || 0).toFixed(5);
      return { started, disposed, time, weather, windiness: +windiness.toFixed(4), levels };
    },
    setTime(name) { if (disposed) return; time = name; applyTargets(); },
    setWeather(name) { if (disposed) return; weather = name; applyTargets(); },
    setWindiness(w) { if (disposed) return; windiness = Math.max(0, Math.min(1, w)); },
    update(dt) { if (!started || disposed) return; for (const l of layers) l.update(dt); },
    start() {
      if (started || disposed) return;
      started = true;
      wind.start(); crickets.start(); rain.start();
      applyTargets();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      scope.dispose();
    },
  };
}
