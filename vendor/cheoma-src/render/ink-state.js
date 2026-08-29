// Three/DOM-free render-style contract shared by URLs, app state, and adapters.
// Keep the persisted vocabulary intentionally small: new visual treatments belong
// behind one of these stable product modes rather than leaking shader names to URLs.
export const RENDER_STYLE_IDS = Object.freeze(['pbr', 'ink']);

export function normalizeRenderStyle(value) {
  return value === 'ink' ? 'ink' : 'pbr';
}
