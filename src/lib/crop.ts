// Crop-box maths, in the picture's own pixels. Unit-tested in crop.test.ts.

import type { Crop } from './types';

export type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

/** Smallest crop box, in pixels. */
export const MIN_CROP = 16;

/** The shapes offered in the crop tool. */
export const CROP_SHAPES: { id: string; label: string; aspect: number | null }[] = [
  { id: 'free', label: 'Any shape', aspect: null },
  { id: 'square', label: 'Square', aspect: 1 },
  { id: 'wide', label: 'Wide 16:9', aspect: 16 / 9 },
  { id: 'photo', label: 'Photo 4:3', aspect: 4 / 3 },
  { id: 'tall', label: 'Phone 9:16', aspect: 9 / 16 },
];

/** The largest centred box of the given shape, covering 80% of the picture. */
export function defaultCrop(width: number, height: number, aspect: number | null): Crop {
  let w = width * 0.8;
  let h = height * 0.8;
  if (aspect) {
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
  }
  w = Math.round(w);
  h = Math.round(h);
  return { w, h, x: Math.round((width - w) / 2), y: Math.round((height - h) / 2) };
}

/** Apply a drag to a crop box, keeping it inside the picture and on shape. */
export function dragCrop(start: Crop, handle: CropHandle, dx: number, dy: number, width: number, height: number, aspect: number | null): Crop {
  if (handle === 'move') {
    return {
      ...start,
      x: Math.round(Math.min(Math.max(0, start.x + dx), width - start.w)),
      y: Math.round(Math.min(Math.max(0, start.y + dy), height - start.h)),
    };
  }
  // The corner opposite the one being dragged stays where it is.
  const left = handle === 'nw' || handle === 'sw';
  const top = handle === 'nw' || handle === 'ne';
  const anchorX = left ? start.x + start.w : start.x;
  const anchorY = top ? start.y + start.h : start.y;
  const roomX = left ? anchorX : width - anchorX;
  const roomY = top ? anchorY : height - anchorY;
  let w = Math.min(Math.max(MIN_CROP, start.w + (left ? -dx : dx)), roomX);
  let h = Math.min(Math.max(MIN_CROP, start.h + (top ? -dy : dy)), roomY);
  if (aspect) {
    // Follow the width, then shrink to whatever room there is.
    h = w / aspect;
    const fit = Math.min(1, roomX / w, roomY / h);
    w *= fit;
    h *= fit;
  }
  w = Math.round(w);
  h = Math.round(h);
  return { w, h, x: Math.round(left ? anchorX - w : anchorX), y: Math.round(top ? anchorY - h : anchorY) };
}
