import { createAudioScope, equalPower } from './synth.js';
import { TIME_TRACK, OPTION_TRACKS } from './track-policy.js';

// BGM 크로스페이드 매니저. assets/audio/ 의 Suno 트랙을 시간대에 매핑하고
// setTime 시 4초 등파워 크로스페이드로 전환. 루프 재생, 기본 볼륨 낮게(환경음이 주인공).
// **트랙 이름 선택 규칙은 여기 없다** — src/audio/track-policy.js(순수 모듈) 소유.
//
//   createBgm(listener, { destination, baseUrl }) →
//     { play(name), setVolume(v), update(dt), getTracks(), getState(), start(), dispose() }
//   destination: BGM 마스터 게인(setupAudio 가 listener 입력에 연결).

const FADE = 4.0; // 크로스페이드 시간(초)
const BASE_GAIN = 0.2; // ≈ -14dB

// 저속·데이터 절약 연결에서는 "지금 필요한 트랙" 한 곡만 받는다. 시간대 4곡 선프리페치는
// ≈17MB 라 모바일 셀룰러에서 진입 트랙 자체를 굶긴다(사용자 신고: 모바일이 더 안 남).
function frugalNetwork() {
  if (typeof navigator === 'undefined') return false;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  if (c.saveData) return true;
  return ['slow-2g', '2g', '3g'].includes(c.effectiveType);
}

export function createBgm(listener, { destination, baseUrl = './assets/audio/' } = {}) {
  const ctx = listener.context;
  const scope = createAudioScope();
  const master = ctx.createGain();
  let volMul = 1; // setVolume 배수(1 → 기본 -14dB)
  master.gain.value = BASE_GAIN;
  master.connect(destination || ctx.destination);
  scope.track(master);

  const buffers = new Map();   // name → AudioBuffer
  const loading = new Map();   // name → Promise
  const failures = new Map();  // name → 실패 사유(무음 회귀를 진단·게이트에 노출)
  let started = false;
  let disposed = false;
  let currentName = null;
  let requestId = 0;
  const loadAbort = typeof AbortController === 'function' ? new AbortController() : null;

  // 재생 중인 보이스들. 각 { src, gain, from, to, p, dispose }(p: 페이드 진행 0..1)
  let voices = [];

  async function load(name) {
    if (disposed) return null;
    if (buffers.has(name)) return buffers.get(name);
    if (loading.has(name)) return loading.get(name);
    const p = (async () => {
      try {
        const res = await fetch(baseUrl + name + '.mp3', loadAbort ? { signal: loadAbort.signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (disposed) return null;
        const arr = await res.arrayBuffer();
        if (disposed) return null;
        const buf = await ctx.decodeAudioData(arr);
        if (disposed) return null;
        buffers.set(name, buf);
        failures.delete(name);
        return buf;
      } catch (e) {
        // mp3 디코드 실패(코덱 미지원 등)는 치명적이지 않다 — 무음으로 진행.
        // 다만 **조용히 삼키지 않는다**: getState().failures 로 노출해 게이트·진단이 무음 원인을 본다.
        if (!disposed && e?.name !== 'AbortError') {
          failures.set(name, (e && e.message) || String(e));
          console.warn('[bgm] load failed:', name, e && e.message);
        }
        return null;
      }
    })();
    loading.set(name, p);
    const clearLoading = () => { if (loading.get(name) === p) loading.delete(name); };
    void p.then(clearLoading, clearLoading);
    return p;
  }

  function startVoice(buf, targetGain) {
    if (disposed) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain); gain.connect(master);
    const voiceScope = scope.trackVoice([src], [gain]);
    src.start();
    return { src, gain, from: 0, to: targetGain, p: 0, dispose: voiceScope.dispose };
  }

  async function play(name) {
    if (disposed) return;
    const request = ++requestId;
    currentName = name;
    if (!started) return; // start() 후 실제 재생
    const buf = await load(name);
    if (!buf || disposed) return;
    // #140-D stale 가드: await(fetch+decode) 중 새 play(다른 트랙)가 들어왔으면 이 요청은 버린다.
    //   느린 옛 로드가 새 요청을 덮어써 엉뚱한 트랙이 이기던 레이스(시간대 연타 시 트랙 어긋남) 방지.
    if (request !== requestId || currentName !== name) return;
    // 기존 보이스는 페이드 아웃, 새 보이스 페이드 인
    for (const v of voices) { v.from = v.gain.gain.value; v.to = 0; v.p = 0; }
    const voice = startVoice(buf, 1);
    if (voice) voices.push(voice);
  }

  // #140-D 프리페치: 재생 없이 fetch+decode 만 해 buffers 에 담아둔다(load 가 memoized).
  //   · prefetch(name): 단일 트랙(첫 사운드 활성 즉시 재생용, 제스처 전 유휴에 호출 — decode 는 suspended ctx 에서도 동작).
  //   · prefetchTimeTracks(): TIME_TRACK 4곡을 동시 1개·순차로(대역폭 폭주 방지). start() 후 호출 → 이후 시간대 전환 즉시 크로스페이드.
  function prefetch(name) { return !disposed && name ? load(name) : Promise.resolve(null); }
  let prefetchedTimeTracks = false;
  //   preferred: 가장 먼저 받아야 하는 트랙(보통 현재 시간대 = 진입 트랙의 인계 대상). 이게 없으면
  //   dawn→main-theme→sunset→night 고정 순서라, sunset 기본 진입에서 정작 필요한 곡이 3번째로 밀려
  //   인계 시점에 아직 안 와 있었다.
  async function prefetchTimeTracks(preferred = null) {
    if (prefetchedTimeTracks || disposed) return;
    prefetchedTimeTracks = true;
    const all = Object.values(TIME_TRACK);
    const order = preferred && all.includes(preferred)
      ? [preferred, ...all.filter((n) => n !== preferred)]
      : all;
    // 저속·데이터 절약 연결: 필요한 한 곡만(나머지는 그 시간대로 바뀔 때 load 가 즉시 받는다).
    const wanted = frugalNetwork() ? order.slice(0, 1) : order;
    for (const name of wanted) {
      if (disposed) return;
      if (!buffers.has(name)) { try { await load(name); } catch {} }
    }
  }

  return {
    async start() {
      if (started || disposed) return;
      started = true;
      if (currentName) await play(currentName);
      // 나머지 시간대 트랙 백그라운드 프리페치는 setupAudio.start() 가 현재 시간대를 preferred 로
      // 넘겨 호출한다(여기서 순서 힌트 없이 부르면 필요한 곡이 뒤로 밀린다).
    },
    play, prefetch, prefetchTimeTracks,
    currentTrack() { return currentName; },
    // 무음 진단용 스냅샷(브라우저 게이트·window 진단이 이걸 단언한다).
    getState() {
      return {
        track: currentName,
        started,
        disposed,
        master: +master.gain.value.toFixed(6),
        volMul: +volMul.toFixed(6),
        voices: voices.map((v) => ({
          to: v.to,
          p: +v.p.toFixed(4),
          gain: +v.gain.gain.value.toFixed(6),
        })),
        loaded: [...buffers.keys()],
        pending: [...loading.keys()],
        failures: Object.fromEntries(failures),
      };
    },
    setVolume(v) {
      if (disposed) return;
      volMul = Math.max(0, v);
      master.gain.setTargetAtTime(volMul * BASE_GAIN, ctx.currentTime, 0.1);
    },
    getTracks() { return { byTime: { ...TIME_TRACK }, options: [...OPTION_TRACKS] }; },
    update(dt) {
      if (disposed || !voices.length) return;
      const step = dt / FADE;
      for (const v of voices) {
        v.p = Math.min(1, v.p + step);
        // from→to 를 등파워 곡선으로. 페이드인(to=1)은 in, 페이드아웃(to=0)은 out.
        const ep = equalPower(v.p);
        v.gain.gain.value = v.to > 0 ? ep.in : ep.out * v.from;
      }
      // 완전히 사라진 보이스 정리
      voices = voices.filter((v) => {
        if (v.to === 0 && v.p >= 1) { v.dispose(); return false; }
        return true;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      requestId++;
      try { loadAbort?.abort(); } catch {}
      try {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(0, ctx.currentTime);
      } catch {}
      for (const voice of voices) voice.dispose();
      voices = [];
      buffers.clear();
      loading.clear();
      failures.clear();
      scope.dispose();
    },
  };
}

export { TIME_TRACK };
