import { describe, expect, it } from 'vitest';
import { placeMenu } from '../src/renderer/ui/actionMenuModel';

const viewport = { width: 1024, height: 768 };

describe('placeMenu', () => {
  it('places the menu below and right-aligned to the trigger by default', () => {
    const placement = placeMenu({ left: 800, top: 100, width: 28, height: 28 }, { width: 200, height: 100 }, viewport);
    expect(placement).toEqual({ left: 628, top: 132, maxHeight: 752, flippedX: false, flippedY: false });
  });

  it('flips above when there is no room below', () => {
    const placement = placeMenu({ left: 600, top: 700, width: 28, height: 28 }, { width: 200, height: 200 }, viewport);
    expect(placement.top).toBe(496);
    expect(placement.flippedY).toBe(true);
  });

  it('stays below when it does not fit above either, clamped to the margin', () => {
    const placement = placeMenu({ left: 100, top: 20, width: 28, height: 28 }, { width: 200, height: 800 }, viewport);
    expect(placement.top).toBe(52);
    expect(placement.flippedY).toBe(false);
    expect(placement.maxHeight).toBe(752);
  });

  it('shifts left to stay inside the right viewport edge', () => {
    const placement = placeMenu({ left: 900, top: 100, width: 28, height: 28 }, { width: 200, height: 100 }, viewport, 'start');
    expect(placement.left).toBe(696);
    expect(placement.flippedX).toBe(true);
  });

  it('flips a submenu to the left of its parent when there is no room on the right', () => {
    const placement = placeMenu({ left: 940, top: 100, width: 160, height: 32 }, { width: 220, height: 120 }, viewport, 'start');
    expect(placement.left).toBe(716);
    expect(placement.flippedX).toBe(true);
    expect(placement.top).toBe(100);
  });

  it('opens a submenu to the right when there is room', () => {
    const placement = placeMenu({ left: 200, top: 100, width: 160, height: 32 }, { width: 220, height: 120 }, viewport, 'start');
    expect(placement.left).toBe(364);
    expect(placement.flippedX).toBe(false);
  });

  it('gives a tall menu the viewport max-height and a clamped position', () => {
    const placement = placeMenu({ left: 500, top: 100, width: 28, height: 28 }, { width: 240, height: 1200 }, { width: 1024, height: 500 });
    expect(placement.maxHeight).toBe(484);
    expect(placement.top).toBeGreaterThanOrEqual(8);
  });

  it('keeps a narrow viewport inside the 8 px margins', () => {
    const placement = placeMenu({ left: 500, top: 10, width: 28, height: 28 }, { width: 200, height: 100 }, { width: 200, height: 200 });
    expect(placement.left).toBe(8);
    expect(placement.flippedX).toBe(true);
  });
});
