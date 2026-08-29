import * as THREE from 'three';
import { parcelRotY } from './parcel-spatial.js';
import { parcelHouseTranslation } from '../../village/parcel-contract.js';

export { parcelRotY };

const M4 = () => new THREE.Matrix4();

export function houseMatrix(parcel) {
  const local = parcelHouseTranslation(parcel);
  const t1 = M4().makeTranslation(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  const r = M4().makeRotationY(parcelRotY(parcel));
  const t2 = M4().makeTranslation(local.x, 0, local.z);
  const s = M4().makeScale(parcel.sx || 1, parcel.sy || 1, parcel.sz || 1);
  return t1.multiply(r).multiply(t2).multiply(s);
}

export function parcelMatrix(parcel) {
  const t1 = M4().makeTranslation(parcel.center.x, parcel.baseY || 0, parcel.center.z);
  const r = M4().makeRotationY(parcelRotY(parcel));
  return t1.multiply(r);
}
