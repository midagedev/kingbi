// Renderer-free semantic subject for temple focus composition.
//
// TemplePlan already owns the main worship hall and worship court. This adapter
// derives only the physical fit points and aim point needed by a camera; it
// allocates no Three objects and does not inspect the assembled compound.

import { PRESETS, computeLayout } from '../params.js';
import { templeHallBuilderParams } from './role-hierarchy.js';

function polygonCenter(polygon) {
  const sum = polygon.reduce((current, point) => ({
    x: current.x + point.x,
    z: current.z + point.z,
  }), { x: 0, z: 0 });
  const count = polygon.length || 1;
  return { x: sum.x / count, z: sum.z / count };
}

export function templeFocusSubject(plan) {
  const mainHall = plan?.buildings?.find((building) => building.role === 'main-hall');
  const worshipCourt = plan?.courtyards?.find((court) => court.role === 'worship');
  const hallFootprint = mainHall?.eaveFootprint?.polygon;
  const courtFootprint = worshipCourt?.polygon;
  if (!mainHall || !Array.isArray(hallFootprint) || hallFootprint.length < 3
    || !Array.isArray(courtFootprint) || courtFootprint.length < 3) return null;
  const scale = Number.isFinite(mainHall.scale) ? mainHall.scale : 1;
  const layout = computeLayout({
    ...PRESETS.temple,
    ...templeHallBuilderParams(mainHall),
    frontBays: mainHall.frontBays,
    sideBays: mainHall.sideBays,
  });
  const hallCenter = polygonCenter(hallFootprint);
  const courtCenter = polygonCenter(courtFootprint);
  return {
    id: `${plan.variant || 'temple'}:main-worship`,
    representative: {
      id: mainHall.id,
      role: mainHall.role,
      footprint: hallFootprint.map((point) => ({ x: point.x, z: point.z })),
      minY: 0,
      maxY: layout.totalH * scale,
    },
    courtyard: {
      id: worshipCourt.id,
      role: worshipCourt.role,
      footprint: courtFootprint.map((point) => ({ x: point.x, z: point.z })),
      y: Number.isFinite(worshipCourt.level) ? worshipCourt.level : 0,
    },
    // Aim between the main façade and the open worship court. The representative
    // hall remains the vertical anchor while the court stays readable below it.
    target: {
      x: hallCenter.x * 0.62 + courtCenter.x * 0.38,
      y: 3,
      z: hallCenter.z * 0.62 + courtCenter.z * 0.38,
    },
  };
}
