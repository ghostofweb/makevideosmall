// A crop box you drag over a picture. Positions are kept in the picture's own
// pixels, so the result does not depend on how large the window is.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dragCrop, type CropHandle } from '@/lib/crop';
import type { Crop } from '@/lib/types';

export function Cropper({
  src,
  width,
  height,
  value,
  onChange,
  aspect,
}: {
  src: string;
  /** The picture's real size in pixels. */
  width: number;
  height: number;
  value: Crop;
  onChange: (crop: Crop) => void;
  aspect: number | null;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ left: 0, top: 0, scale: 1 });
  const drag = useRef<{ handle: CropHandle; x: number; y: number; start: Crop } | null>(null);

  // Work out where the picture sits inside the available space.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => {
      const pad = 24;
      const scale = Math.max(0.01, Math.min((el.clientWidth - pad * 2) / width, (el.clientHeight - pad * 2) / height));
      setBox({ scale, left: (el.clientWidth - width * scale) / 2, top: (el.clientHeight - height * scale) / 2 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      onChange(dragCrop(d.start, d.handle, (e.clientX - d.x) / box.scale, (e.clientY - d.y) / box.scale, width, height, aspect));
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [box.scale, width, height, aspect, onChange]);

  const begin = (handle: CropHandle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { handle, x: e.clientX, y: e.clientY, start: value };
  };

  const corner = 'absolute size-4 rounded-full border-2 border-background bg-primary';
  return (
    <div ref={frame} className="absolute inset-0 overflow-hidden">
      <div className="absolute" style={{ left: box.left, top: box.top, width: width * box.scale, height: height * box.scale }}>
        <img src={src} alt="" draggable={false} className="size-full" />
        <div
          role="group"
          aria-label={`Part to keep: ${value.w} by ${value.h} pixels`}
          data-testid="crop-box"
          className="absolute cursor-move outline-2 outline-primary"
          // The huge shadow darkens everything outside the box.
          style={{
            left: value.x * box.scale,
            top: value.y * box.scale,
            width: value.w * box.scale,
            height: value.h * box.scale,
            boxShadow: '0 0 0 9999px rgba(8, 10, 16, 0.62)',
          }}
          onPointerDown={begin('move')}
        >
          {/* Thirds, to help with framing. */}
          <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-40">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="border-[0.5px] border-white/50" />
            ))}
          </div>
          <span data-testid="crop-nw" className={`${corner} -top-2 -left-2 cursor-nwse-resize`} onPointerDown={begin('nw')} />
          <span className={`${corner} -top-2 -right-2 cursor-nesw-resize`} onPointerDown={begin('ne')} />
          <span className={`${corner} -bottom-2 -left-2 cursor-nesw-resize`} onPointerDown={begin('sw')} />
          <span data-testid="crop-se" className={`${corner} -right-2 -bottom-2 cursor-nwse-resize`} onPointerDown={begin('se')} />
        </div>
      </div>
    </div>
  );
}
