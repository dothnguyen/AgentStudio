// Pure pixel comparison used by the operator capture script; no Electron import so it is unit-testable.
export interface RawImage {
  width: number;
  height: number;
  /** 4 bytes per pixel: B, G, R, A (Electron nativeImage.toBitmap order). */
  data: Buffer;
}

export const COMPARE_GAP = 8;
export const DIFF_TOLERANCE = 16;

function checkSize(image: RawImage): void {
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error('Image data length does not match its size');
  }
}

/** Three panels side by side: design | actual | difference (white diagram on grey, changed pixels red). */
export function composeComparison(design: RawImage, actual: RawImage): { image: RawImage; differing: number; total: number } {
  checkSize(design);
  checkSize(actual);
  if (design.width !== actual.width || design.height !== actual.height) {
    throw new Error(`Image sizes differ: design ${design.width}x${design.height}, actual ${actual.width}x${actual.height}`);
  }

  const width = design.width;
  const height = design.height;
  const outputWidth = 3 * width + 2 * COMPARE_GAP;
  const data = Buffer.alloc(outputWidth * height * 4, 255);
  const actualOffset = width + COMPARE_GAP;
  const differenceOffset = 2 * (width + COMPARE_GAP);
  let differing = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const row = y * outputWidth;
      design.data.copy(data, (row + x) * 4, source, source + 4);
      actual.data.copy(data, (row + actualOffset + x) * 4, source, source + 4);

      const blue = Math.abs(design.data[source]! - actual.data[source]!);
      const green = Math.abs(design.data[source + 1]! - actual.data[source + 1]!);
      const red = Math.abs(design.data[source + 2]! - actual.data[source + 2]!);
      const delta = Math.max(blue, green, red);
      const target = (row + differenceOffset + x) * 4;
      if (delta > DIFF_TOLERANCE) {
        data[target] = 0;
        data[target + 1] = 0;
        data[target + 2] = 255;
        differing++;
      } else {
        const grey = Math.round((0.114 * design.data[source]! + 0.587 * design.data[source + 1]! + 0.299 * design.data[source + 2]!) * 0.35);
        data[target] = grey;
        data[target + 1] = grey;
        data[target + 2] = grey;
      }
      data[target + 3] = 255;
    }
  }

  return { image: { width: outputWidth, height, data }, differing, total: width * height };
}
