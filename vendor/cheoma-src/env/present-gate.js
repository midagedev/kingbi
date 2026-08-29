// 건물 종속 이펙트(굴뚝 연기·적설 쉘·빗물 리벌릿·처마 낙수 등)의 "조기 노출" 방지 게이트(#61).
//
// 문제: 히어로 오프닝은 빈 터에서 시작(building.visible=false)하고, 리롤/재생성은 건물을 새로
//   교체한 뒤 조립 애니로 부재가 솟아오른다. 이 사이에 이펙트가 자기 앵커(굴뚝·지붕·처마)가
//   아직 없는데 먼저 떠서 "빈 터 위 연기"처럼 보인다(사용자 리포트).
//
// 처방: #36 이 스플래시/낙수에 쓴 bldFx(건물 visible 추종) 패턴을 일반화한다.
//   - value(0..1): 이펙트 강도 배율. present 가 delay 초 이상 연속 유지돼야 비로소 ramp 로 오른다
//     → "굴뚝이 서고 1~2초 뒤 연기가 스멀스멀"(조립 완료의 보상 신호).
//   - reset(건물 교체): 즉시 0 으로 스냅하고 delay 를 다시 요구.
//   - 첫 프레임은 스냅(prime): shot·히어로 없는 로드는 present=true 로 시작해 value=1(재현성 유지),
//     히어로는 present=false 로 시작해 value=0(첫 프레임 깜빡임 없음).
//
//   makePresenceGate({ delay, up, down }) → { update(dt, { present, reset }) → value, get value }
export function makePresenceGate({ delay = 1.4, up = 1.6, down = 0.35 } = {}) {
  let value = 1;
  let held = 0;
  let primed = false;

  function update(dt, { present = true, reset = false } = {}) {
    if (!primed) {
      primed = true;
      value = present ? 1 : 0;      // 로드/shot 스냅(페이드-인 없음)
      held = present ? delay : 0;   // 이미 있으면 지연 소진 상태로 시작
      return value;
    }
    if (reset) { value = 0; held = 0; return value; }
    if (present) {
      held += dt;
      if (held >= delay) value += (1 - value) * Math.min(1, dt / up);
    } else {
      held = 0;
      value += (0 - value) * Math.min(1, dt / down);
    }
    return value;
  }

  return { update, get value() { return value; } };
}
