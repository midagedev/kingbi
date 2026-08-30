import * as THREE from 'three';

/** Canvas masonry: stone base + mottle + staggered seams, reused as color and
 *  bump so the rampart reads as fitted blocks at quarter-view distance. */
function makeStoneTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8f887a';
  ctx.fillRect(0, 0, size, size);
  let s = 1337;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const rows = 8;
  const rowH = size / rows;
  for (let row = 0; row < rows; row += 1) {
    const offset = (row % 2) * (size / 12);
    for (let x = -1; x < 6; x += 1) {
      const w = size / 6;
      const px = x * w + offset;
      const shade = 0.82 + rnd() * 0.3;
      ctx.fillStyle = `rgb(${Math.round(148 * shade)}, ${Math.round(140 * shade)}, ${Math.round(122 * shade)})`;
      ctx.fillRect(px + 1.5, row * rowH + 1.5, w - 3, rowH - 3);
    }
  }
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 900; i += 1) {
    ctx.fillStyle = rnd() > 0.5 ? '#5f594e' : '#b7b0a0';
    ctx.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 3, 1 + rnd() * 2);
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Cookbook (a): fresnel rim — separates a body from a dark background
 *  without another dynamic light. A cool steel tint reads white in the
 *  noir grade, so the rim reads as moonlight on the metal. */
function applyRim(material: THREE.MeshStandardMaterial, color: number, strength: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: new THREE.Color(color) };
    shader.uniforms.uRimStrength = { value: strength };
    shader.fragmentShader =
      'uniform vec3 uRimColor;\nuniform float uRimStrength;\n' +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float fres = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
         totalEmissiveRadiance += uRimColor * fres * uRimStrength;`,
      );
  };
  material.customProgramCacheKey = () => `fresnel-rim-${strength}`;
}

/**
 * 궁 벙커 개틀링 — the first-person gatling rig: stone embrasure rampart
 * plus a six-barrel gun with spin animation, muzzle flash, and heat glow.
 * The gun group parents to the FPS camera; the rampart stays in the world.
 */
export class Gunner {
  /** World-space bunker rampart (stays at the palace heart). */
  readonly bunker = new THREE.Group();
  /** Camera-space gun rig (barrels + shield + belt). */
  readonly gun = new THREE.Group();

  private readonly barrelAssembly = new THREE.Group();
  private readonly barrels: THREE.Mesh[] = [];
  private readonly muzzleFlash: THREE.Sprite;
  private readonly muzzleLight: THREE.PointLight;
  private readonly heatMaterial: THREE.MeshStandardMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private spin = 0;
  private flashTimer = 0;

  constructor(scene: THREE.Scene, centerX: number, centerZ: number, groundY: number) {
    // ── Bunker: stone drum rampart with an embrasure lip and torch posts. ──
    const bunkerStoneTex = makeStoneTexture();
    bunkerStoneTex.repeat.set(4, 1.4);
    const stone = new THREE.MeshStandardMaterial({
      color: 0x9a9282, roughness: 0.95, map: bunkerStoneTex, bumpMap: bunkerStoneTex, bumpScale: 0.5,
    });
    const stoneDark = new THREE.MeshStandardMaterial({ color: 0x6e675a, roughness: 0.95 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x5c4632, roughness: 0.9 });
    this.materials.push(stone, stoneDark, wood);

    const track = (mesh: THREE.Mesh) => {
      this.geometries.push(mesh.geometry);
      mesh.castShadow = false; // moon map is cached statics-only
      mesh.receiveShadow = true;
      return mesh;
    };

    const rampart = track(new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.1, 1.5, 12), stone));
    rampart.position.y = 0.75;
    this.bunker.add(rampart);

    const parapet = track(new THREE.Mesh(new THREE.TorusGeometry(2.62, 0.24, 6, 14), stoneDark));
    parapet.rotation.x = Math.PI / 2;
    parapet.position.y = 1.55;
    this.bunker.add(parapet);

    // Ammo crates ringing the platform.
    const crateGeo = new THREE.BoxGeometry(0.55, 0.34, 0.36);
    for (let i = 0; i < 5; i += 1) {
      const crate = track(new THREE.Mesh(crateGeo, wood));
      const a = (i / 5) * Math.PI * 2 + 0.7;
      crate.position.set(Math.cos(a) * 1.85, 1.67, Math.sin(a) * 1.85);
      crate.rotation.y = -a;
      this.bunker.add(crate);
    }

    // Torch posts at four corners — the night defense mood anchors.
    const postGeo = new THREE.CylinderGeometry(0.04, 0.05, 1.3, 5);
    const flameTex = makeFlameTexture();
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const post = track(new THREE.Mesh(postGeo, wood));
      post.position.set(Math.cos(a) * 2.35, 2.1, Math.sin(a) * 2.35);
      this.bunker.add(post);
      const torch = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flameTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      torch.scale.set(0.7, 1.0, 1);
      torch.position.set(Math.cos(a) * 2.35, 2.85, Math.sin(a) * 2.35);
      this.bunker.add(torch);
      // Torch glow is carried by the additive sprite; no dynamic light
      // (forward renderer pays per light per fragment — see perf notes).
    }

    this.bunker.position.set(centerX, groundY, centerZ);
    this.bunker.name = 'bunker';
    scene.add(this.bunker);

    // ── Gun (camera space): shield, housing, six barrels, belt. ──
    // Rim light (cookbook fresnel): the gun sat half-swallowed by the
    // bunker's shadow — a cool steel rim carves it back out without
    // spending another dynamic light.
    const gunSteel = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.42, metalness: 0.85 });
    const gunDark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.6, metalness: 0.7 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc9a24b, roughness: 0.35, metalness: 0.9 });
    applyRim(gunSteel, 0xaebbd0, 0.85);
    applyRim(gunDark, 0x8fa0b8, 0.6);
    applyRim(brassMat, 0xe8d9a8, 0.5);
    this.heatMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a4038,
      emissive: new THREE.Color(0xff3a10),
      emissiveIntensity: 0,
      roughness: 0.5,
      metalness: 0.8,
    });
    this.materials.push(gunSteel, gunDark, brassMat, this.heatMaterial);

    const gTrack = (mesh: THREE.Mesh) => {
      this.geometries.push(mesh.geometry);
      return mesh;
    };

    const shield = gTrack(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.06, 12), gunSteel));
    shield.rotation.x = Math.PI / 2 - 0.22;
    shield.position.set(0, -0.02, -0.42);
    this.gun.add(shield);

    const housing = gTrack(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.34, 10), gunDark));
    housing.rotation.x = Math.PI / 2;
    housing.position.set(0, -0.03, -0.16);
    this.gun.add(housing);

    const rearPlate = gTrack(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.1, 8), brassMat));
    rearPlate.rotation.x = Math.PI / 2;
    rearPlate.position.set(0, -0.03, 0.06);
    this.gun.add(rearPlate);

    // Six barrels around the spin axis; heat jacket on the middle section.
    const barrelGeo = new THREE.CylinderGeometry(0.026, 0.03, 0.78, 6);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, -0.52);
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      const barrel = gTrack(new THREE.Mesh(barrelGeo, gunSteel));
      barrel.position.set(Math.cos(a) * 0.062, Math.sin(a) * 0.062 - 0.03, 0);
      this.barrels.push(barrel);
      this.barrelAssembly.add(barrel);
    }
    const jacket = gTrack(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 10), this.heatMaterial));
    jacket.rotation.x = Math.PI / 2;
    jacket.position.set(0, -0.03, -0.36);
    this.barrelAssembly.add(jacket);
    this.gun.add(this.barrelAssembly);

    // Ammo belt curving in from the lower right.
    const beltCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.12, -0.14, 0.02),
      new THREE.Vector3(0.2, -0.2, 0.14),
      new THREE.Vector3(0.26, -0.24, 0.3),
      new THREE.Vector3(0.24, -0.2, 0.48),
    ]);
    const belt = gTrack(new THREE.Mesh(new THREE.TubeGeometry(beltCurve, 10, 0.024, 5, false), brassMat));
    this.gun.add(belt);

    // Muzzle flash sprite + light at the barrel tips.
    const flashTex = makeFlameTexture();
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    this.muzzleFlash.scale.setScalar(0.001);
    this.muzzleFlash.position.set(0, -0.03, -0.94);
    this.muzzleFlash.material.rotation = 0;
    this.gun.add(this.muzzleFlash);
    this.materials.push(this.muzzleFlash.material as THREE.SpriteMaterial);

    this.muzzleLight = new THREE.PointLight(0xff6a3a, 0, 16, 2);
    this.muzzleLight.position.set(0, -0.03, -1.0);
    this.gun.add(this.muzzleLight);

    // Quarter-view turret: seated on the bunker platform, scaled to read from
    // the defense camera. Yaw tracks the ground aim point.
    this.gun.position.set(0, 2.06, 0);
    this.gun.scale.setScalar(2.15);
    this.bunker.add(this.gun);
    this.gun.name = 'gatling';
  }

  /** Ground-plane yaw the barrels should sweep toward (atan2(dx, dz)). */
  setAim(yaw: number): void {
    this.targetAimYaw = yaw;
  }

  private targetAimYaw = Math.PI;
  private currentAimYaw = Math.PI;

  private shortestAngle(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  setSpinRate(rate01: number): void {
    this.targetSpin = rate01;
  }

  private targetSpin = 0;

  /** Barrel world-space muzzle position for tracers. */
  muzzleWorld(target: THREE.Vector3): THREE.Vector3 {
    return this.barrelAssembly.getWorldPosition(target);
  }

  flash(): void {
    this.flashTimer = 0.085;
    // Keep a sustained bloom alive while the trigger is held: the per-shot
    // sprite decays in 85ms, this floor carries the whole 격发 window.
    this.sustainFlash = 0.18;
  }

  private sustainFlash = 0;

  setHeat(heat01: number): void {
    this.heatMaterial.emissiveIntensity = heat01 * 1.8;
  }

  update(delta: number, animDelta: number): void {
    this.spin += this.targetSpin * animDelta * 46;
    this.barrelAssembly.rotation.z = this.spin;
    this.currentAimYaw += this.shortestAngle(this.currentAimYaw, this.targetAimYaw) * Math.min(1, delta * 11);
    // The rig's local forward is -z; an aim yaw of atan2(dx, dz) needs +π.
    this.gun.rotation.y = this.currentAimYaw + Math.PI;
    this.sustainFlash = Math.max(0, this.sustainFlash - delta);
    const alive = this.flashTimer > 0 || this.sustainFlash > 0 && this.targetSpin > 0.1;
    if (alive) {
      if (this.flashTimer > 0) this.flashTimer -= delta;
      const pulse = 0.72 + Math.sin(this.spin * 3.1) * 0.14 + Math.random() * 0.1;
      const s = 0.68 * pulse;
      this.muzzleFlash.scale.set(s + 0.001, s + 0.001, 1);
      this.muzzleLight.intensity = 52 * pulse;
    } else {
      this.muzzleFlash.scale.setScalar(0.001);
      this.muzzleLight.intensity = 0;
    }
  }

  reset(): void {
    this.spin = 0;
    this.targetSpin = 0;
    this.flashTimer = 0;
    this.sustainFlash = 0;
    this.targetAimYaw = Math.PI;
    this.currentAimYaw = Math.PI;
    this.gun.rotation.y = 0;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) {
      const spriteMat = material as THREE.SpriteMaterial;
      spriteMat.map?.dispose();
      material.dispose();
    }
    this.bunker.removeFromParent();
    this.gun.removeFromParent();
  }}

export function makeFlameTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 36, 2, 32, 32, 30);
    gradient.addColorStop(0, 'rgba(255, 246, 234, 0.95)');
    gradient.addColorStop(0.35, 'rgba(255, 64, 36, 0.6)');
    gradient.addColorStop(1, 'rgba(80, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}
