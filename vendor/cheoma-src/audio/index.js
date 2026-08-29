import * as THREE from 'three';
import { createChimes } from './chime.js';
import { createAmbience } from './ambience.js';
import { createBgm } from './bgm.js';
import { createStream } from './stream.js';
import { createDog } from './dog.js';
import { handOffTrack, trackForEntry, trackForTime } from './track-policy.js';
import { introAdvance, introInitialState, introReduce } from './intro-policy.js';

// 사운드 레이어 오케스트레이터.
//   setupAudio(listenerCarrier, {
//     layout, streamAnchor, getStreamAnchor, getChimeCorners,
//     getDogAnchor, getDogState,
//   }) →
//     { start(), setEnabled(v), setEnvActive(v), setTime(name), setWeather(name),
//       update(dt), setBgmVolume(v), setAmbienceVolume(v), setLayout(l), setChimeCorners(c),
//       strike(i?), barkDog(), getTracks(), playTrack(n),
//       introEvent(e), playEntryTrack(), prefetchEntryTrack(), handOffEntryTrack(),
//       diagnostics(), listener, dispose() }
//   streamAnchor: 개울 물소리 초기 월드 좌표(THREE.Vector3) 또는 null — 값 캡처(레거시).
//   getStreamAnchor: 라이브 개울 앵커 getter(권장). 개(getDogAnchor)와 같은 패턴.
//     마을 모드에서는 카메라/포커스 근처 개울 중심선 점, 솔로 하우스는 env.streamAnchor.
//     null 을 주면 개울 SFX 게인 0. streamAnchor 와 함께 주면 getter 가 우선 갱신.
//   getChimeCorners: 풍경 4모서리 월드 좌표 getter([[x,y,z]×4]). 마을 포커스/최근접 집 처마.
//     없으면 layout/setLayout 의 원점 처마(솔로 하우스 경로).
//   getDogAnchor/getDogState: 마당 개의 라이브 월드 위치·상태('walking'|'sitting') getter(없으면 개 없음).
//
// listenerCarrier(보통 camera)에 THREE.AudioListener 를 붙인다. 브라우저 autoplay 정책상
// 소리는 첫 사용자 제스처에서 start() 로 AudioContext.resume() 한 뒤에야 난다. start() 는
// **제스처 핸들러 안에서 동기적으로** 불려야 한다(첫 문장이 ctx.resume() 이라 그 호출 자체는
// 동기다). 이후엔 어떤 제스처·복귀에서든 resume 을 재시도한다(iOS 인터럽션 복구).
//
// 첫 진입 BGM(genesis)과 타이틀 뮤트 복원은 순수 모듈이 소유한다:
//   · track-policy.js  — 어떤 상태가 어떤 트랙 이름으로 풀리는가.
//   · intro-policy.js  — arm/enter/settle/skip 상태기계와 볼륨 종착 불변식.
// 엔진은 introEvent() 로 사건만 알린다. **엔진이 직접 BGM 을 뮤트하면 안 된다**(복원 누락 = 영구 무음).
//
// 신호 흐름:
//   ambience 레이어 -> ambienceGain --\
//   bgm 보이스       -> bgmGain -------- +--> listener.gain(master) -> destination
//   풍경(PositionalAudio) -------------/  (three 가 panner->gain->listener 로 연결)
// 풍경 볼륨은 ambience 볼륨에 종속(환경음의 일부).

export function setupAudio(listenerCarrier, {
  layout,
  streamAnchor = null,
  getStreamAnchor = null,
  getChimeCorners = null,
  getDogAnchor = null,
  getDogState = null,
} = {}) {
  const listener = new THREE.AudioListener();
  listenerCarrier.add(listener);
  const ctx = listener.context;
  const input = listener.getInput();

  // Web Audio API non-finite 파라미터 에러 방지용 가드
  if (typeof window !== 'undefined' && window.AudioParam && !window.AudioParam.__safeguarded) {
    window.AudioParam.__safeguarded = true;
    const origLinear = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.linearRampToValueAtTime = function(value, endTime) {
      if (!isFinite(value) || !isFinite(endTime)) {
        console.warn('AudioParam.linearRampToValueAtTime was bypassed due to non-finite arguments:', value, endTime);
        return this;
      }
      return origLinear.call(this, value, endTime);
    };
    const origExp = AudioParam.prototype.exponentialRampToValueAtTime;
    AudioParam.prototype.exponentialRampToValueAtTime = function(value, endTime) {
      if (!isFinite(value) || !isFinite(endTime) || value <= 0) {
        console.warn('AudioParam.exponentialRampToValueAtTime was bypassed due to non-finite or non-positive arguments:', value, endTime);
        return this;
      }
      return origExp.call(this, value, endTime);
    };
    const origSetValue = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function(value, startTime) {
      if (!isFinite(value) || !isFinite(startTime)) {
        console.warn('AudioParam.setValueAtTime was bypassed due to non-finite arguments:', value, startTime);
        return this;
      }
      return origSetValue.call(this, value, startTime);
    };
  }

  // 마스터 소프트 리미터. 풍경 4연타·환경음·BGM 동시 피크를 부드럽게 잡아 클리핑 방지.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 4;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  input.disconnect();
  input.connect(limiter);
  limiter.connect(ctx.destination);

  const ambienceGain = ctx.createGain();
  ambienceGain.gain.value = 1;
  ambienceGain.connect(input);

  const bgmGain = ctx.createGain();
  bgmGain.gain.value = 1;
  bgmGain.connect(input);

  const chimes = createChimes(listener, { layout, getCorners: getChimeCorners });
  const ambience = createAmbience(listener, { layout, destination: ambienceGain });
  const bgm = createBgm(listener, { destination: bgmGain });
  // 개울 물소리(위치성). 정적 앵커 또는 라이브 getter 가 있을 때만 생성.
  // 값으로 한 번 캡처하면 마을 모드에서 원점 개울에 묶이므로 getStreamAnchor 권장.
  const stream = (getStreamAnchor || streamAnchor)
    ? createStream(listener, { anchor: streamAnchor, getAnchor: getStreamAnchor })
    : null;
  // 마당 개 짖음(위치성). 개 앵커 getter 없으면 생성하지 않는다.
  const dog = getDogAnchor ? createDog(listener, { getAnchor: getDogAnchor, getState: getDogState }) : null;

  let enabled = true;
  let started = false;
  let disposed = false;
  let startPromise = null;
  let envActive = true;  // env 레이어 ON 여부 — 개울 물소리는 env 가 꺼지면 정지
  let time = 'day';
  let weather = 'clear';
  let ambienceVol = 1;
  let intro = introInitialState();
  let appliedIntroVol = intro.volume;

  // 시간대·날씨 → 바람 세기(0~1). 풍경 타종·바람음의 공통 구동값.
  function windiness() {
    let w = { dawn: 0.1, day: 0.22, sunset: 0.3, night: 0.12 }[time] ?? 0.18;
    if (weather === 'rain') w = Math.max(w, 0.62);
    else if (weather === 'snow') w = Math.min(0.35, w + 0.12);
    return w;
  }
  function pushWind() {
    if (disposed) return;
    const w = windiness();
    chimes.setWindiness(w);
    ambience.setWindiness(w);
  }

  function applyMaster() {
    if (disposed) return;
    listener.setMasterVolume(enabled ? 1 : 0);
  }
  // ---------- AudioContext 재개 그물(모바일 핵심) ----------
  // iOS/Safari 는 백그라운드 전환·오디오 인터럽션(전화·타 앱 재생)에서 컨텍스트를 suspended 로
  // 떨어뜨리고 **스스로 돌아오지 않는다**. start() 이후엔 어떤 사용자 제스처/포그라운드 복귀에서든
  // resume 을 재시도한다. running 이면 비교 한 번으로 끝나 프레임 비용 0.
  const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'keydown'];
  let unlockBound = false;
  function tryResume() {
    if (disposed || !started || ctx.state === 'running') return;
    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch {}
  }
  function onVisibility() { if (document.visibilityState === 'visible') tryResume(); }
  function bindUnlock() {
    if (unlockBound || typeof window === 'undefined') return;
    unlockBound = true;
    for (const type of UNLOCK_EVENTS) {
      window.addEventListener(type, tryResume, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
  }
  function unbindUnlock() {
    if (!unlockBound) return;
    unlockBound = false;
    for (const type of UNLOCK_EVENTS) {
      window.removeEventListener(type, tryResume, { capture: true });
    }
    document.removeEventListener('visibilitychange', onVisibility);
  }

  // 시간대 트랙 프리페치 시점. 진입 스웰 중(랜딩)에는 **인계 대상 한 곡만** 받는다 — 랜딩은
  // 프레임 예산이 가장 빡빡한 구간이고, 4곡(≈17MB) fetch+decode 를 그 위에 얹을 이유가 없다.
  // 나머지는 정착(settle/skip) 후 배경으로 받는다.
  function kickTimeTrackPrefetch() {
    if (disposed) return;
    const preferred = trackForTime(time);
    if (intro.phase === 'entering') bgm.prefetch(preferred);
    else bgm.prefetchTimeTracks(preferred);
  }

  // ---------- 첫 진입 BGM 상태기계 적용 ----------
  function pushIntroVolume() {
    if (disposed || intro.volume === appliedIntroVol) return;
    appliedIntroVol = intro.volume;
    bgm.setVolume(intro.volume);
  }
  //   사건 전환 시에만 트랙을 건드린다(프레임마다 play 하면 보이스가 쌓인다).
  function applyIntro(prev) {
    if (intro === prev) return;
    pushIntroVolume();
    if (intro.track && intro.track !== prev.track) { bgm.play(intro.track); return; }
    if (!intro.track && prev.track) {
      // 진입 트랙 → 시간대 트랙 인계(4s 등파워 크로스페이드). 랜딩 중 사용자가 시간대를 직접
      // 바꿨다면 현재 트랙이 진입 트랙이 아니므로 handOffTrack 이 null → 그 선택을 덮지 않는다.
      const next = handOffTrack(bgm.currentTrack(), time);
      if (next) bgm.play(next);
    }
  }

  // 개울 물소리·개 짖음(위치성 env 사운드)은 전체 사운드 ON && env 레이어 ON 일 때만.
  function pushEnvAudio() {
    if (disposed) return;
    const on = enabled && envActive;
    stream?.setEnabled(on);
    dog?.setEnabled(on);
  }

  const api = {
    listener,
    start() {
      if (disposed || started) return startPromise || Promise.resolve();
      if (startPromise) return startPromise;
      // ctx.resume() 은 이 async 본문의 첫 문장이라 호출 자체가 동기다 → 제스처 핸들러에서
      // start() 를 부르면 iOS 도 재개한다. await 뒤로 밀면 사용자 활성 창을 벗어나 영구 무음.
      startPromise = (async () => {
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
        if (disposed) return;
        started = true;
        bindUnlock();
        chimes.start();
        ambience.start();
        stream?.start();
        dog?.start();
        await bgm.start();
        if (disposed) return;
        kickTimeTrackPrefetch();
        applyMaster();
        pushEnvAudio();
      })().finally(() => { startPromise = null; });
      return startPromise;
    },
    // 제스처마다 부를 수 있는 무비용 재개 시도(running 이면 즉시 반환).
    resume() { tryResume(); },
    setEnabled(v) { if (disposed) return; enabled = !!v; applyMaster(); pushEnvAudio(); },
    // env 레이어(산수화 배경·지형·개울·개) ON/OFF — 위치성 env 사운드를 따라 정지/재개
    setEnvActive(v) { if (disposed) return; envActive = !!v; pushEnvAudio(); },
    setTime(name) {
      if (disposed) return;
      time = name;
      ambience.setTime(name);
      pushWind();
      // BGM 트랙 매핑 + 4s 크로스페이드(정책은 track-policy.js 소유)
      bgm.play(trackForTime(name));
    },
    setWeather(name) {
      if (disposed) return;
      weather = name;
      ambience.setWeather(name);
      stream?.setWeather(name); // 눈(결빙) 시 물소리 0.25배
      pushWind();
    },
    // 건물 재생성(크기 변경) 시 풍경 위치 갱신(solo). 마을 getChimeCorners 활성 시 no-op.
    setLayout(layout) { if (!disposed) chimes.setLayout(layout); },
    // 풍경 월드 좌표 명시 갱신(포커스 전환 등). getter 와 병행 가능.
    setChimeCorners(corners) { if (!disposed) chimes.setCorners(corners); },
    setBgmVolume(v) { if (!disposed) bgm.setVolume(v); },
    setAmbienceVolume(v) {
      if (disposed) return;
      ambienceVol = Math.max(0, v);
      ambienceGain.gain.setTargetAtTime(ambienceVol, ctx.currentTime, 0.1);
      chimes.setVolume(ambienceVol); // 풍경도 환경음 볼륨에 종속
      stream?.setVolume(ambienceVol); // 개울도 환경음 볼륨에 종속
      dog?.setVolume(ambienceVol);    // 개 짖음도 환경음 볼륨에 종속
    },
    // #140-D 현재 시간대 트랙 프리페치(제스처 전 유휴 호출용) — 첫 사운드 활성 즉시 재생.
    prefetchCurrentTrack() { return disposed ? Promise.resolve(null) : bgm.prefetch(trackForTime(time)); },
    // 첫 진입 트랙 프리페치 — 타이틀이 화면을 덮는 동안(무거운 작업 창) 받아 둔다.
    prefetchEntryTrack() { return disposed ? Promise.resolve(null) : bgm.prefetch(trackForEntry()); },
    // 첫 진입 BGM 상태기계 사건. 'arm' | 'enter' | 'settle' | 'skip' (intro-policy.js).
    //   엔진의 유일한 BGM 뮤트·복원 창구다. 어떤 사건 열이든 settle/skip 에서 볼륨 1 로 끝난다.
    introEvent(event) {
      if (disposed) return null;
      const prev = intro;
      intro = introReduce(prev, event);
      applyIntro(prev);
      // 정착 후에는 남은 시간대 트랙을 배경으로 받아 둔다(이후 시간대 전환이 즉시 크로스페이드).
      if (started && intro.phase === 'settled' && prev.phase !== 'settled') kickTimeTrackPrefetch();
      return intro.phase;
    },
    // 진입 트랙을 직접 지정(introEvent('enter') 가 이미 하지만, 진입 연출 없는 경로 테스트용).
    playEntryTrack() { if (!disposed) bgm.play(trackForEntry()); },
    // 진입 트랙 → 현재 시간대 트랙 인계. 이미 시간대 트랙이면 no-op.
    handOffEntryTrack() {
      if (disposed) return null;
      const next = handOffTrack(bgm.currentTrack(), time);
      if (next) bgm.play(next);
      return next;
    },
    // BGM 트랙 선택지(옵션 트랙 village/genesis 포함) 노출
    getTracks() { return bgm.getTracks(); },
    // 특정 트랙 강제 재생(옵션 트랙 테스트/노출용)
    playTrack(name) { if (!disposed) bgm.play(name); },
    // 테스트용 즉시 타종
    strike(i) { if (!disposed) chimes.strike(i); },
    // 테스트용 즉시 개 짖음
    barkDog() { if (!disposed) dog?.bark(); },
    // 무음 진단 스냅샷 — 귀 없이 판정하는 계측점. 화면이 아니라 오디오 그래프를 본다.
    //   ctx 상태 / 마스터 / BGM 트랙·보이스 게인 / 각 레이어 활성·게인 / mp3 로드 실패.
    diagnostics() {
      return {
        disposed,
        ctxState: disposed ? 'disposed' : ctx.state,
        started,
        enabled,
        envActive,
        time,
        weather,
        master: +listener.getMasterVolume().toFixed(6),
        ambienceGain: +ambienceGain.gain.value.toFixed(6),
        bgmBusGain: +bgmGain.gain.value.toFixed(6),
        intro: { phase: intro.phase, volume: +intro.volume.toFixed(4), track: intro.track },
        bgm: bgm.getState(),
        ambience: ambience.getState(),
        chimes: chimes.getState(),
        stream: stream ? stream.getState() : null,
        dog: dog ? dog.getState() : null,
      };
    },
    update(dt) {
      if (disposed) return;
      // 진입 스웰은 사운드 OFF·미start 상태에서도 진행시킨다 — 그래야 어떤 순서로 켜도
      // "볼륨이 중간에 갇히는" 상태가 남지 않는다(비용: 국면 비교 1회).
      if (intro.phase === 'entering' && intro.volume < 1) {
        intro = introAdvance(intro, dt);
        pushIntroVolume();
      }
      if (!started || !enabled) return;
      chimes.update(dt);
      ambience.update(dt);
      stream?.update(dt);
      dog?.update(dt);
      bgm.update(dt);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      envActive = false;
      started = false;
      unbindUnlock();
      try {
        input.gain.cancelScheduledValues(ctx.currentTime);
        input.gain.setValueAtTime(0, ctx.currentTime);
      } catch {}
      chimes.dispose();
      ambience.dispose();
      bgm.dispose();
      stream?.dispose();
      dog?.dispose();
      try { ambienceGain.disconnect(); } catch {}
      try { bgmGain.disconnect(); } catch {}
      try { input.disconnect(); } catch {}
      try { limiter.disconnect(); } catch {}
      listener.removeFromParent();
    },
  };

  // 초기 상태 반영
  ambience.setTime(time);
  ambience.setWeather(weather);
  stream?.setWeather(weather);
  pushWind();
  bgm.play(trackForTime(time));

  return api;
}
