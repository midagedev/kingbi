import * as THREE from 'three';

// 시네마틱 데모 — 드론샷 패스 제너레이터 (태스크 #103).
//   createDronePaths({ site, plan, heightAt, seed }) → [ pass, ... ]  (명명된 패스 목록, 4종)
//     pass = { name, kind, duration, sample(t01) → { pos:Vector3, lookAt:Vector3, fov } }
//
// 좌표 규약(site.js): +z=남(앞·진입·개울), -z=북(뒤·주산·고지). center≈(0,-0.24R), mountainZ≈-1.0R,
//   streamZ≈0.30R, bowlR=0.56R. 모든 거리·고도는 site.R·Hmax 로 파생 → 규모 연속 대응(village↔hanyang).
//
// 경로는 CatmullRomCurve3(centripetal, C¹)·해석적 원(orbit)으로 구성하고 시간축을 easeInOutCubic 로
//   매핑해 시작/끝 속도 0(속도 급변 없음). lookAt 은 고정점·타깃곡선·전방접선(flythrough) 중 하나.
//
// 수치 안전(하네스 verify-cine.mjs 가 단언):
//   (a) 지형 클리어런스: 매 샘플 pos.y - heightAt(pos) > 1.5m  — safeFloor 하한으로 보장.
//   (b) 건물 관통 0: plan.parcels(+궁·절) 지붕 추정 볼륨 침범 없음. flythrough 는 지붕 위 ≥2m.
//       — safeFloor 가 필지 지붕 위로 pos.y 를 밀어 올려 보장(전방접선 lookAt 은 pos.y 를 따라가
//          floor 개입 시에도 시선 급변 없음).
//   (c) lookAt 각속도 상한: 타깃을 부드럽게(고정/곡선/접선) 두고 easeInOut 로 등가속 → 상한 이내.

const DEG = Math.PI / 180;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
// smootherstep(C²): 시작/끝 속도 0 + 중간 최대 기울기 1.875(easeInOutCubic 의 3보다 완만) → 각속도 상한 여유.
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// 지형 위 최소 클리어런스(>1.5m 요구, 여유 포함)와 필지 지붕 위 최소 클리어런스(관통 방지 + flythrough 스침).
const GROUND_CLEAR = 2.0;
const ROOF_CLEAR = 2.0;
// 프록시(adapter buildProxies)와 동일한 필지 여유(8%보다 살짝 넉넉히) — 관통 판정 보수화.
const FOOT_PAD = 1.12;

// 필지 유형별 지붕 상단 높이 추정(m). adapter buildProxies 의 H 와 동일 축척.
const parcelRoofH = (p) => (p.hero ? 14 : (p.kind === 'giwa' ? 9 : 6.5));
const facingY = (dir) => (dir ? Math.atan2(dir.x, dir.z) : 0);

// ── 장애물(건물 볼륨) 모델 ── 필지·궁·절을 회전 바운딩박스(OBB) + 지붕 상단 y 로. 드론 패스 생성과
//    검증이 이 단일 정의를 공유(계약면). world 매핑은 parcelMatrix/buildProxies 규약과 정합:
//    (wx-cx, wz-cz) = (lx·cos + lz·sin, -lx·sin + lz·cos).
export function buildObstacles(plan, heightAt) {
  const H = typeof heightAt === 'function' ? heightAt
    : (plan && plan.site && plan.site.heightAt) || (() => 0);
  const obs = [];
  const add = (cx, cz, bw, bd, rotY, top) => {
    obs.push({
      cx, cz, hw: bw * 0.5 * FOOT_PAD, hd: bd * 0.5 * FOOT_PAD,
      cos: Math.cos(rotY), sin: Math.sin(rotY), top,
    });
  };
  for (const p of (plan.parcels || [])) {
    let bw = p.plotW, bd = p.plotD, lcx = 0, lcz = 0;
    const pts = p.shape && p.shape.pts;
    if (pts && pts.length >= 3) {
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (const q of pts) { if (q.x < mnx) mnx = q.x; if (q.x > mxx) mxx = q.x; if (q.z < mnz) mnz = q.z; if (q.z > mxz) mxz = q.z; }
      bw = mxx - mnx; bd = mxz - mnz; lcx = (mnx + mxx) / 2; lcz = (mnz + mxz) / 2;
    }
    const rotY = facingY(p.frontDir) + (p.yaw || 0);
    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    const wcx = p.center.x + lcx * cos + lcz * sin;
    const wcz = p.center.z - lcx * sin + lcz * cos;
    const baseY = (p.baseY != null) ? p.baseY : H(p.center.x, p.center.z);
    add(wcx, wcz, bw, bd, rotY, baseY + parcelRoofH(p));
  }
  const f = plan.features || {};
  if (f.palace) add(f.palace.x, f.palace.z, f.palace.plotW || 60, f.palace.plotD || 90, facingY(f.palace.frontDir), H(f.palace.x, f.palace.z) + 18);
  if (f.temple) add(f.temple.x, f.temple.z, 40, 40, 0, H(f.temple.x, f.temple.z) + 13);
  return obs;
}

// (x,z) 위에 있는 건물의 최고 지붕 상단 y(없으면 null).
export function roofTopAt(obs, x, z) {
  let top = -Infinity;
  for (const o of obs) {
    const dx = x - o.cx, dz = z - o.cz;
    const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
    if (Math.abs(lx) <= o.hw && Math.abs(lz) <= o.hd && o.top > top) top = o.top;
  }
  return top > -Infinity ? top : null;
}

// 도로 폴리라인 길이.
function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}
// 주 도로 선택(대로 우선, 길이 가중). flythrough·초기 스폰 공용.
export function mainRoad(plan) {
  const roads = plan.roads || [];
  let best = null, bestScore = -1;
  for (const r of roads) {
    if (!r.pts || r.pts.length < 2) continue;
    const w = r.level === 'daero' ? 3 : r.level === 'jungno' ? 2 : r.level === 'soro' ? 1.2 : 1;
    const s = polyLen(r.pts) * w;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return best;
}
// 폴리라인을 호길이 등간격 n점으로 재샘플(제어점 등속화).
function resample(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1] || 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * total;
    let i = 1; while (i < cum.length && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[Math.min(i, pts.length - 1)];
    const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
    const f = (s - cum[i - 1]) / seg;
    out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
  }
  return out;
}

export function createDronePaths({ site, plan, heightAt, seed = 0 } = {}) {
  const H = typeof heightAt === 'function' ? heightAt : (site && site.heightAt) || (() => 0);
  const R = site.R, C = site.center, Hmax = site.Hmax;
  const obstacles = buildObstacles(plan, H);
  const roofTop = (x, z) => roofTopAt(obstacles, x, z);

  // 지형·지붕 위 안전 하한 — pos.y 는 항상 이 값 이상(클리어런스·관통 보장).
  const safeFloor = (x, z, clear) => {
    const g = H(x, z) + GROUND_CLEAR;
    const rt = roofTop(x, z);
    return rt != null ? Math.max(g, rt + (clear != null ? clear : ROOF_CLEAR)) : g;
  };
  // 필지 안이면 지정 방향으로 밀어 열린 지점(마당·도로) 찾기. 저고도 시작점 안전 스폰.
  const openPointNear = (x, z, dir) => {
    if (roofTop(x, z) == null) return { x, z };
    const d = dir || { x: 0, z: 1 };
    const step = Math.max(2.5, R * 0.02);
    let px = x, pz = z;
    for (let i = 0; i < 48; i++) { px += d.x * step; pz += d.z * step; if (roofTop(px, pz) == null) break; }
    return { x: px, z: pz };
  };

  // ── 랜드마크(궁 우선, 없으면 종가 hero 필지, 없으면 마을 중심) ──
  const f = plan.features || {};
  let L, lext, lH;
  if (f.palace) { L = { x: f.palace.x, z: f.palace.z }; lext = Math.max(f.palace.plotW || 60, f.palace.plotD || 90); lH = 18; }
  else {
    const hp = (plan.parcels || []).find((p) => p.hero);
    if (hp) { L = { x: hp.center.x, z: hp.center.z }; lext = Math.max(hp.plotW, hp.plotD) * 1.2; lH = 14; }
    else { L = { x: C.x, z: C.z }; lext = 40; lH = 12; }
  }
  const lbaseY = H(L.x, L.z);

  // ── 공통 패스 팩토리 ──
  function pass(name, kind, duration, cfg) {
    const posCurve = cfg.pos ? new THREE.CatmullRomCurve3(cfg.pos, false, 'centripetal') : null;
    const tgtCurve = Array.isArray(cfg.target) ? new THREE.CatmullRomCurve3(cfg.target, false, 'centripetal') : null;
    const fixed = (cfg.target && cfg.target.isVector3) ? cfg.target : null;
    const ease = cfg.ease || smootherstep;
    const roofClear = cfg.roofClear != null ? cfg.roofClear : ROOF_CLEAR;
    const lead = cfg.lead != null ? cfg.lead : 0.05;
    const drop = cfg.drop != null ? cfg.drop : 4;
    const aheadDist = cfg.aheadDist != null ? cfg.aheadDist : Math.max(16, R * 0.12);
    const getPos = cfg.custom ? cfg.custom : (u) => posCurve.getPoint(u);
    return {
      name, kind, duration,
      sample(t01) {
        const u = ease(clamp01(t01));
        const pos = getPos(u);
        const fl = safeFloor(pos.x, pos.z, roofClear);
        if (pos.y < fl) pos.y = fl;
        let lookAt;
        if (cfg.target === 'lookAhead') {
          const a = getPos(Math.max(0, u - lead));
          const b = getPos(Math.min(1, u + lead));
          let dx = b.x - a.x, dz = b.z - a.z;
          const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          lookAt = V(pos.x + dx * aheadDist, pos.y - drop, pos.z + dz * aheadDist);
        } else if (fixed) lookAt = fixed.clone();
        else lookAt = tgtCurve.getPoint(u);
        const fov = cfg.fov1 != null ? cfg.fov + (cfg.fov1 - cfg.fov) * u : cfg.fov;
        return { pos, lookAt, fov };
      },
    };
  }

  // ① crane-in — 북 능선 너머 높은 곳에서 마을로 내려앉는 진입 크레인(히어로/타이틀).
  const camAlt = Hmax * 1.15 + R * 0.22;
  const craneIn = pass('crane-in', 'establish', 14, {
    pos: [
      V(C.x - 0.08 * R, camAlt * 1.12, site.mountainZ + 0.10 * R),
      V(C.x, camAlt * 0.98, C.z - 0.55 * R),
      V(C.x + 0.04 * R, camAlt * 0.60, C.z - 0.05 * R),
      V(C.x, Hmax * 0.55 + R * 0.10, C.z + 0.42 * R),
    ],
    target: V(C.x, H(C.x, C.z) + R * 0.05, C.z),
    fov: 34, fov1: 42,
  });

  // ② street-flythrough — 대로를 따라 지붕 높이 스침 비행(지붕 바다). y=지형+skim, floor 가 지붕 위 ≥2m 보장.
  const road = mainRoad(plan);
  const roadPts = road ? resample(road.pts, 12) : [
    { x: C.x, z: C.z + 0.5 * R }, { x: C.x, z: C.z }, { x: C.x, z: C.z - 0.4 * R },
  ];
  const skim = 12; // 지붕(기와 ~9) 위 스침 높이
  const flyPos = roadPts.map((p) => V(p.x, H(p.x, p.z) + skim, p.z));
  const flyDur = road ? Math.max(12, Math.min(40, polyLen(road.pts) / 22)) : 16;
  const flythrough = pass('street-flythrough', 'flythrough', flyDur, {
    pos: flyPos, target: 'lookAhead', roofClear: 2.0, drop: 4.5, lead: 0.06,
    fov: 40,
  });

  // ③ landmark-orbit — 궁/종가 저속 선회(역광 실루엣). 해석적 원(정확 외접) + 고정 타깃.
  const orbitR = 0.5 * lext * 1.5 + Math.max(R * 0.07, 10);
  const orbitY0 = lbaseY + Math.max(lH * 0.85, 12);
  const sweep = 300 * DEG, th0 = 0; // th=0 → +z(남/정면)에서 시작
  const orbitCustom = (u) => {
    const th = th0 + sweep * u;
    const x = L.x + orbitR * Math.sin(th);
    const z = L.z + orbitR * Math.cos(th);
    let y = orbitY0; const fl = safeFloor(x, z, ROOF_CLEAR); if (y < fl) y = fl;
    return V(x, y, z);
  };
  const landmarkOrbit = pass('landmark-orbit', 'orbit', 22, {
    custom: orbitCustom,
    target: V(L.x, lbaseY + lH * 0.5, L.z),
    fov: 30,
  });

  // ④ pullback-reveal — 마당 근접(저고도) → 마을 전경 당김(엔딩). 타깃곡선으로 근경 디테일→전경.
  const s0 = openPointNear(L.x, L.z + lext * 0.5, { x: 0, z: 1 });
  const pullback = pass('pullback-reveal', 'reveal', 16, {
    pos: [
      V(s0.x, H(s0.x, s0.z) + 4.5, s0.z),
      V(C.x + 0.05 * R, Hmax * 0.30 + R * 0.06, C.z + 0.30 * R),
      V(C.x, Hmax * 0.55 + R * 0.12, C.z + 0.55 * R),
      V(C.x, Hmax * 0.72 + R * 0.18, C.z + 0.82 * R),
    ],
    target: [
      V(L.x, H(L.x, L.z) + 3, L.z),
      V((L.x + C.x) / 2, H(C.x, C.z) + R * 0.03, (L.z + C.z) / 2),
      V(C.x, H(C.x, C.z) + R * 0.05, C.z),
      V(C.x, H(C.x, C.z) + R * 0.06, C.z - 0.05 * R),
    ],
    fov: 40, fov1: 32,
  });

  return [craneIn, flythrough, landmarkOrbit, pullback];
}
