import { describe, expect, it } from 'vitest';
import { composeComparison, DIFF_TOLERANCE, type RawImage } from '../src/live/imageCompare';

function image(width: number, height: number, data: number[]): RawImage {
  return { width, height, data: Buffer.from(data) };
}

// A 2x1 image: two BGRA pixels.
const DESIGN = [10, 20, 30, 255, 200, 100, 50, 255];

describe('Teams v4 image comparison', () => {
  it('identical images give no differences', () => {
    const result = composeComparison(image(2, 1, DESIGN), image(2, 1, DESIGN));

    expect(result.differing).toBe(0);
    expect(result.total).toBe(2);
    expect(result.image.width).toBe(22);
    expect(result.image.height).toBe(1);
    expect([...result.image.data.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...result.image.data.subarray(8, 12)]).toEqual([255, 255, 255, 255]);
    expect([...result.image.data.subarray(40, 44)]).toEqual([10, 20, 30, 255]);
    const grey = Math.round((0.114 * 10 + 0.587 * 20 + 0.299 * 30) * 0.35);
    expect(grey).toBe(8);
    expect([...result.image.data.subarray(80, 84)]).toEqual([8, 8, 8, 255]);
  });

  it('marks pixels beyond the tolerance red', () => {
    const actual = [...DESIGN];
    actual[6] = 90; // second pixel red channel: 50 -> 90
    const result = composeComparison(image(2, 1, DESIGN), image(2, 1, actual));

    expect(result.differing).toBe(1);
    expect([...result.image.data.subarray(84, 88)]).toEqual([0, 0, 255, 255]);
  });

  it('a difference equal to the tolerance is not counted', () => {
    const actual = [...DESIGN];
    actual[6] = 50 + DIFF_TOLERANCE;
    const result = composeComparison(image(2, 1, DESIGN), image(2, 1, actual));

    expect(result.differing).toBe(0);
  });

  it('ignores alpha differences', () => {
    const actual = [...DESIGN];
    actual[3] = 0;
    actual[7] = 0;
    const result = composeComparison(image(2, 1, DESIGN), image(2, 1, actual));

    expect(result.differing).toBe(0);
  });

  it('detects a channel that is darker than the design', () => {
    const actual = [...DESIGN];
    actual[2] = 5; // first pixel red: 30 -> 5
    const result = composeComparison(image(2, 1, DESIGN), image(2, 1, actual));

    expect(result.differing).toBe(1);
    expect([...result.image.data.subarray(80, 84)]).toEqual([0, 0, 255, 255]);
  });

  it('compares each row in images taller than one pixel', () => {
    const design = image(2, 2, [0, 0, 0, 255, 10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255]);
    const actualData = [...design.data];
    actualData[14] = 100; // second row, second pixel red: 30 -> 100
    const result = composeComparison(design, image(2, 2, actualData));

    expect(result.image.height).toBe(2);
    expect(result.differing).toBe(1);
    // Second row starts after one output row of 22 pixels; actual panel starts at x=10.
    expect([...result.image.data.subarray((22 + 10) * 4, (22 + 10) * 4 + 4)]).toEqual([20, 20, 20, 255]);
    expect([...result.image.data.subarray((22 + 20 + 1) * 4, (22 + 20 + 1) * 4 + 4)]).toEqual([0, 0, 255, 255]);
  });

  it('rejects images of different sizes', () => {
    expect(() => composeComparison(image(2, 1, DESIGN), image(1, 1, DESIGN.slice(0, 4))))
      .toThrow('Image sizes differ: design 2x1, actual 1x1');
  });

  it('rejects data that does not match the size', () => {
    expect(() => composeComparison(image(2, 1, DESIGN.slice(0, 4)), image(2, 1, DESIGN)))
      .toThrow('Image data length does not match its size');
  });
});
