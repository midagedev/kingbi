// #123 forest 크런치 워커 — 마을 생성 프리즈의 64~90%(forest 배치 루프)를 메인 스레드 밖으로.
//   메시지 { opts, seed, id } 수신 → planVillage 로 plan 재구성(self-seeded, 결정론) → crunchForest 로
//   그루/암괴 인스턴스 매트릭스·계절색을 계산 → transferable Float32Array 로 반환.
//   메인(adapter.createVillageAsync)은 이 버퍼를 buildForest 에 넘겨 InstancedMesh 조립만(값싼) 한다.
//   ★ 워커-안전 임포트만: plan.js(THREE-free)·forest-crunch.js(THREE 코어 수학만). palette/populate 등
//     canvas·DOM 의존 모듈은 절대 임포트 금지.
import { planVillage } from './plan.js';
import { crunchForest, crunchTransferables } from './forest-crunch.js';

self.onmessage = (e) => {
  const { opts, seed, id } = e.data || {};
  try {
    const plan = planVillage({ ...opts, seed });
    const cr = crunchForest(plan, plan.site, {});   // warp/mask/clearDist 는 crunchForest 가 내부 재구성
    self.postMessage({ id, ok: true, crunch: cr }, crunchTransferables(cr));
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
};
