import * as THREE from 'three';
import { createAudioScope, synthBell, poissonInterval } from './synth.js';
import { chimeLocalCorners } from './anchors.js';

// 처마 끝 풍경(風磬) — 4개 모서리에 THREE.PositionalAudio 로 배치.
// 각 풍경은 자기 기음(base)과 독립 포아송 타이머를 가진다(바람이 각 모서리를 따로 때린다).
// 바람 세기(windiness 0~1)에 따라 타종 빈도가 오른다:
//   평온(0): 평균 ~34s, 최소 18s   /   강풍(1): 평균 ~5s, 최소 2.5s
//
//   createChimes(listener, { layout, getCorners, rand }) →
//     { objects[], setWindiness(w), setVolume(v), setLayout(l), setCorners(c),
//       strike(i?), update(dt), start(), dispose() }
//   objects 는 씬에 추가하지 않아도 된다 — update()에서 updateMatrixWorld 로
//   panner 위치만 갱신한다(listener 는 camera 를 따라 움직인다).
//
// getCorners: 라이브 월드 좌표 getter([[x,y,z]×4]). 마을 모드에서 포커스/최근접 집
// 처마로 옮길 때 사용. 활성일 때 setLayout 은 원점 레이아웃 덮어쓰기를 하지 않는다
// (solo 재생성은 getCorners 없이 setLayout 만 쓴다).

export function createChimes(listener, { layout, getCorners = null, rand = Math.random } = {}) {
  const ctx = listener.context;
  const scope = createAudioScope();

  function applyCorners(corners) {
    if (!corners || corners.length < chimes.length) return false;
    for (let i = 0; i < chimes.length; i++) {
      const c = corners[i];
      if (!c) return false;
      const x = Array.isArray(c) ? c[0] : c.x;
      const y = Array.isArray(c) ? c[1] : c.y;
      const z = Array.isArray(c) ? c[2] : c.z;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
      chimes[i].pa.position.set(x, y, z);
      chimes[i].pa.updateMatrixWorld(true);
    }
    return true;
  }

  const chimes = chimeLocalCorners(layout).map(([x, y, z]) => {
    const pa = new THREE.PositionalAudio(listener);
    // 원경 카메라(건물 크기의 2배 거리)에서도 들리도록 완만한 거리 감쇠.
    pa.setDistanceModel('inverse');
    pa.setRefDistance(12);
    pa.setRolloffFactor(0.5);
    pa.setMaxDistance(400);
    // 합성 출력을 흘려보낼 상시 버스(setNodeSource → panner → gain → listener)
    const bus = ctx.createGain();
    bus.gain.value = 1;
    pa.setNodeSource(bus);
    scope.track(bus, pa.panner, pa.gain);
    pa.position.set(x, y, z);
    pa.updateMatrixWorld(true);
    // 풍경마다 다른 기음(1.35~1.75kHz 개체차)
    const base = 1350 + rand() * 400;
    return { pa, bus, base, next: 2 + rand() * 6 };
  });

  let windiness = 0.15;
  let volume = 1;
  let started = false;
  let disposed = false;
  // liveCorners is true only while getCorners() currently yields world positions.
  // Merely passing a getter (product engine always does) must not block solo setLayout.
  let liveCorners = false;
  let lastLayout = layout;

  // 건물 재생성으로 크기가 바뀌면 처마 모서리 좌표 갱신(solo-house).
  // 마을 live getter 가 코너를 내고 있을 때만 원점 레이아웃 덮어쓰기를 막는다.
  function setLayout(L) {
    if (disposed) return;
    lastLayout = L;
    if (liveCorners) return;
    applyCorners(chimeLocalCorners(L));
  }

  // 명시 월드 좌표(엔진이 포커스 전환 때 호출해도 됨). getter 와 병행 가능.
  function setCorners(corners) {
    if (disposed) return;
    if (applyCorners(corners)) liveCorners = true;
  }

  function rate() {
    // windiness → 평균 타종 간격(초)과 하한
    const mean = 34 - windiness * 29;   // 0 → 34s, 1 → 5s
    const min = 18 - windiness * 15.5;  // 0 → 18s, 1 → 2.5s
    const max = mean * 2.2;
    return { mean, min, max };
  }

  function strike(i) {
    if (disposed) return;
    const c = (i == null) ? chimes[Math.floor(rand() * chimes.length)] : chimes[i % chimes.length];
    if (!c) return;
    // 강풍일수록 강하게, 약할 때는 여린 종소리
    const g = (0.5 + windiness * 0.5) * (0.75 + rand() * 0.25) * volume;
    synthBell(ctx, c.bus, ctx.currentTime + 0.01, { base: c.base, gain: g, rand, scope });
  }

  function syncCorners() {
    if (!getCorners) return;
    const c = getCorners();
    if (c) {
      if (applyCorners(c)) liveCorners = true;
      return;
    }
    // Getter released (left village / no residential host) — restore solo layout eaves.
    if (liveCorners) {
      liveCorners = false;
      applyCorners(chimeLocalCorners(lastLayout));
    }
  }

  function update(dt) {
    if (!started || disposed) return;
    syncCorners();
    for (const c of chimes) {
      c.pa.updateMatrixWorld(); // 정적이지만 저렴 — panner 위치 확정
      c.next -= dt;
      if (c.next <= 0) {
        const { mean, min, max } = rate();
        // 강풍일 땐 한 번 흔들릴 때 2~3연타가 나기도 한다
        const g = (0.5 + windiness * 0.5) * (0.75 + rand() * 0.25) * volume;
        synthBell(ctx, c.bus, ctx.currentTime + 0.01, { base: c.base, gain: g, rand, scope });
        if (windiness > 0.55 && rand() < windiness * 0.5) {
          synthBell(ctx, c.bus, ctx.currentTime + 0.14 + rand() * 0.18, { base: c.base, gain: g * 0.7, rand, scope });
        }
        c.next = poissonInterval(mean, min, max, rand);
      }
    }
  }

  return {
    objects: chimes.map((c) => c.pa),
    getState() {
      return {
        started, disposed, count: chimes.length, liveCorners,
        windiness: +windiness.toFixed(4), volume: +volume.toFixed(4),
        busGain: chimes.length ? +chimes[0].bus.gain.value.toFixed(6) : 0,
        positions: chimes.map((c) => ({
          x: +c.pa.position.x.toFixed(3),
          y: +c.pa.position.y.toFixed(3),
          z: +c.pa.position.z.toFixed(3),
        })),
      };
    },
    setWindiness(w) { if (!disposed) windiness = Math.max(0, Math.min(1, w)); },
    setVolume(v) { if (!disposed) volume = Math.max(0, v); },
    setLayout,
    setCorners,
    strike,
    update,
    start() { if (!disposed) started = true; },
    dispose() {
      if (disposed) return;
      disposed = true;
      started = false;
      for (const chime of chimes) {
        try { chime.bus.gain.setValueAtTime(0, ctx.currentTime); } catch {}
        try { chime.pa.disconnect(); } catch {}
        chime.pa.removeFromParent();
      }
      scope.dispose();
    },
  };
}
