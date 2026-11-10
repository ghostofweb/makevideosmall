import { describe, expect, it } from 'vitest';
import { CROP_SHAPES, MIN_CROP, defaultCrop, dragCrop } from './crop';

const W = 1000;
const H = 600;
const inside = (c: { w: number; h: number; x: number; y: number }) =>
  c.x >= 0 && c.y >= 0 && c.w >= 1 && c.h >= 1 && c.x + c.w <= W && c.y + c.h <= H;

describe('defaultCrop', () => {
  it('is centred and covers most of the picture', () => {
    expect(defaultCrop(W, H, null)).toEqual({ w: 800, h: 480, x: 100, y: 60 });
  });
  it('fits every offered shape inside the picture', () => {
    for (const shape of CROP_SHAPES) {
      const c = defaultCrop(W, H, shape.aspect);
      expect(inside(c)).toBe(true);
      if (shape.aspect) expect(c.w / c.h).toBeCloseTo(shape.aspect, 1);
    }
  });
});

describe('dragCrop', () => {
  const start = { w: 400, h: 300, x: 300, y: 150 };

  it('moves without changing size and stops at the edges', () => {
    expect(dragCrop(start, 'move', 50, -20, W, H, null)).toEqual({ w: 400, h: 300, x: 350, y: 130 });
    expect(dragCrop(start, 'move', 9999, 9999, W, H, null)).toEqual({ w: 400, h: 300, x: 600, y: 300 });
    expect(dragCrop(start, 'move', -9999, -9999, W, H, null)).toEqual({ w: 400, h: 300, x: 0, y: 0 });
  });

  it('resizes from a corner while the opposite corner stays put', () => {
    const se = dragCrop(start, 'se', 100, 50, W, H, null);
    expect(se).toEqual({ w: 500, h: 350, x: 300, y: 150 });
    const nw = dragCrop(start, 'nw', -100, -50, W, H, null);
    expect(nw).toEqual({ w: 500, h: 350, x: 200, y: 100 });
    // Bottom-right corner did not move.
    expect(nw.x + nw.w).toBe(start.x + start.w);
    expect(nw.y + nw.h).toBe(start.y + start.h);
  });

  it('never leaves the picture or collapses', () => {
    for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const [dx, dy] of [[9999, 9999], [-9999, -9999], [9999, -9999], [-9999, 9999]]) {
        const c = dragCrop(start, handle, dx, dy, W, H, null);
        expect(inside(c)).toBe(true);
        expect(c.w).toBeGreaterThanOrEqual(MIN_CROP);
        expect(c.h).toBeGreaterThanOrEqual(MIN_CROP);
      }
    }
  });

  it('holds the shape when one is chosen, even at the edges', () => {
    const square = { w: 300, h: 300, x: 300, y: 150 };
    const grown = dragCrop(square, 'se', 120, 5, W, H, 1);
    expect(grown.w).toBe(grown.h);
    expect(grown.w).toBe(420);
    // Dragged far past the edge: limited by the room below (600 - 150 = 450).
    const maxed = dragCrop(square, 'se', 9999, 9999, W, H, 1);
    expect(maxed).toEqual({ w: 450, h: 450, x: 300, y: 150 });
    const wide = dragCrop({ w: 320, h: 180, x: 100, y: 100 }, 'nw', -9999, -9999, W, H, 16 / 9);
    expect(inside(wide)).toBe(true);
    expect(wide.w / wide.h).toBeCloseTo(16 / 9, 1);
  });
});
