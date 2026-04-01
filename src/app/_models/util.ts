import * as THREE from "three";

const createCanvas = (width: number, height: number) => {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  throw new Error("Canvas is not available in this environment");
};

const copyTextureSettings = (
  source: THREE.Texture | null | undefined,
  target: THREE.Texture,
) => {
  if (!source) {
    return target;
  }

  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.repeat.copy(source.repeat);
  target.offset.copy(source.offset);
  target.center.copy(source.center);
  target.rotation = source.rotation;
  target.flipY = source.flipY;
  target.colorSpace = source.colorSpace;
  target.minFilter = source.minFilter;
  target.magFilter = source.magFilter;
  target.anisotropy = source.anisotropy;
  target.generateMipmaps = source.generateMipmaps;

  return target;
};

export const invertNormalMap = (material: THREE.MeshStandardMaterial) => {
  const image = material.normalMap?.image;
  if (!image) {
    throw new Error("Material does not have a normal map");
  }

  const width = image.width;
  const height = image.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get 2d context");
  }

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const bytesPerPixel = pixels.length / (width * height);
  if (bytesPerPixel !== 4) {
    throw new Error("Unexpected number of bytes per pixel");
  }

  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + 1] = 255 - pixels[i + 1];
  }

  ctx.putImageData(imageData, 0, 0);

  const normalMap = copyTextureSettings(
    material.normalMap,
    new THREE.CanvasTexture(canvas),
  );
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.needsUpdate = true;

  return normalMap;
};

export const applyColor = (
  material: THREE.MeshStandardMaterial,
  color: THREE.Color,
) => {
  const image = material.map?.image;
  if (!image) {
    throw new Error("Material does not have a map");
  }

  const width = image.width;
  const height = image.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get 2d context");
  }

  ctx.fillStyle = color.getStyle();
  ctx.fillRect(0, 0, width, height);

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  // Debugging
  // canvas.convertToBlob().then((blob) => {
  //   const url = URL.createObjectURL(blob);
  //   const img = new Image();
  //   img.src = url;
  //   document.body.appendChild(img);
  // });

  // material.map = new THREE.CanvasTexture(canvas);
  // material.emissiveMap = null;
  // material.emissiveIntensity = 0;
  // material.roughnessMap = null;
  // material.metalnessMap = null;
  // material.normalMap = null;
  // material.color = color;

  const map = copyTextureSettings(material.map, new THREE.CanvasTexture(canvas));
  map.needsUpdate = true;

  const coloredMaterial = material.clone();
  coloredMaterial.map = map;
  coloredMaterial.name = `${material.name} (colored)`;
  coloredMaterial.userData = {
    ...material.userData,
    hasColorBeenApplied: true,
  };

  return coloredMaterial;
};
