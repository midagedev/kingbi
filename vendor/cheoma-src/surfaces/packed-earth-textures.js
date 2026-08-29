import * as THREE from 'three';

function validateSource(source) {
  const length = source?.width * source?.height * 4;
  if (!Number.isInteger(source?.width) || !Number.isInteger(source?.height)
    || !(source.albedo instanceof Uint8Array) || source.albedo.length !== length
    || !(source.heightMap instanceof Uint8Array) || source.heightMap.length !== length) {
    throw new TypeError('packed-earth source must contain same-size RGBA8 albedo and heightMap');
  }
}

function makeTexture(data, width, height, { colorSpace, name, anisotropy }) {
  const texture = new THREE.DataTexture(
    new Uint8Array(data), width, height, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  texture.name = name;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Creates per-consumer GPU resources; callers dispose them with their owning object tree. */
export function createPackedEarthTextures(source, { anisotropy = 4 } = {}) {
  validateSource(source);
  const numericAnisotropy = Number(anisotropy);
  const boundedAnisotropy = Number.isFinite(numericAnisotropy)
    ? Math.max(1, Math.min(8, Math.round(numericAnisotropy))) : 4;
  return {
    albedo: makeTexture(source.albedo, source.width, source.height, {
      colorSpace: THREE.SRGBColorSpace,
      name: 'packed-earth-albedo',
      anisotropy: boundedAnisotropy,
    }),
    height: makeTexture(source.heightMap, source.width, source.height, {
      colorSpace: THREE.NoColorSpace,
      name: 'packed-earth-height',
      anisotropy: boundedAnisotropy,
    }),
  };
}
