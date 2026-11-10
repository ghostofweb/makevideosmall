// Image Studio state: the list of images and what to do with them.

import { create } from 'zustand';
import { toast } from 'sonner';
import { api, errorText } from '@/lib/ipc';
import type { Crop, ImageAction, ImageEvent, ImageFormat, ImageInfo, ImageJob } from '@/lib/types';

export type ImageMode = 'compress' | 'target' | 'upscale' | 'background' | 'crop';
export type ImageStatus = 'ready' | 'working' | 'done' | 'failed';

export interface ImageItem {
  id: string;
  info: ImageInfo;
  status: ImageStatus;
  progress: number;
  message: string;
  output: string | null;
  newBytes: number | null;
  /** What the last result was made with, so the preview can show it properly. */
  doneMode: ImageMode | null;
  /** The part to keep, in the picture's own pixels (crop tool). */
  crop: Crop | null;
}

interface ImagesState {
  items: ImageItem[];
  selectedId: string | null;
  busy: boolean;
  loading: number;
  mode: ImageMode;
  format: ImageFormat;
  quality: number;
  targetKb: number;
  /** Width ÷ height the crop box is held to; null for any shape. */
  cropAspect: number | null;
  /** null = next to each original. */
  outputDir: string | null;

  set: (patch: Partial<Pick<ImagesState, 'mode' | 'format' | 'quality' | 'targetKb' | 'outputDir' | 'selectedId' | 'cropAspect'>>) => void;
  setCrop: (id: string, crop: Crop | null) => void;
  addPaths: (paths: string[]) => Promise<void>;
  remove: (id: string) => void;
  /** Forget a picture's result so the tool can be used on it again. */
  redo: (id: string) => void;
  clear: () => void;
  start: () => Promise<void>;
  cancel: () => void;
  onEvent: (e: ImageEvent) => void;
  onBatchDone: () => void;
}

let counter = 0;

/** The format a cropped copy is saved in: the original's, when the app can write it. */
export function sameFormat(fileName: string): ImageFormat {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'webp') return 'webp';
  if (ext === 'avif') return 'avif';
  return 'png';
}

export const useImages = create<ImagesState>((set, get) => ({
  items: [],
  selectedId: null,
  busy: false,
  loading: 0,
  mode: 'compress',
  format: 'webp',
  quality: 80,
  targetKb: 500,
  cropAspect: null,
  outputDir: null,

  set: (patch) => set(patch),

  setCrop: (id, crop) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, crop } : i)) })),

  addPaths: async (paths) => {
    const files = await api.expandPaths(paths, 'image');
    const known = new Set(get().items.map((i) => i.info.path.toLowerCase()));
    const incoming = files.filter((f) => !known.has(f.toLowerCase()));
    if (incoming.length === 0) {
      toast.info(files.length === 0 ? 'No pictures were found there.' : 'Those pictures are already in the list.');
      return;
    }
    set((s) => ({ loading: s.loading + incoming.length }));
    let failed = 0;
    for (const path of incoming) {
      try {
        const info = await api.imageProbe(path);
        const item: ImageItem = {
          id: `i${Date.now().toString(36)}${counter++}`,
          info,
          status: 'ready',
          progress: 0,
          message: '',
          output: null,
          newBytes: null,
          doneMode: null,
          crop: null,
        };
        set((s) => ({ items: [...s.items, item], selectedId: s.selectedId ?? item.id, loading: s.loading - 1 }));
      } catch {
        failed++;
        set((s) => ({ loading: s.loading - 1 }));
      }
    }
    if (failed > 0) toast.error(`${failed} file${failed === 1 ? '' : 's'} could not be opened as pictures.`);
  },

  remove: (id) =>
    set((s) => {
      const items = s.items.filter((i) => i.id !== id);
      return { items, selectedId: s.selectedId === id ? (items[0]?.id ?? null) : s.selectedId };
    }),

  redo: (id) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, status: 'ready', output: null, newBytes: null, doneMode: null, message: '' } : i)),
    })),

  clear: () => set({ items: [], selectedId: null }),

  start: async () => {
    const { items, selectedId, mode, format, quality, targetKb, outputDir } = get();
    // Cropping is done one picture at a time: the box is different for each.
    const pending =
      mode === 'crop' ? items.filter((i) => i.id === selectedId && i.crop && i.status !== 'working') : items.filter((i) => i.status !== 'working');
    if (pending.length === 0) return;

    const action: ImageAction =
      mode === 'target'
        ? { mode: 'target', kb: targetKb }
        : mode === 'upscale'
          ? { mode: 'upscale' }
          : mode === 'background'
            ? { mode: 'removeBackground' }
            : { mode: 'compress', quality: mode === 'crop' ? 92 : quality };
    const suffix = { compress: '_small', target: '_small', upscale: '_4x', background: '_no_background', crop: '_cropped' }[mode];

    try {
      const jobs: ImageJob[] = [];
      const taken: string[] = [];
      for (const item of pending) {
        // Enlarging and cut-outs are always PNG; a crop keeps the original's format.
        const outFormat: ImageFormat =
          mode === 'upscale' || mode === 'background'
            ? 'png'
            : mode === 'crop'
              ? sameFormat(item.info.fileName)
              : mode === 'target' && format === 'png'
                ? 'webp'
                : format;
        const output = await api.imageOutputFor({ input: item.info.path, format: outFormat, suffix, dir: outputDir, name: null, alsoTaken: taken });
        taken.push(output);
        jobs.push({ id: item.id, input: item.info.path, output, action, format: outFormat, crop: mode === 'crop' ? item.crop : null });
      }
      set((s) => ({
        busy: true,
        items: s.items.map((i) =>
          jobs.some((j) => j.id === i.id) ? { ...i, status: 'working', progress: 0, message: 'Waiting', output: null, newBytes: null, doneMode: mode } : i,
        ),
      }));
      await api.imageStart(jobs);
    } catch (e) {
      set({ busy: false });
      toast.error('Could not start', { description: errorText(e) });
    }
  },

  cancel: () => {
    api.imageCancel().catch(() => {});
  },

  onEvent: (e) =>
    set((s) => ({
      items: s.items.map((i) => {
        if (i.id !== e.id) return i;
        if (e.kind === 'progress') return { ...i, progress: e.progress, message: e.message };
        if (e.kind === 'done') return { ...i, status: 'done', progress: 100, message: e.message, output: e.output, newBytes: e.newBytes };
        return { ...i, status: 'failed', progress: 0, message: e.message };
      }),
    })),

  onBatchDone: () => {
    const { items } = get();
    set({ busy: false });
    const done = items.filter((i) => i.status === 'done').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const pictures = (n: number) => `${n} picture${n === 1 ? '' : 's'}`;
    if (failed > 0) toast.warning(`${pictures(done)} done, ${failed} failed`);
    else if (done > 0) toast.success(`${pictures(done)} done`);
  },
}));
