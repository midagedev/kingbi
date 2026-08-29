import * as THREE from 'three';
import { createHeadingController, shortestAngleDelta } from '../camera/heading.js';
import { mainRoad } from './dronepath.js';
import { buildWalkSolids, pointHitsWalkSolids } from './walk-solids.js';

// 시네마틱 데모 — 1인칭 골목 탐색 (태스크 #103, 대문 진입 #150-J).
//   createWalker({ site, plan, heightAt }) → walker
//     walker.update(dt, input) → { pos, dir }    input:{ fwd, strafe, yaw, pitch, run }
//       fwd/strafe ∈ [-1,1] 이동 의도, yaw/pitch 는 이번 프레임 시선 회전 증분(rad, 호출부가 감도 적용),
//       run: true 면 달리기(2.8m/s).
//     walker.pos  Vector3(x, 시선고 y, z)      walker.dir  Vector3 시선 단위벡터
//     walker.startAutoStroll() / stopAutoStroll()  — 도로 폴리라인 따라 자동 산책(데모 클립)
//     walker.setPos(x,z) / walker.yaw / walker.pitch
//
// 접지: 시선고 = heightAt + 1.6m, 계단·성토 패드 단차를 지수 스무딩(단차에서 튀지 않게). 하한 클램프로
//   지면 침하(발이 땅 아래) 0 보장. 충돌: walk-solids — 담 런 세그먼트 + 집 지붕 OBB(대문 틈 open).
//   필지 전체를 solid 로 쓰지 않으므로 free walk 가 도로→대문→마당으로 들어갈 수 있다. 종가·궁·절은
//   보수적 풋프린트 solid. auto-stroll 은 계속 도로 폴리라인만 따른다(마당 진입 없음). mesh-bvh 불필요.
//   경계: 마을 분지(bowlR)·1.12 밖으로 나가지 않는 하드 캡.
//   자동산책 종점: 먼저 멈춰 바라본 뒤 52°/s·120°/s² 제한으로 회전하고 다시 걷는다. 정확히 반대인
//   ±π 목표도 회전면을 고정해 한 프레임 급회전이나 좌우 부호 진동을 만들지 않는다.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EYE = 1.6;
const WALK = 1.4, RUN = 2.8;
const BODY = 0.45;              // 몸 반경(담과의 이격)
const DEG = Math.PI / 180;
const AUTO_LOOK_AHEAD = 3.0;
const AUTO_TURN_SPEED = 52 * DEG;
const AUTO_TURN_ACCELERATION = 120 * DEG;
const AUTO_MOVE_CONE = 62 * DEG;
const AUTO_TURN_PAUSE = 0.35;

export function createWalker({ site, plan, heightAt } = {}) {
  const H = typeof heightAt === 'function' ? heightAt : (site && site.heightAt) || (() => 0);
  const C = site.center, bowlR = site.bowlR, R = site.R;
  const MAXR = bowlR * 1.12;                 // 경계 하드 캡
  // Gate-aware semantic solids (walls + house OBB); drone still uses buildObstacles.
  const obstacles = buildWalkSolids(plan, H);

  // (x,z) 가 어떤 solid(+몸 반경) 안이면 true.
  const collides = (nx, nz) => pointHitsWalkSolids(obstacles, nx, nz, BODY);
  // 필지 안이면 남(+z)으로 밀어 열린 지점 확보(안전 스폰).
  const nudgeOut = (x, z) => {
    if (!collides(x, z)) return { x, z };
    const step = Math.max(2, R * 0.02);
    let px = x, pz = z;
    for (let i = 0; i < 60; i++) { pz += step; if (!collides(px, pz)) break; }
    return { x: px, z: pz };
  };

  // ── 자동 산책 경로(도로 폴리라인) ──
  const entrance = site.entrance || { x: C.x, z: C.z + bowlR * 0.3 };
  const road = mainRoad(plan);
  const routePts = road
    ? road.pts.slice()
    : [{ x: C.x, z: C.z + bowlR * 0.4 }, { x: C.x, z: C.z - bowlR * 0.4 }];
  const endpointDistance = (point) => Math.hypot(point.x - entrance.x, point.z - entrance.z);
  if (endpointDistance(routePts[routePts.length - 1]) < endpointDistance(routePts[0])) routePts.reverse();
  const routeCum = [0];
  for (let i = 1; i < routePts.length; i++) {
    routeCum.push(routeCum[i - 1] + Math.hypot(
      routePts[i].x - routePts[i - 1].x,
      routePts[i].z - routePts[i - 1].z,
    ));
  }
  const routeLen = routeCum[routeCum.length - 1] || 1;
  const sampleRoute = (s) => {
    s = clamp(s, 0, routeLen);
    let i = 1; while (i < routeCum.length && routeCum[i] < s) i++;
    const a = routePts[i - 1], b = routePts[Math.min(i, routePts.length - 1)];
    const seg = (routeCum[Math.min(i, routeCum.length - 1)] - routeCum[i - 1]) || 1;
    const f = (s - routeCum[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };

  // ── 상태 ── 시작 위치와 routeS=0은 같은 도로 끝점을 가리킨다.
  const spawn = nudgeOut(routePts[0].x, routePts[0].z);
  let x = spawn.x, z = spawn.z;
  const initialLook = sampleRoute(AUTO_LOOK_AHEAD);
  let yaw = Math.atan2(initialLook.x - x, initialLook.z - z);
  let pitch = 0;
  let eyeY = H(x, z) + EYE;
  const heading = createHeadingController({
    angle: yaw,
    maxSpeed: AUTO_TURN_SPEED,
    maxAcceleration: AUTO_TURN_ACCELERATION,
  });

  const pos = new THREE.Vector3(x, eyeY, z);
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

  let auto = false, routeS = 0, routeDir = 1, turnPause = 0, turnarounds = 0;

  // 축분리 이동+슬라이드: 각 축을 독립 시도, 충돌하면 그 축만 취소(담을 따라 미끄러짐).
  function tryStep(dx, dz) {
    const ox = x, oz = z;
    if (!collides(x + dx, z)) x += dx;
    if (!collides(x, z + dz)) z += dz;
    return Math.hypot(x - ox, z - oz);
  }

  function freeStep(dt) {
    let f = clamp(cur.fwd, -1, 1), s = clamp(cur.strafe, -1, 1);
    const mag = Math.hypot(f, s); if (mag > 1) { f /= mag; s /= mag; }
    const spd = (cur.run ? RUN : WALK) * dt;
    const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
    const rdx = Math.cos(yaw), rdz = -Math.sin(yaw);
    tryStep((fdx * f + rdx * s) * spd, (fdz * f + rdz * s) * spd);
  }

  function strollStep(dt) {
    const look = sampleRoute(routeS + routeDir * AUTO_LOOK_AHEAD);
    const ty = Math.atan2(look.x - x, look.z - z);
    yaw = heading.step(ty, dt, -routeDir);
    const turnError = Math.abs(shortestAngleDelta(yaw, ty, -routeDir));
    turnPause = Math.max(0, turnPause - dt);

    // A walker looks through the turn before moving again. This removes the
    // endpoint skid while preserving gradual motion through ordinary corners.
    const alignment = turnPause > 0
      ? 0
      : clamp((Math.cos(turnError) - Math.cos(AUTO_MOVE_CONE)) / (1 - Math.cos(AUTO_MOVE_CONE)), 0, 1);
    const fdx = Math.sin(yaw), fdz = Math.cos(yaw);
    const moved = tryStep(fdx * WALK * dt * alignment, fdz * WALK * dt * alignment);
    routeS += moved * routeDir;

    if (routeDir > 0 && routeS >= routeLen) {
      routeS = routeLen;
      routeDir = -1;
      turnPause = AUTO_TURN_PAUSE;
      turnarounds++;
    } else if (routeDir < 0 && routeS <= 0) {
      routeS = 0;
      routeDir = 1;
      turnPause = AUTO_TURN_PAUSE;
      turnarounds++;
    }
  }

  const cur = { fwd: 0, strafe: 0, run: false };

  function update(dt, input = {}) {
    dt = Math.min(Math.max(dt, 0), 0.1);      // 큰 dt 터널링 방지
    if (auto) {
      strollStep(dt);
    } else {
      if (input.yaw) { yaw += input.yaw; heading.reset(yaw); }
      if (input.pitch) pitch = clamp(pitch + input.pitch, -1.2, 1.2);
      cur.fwd = input.fwd || 0; cur.strafe = input.strafe || 0; cur.run = !!input.run;
      freeStep(dt);
    }

    // 경계: MAXR 초과는 원형 분지 안으로 하드 캡.
    const rr = Math.hypot(x - C.x, z - C.z);
    if (rr > MAXR) { const k = MAXR / rr; x = C.x + (x - C.x) * k; z = C.z + (z - C.z) * k; }

    // 접지: 목표 시선고로 지수 스무딩(단차 완화) + 침하 방지 하한.
    const ground = H(x, z);
    const desired = ground + EYE;
    eyeY += (desired - eyeY) * (1 - Math.exp(-dt * 8));
    if (eyeY < ground + 0.1) eyeY = ground + 0.1;

    pos.set(x, eyeY, z);
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
    return { pos, dir };
  }

  return {
    update, pos, dir,
    get yaw() { return yaw; }, set yaw(v) { yaw = v; heading.reset(v); },
    get pitch() { return pitch; }, set pitch(v) { pitch = clamp(v, -1.2, 1.2); },
    get autoStroll() { return auto; },
    startAutoStroll() { auto = true; heading.reset(yaw); },
    stopAutoStroll() { auto = false; heading.reset(yaw); cur.fwd = cur.strafe = 0; cur.run = false; },
    setPos(nx, nz) { const p = nudgeOut(nx, nz); x = p.x; z = p.z; eyeY = H(x, z) + EYE; pos.set(x, eyeY, z); },
    lookAt() { return pos.clone().add(dir); },
    // 검증·엔진 배선용 디버그/조회 훅.
    eyeHeight: EYE, bodyRadius: BODY, maxRadius: MAXR, center: { x: C.x, z: C.z },
    groundClearance() { return eyeY - H(x, z); },
    isColliding() { return collides(x, z); },
    outsideBoundary() { return Math.hypot(x - C.x, z - C.z) > MAXR + 1e-3; },
    turnRate() { return heading.velocity; },
    turnaroundCount() { return turnarounds; },
  };
}
