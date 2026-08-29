# kingbi — 새벽까지 (Till Dawn)

킹덤(Netflix) 영감 조선 원귀 생존 액션. 렌더/환경/포스트는 자작 처마 생성기(`../asiahouse`)를
`@cheoma/*` alias로 재사용(vite.config.ts — three 0.185.1 단일 인스턴스 필수).

## Commands

```bash
npm install
npm run dev        # http://127.0.0.1:5188 (?debug=1 튜닝 GUI, ?godmode=1 무적)
npm run build      # tsc && vite build
npm run preview    # http://127.0.0.1:4188
npm test           # playwright 전체 (bot-playtest + visual, desktop+mobile)
node scripts/capture-states.mjs   # 8상태 결정론 스크린샷 → shots/
node scripts/perf-probe.mjs       # FPS/드로우콜 계측 (PERF_STATE=stress)
```

## Rules

- 처마 src는 수정 금지 — `src/api/*` 퍼사이드만 import(ts 타입은 `src/types/cheoma.d.ts`).
- 게임 난수는 전부 `this.rng`(seeded)로 — 테스트 훅 `__THREE_GAME_TEST_HOOKS__.seed` 의존.
- 주야 전환은 `World.setTimeOfDay`(env/post/village + 노출 그레이드 함께)로만.
- 좀비 지오메트리 병합 시 `toNonIndexed()` 정규화 필수(mergeGeometries 제약).
