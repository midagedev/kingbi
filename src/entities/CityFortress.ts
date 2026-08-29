import type { CheomaCityWallSpec, CheomaCityWallGate } from '@cheoma/api/village.js';

/** cheoma CITY_WALL_DIMENSIONS: body 7.9 − foundation 2.5 = 5.4 above grade. */
export const WALL_WALK_HEIGHT = 5.4;
const WALL_THICKNESS = 2.6;

/**
 * The 한양 성곽 as a horde collider: the cheoma contour is a wobbly ring, so
 * collision is radial — a body may cross the wall line only inside a gate's
 * angular opening. Outside bodies slide along the outer face until they find
 * a gate; inside bodies are kept inside the same way. Four gates stay open:
 * the south gate is the kill funnel the gatling covers, the others let
 * stragglers take the long way around (and remind you the city is a ring).
 */
export class CityFortress {
  readonly southGate: CheomaCityWallGate;

  constructor(private readonly spec: CheomaCityWallSpec) {
    const south = spec.gates.find((gate) => gate.name === 'south');
    if (!south) throw new Error('city wall has no south gate');
    this.southGate = south;
  }

  /** Wall-line radius at a cheoma-convention angle (point = c + r·(sin a, cos a)). */
  radiusAt(a: number): number {
    const radii = this.spec.radii;
    const n = radii.length;
    const t = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const f = (t / (Math.PI * 2)) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const k = f - Math.floor(f);
    return radii[i0] * (1 - k) + radii[i1] * k;
  }

  private inGateCorridor(a: number): boolean {
    for (const gate of this.spec.gates) {
      let d = Math.abs(a - gate.angle) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d < gate.halfAngle) return true;
    }
    return false;
  }

  /** Radial clamp against the wall ring; gate corridors pass free. */
  resolveBody(body: { x: number; z: number }, radius: number): boolean {
    const dx = body.x - this.spec.cx;
    const dz = body.z - this.spec.cz;
    const r = Math.hypot(dx, dz) || 1e-4;
    const a = Math.atan2(dx, dz);
    if (this.inGateCorridor(a)) return false;
    const wallR = this.radiusAt(a);
    const halfBand = WALL_THICKNESS * 0.5 + radius;
    if (r <= wallR - halfBand) return false;
    // Snap back to whichever face the body is already on — walls never
    // teleport a zombie through, they just refuse passage.
    const side = r >= wallR ? 1 : -1;
    const target = wallR + side * halfBand;
    body.x = this.spec.cx + Math.sin(a) * target;
    body.z = this.spec.cz + Math.cos(a) * target;
    return true;
  }
}
