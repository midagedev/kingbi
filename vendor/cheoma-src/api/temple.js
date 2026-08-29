// Reusable Korean temple compound generation and explicit lifecycle API.
export * from './temple-plan.js';
export { buildTempleCompound, disposeTempleCompound } from '../temple/compound.js';
export {
  DANCHEONG_DEFAULTS,
  resolveDancheong,
  resolveTempleRoleDancheong,
} from '../builder/dancheong.js';
