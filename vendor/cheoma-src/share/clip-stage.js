// Renderer-free viral clip stage contract (#255–#260).
// Each stage pins seed/time/scale/mode so OS screen recordings stay reproducible.
// No in-app recorder — stages only fix boot path and product state.

export const CLIP_STAGE_IDS = Object.freeze([
  'assemble',
  'yard',
  'aerial',
  'night',
  'ink',
]);

const stage = (id, fields) => Object.freeze({ id, ...fields });

// Fixed product fixtures for share URLs (seed 7 is the clip/golden workhorse).
export const CLIP_STAGES = Object.freeze({
  // High-원 assembly: default hero landing (2-beat reveal + 10s tofu).
  assemble: stage('assemble', {
    seed: 7,
    vseed: 7,
    vscale: 'village',
    time: 'sunset',
    season: 'summer',
    weather: 'clear',
    renderStyle: 'pbr',
    boot: 'hero',
    autoEnter: true,
    parcelId: null,
    label: '종가 조립 (고원)',
  }),
  // Courtyard life: aerial village then focus a known residential parcel.
  yard: stage('yard', {
    seed: 7,
    vseed: 7,
    vscale: 'village',
    time: 'sunset',
    season: 'summer',
    weather: 'clear',
    renderStyle: 'pbr',
    boot: 'village-focus',
    autoEnter: true,
    // capital/7/p8 is a cinematic fixture; village/7 uses p8 as a regular house
    // when present — resolve falls back to first non-hero residential.
    parcelId: 'p8',
    label: '마당 근경',
  }),
  // Basin aerial: 배산임수 bowl reading.
  aerial: stage('aerial', {
    seed: 7,
    vseed: 7,
    vscale: 'village',
    time: 'sunset',
    season: 'summer',
    weather: 'clear',
    renderStyle: 'pbr',
    boot: 'village-aerial',
    autoEnter: true,
    parcelId: null,
    label: '배산임수 부감',
  }),
  // Night moon + hanji: aerial under night atmosphere.
  night: stage('night', {
    seed: 7,
    vseed: 7,
    vscale: 'village',
    time: 'night',
    season: 'summer',
    weather: 'clear',
    renderStyle: 'pbr',
    boot: 'village-aerial',
    autoEnter: true,
    parcelId: null,
    label: '야간 달·창호',
  }),
  // Ink landscape accent — separate clip, never mixed into PBR assemble.
  ink: stage('ink', {
    seed: 7,
    vseed: 7,
    vscale: 'village',
    time: 'day',
    season: 'summer',
    weather: 'clear',
    renderStyle: 'ink',
    boot: 'village-aerial',
    autoEnter: true,
    parcelId: null,
    label: '수묵 산수',
  }),
});

export function normalizeClipStageId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return CLIP_STAGE_IDS.includes(id) ? id : null;
}

export function clipStageFor(value) {
  const id = normalizeClipStageId(value);
  return id ? CLIP_STAGES[id] : null;
}

/** Query keys a stage always forces into the product boot (shareable). */
export function clipStageQuery(stageOrId) {
  const stageSpec = typeof stageOrId === 'string'
    ? clipStageFor(stageOrId)
    : stageOrId;
  if (!stageSpec) return null;
  const q = {
    clip: stageSpec.id,
    seed: String(stageSpec.seed >>> 0),
    vseed: String(stageSpec.vseed >>> 0),
    time: stageSpec.time,
    season: stageSpec.season,
    weather: stageSpec.weather,
  };
  if (stageSpec.vscale && stageSpec.vscale !== 'village') q.vscale = stageSpec.vscale;
  if (stageSpec.renderStyle === 'ink') q.mode = 'ink';
  if (stageSpec.boot !== 'hero') q.village = '1';
  return Object.freeze(q);
}

export function buildClipStageUrl(baseUrl, stageOrId) {
  const q = clipStageQuery(stageOrId);
  if (!q) return null;
  const url = new URL(baseUrl, 'https://cheoma.midagedev.com/');
  // Replace the whole search so a stale scene snapshot cannot win.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) params.set(key, value);
  url.search = params.toString();
  return url.toString();
}
