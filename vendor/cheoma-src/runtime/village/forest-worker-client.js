import { abortError } from '../abort.js';

let forestWorker = null; // null=미시도, false=사용 불가, Worker=활성
let jobSequence = 0;
const jobs = new Map();

export function forestWorkerAllowed() {
  if (typeof Worker === 'undefined') return false;
  if (typeof location !== 'undefined') {
    try {
      if (new URLSearchParams(location.search).get('worker') === '0') return false;
    } catch {}
  }
  return true;
}

function rejectPendingJobs(error) {
  for (const settle of jobs.values()) settle({ ok: false, error });
  jobs.clear();
}

function getForestWorker() {
  if (forestWorker !== null) return forestWorker || null;
  if (!forestWorkerAllowed()) {
    forestWorker = false;
    return null;
  }

  try {
    const worker = new Worker(new URL('../../village/populate.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const data = event.data || {};
      const settle = jobs.get(data.id);
      if (!settle) return;
      jobs.delete(data.id);
      settle(data);
    };
    worker.onerror = () => {
      forestWorker = false;
      rejectPendingJobs('worker error');
    };
    forestWorker = worker;
    return worker;
  } catch {
    forestWorker = false;
    return null;
  }
}

// opts+seed → worker crunch 결과. 사용 불가·실패는 reject하며 호출자가 동기 fallback을 선택한다.
export function crunchForestInWorker(opts, seed, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError('Village forest generation aborted'));
      return;
    }
    const worker = getForestWorker();
    if (!worker) {
      reject(new Error('no-worker'));
      return;
    }

    const id = ++jobSequence;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (!jobs.delete(id)) return;
      cleanup();
      reject(abortError('Village forest generation aborted'));
    };
    jobs.set(id, (data) => {
      cleanup();
      if (data?.ok) resolve(data.crunch);
      else reject(new Error(data?.error || 'worker-fail'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      worker.postMessage({ opts, seed, id });
    } catch (error) {
      jobs.delete(id);
      cleanup();
      reject(error);
    }
  });
}
