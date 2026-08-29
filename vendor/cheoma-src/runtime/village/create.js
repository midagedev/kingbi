import { planVillage } from '../../village/plan.js';
import { populateVillage, populateVillageSteps } from '../../village/populate.js';
import { createVillageRandomWindow, resolveVillageSeed } from './random-window.js';
import { crunchForestInWorker, forestWorkerAllowed } from './forest-worker-client.js';
import { createVillageHandle } from './handle.js';
import { abortError, isAbortError } from '../abort.js';
import { disposeObjectTree } from '../../core/three-resources.js';

export function createVillage(opts = {}) {
  const seed = resolveVillageSeed(opts.seed);
  const runSeeded = createVillageRandomWindow(seed);
  let plan;
  let group;
  runSeeded(() => {
    plan = planVillage({ ...opts, seed });
    group = populateVillage(plan);
  });
  return createVillageHandle(opts, seed, plan, group);
}

// plan과 populate generator의 각 slice만 seeded window에 넣는다. slice 사이의 render loop는 원래
// Math.random을 쓰되, 동일 RNG closure를 재사용하므로 sync와 소비 순서가 byte-identical하다.
export function createVillageAsync(opts = {}, {
  onStep, budgetMs = 8, nextFrame, cancelFrame, signal,
} = {}) {
  const seed = resolveVillageSeed(opts.seed);
  const runSeeded = createVillageRandomWindow(seed);
  const usesAnimationFrame = !nextFrame && typeof requestAnimationFrame === 'function';
  const schedule = nextFrame || (usesAnimationFrame
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 0));
  const cancelSchedule = cancelFrame || (!nextFrame
    ? (handle) => (usesAnimationFrame ? cancelAnimationFrame(handle) : clearTimeout(handle))
    : null);

  return new Promise((resolve, reject) => {
    const forestCrunch = { value: null };
    const usesWorker = forestWorkerAllowed();
    const workerAbort = new AbortController();
    let workerFailed = false;
    let plan = null;
    let steps = null;
    let partialRoot = null;
    let stepIndex = 0;
    let lastLabel = null;
    let scheduled = null;
    let settled = false;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (scheduled != null && cancelSchedule) cancelSchedule(scheduled);
      scheduled = null;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      workerAbort.abort();
      try { steps?.return?.(); } catch {}
      if (partialRoot) {
        partialRoot.userData.yardLife?.dispose?.();
        disposeObjectTree(partialRoot);
        partialRoot.clear();
        partialRoot = null;
      }
      reject(error);
    };
    const succeed = (handle) => {
      if (settled) { handle?.dispose?.(); return; }
      settled = true;
      cleanup();
      partialRoot = null; // ownership moves into VillageHandle
      resolve(handle);
    };
    const onAbort = () => fail(abortError('Village generation aborted'));
    const aborted = () => {
      if (!signal?.aborted) return false;
      onAbort();
      return true;
    };
    const scheduleSlice = () => {
      if (settled || aborted()) return;
      scheduled = schedule(() => {
        scheduled = null;
        runSlice();
      });
    };

    function runSlice() {
      if (settled || aborted()) return;
      try {
        const startedAt = now();
        if (!plan) {
          runSeeded(() => { plan = planVillage({ ...opts, seed }); });
          if (aborted()) return;
          steps = populateVillageSteps(plan, {
            forestCrunchRef: forestCrunch,
            onRoot: (root) => { partialRoot = root; },
          });
          onStep?.('plan', stepIndex++);
          if (aborted()) return;
          if (now() - startedAt < budgetMs) return runSlice();
          scheduleSlice();
          return;
        }

        let result = { done: false };
        do {
          // 다음 generator step이 forest 조립이면 worker buffer가 도착할 때까지 메인 thread를 양보한다.
          if (lastLabel === 'trees' && usesWorker && !forestCrunch.value && !workerFailed) {
            scheduleSlice();
            return;
          }
          result = runSeeded(() => steps.next());
          if (aborted()) return;
          if (!result.done) {
            lastLabel = result.value;
            onStep?.(result.value, stepIndex++);
            if (aborted()) return;
          }
        } while (!result.done && now() - startedAt < budgetMs);

        if (result.done) {
          if (aborted()) return;
          succeed(createVillageHandle(opts, seed, plan, result.value));
          return;
        }
        scheduleSlice();
      } catch (error) {
        fail(error);
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (aborted()) return;
    if (usesWorker) {
      crunchForestInWorker(opts, seed, { signal: workerAbort.signal }).then(
        (result) => {
          if (settled) return;
          forestCrunch.value = result;
        },
        (error) => {
          if (settled) return;
          if (isAbortError(error)) fail(error);
          else workerFailed = true;
        },
      );
    }
    try { scheduleSlice(); }
    catch (error) { fail(error); }
  });
}
