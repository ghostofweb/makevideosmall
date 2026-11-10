import { open } from '@tauri-apps/plugin-dialog';
import { FilePlus2, FolderPlus, Film, ListPlus, Loader2, Merge, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, Segmented, ShrinkMeter, Tip } from '@/components/common';
import { PresetPicker } from '@/features/presets/PresetPicker';
import { bytes, clock } from '@/lib/format';
import { fileUrl } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';
import { isJoined, useSources, type Source } from '@/stores/sources';

const VIDEO_TYPES = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp', 'ogv', 'vob'];

async function pickVideoFiles() {
  const picked = await open({ multiple: true, title: 'Add videos', filters: [{ name: 'Videos', extensions: VIDEO_TYPES }] });
  if (!picked) return;
  await useSources.getState().addPaths(Array.isArray(picked) ? picked : [picked]);
}

async function pickFolder() {
  const picked = await open({ directory: true, title: 'Add every video in a folder' });
  if (typeof picked === 'string') await useSources.getState().addPaths([picked]);
}

export function SourcesPane() {
  const sources = useSources((s) => s.sources);
  const selectedId = useSources((s) => s.selectedId);
  const checked = useSources((s) => s.checked);
  const loading = useSources((s) => s.loading);
  const { checkAll, applyPreset, pickChoice, queue, join } = useSources.getState();
  const problem = useApp((s) => s.problem);
  const advanced = useApp((s) => s.settings.advancedMode);
  const options = useApp((s) => s.easyOptions);

  // Batch actions apply to the ticked files, or to every file when none are ticked.
  const targets = checked.length > 0 ? checked : sources.map((s) => s.id);
  const targeted = sources.filter((s) => targets.includes(s.id));
  const allChecked = sources.length > 0 && checked.length === sources.length;
  const noun = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  // The choice every targeted file shares, if they all share one.
  const shared = targeted.length > 0 && targeted.every((s) => s.choice === targeted[0].choice) ? targeted[0].choice : null;

  return (
    <section aria-label="Files" className="flex min-h-0 flex-col border-r bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {sources.length > 0 && (
          <Tip text={allChecked ? 'Untick all' : 'Tick all'}>
            <Checkbox
              aria-label="Tick all files"
              checked={allChecked ? true : checked.length > 0 ? 'indeterminate' : false}
              onCheckedChange={(v) => checkAll(v === true)}
            />
          </Tip>
        )}
        <h2 className="font-medium">Videos</h2>
        {sources.length > 0 && <span className="readout text-muted-foreground">{sources.length}</span>}
        {loading > 0 && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Reading files" />}
        <div className="ml-auto flex">
          <Tip text="Add videos">
            <Button variant="ghost" size="icon-sm" aria-label="Add videos" disabled={!!problem} onClick={pickVideoFiles}>
              <FilePlus2 />
            </Button>
          </Tip>
          <Tip text="Add a folder of videos">
            <Button variant="ghost" size="icon-sm" aria-label="Add a folder of videos" disabled={!!problem} onClick={pickFolder}>
              <FolderPlus />
            </Button>
          </Tip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sources.length === 0 ? (
          <Empty icon={<Film />} title={loading > 0 ? 'Reading your videos…' : 'Drop videos here'}>
            {loading === 0 && (
              <>
                <p>Drag videos or folders anywhere onto the window, or pick them yourself.</p>
                <Button className="mt-4" disabled={!!problem} onClick={pickVideoFiles}>
                  <FilePlus2 /> Add videos
                </Button>
              </>
            )}
          </Empty>
        ) : (
          <ul>
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                selected={s.id === selectedId}
                checked={checked.includes(s.id)}
                // Ticking order is the joining order, so show it once it matters.
                order={checked.length >= 2 ? checked.indexOf(s.id) + 1 : 0}
              />
            ))}
          </ul>
        )}
      </div>

      {sources.length > 0 && (
        <div className="shrink-0 space-y-2 border-t p-3">
          {checked.length >= 2 ? (
            <>
              <Button variant="outline" size="sm" className="w-full" onClick={() => join(checked)}>
                <Merge /> Join these {checked.length} into one video
              </Button>
              <p className="text-xs text-muted-foreground">They play in the order you ticked them (see the numbers).</p>
            </>
          ) : (
            sources.length >= 2 && <p className="text-xs text-muted-foreground">Tick two or more videos to join them into one.</p>
          )}
          {advanced ? (
            <PresetPicker
              current={null}
              label={`Apply a preset to ${checked.length > 0 ? noun(checked.length) : 'all files'}`}
              className="w-full"
              onPick={(p) => applyPreset(targets, p)}
            />
          ) : (
            sources.length > 1 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{checked.length > 0 ? `Use for the ${noun(checked.length)} ticked` : 'Use for all videos'}</p>
                <Segmented
                  label="Choice for several videos"
                  className="w-full [&>button]:flex-1 [&>button]:px-1"
                  value={shared ?? ''}
                  onChange={(id) => targets.forEach((t) => void pickChoice(t, id))}
                  options={options.map((o) => ({ value: o.id, label: o.title }))}
                />
              </div>
            )
          )}
          <Button className="w-full" onClick={() => queue(targets)}>
            <ListPlus />
            {checked.length > 0
              ? `Add ${noun(checked.length)} to queue`
              : sources.length === 1
                ? 'Add to queue'
                : `Add all ${sources.length} to queue`}
          </Button>
        </div>
      )}
    </section>
  );
}

function SourceRow({ source, selected, checked, order }: { source: Source; selected: boolean; checked: boolean; order: number }) {
  const { select, toggle, remove } = useSources.getState();
  const presets = useApp((s) => s.presets);
  const options = useApp((s) => s.easyOptions);
  const v = source.media.video;
  const joined = isJoined(source);
  const label =
    options.find((o) => o.id === source.choice)?.title ?? presets.find((p) => p.id === source.presetId)?.name ?? 'Your own settings';
  const name = joined ? `${(source.spec.extraInputs?.length ?? 0) + 1} videos joined` : source.media.fileName;

  return (
    <li
      className={cn(
        'group relative flex cursor-pointer gap-2.5 border-b px-3 py-2.5 transition-colors hover:bg-accent/50',
        selected && 'bg-accent/80 hover:bg-accent/80',
      )}
      onClick={() => select(source.id)}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" aria-hidden="true" />}
      <Checkbox
        aria-label={`Tick ${name}`}
        className="mt-0.5"
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => toggle(source.id)}
      />
      <div className="relative h-[42px] w-[74px] shrink-0 overflow-hidden rounded-[3px] bg-stage">
        {source.thumb ? (
          <img src={fileUrl(source.thumb)} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <div className="grid size-full place-items-center text-faint">
            <Film className="size-4" />
          </div>
        )}
        {order > 0 && (
          <span className="readout absolute top-0.5 left-0.5 grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
            {order}
          </span>
        )}
        <span className="readout absolute right-0.5 bottom-0.5 rounded-[2px] bg-black/70 px-1 text-[10px] leading-4 text-white">
          {clock(source.media.duration)}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block w-full truncate text-left font-medium outline-none focus-visible:underline"
          title={joined ? [source.spec.input, ...(source.spec.extraInputs ?? [])].join('\n') : source.media.path}
          onClick={() => select(source.id)}
        >
          {name}
        </button>
        <p className="readout truncate text-xs text-muted-foreground">
          {v ? `${v.width}×${v.height}` : 'No video'} <span className="text-faint">/</span> {bytes(source.media.sizeBytes)}{' '}
          <span className="text-faint">/</span> {label}
        </p>
        <ShrinkMeter
          compact
          className="mt-1.5"
          sourceBytes={source.media.sizeBytes}
          outputBytes={source.estimate?.sizeBytes ?? null}
          state={source.estimate ? 'estimate' : 'unknown'}
        />
      </div>
      <button
        type="button"
        aria-label={`Remove ${name} from the list`}
        className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-raised hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          remove([source.id]);
        }}
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
}
