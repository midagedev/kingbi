// 브라우저 Web Audio 기반 환경음·음악 오케스트레이터의 공개 API.
export { setupAudio } from '../audio/index.js';
// Pure positional-anchor helpers (village stream / 풍경 eave corners). No AudioContext.
export {
  chimeLocalCorners,
  chimeLayoutParams,
  chimeWorldCorners,
  nearestStreamAnchor,
  pickChimeParcel,
} from '../audio/anchors.js';
