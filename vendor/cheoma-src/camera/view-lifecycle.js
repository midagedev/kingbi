// Village view lifecycle — Three/DOM-free pure reducer + diagnostic event trace.
//
// Why this exists (#150 item M): explore / focus / hop / focusOut / wave / exit
// transitions are scattered across engine.js. Before any large split, the legal
// transition table and a ring-buffer event log must be a pure contract that
// Node can exhaust without WebGL. The engine only dispatches; side effects stay
// in the integration façade.
//
// Orthogonal axes (must stay split):
//   · selection regime — this module (which parcel, if any)
//   · zoom distance — wheel/pinch inside explore|focus via optics.js; never
//     owns enter/leave of focus. Transitions lock zoom but do not change the
//     selection regime by themselves.
//
// Wave exclusivity: while phase === 'waving', focus / hop / focusOut are
// rejected. Exit may still cancel the wave and leave village mode.

export const VIEW_PHASES = Object.freeze([
  'outside',
  'explore',
  'focusing',
  'focus',
  'hopping',
  'focusingOut',
  'waving',
]);

// Engine-facing intent events. Completion events (*Done / waveCancel) close a
// transition the engine already started; the pure table owns which intents are
// legal from each phase.
export const VIEW_EVENTS = Object.freeze([
  'enter',
  'focus',
  'focusDone',
  'hop',
  'hopDone',
  'focusOut',
  'focusOutDone',
  'wave',
  'waveDone',
  'waveCancel',
  'exit',
]);

const OUTSIDE = Object.freeze({ phase: 'outside', selected: null, from: null });

export function viewInitialState() {
  return OUTSIDE;
}

function freezeState(phase, selected = null, from = null) {
  return Object.freeze({ phase, selected, from });
}

function parcelIdOf(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string' || typeof payload === 'number') return payload;
  if (typeof payload === 'object' && payload.parcelId != null) return payload.parcelId;
  return null;
}

/** True while a camera or scenery transition owns input. */
export function viewIsBusy(state) {
  const phase = (state || OUTSIDE).phase;
  return phase === 'focusing' || phase === 'hopping'
    || phase === 'focusingOut' || phase === 'waving';
}

/** Selection regime for product chrome — never conflated with zoom distance. */
export function viewSelectionRegime(state) {
  const s = state || OUTSIDE;
  if (s.phase === 'outside') return 'outside';
  if (s.phase === 'focus' || s.phase === 'focusing' || s.phase === 'hopping') return 'focus';
  // explore, focusingOut (already cleared), waving (cleared to aerial)
  return 'explore';
}

/**
 * Zoom lock is derived from the transition phase only.
 * Settled explore/focus allow wheel/pinch; transitions and wave lock distance.
 * This is deliberately not a second selection state.
 */
export function viewZoomRegime(state) {
  const s = state || OUTSIDE;
  if (s.phase === 'outside') return 'free';
  if (s.phase === 'explore') return 'explore';
  if (s.phase === 'focus') return 'focus';
  return 'lock';
}

export function viewWaveExclusive(state) {
  return (state || OUTSIDE).phase === 'waving';
}

/**
 * Pure transition table.
 * No-ops return the identical frozen object so callers can identity-check.
 */
export function viewReduce(state, event, payload = null) {
  const s = state || OUTSIDE;
  const id = parcelIdOf(payload);

  switch (event) {
    case 'enter': {
      // Enter (or re-enter) village aerial. Focus/wave traces are dropped.
      if (s.phase === 'explore' && s.selected == null && s.from == null) return s;
      return freezeState('explore', null, null);
    }

    case 'focus': {
      if (id == null) return s;
      // Only from settled explore. Settled focus uses hop; transitions/wave reject.
      if (s.phase !== 'explore') return s;
      return freezeState('focusing', id, null);
    }

    case 'focusDone': {
      if (s.phase !== 'focusing' || s.selected == null) return s;
      return freezeState('focus', s.selected, null);
    }

    case 'hop': {
      if (id == null) return s;
      if (s.phase !== 'focus' || s.selected == null) return s;
      if (id === s.selected) return s; // same parcel is a product no-op
      return freezeState('hopping', id, s.selected);
    }

    case 'hopDone': {
      if (s.phase !== 'hopping' || s.selected == null) return s;
      return freezeState('focus', s.selected, null);
    }

    case 'focusOut': {
      // Allowed from settled focus, mid focus-in, or mid hop (escape / breadcrumb).
      // Wave exclusivity: waving rejects focusOut — exit cancels instead.
      if (s.phase === 'focus') {
        return freezeState('focusingOut', null, s.selected);
      }
      if (s.phase === 'focusing' || s.phase === 'hopping') {
        return freezeState('focusingOut', null, s.selected);
      }
      // Already focusing out, explore, outside, waving → identity
      return s;
    }

    case 'focusOutDone': {
      if (s.phase !== 'focusingOut') return s;
      return freezeState('explore', null, null);
    }

    case 'wave': {
      // Wave is exclusive scenery handoff. Accept from settled explore or
      // settled focus (engine defensively clears focus first). Reject mid
      // camera transitions and a second concurrent wave.
      if (s.phase === 'explore') {
        return freezeState('waving', null, null);
      }
      if (s.phase === 'focus') {
        return freezeState('waving', null, null);
      }
      return s;
    }

    case 'waveDone':
    case 'waveCancel': {
      if (s.phase !== 'waving') return s;
      return freezeState('explore', null, null);
    }

    case 'exit': {
      // Always legal from any village phase; outside is identity.
      if (s.phase === 'outside') return s;
      return OUTSIDE;
    }

    default:
      return s;
  }
}

/** Whether `event` would change state from `state` (legal non-identity step). */
export function viewCan(state, event, payload = null) {
  const s = state || OUTSIDE;
  return viewReduce(s, event, payload) !== s;
}

// ── Ring-buffer event trace (diagnostics; not part of the pure state) ──

export const VIEW_TRACE_DEFAULT_CAPACITY = 64;

/**
 * Fixed-capacity ring buffer of lifecycle dispatches.
 * Mutable by design — it is a diagnostic log, not product state.
 */
export function createViewTrace(capacity = VIEW_TRACE_DEFAULT_CAPACITY) {
  const cap = Math.max(1, capacity | 0);
  const slots = new Array(cap);
  let head = 0; // next write index
  let size = 0;
  let seq = 0;

  function push(entry) {
    slots[head] = entry;
    head = (head + 1) % cap;
    if (size < cap) size += 1;
    return entry;
  }

  return {
    get capacity() { return cap; },
    get size() { return size; },
    clear() {
      for (let i = 0; i < cap; i++) slots[i] = undefined;
      head = 0;
      size = 0;
      seq = 0;
    },
    /** Oldest → newest. */
    toArray() {
      const out = new Array(size);
      const start = size === cap ? head : 0;
      for (let i = 0; i < size; i++) out[i] = slots[(start + i) % cap];
      return out;
    },
    /**
     * Apply a pure reduce, record the step, return the next state.
     * Identity reductions are still logged (rejected intents are diagnostics).
     */
    dispatch(state, event, payload = null) {
      const prev = state || OUTSIDE;
      const next = viewReduce(prev, event, payload);
      push(Object.freeze({
        seq: seq++,
        event,
        payload: payload == null ? null : payload,
        from: prev.phase,
        to: next.phase,
        selected: next.selected,
        changed: next !== prev,
      }));
      return next;
    },
  };
}
