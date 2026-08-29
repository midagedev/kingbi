import * as THREE from 'three';
import { smoothstep } from '../core/math/scalar.js';
import {
  SEASON_GROUND_BUDGET,
  seasonGroundCarpetActive,
  seasonGroundPalette,
} from './season-ground-plan.js';

// Seasonal ground carpet renderer (#219 / U4).
// One transparent InstancedMesh of leaf/petal decals. No Points, no FAR duplicate.
// Spots come from season-ground-plan.js (env trees+yard or focus parcel).

const linCol = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// 3-frame atlas: [petal | ginkgo | maple] — shared with seasons.js falling leaves.
function drawLeafShape(g, kind) {
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
  if (kind === 0) {
    g.beginPath();
    g.moveTo(0, 21);
    g.bezierCurveTo(15, 13, 14, -13, 3, -19);
    g.quadraticCurveTo(0, -15, -3, -19);
    g.bezierCurveTo(-14, -13, -15, 13, 0, 21);
    g.fill();
  } else if (kind === 1) {
    g.beginPath();
    g.moveTo(0, 20);
    g.quadraticCurveTo(-17, 12, -22, -9);
    g.quadraticCurveTo(-13, -19, -4, -11);
    g.quadraticCurveTo(0, -8, 4, -11);
    g.quadraticCurveTo(13, -19, 22, -9);
    g.quadraticCurveTo(17, 12, 0, 20);
    g.fill();
    g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 18); g.lineTo(0, 29); g.stroke();
  } else {
    const tips = [0, 65, 135, 225, 295];
    const R = 23;
    g.beginPath();
    for (let i = 0; i < tips.length; i++) {
      const a = tips[i] * Math.PI / 180;
      const x = Math.sin(a) * R, y = -Math.cos(a) * R;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      const n = tips[(i + 1) % tips.length];
      let mid = (tips[i] + (n > tips[i] ? n : n + 360)) / 2;
      const bottom = Math.abs(((mid % 360) + 360) % 360 - 180) < 20;
      const rv = bottom ? 5 : 10;
      const av = mid * Math.PI / 180;
      g.lineTo(Math.sin(av) * rv, -Math.cos(av) * rv);
    }
    g.closePath(); g.fill();
    g.lineWidth = 2.6; g.beginPath(); g.moveTo(0, 6); g.lineTo(0, 30); g.stroke();
  }
}

function makeLeafAtlas() {
  const c = document.createElement('canvas');
  c.width = 192; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 192, 64);
  for (let f = 0; f < 3; f++) {
    g.save(); g.translate(f * 64 + 32, 32); drawLeafShape(g, f); g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Build one seasonal ground carpet from planned spots.
 *   spots: planEnvLitterSpots / planFocusLitterSpots records
 *   name: object name (seasonLitter | focusSeasonLitter)
 *   local: when true, positions stay in the parent group's local frame
 * Returns null when spots empty.
 *
 * Draw budget: +1 InstancedMesh, 0 Points, 0 shadow casters.
 */
export function buildSeasonGroundCarpet({
  spots = [],
  name = 'seasonLitter',
  season = 'autumn',
} = {}) {
  const N = spots.length;
  if (!N) return null;
  if (N > SEASON_GROUND_BUDGET.maxInstances) {
    throw new RangeError(
      `season ground carpet ${N} exceeds budget ${SEASON_GROUND_BUDGET.maxInstances}`,
    );
  }

  const tex = makeLeafAtlas();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    alphaTest: 0.06, fog: true,
  });
  // MeshBasic — not a snow surface; no FAR Points path.
  mat.userData.snowSurface = false;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFrame;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = vec2((vMapUv.x + aFrame) / 3.0, vMapUv.y);\n#endif');
  };
  mat.customProgramCacheKey = () => 'cheoma-season-ground-carpet-v1';

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute('aFrame', new THREE.InstancedBufferAttribute(new Float32Array(N), 1));
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = name;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.seasonGroundCarpet = true;
  mesh.userData.drawBudget = {
    draws: SEASON_GROUND_BUDGET.draws,
    points: SEASON_GROUND_BUDGET.points,
    instances: N,
  };

  const st = spots.map((s) => ({
    x: s.x, y: s.y, z: s.z,
    rev: s.rev, rot: s.rot, size: s.size,
    tiltX: s.tiltX, tiltZ: s.tiltZ,
  }));

  const frames = geo.attributes.aFrame.array;
  const col = new THREE.Color();
  let currentSeason = seasonGroundCarpetActive(season) ? season : 'autumn';

  function writePalette(seasonName) {
    const pal = seasonGroundPalette(seasonName);
    const framePool = pal.frames;
    const colors = pal.colors;
    for (let i = 0; i < N; i++) {
      const frame = framePool[i % framePool.length];
      frames[i] = frame;
      // Autumn maps frame→family colour; spring is all pink with slight variety.
      let hex;
      if (seasonName === 'spring') {
        hex = colors[i % colors.length];
      } else if (frame === 1) {
        hex = colors[i % 3];
      } else if (frame === 2) {
        hex = colors[3 + (i % 4)];
      } else {
        hex = colors[7 + (i % 4)];
      }
      col.copy(linCol(hex)).multiplyScalar(0.82 + ((i * 2654435761) >>> 0) % 1000 / 1000 * 0.32);
      mesh.setColorAt(i, col);
    }
    geo.attributes.aFrame.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }
  writePalette(currentSeason);

  const dummy = new THREE.Object3D();
  let last = -1;
  let lastSeason = currentSeason;

  function setLevel(level) {
    const L = Math.max(0, Math.min(1, Number(level) || 0));
    if (Math.abs(L - last) < 0.004 && lastSeason === currentSeason) return;
    last = L;
    lastSeason = currentSeason;
    mesh.visible = L > 0.005;
    if (!mesh.visible) return;
    for (let i = 0; i < N; i++) {
      const p = st[i];
      const g = smoothstep(p.rev, p.rev + 0.18, L);
      const sc = g * p.size;
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(-Math.PI / 2 + p.tiltX, p.rot, p.tiltZ);
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function setSeason(name) {
    if (!seasonGroundCarpetActive(name)) {
      // Keep last palette; caller drives level to 0 for summer/winter.
      return;
    }
    if (name === currentSeason) return;
    currentSeason = name;
    writePalette(name);
    // Force matrix rewrite so a mid-transition colour swap reappears.
    last = -1;
  }

  function dispose() {
    mesh.geometry.dispose();
    mesh.material.dispose();
    tex.dispose();
  }

  setLevel(0);

  return {
    mesh,
    tex,
    setLevel,
    setSeason,
    dispose,
    get count() { return N; },
    get season() { return currentSeason; },
    get budget() { return mesh.userData.drawBudget; },
  };
}
