import { useEffect, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { AlertCircle, Crop as CropIcon, Eraser, FolderOpen, ImagePlus, Images, Loader2, Maximize2, Minimize2, Ruler, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Empty, Segmented, ShrinkMeter, Tip } from '@/components/common';
import { NumberBox } from '@/features/editor/tabs';
import { CROP_SHAPES, defaultCrop } from '@/lib/crop';
import { bytes } from '@/lib/format';
import { api, fileUrl } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';
import { useImages, type ImageItem, type ImageMode } from '@/stores/images';
import { Cropper } from './Cropper';
import type { ImageFormat } from '@/lib/types';

const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'gif'];

/** A grey checkerboard, the usual way to show "nothing here". */
const CHECKER = {
  backgroundColor: '#2a2e3a',
  backgroundImage:
    'linear-gradient(45deg, #3a3f4e 25%, transparent 25%), linear-gradient(-45deg, #3a3f4e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #3a3f4e 75%), linear-gradient(-45deg, transparent 75%, #3a3f4e 75%)',
  backgroundSize: '20px 20px',
  backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
};

async function pickImages() {
  const picked = await open({ multiple: true, title: 'Add pictures', filters: [{ name: 'Pictures', extensions: IMAGE_TYPES }] });
  if (picked) await useImages.getState().addPaths(Array.isArray(picked) ? picked : [picked]);
}

export function ImageStudio() {
  const items = useImages((s) => s.items);
  const selected = useImages((s) => s.items.find((i) => i.id === s.selectedId));
  const loading = useImages((s) => s.loading);
  const problem = useApp((s) => s.problem);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_340px]">
      <section aria-label="Images" className="flex min-h-0 flex-col border-r bg-panel">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <h2 className="font-medium">Pictures</h2>
          {items.length > 0 && <span className="readout text-muted-foreground">{items.length}</span>}
          {loading > 0 && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Reading pictures" />}
          <div className="ml-auto flex">
            {items.length > 0 && (
              <Button variant="ghost" size="xs" onClick={() => useImages.getState().clear()}>
                Clear list
              </Button>
            )}
            <Tip text="Add pictures">
              <Button variant="ghost" size="icon-sm" aria-label="Add pictures" disabled={!!problem} onClick={pickImages}>
                <ImagePlus />
              </Button>
            </Tip>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <Empty icon={<Images />} title={loading > 0 ? 'Reading your pictures…' : 'Drop pictures here'}>
              {loading === 0 && (
                <>
                  <p>Drag pictures or folders anywhere onto the window, or pick them yourself.</p>
                  <Button className="mt-4" disabled={!!problem} onClick={pickImages}>
                    <ImagePlus /> Add pictures
                  </Button>
                </>
              )}
            </Empty>
          ) : (
            <ul>
              {items.map((item) => (
                <ImageRow key={item.id} item={item} selected={item.id === selected?.id} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Preview" className="relative min-h-0 min-w-0 bg-stage">
        {selected ? <ImagePreview key={selected.id} item={selected} /> : <Empty icon={<Images />} title="Add a picture to get started" />}
      </section>

      <ImageSettings />
    </div>
  );
}

function ImageRow({ item, selected }: { item: ImageItem; selected: boolean }) {
  const { set, remove } = useImages.getState();
  return (
    <li
      className={cn('group relative flex cursor-pointer gap-2.5 border-b px-3 py-2.5 hover:bg-accent/50', selected && 'bg-accent/80 hover:bg-accent/80')}
      onClick={() => set({ selectedId: item.id })}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" aria-hidden="true" />}
      <img src={fileUrl(item.info.path)} alt="" loading="lazy" draggable={false} className="size-11 shrink-0 rounded-[3px] bg-stage object-cover" />
      <div className="min-w-0 flex-1">
        <button type="button" className="block w-full truncate text-left font-medium outline-none focus-visible:underline" title={item.info.path}>
          {item.info.fileName}
        </button>
        <p className="readout truncate text-xs text-muted-foreground">
          {item.info.width}×{item.info.height} <span className="text-faint">/</span> {bytes(item.info.sizeBytes)}
        </p>
        {item.status === 'working' && (
          <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-primary">
            <Loader2 className="size-3 shrink-0 animate-spin" /> {item.message || 'Working'}
          </p>
        )}
        {item.status === 'failed' && (
          <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs text-destructive" title={item.message}>
            <AlertCircle className="mt-0.5 size-3 shrink-0" /> <span className="line-clamp-3">{item.message || 'Failed'}</span>
          </p>
        )}
        {item.status === 'done' &&
          item.newBytes !== null &&
          (item.doneMode === 'compress' || item.doneMode === 'target' ? (
            <ShrinkMeter compact className="mt-1.5" sourceBytes={item.info.sizeBytes} outputBytes={item.newBytes} state="final" />
          ) : (
            <p className="mt-1 text-xs text-saved">Done, saved as {bytes(item.newBytes)}</p>
          ))}
      </div>
      {item.status !== 'working' && (
        <button
          type="button"
          aria-label={`Remove ${item.info.fileName} from the list`}
          className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-raised hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            remove(item.id);
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function ImagePreview({ item }: { item: ImageItem }) {
  const mode = useImages((s) => s.mode);
  const aspect = useImages((s) => s.cropAspect);
  const setCrop = useImages.getState().setCrop;
  const done = item.status === 'done' && !!item.output;
  const cropping = mode === 'crop' && item.status !== 'working' && !(done && item.doneMode === 'crop');

  // Entering the crop tool, or changing the shape, starts from a sensible box.
  useEffect(() => {
    if (mode === 'crop') setCrop(item.id, defaultCrop(item.info.width, item.info.height, aspect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, aspect, item.id]);

  if (cropping && item.crop) {
    return (
      <>
        <Cropper
          src={fileUrl(item.info.path)}
          width={item.info.width}
          height={item.info.height}
          value={item.crop}
          aspect={aspect}
          onChange={(crop) => setCrop(item.id, crop)}
        />
        <p className="readout pointer-events-none absolute inset-x-2 bottom-2 text-center text-xs">
          <span className="rounded-sm bg-black/70 px-2 py-0.5 text-white">
            Keeping {item.crop.w}×{item.crop.h} of {item.info.width}×{item.info.height}. Drag the box to move it, drag a corner to resize it.
          </span>
        </p>
      </>
    );
  }

  const result = done ? fileUrl(item.output!, item.newBytes ?? 0) : null;
  // Same-shape results can be compared with a slider; a crop or an enlargement cannot.
  const comparable = done && (item.doneMode === 'compress' || item.doneMode === 'target' || item.doneMode === 'background');
  return (
    <>
      {comparable && result ? (
        <ReactCompareSlider
          className="absolute inset-0 size-full"
          style={item.doneMode === 'background' ? CHECKER : undefined}
          itemOne={<ReactCompareSliderImage src={fileUrl(item.info.path)} alt="Original" style={{ objectFit: 'contain' }} />}
          itemTwo={<ReactCompareSliderImage src={result} alt="Result" style={{ objectFit: 'contain' }} />}
        />
      ) : (
        <img src={result ?? fileUrl(item.info.path)} alt={item.info.fileName} draggable={false} className="absolute inset-0 size-full object-contain" />
      )}
      <div className="readout pointer-events-none absolute inset-x-2 bottom-2 flex justify-between text-xs">
        <span className="rounded-sm bg-black/70 px-2 py-0.5 text-white">
          {comparable || !done ? `Original, ${bytes(item.info.sizeBytes)}` : `Result, ${bytes(item.newBytes)}`}
        </span>
        {comparable && item.newBytes !== null && <span className="rounded-sm bg-black/70 px-2 py-0.5 text-white">Result, {bytes(item.newBytes)}</span>}
      </div>
      {done && (
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => api.revealPath(item.output!).catch(() => {})}>
            <FolderOpen /> Show in folder
          </Button>
          {item.doneMode === 'crop' && (
            <Button size="sm" variant="secondary" onClick={() => useImages.getState().redo(item.id)}>
              Crop it differently
            </Button>
          )}
          {item.message && <p className="max-w-xs rounded-md bg-black/75 px-2.5 py-1.5 text-xs text-white">{item.message}</p>}
        </div>
      )}
    </>
  );
}

const FORMATS: { value: ImageFormat; label: string; note: string }[] = [
  { value: 'webp', label: 'WebP', note: 'Small, and works in every current browser and most apps. A good default.' },
  { value: 'jpg', label: 'JPEG', note: 'Opens everywhere, even on old devices. Bigger than WebP.' },
  { value: 'avif', label: 'AVIF', note: 'The smallest of all. Some older apps cannot open it.' },
  { value: 'png', label: 'PNG', note: 'No quality loss at all, but often not much smaller.' },
];

interface Tool {
  mode: ImageMode;
  title: string;
  detail: string;
  icon: ReactNode;
}

const TOOLS: Tool[] = [
  { mode: 'compress', title: 'Make smaller', detail: 'Smaller file', icon: <Minimize2 /> },
  { mode: 'target', title: 'Fit a size limit', detail: 'For upload limits', icon: <Ruler /> },
  { mode: 'crop', title: 'Crop', detail: 'Keep only a part', icon: <CropIcon /> },
  { mode: 'background', title: 'Remove background', detail: 'Keep the subject', icon: <Eraser /> },
  { mode: 'upscale', title: 'Make bigger', detail: 'Four times, with AI', icon: <Maximize2 /> },
];

function ImageSettings() {
  const { items, selectedId, busy, mode, format, quality, targetKb, cropAspect, outputDir } = useImages();
  const { set, start, cancel } = useImages.getState();
  const caps = useApp((s) => s.caps);
  const problem = useApp((s) => s.problem);
  const available = (m: ImageMode) =>
    m === 'upscale' ? (caps?.upscalerAvailable ?? false) : m === 'background' ? (caps?.backgroundRemovalAvailable ?? false) : true;

  const shrunk = items.filter((i) => i.status === 'done' && i.newBytes !== null && (i.doneMode === 'compress' || i.doneMode === 'target'));
  const before = shrunk.reduce((sum, i) => sum + i.info.sizeBytes, 0);
  const after = shrunk.reduce((sum, i) => sum + (i.newBytes ?? 0), 0);
  const idle = items.filter((i) => i.status !== 'working').length;
  const pictures = `${idle} picture${idle === 1 ? '' : 's'}`;
  const selected = items.find((i) => i.id === selectedId);

  const pickFolder = async () => {
    const dir = await open({ directory: true, title: 'Choose a folder for the results' });
    if (typeof dir === 'string') set({ outputDir: dir });
  };

  const go =
    mode === 'compress' || mode === 'target'
      ? `Make ${pictures} smaller`
      : mode === 'upscale'
        ? `Make ${pictures} bigger`
        : mode === 'background'
          ? `Remove the background from ${pictures}`
          : 'Crop this picture';
  const canGo = mode === 'crop' ? !!selected?.crop && selected.status !== 'working' : idle > 0;

  return (
    <section aria-label="Image settings" className="flex min-h-0 flex-col border-l bg-panel">
      <div className="flex h-11 shrink-0 items-center border-b px-3">
        <h2 className="font-medium">What do you want to do?</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div role="radiogroup" aria-label="What to do with the pictures" className="grid grid-cols-2 gap-2">
          {TOOLS.map((tool) => {
            const ok = available(tool.mode);
            return (
              <button
                key={tool.mode}
                type="button"
                role="radio"
                aria-checked={mode === tool.mode}
                disabled={!ok}
                title={ok ? undefined : 'Not installed with this copy of the app'}
                onClick={() => set({ mode: tool.mode })}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border-2 px-3 py-2.5 text-left outline-none transition-colors',
                  'hover:border-faint focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
                  mode === tool.mode ? 'border-primary bg-primary/[0.07] hover:border-primary' : 'border-border',
                  // Five tools: the last one spans the row.
                  tool.mode === 'upscale' && 'col-span-2',
                )}
              >
                <span className={cn('[&_svg]:size-5', mode === tool.mode ? 'text-primary' : 'text-muted-foreground')}>{tool.icon}</span>
                <span className="min-w-0">
                  <span className="block font-medium">{tool.title}</span>
                  <span className="block text-xs leading-snug text-muted-foreground">{tool.detail}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 space-y-4">
          {(mode === 'compress' || mode === 'target') && (
            <div>
              <p className="mb-1.5 font-medium">Save as</p>
              <Segmented<ImageFormat>
                label="Picture format"
                className="w-full [&>button]:flex-1"
                value={mode === 'target' && format === 'png' ? 'webp' : format}
                onChange={(f) => set({ format: f })}
                options={FORMATS.filter((f) => mode === 'compress' || f.value !== 'png').map(({ value, label }) => ({ value, label }))}
              />
              <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{FORMATS.find((f) => f.value === format)?.note}</p>
            </div>
          )}

          {mode === 'compress' && format !== 'png' && (
            <div>
              <p className="mb-2 flex justify-between font-medium">
                Quality <span className="readout font-normal text-muted-foreground">{quality} out of 100</span>
              </p>
              <Slider aria-label="Quality" min={1} max={100} step={1} value={[quality]} onValueChange={([q]) => set({ quality: q })} />
              <p className="mt-1.5 flex justify-between text-xs text-muted-foreground">
                <span>Smaller file</span>
                <span>Looks better</span>
              </p>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">Around 80, most photos look the same as the original.</p>
            </div>
          )}

          {mode === 'target' && (
            <div>
              <p className="mb-1.5 font-medium">No bigger than</p>
              <div className="flex flex-wrap items-center gap-2">
                <NumberBox label="Size limit in kilobytes" value={targetKb} min={5} max={102400} suffix="KB" onCommit={(kb) => set({ targetKb: kb })} />
                {[100, 250, 500, 1024, 2048].map((kb) => (
                  <Button key={kb} variant={targetKb === kb ? 'secondary' : 'outline'} size="xs" onClick={() => set({ targetKb: kb })}>
                    {kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`}
                  </Button>
                ))}
              </div>
              <p className="mt-1.5 text-xs leading-snug text-muted-foreground">Each picture gets the best quality that still fits under the limit.</p>
            </div>
          )}

          {mode === 'crop' && (
            <div>
              <p className="mb-1.5 font-medium">Shape</p>
              <div className="flex flex-wrap gap-1.5">
                {CROP_SHAPES.map((shape) => (
                  <Button key={shape.id} variant={cropAspect === shape.aspect ? 'secondary' : 'outline'} size="sm" onClick={() => set({ cropAspect: shape.aspect })}>
                    {shape.label}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-snug text-muted-foreground">
                Drag the box on the picture to choose the part to keep. Crop works on the picture you have selected.
              </p>
            </div>
          )}

          {mode === 'background' && (
            <p className="leading-snug text-muted-foreground">
              Finds the main person or object and makes everything else see-through. Works best when the subject stands out clearly. Saved as a PNG,
              which keeps the see-through parts.
            </p>
          )}

          {mode === 'upscale' && (
            <p className="leading-snug text-muted-foreground">
              Makes each picture four times wider and taller, and uses AI to fill in sharp detail. Needs a graphics card. Pictures that are already
              4K or bigger are skipped. Saved as a PNG.
            </p>
          )}

          <div>
            <p className="mb-1.5 font-medium">Where to save</p>
            <div className="flex items-center gap-2">
              <p className="selectable min-w-0 flex-1 truncate rounded-md border bg-muted px-2.5 py-1.5" title={outputDir ?? undefined}>
                {outputDir ?? 'Next to each original'}
              </p>
              <Button variant="outline" size="sm" onClick={pickFolder}>
                Choose…
              </Button>
              {outputDir && (
                <Button variant="ghost" size="sm" onClick={() => set({ outputDir: null })}>
                  Reset
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
              Your originals are never changed: results get a new name. Camera details and location stored in a photo are left out of the result.
            </p>
          </div>
        </div>
      </div>

      {shrunk.length > 0 && (
        <div className="shrink-0 border-t px-3 py-2.5">
          <ShrinkMeter sourceBytes={before} outputBytes={after} state="final" />
        </div>
      )}
      <div className="shrink-0 border-t p-3">
        {busy ? (
          <Button className="w-full" size="lg" variant="secondary" onClick={cancel}>
            Stop
          </Button>
        ) : (
          <Button className="h-auto min-h-10 w-full py-2 whitespace-normal" size="lg" disabled={!canGo || !!problem} onClick={start}>
            {go}
          </Button>
        )}
      </div>
    </section>
  );
}
