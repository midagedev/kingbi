import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const gameRoot = fileURLToPath(new URL('.', import.meta.url));
// The live cheoma checkout next door wins locally; CI (and any machine
// without the sibling) builds against the vendored snapshot under
// vendor/cheoma-src. Re-copy it when asiahouse changes.
const cheomaSibling = path.join(repoRoot, 'asiahouse', 'src');
const cheomaVendored = path.join(gameRoot, 'vendor', 'cheoma-src');
const cheomaSrc = fs.existsSync(cheomaSibling) ? cheomaSibling : cheomaVendored;

// Single three.js instance contract (cheoma breaks silently on a second copy:
// instanceof checks + prototype patches). Every bare `three` import — ours and
// cheoma's — resolves to this game's node_modules copy.
const threeModule = fileURLToPath(
  new URL('./node_modules/three/build/three.module.js', import.meta.url),
);
const threeAddons = fileURLToPath(
  new URL('./node_modules/three/examples/jsm/', import.meta.url),
);

export default defineConfig(({ command }) => ({
  // GitHub Pages project site: the DEPLOY build anchors assets at /kingbi/;
  // dev/preview stay at '/' so local probes keep their URLs.
  base: command === 'build' ? '/kingbi/' : '/',
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  resolve: {
    alias: [
      { find: /^three\/addons\/(.*)$/, replacement: `${threeAddons}$1` },
      { find: /^three$/, replacement: threeModule },
      { find: /^@cheoma\/(.*)$/, replacement: path.join(cheomaSrc, '$1') },
    ],
    dedupe: ['three'],
  },
  build: {
    // Maps were a 7.6MB deploy tax with no player value — see QA report.
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
}));
