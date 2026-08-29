// Reusable mud-wall surface planning and owned-geometry lifecycle API.
// Callers provide their own Three materials when attaching the geometries to meshes.
export * from './mud-wall-plan.js';
export {
  buildMudWallSurfaceGeometry,
  disposeMudWallSurfaceGeometry,
} from '../village/mud-wall-geometry.js';
