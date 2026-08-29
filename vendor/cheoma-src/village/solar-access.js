import * as G from '../core/math/geom2.js';
import { impostorHouseSpec } from './impostor-spec.js';
import {
  circleIntersectsPolygon,
  parcelSolarAccessPolygon,
  parcelWorldPoint,
} from './parcel-contract.js';
import { parcelRoofPolygons } from './house-footprint.js';
import {
  auxiliarySolarObstruction,
  auxiliaryWorldFootprint,
} from './auxiliary-building-plan.js';

// A conservative low winter-sun design angle. This is a layout invariant rather
// than a real-time sun simulation: roofs that cannot shadow a 1.5m south window
// at this angle need not consume the whole vegetation/camera corridor.
export const BUILDING_SOLAR_ALTITUDE = 30 * Math.PI / 180;
export const BUILDING_SOLAR_TARGET_LIFT = 1.5;

export function parcelGroundY(parcel, site) {
  if (Number.isFinite(parcel.baseY)) return parcel.baseY;
  if (Number.isFinite(parcel.padY)) return parcel.padY;
  return site.heightAt(parcel.center.x, parcel.center.z);
}

export function circleBlocksSolarAccess(target, obstruction, site) {
  if (!target?.solarAccess || !site
    || !Number.isFinite(obstruction?.x) || !Number.isFinite(obstruction?.z)
    || !Number.isFinite(obstruction?.height)) return false;
  const targetY = parcelGroundY(target, site) + BUILDING_SOLAR_TARGET_LIFT;
  const baseY = Number.isFinite(obstruction.baseY)
    ? obstruction.baseY
    : site.heightAt(obstruction.x, obstruction.z);
  const shadowLength = Math.max(
    0,
    (baseY + obstruction.height - targetY) / Math.tan(BUILDING_SOLAR_ALTITUDE),
  );
  if (shadowLength <= 1e-8) return false;
  const corridor = target.solarAccess;
  const localEnd = Math.min(corridor.localEnd, corridor.localStart + shadowLength);
  const shadow = [
    parcelWorldPoint(target, { x: -corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(target, { x: corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(target, { x: corridor.halfWidth, z: localEnd }),
    parcelWorldPoint(target, { x: -corridor.halfWidth, z: localEnd }),
  ];
  return circleIntersectsPolygon(obstruction, Math.max(0, obstruction.radius || 0), shadow);
}

export function parcelObstructionPolygons(parcel) {
  if (parcel.kind === 'choga' || parcel.kind === 'giwa') {
    return [
      ...parcelRoofPolygons(parcel),
      ...(
        parcel.auxiliary
          ? [auxiliaryWorldFootprint(parcel, parcel.auxiliary)]
          : []
      ),
    ].filter((polygon) => polygon.length >= 3);
  }
  return parcel.poly?.length ? [parcel.poly] : [];
}

export function parcelObstructionRecords(parcel, site) {
  const main = parcel.kind === 'choga' || parcel.kind === 'giwa'
    ? parcelRoofPolygons(parcel).map((polygon) => ({
        polygon,
        roofTopY: parcelRoofTopY(parcel, site),
        role: 'main-house',
      }))
    : (parcel.poly?.length ? [{
        polygon: parcel.poly,
        roofTopY: parcelRoofTopY(parcel, site),
        role: 'compound',
      }] : []);
  const auxiliary = auxiliarySolarObstruction(parcel, parcel.auxiliary, site);
  if (auxiliary) main.push({ ...auxiliary, role: 'auxiliary-building' });
  return main;
}

export function parcelRoofTopY(parcel, site) {
  const baseY = parcelGroundY(parcel, site);
  if (parcel?.mjaHouse?.kind === 'mja-banga') {
    const localTop = Math.max(
      parcel.mjaHouse.gate?.roofTopY || 0,
      ...parcel.mjaHouse.wings.map((wing) => wing.roofTopY || 0),
    );
    return baseY + localTop;
  }
  if (parcel.kind !== 'choga' && parcel.kind !== 'giwa') return baseY + 14;
  const spec = impostorHouseSpec(parcel);
  const sy = Number.isFinite(parcel.sy) ? parcel.sy : 1;
  return baseY + Math.max(...spec.roofs.map((roof) => roof.ridgeY * sy));
}

function parcelSolarAccessForRoofTop(target, roofTopY, site) {
  const corridor = target.solarAccess;
  if (!corridor) return parcelSolarAccessPolygon(target);
  const targetY = parcelGroundY(target, site) + BUILDING_SOLAR_TARGET_LIFT;
  const shadowLength = Math.max(
    0,
    (roofTopY - targetY) / Math.tan(BUILDING_SOLAR_ALTITUDE),
  );
  const localEnd = Math.min(corridor.localEnd, corridor.localStart + shadowLength);
  return [
    parcelWorldPoint(target, { x: -corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(target, { x: corridor.halfWidth, z: corridor.localStart }),
    parcelWorldPoint(target, { x: corridor.halfWidth, z: localEnd }),
    parcelWorldPoint(target, { x: -corridor.halfWidth, z: localEnd }),
  ];
}

export function parcelBuildingSolarAccessPolygon(target, blocker, site) {
  return parcelSolarAccessForRoofTop(target, parcelRoofTopY(blocker, site), site);
}

export function buildingBlocksSolarAccess(target, blocker, site) {
  return parcelObstructionRecords(blocker, site).some((obstruction) => (
    G.polysOverlap(
      parcelSolarAccessForRoofTop(target, obstruction.roofTopY, site),
      obstruction.polygon,
    )
  ));
}
