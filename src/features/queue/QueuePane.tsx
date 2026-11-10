import { useEffect, useRef, useState } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import {
  AlertCircle,
  Ban,
  Check,
  FolderOpen,
  GripVertical,
  ListVideo,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  ScrollText,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Empty, ShrinkMeter, Tip } from '@/components/common';
import { bytes, clock, savingsLabel, span } from '@/lib/format';
import { api, errorText, on } from '@/lib/ipc';
import { describeSettings } from '@/lib/spec';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';
import { countJobs, useQueue } from '@/stores/queue';
import { useSources } from '@/stores/sources';
import type { Job } from '@/lib/types';

const call = (p: Promise<unknown>) => p.catch((e) => toast.error(errorText(e)));

export function QueuePane() {
  const jobs = useQueue((s) => s.jobs);
  const running = useQueue((s) => s.running);
  const paused = useQueue((s) => s.paused);
  const counts = countJobs(jobs);
  const finished = counts.done + counts.failed + counts.cancelled;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const index = jobs.findIndex((j) => j.id === over.id);
    if (index >= 0) void call(api.queueMove(String(active.id), index));
  };

  const summary = [
    counts.active > 0 && `${counts.active} encoding`,
    counts.queued > 0 && `${counts.queued} waiting`,
    counts.done > 0 && `${counts.done} done`,
    counts.failed > 0 && `${counts.failed} failed`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <section aria-label="Queue" className="flex min-h-0 flex-col border-l bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="font-medium">Queue</h2>
        <span className="readout truncate text-xs text-muted-foreground">{summary}</span>
        <div className="ml-auto flex items-center gap-1">
          {!running && (
            <Button size="sm" disabled={counts.queued === 0} onClick={() => call(api.queueStart())}>
              <Play /> Start
            </Button>
          )}
          {running && !paused && (
            <Button size="sm" variant="secondary" onClick={() => call(api.queuePause())}>
              <Pause /> Pause
            </Button>
          )}
          {running && paused && (
            <Button size="sm" onClick={() => call(api.queueResume())}>
              <Play /> Resume
            </Button>
          )}
          {running && (
            <Tip text="Stop. Encodes in progress go back to waiting and start over next time.">
              <Button size="icon-sm" variant="ghost" aria-label="Stop the queue" onClick={() => call(api.queueStop())}>
                <Square />
              </Button>
            </Tip>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {jobs.length === 0 ? (
          <Empty icon={<ListVideo />} title="The queue is empty">
            Set up a file, then choose "Add to queue". Jobs run one after another and are remembered if you close the app.
          </Empty>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={jobs.map((j) => j.id)} strategy={verticalListSortingStrategy}>
              <ul>
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {finished > 0 && (
        <div className="flex shrink-0 justify-end border-t px-3 py-1.5">
          <Button variant="ghost" size="xs" onClick={() => call(api.queueClearFinished())}>
            Clear {finished} finished
          </Button>
        </div>
      )}
      <WhenFinished />
      <Hardware />
      <LogDialog />
    </section>
  );
}

const STATUS: Record<Job['status'], { label: string; tone: string }> = {
  queued: { label: 'Waiting', tone: 'text-muted-foreground' },
  running: { label: 'Encoding', tone: 'text-primary' },
  paused: { label: 'Paused', tone: 'text-foreground' },
  done: { label: 'Done', tone: 'text-saved' },
  failed: { label: 'Failed', tone: 'text-destructive' },
  cancelled: { label: 'Cancelled', tone: 'text-muted-foreground' },
};

function JobRow({ job }: { job: Job }) {
  const caps = useApp((s) => s.caps);
  const showLog = useQueue((s) => s.showLog);
  const draggable = job.status === 'queued';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: job.id, disabled: !draggable });
  const active = job.status === 'running' || job.status === 'paused';
  const status = STATUS[job.status];

  const edit = async () => {
    await useSources.getState().addFromJob(job);
    await call(api.queueRemove([job.id]));
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group relative border-b px-3 py-2.5', isDragging && 'z-10 bg-raised shadow-lg')}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          aria-label={draggable ? `Drag to reorder ${job.source.fileName}` : undefined}
          className={cn(
            '-ml-1.5 mt-0.5 grid size-5 shrink-0 place-items-center rounded-sm text-faint outline-none',
            draggable ? 'cursor-grab hover:text-foreground focus-visible:text-foreground active:cursor-grabbing' : 'invisible',
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={job.spec.output}>
            {job.source.fileName}
          </p>
          <p className="truncate text-xs text-muted-foreground">{describeSettings(job.spec.settings, caps)}</p>
        </div>
        <JobMenu job={job} onEdit={edit} onLog={() => showLog(job.id)} />
      </div>

      <div className="mt-2 pl-5">
        {active ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-[3px] bg-accent" role="progressbar" aria-valuenow={Math.round(job.progress)} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={cn('h-full rounded-[3px] bg-primary transition-[width] duration-500 ease-linear', job.status === 'paused' && 'bg-faint')}
                style={{ width: `${job.progress}%` }}
              />
            </div>
            <div className="readout mt-1.5 flex justify-between gap-2 text-xs">
              <span className={status.tone}>
                {job.status === 'paused' ? 'Paused' : job.stage || 'Encoding'} {job.progress.toFixed(1)}%
              </span>
              <span className="truncate text-muted-foreground">
                {job.status === 'running' && job.speed > 0 ? `${job.speed.toFixed(job.speed < 10 ? 2 : 0)}× speed` : ''}
                {job.status === 'running' && job.etaSecs !== null ? `, ${span(job.etaSecs)} left` : ''}
                {job.outBytes > 0 ? `${job.status === 'running' ? ', ' : ''}${bytes(job.outBytes)} so far` : ''}
              </span>
            </div>
          </>
        ) : job.status === 'done' && job.finalBytes !== null ? (
          <>
            <ShrinkMeter compact sourceBytes={job.source.sizeBytes} outputBytes={job.finalBytes} state="final" />
            <div className="readout mt-1.5 flex justify-between gap-2 text-xs">
              <span className="flex items-center gap-1 text-saved">
                <Check className="size-3.5" /> {savingsLabel(job.source.sizeBytes, job.finalBytes)}
              </span>
              <span className="text-muted-foreground">
                {bytes(job.source.sizeBytes)} to {bytes(job.finalBytes)}
                {job.startedAt && job.finishedAt ? ` in ${span((job.finishedAt - job.startedAt) / 1000)}` : ''}
              </span>
            </div>
          </>
        ) : (
          <div className="readout flex items-center gap-1.5 text-xs">
            {job.status === 'failed' && <AlertCircle className="size-3.5 shrink-0 text-destructive" />}
            {job.status === 'cancelled' && <Ban className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className={status.tone}>{status.label}</span>
            {job.status === 'queued' && (
              <span className="text-muted-foreground">
                {clock(job.source.duration)}, {bytes(job.source.sizeBytes)}
              </span>
            )}
            {job.status === 'failed' && (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:underline"
                title={job.error ?? undefined}
                onClick={() => showLog(job.id)}
              >
                {job.error?.split('\n').pop()}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function JobMenu({ job, onEdit, onLog }: { job: Job; onEdit: () => void; onLog: () => void }) {
  const active = job.status === 'running' || job.status === 'paused';
  const over = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
  return (
    <div className="flex shrink-0 items-center">
      {active && (
        <Tip text="Cancel this encode">
          <Button variant="ghost" size="icon-xs" aria-label={`Cancel ${job.source.fileName}`} onClick={() => call(api.queueCancel(job.id))}>
            <X />
          </Button>
        </Tip>
      )}
      {job.status === 'done' && (
        <Tip text="Show the file in its folder">
          <Button variant="ghost" size="icon-xs" aria-label="Show in folder" onClick={() => call(api.revealPath(job.spec.output))}>
            <FolderOpen />
          </Button>
        </Tip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`More actions for ${job.source.fileName}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {job.status === 'done' && (
            <>
              <DropdownMenuItem onSelect={() => call(api.openPath(job.spec.output))}>
                <Play /> Play the result
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => call(api.revealPath(job.spec.output))}>
                <FolderOpen /> Show in folder
              </DropdownMenuItem>
            </>
          )}
          {job.status === 'queued' && (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> Change settings
            </DropdownMenuItem>
          )}
          {over && (
            <DropdownMenuItem onSelect={() => call(api.queueRetry(job.id))}>
              <RotateCcw /> {job.status === 'done' ? 'Encode again' : 'Try again'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onLog}>
            <ScrollText /> Show log
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => call(api.queueRemove([job.id]))}>
            <Trash2 /> {active ? 'Cancel and remove' : 'Remove from queue'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** What happens once every job has finished. */
function WhenFinished() {
  const settings = useApp((s) => s.settings);
  const save = useApp((s) => s.saveSettings);
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2 text-xs">
      <span className="text-muted-foreground">When finished</span>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5">
          <Switch className="scale-90" checked={settings.playSoundOnFinish} onCheckedChange={(playSoundOnFinish) => save({ playSoundOnFinish })} />
          Play a sound
        </label>
        <label className="flex items-center gap-1.5">
          <Switch className="scale-90" checked={settings.shutdownOnFinish} onCheckedChange={(shutdownOnFinish) => save({ shutdownOnFinish })} />
          Shut down
        </label>
      </div>
    </div>
  );
}

function Meter({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  return (
    <div className="min-w-0">
      <div className="readout flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate">{detail}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-accent">
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-700" style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} />
      </div>
    </div>
  );
}

/** Live load on the processor, graphics card and memory. */
function Hardware() {
  const stats = useApp((s) => s.stats);
  if (!stats) return null;
  const ram = stats.ramTotalGb > 0 ? (stats.ramUsedGb / stats.ramTotalGb) * 100 : 0;
  return (
    <div className="shrink-0 space-y-2 border-t px-3 py-2.5" aria-label="Hardware load">
      <Tip text={`${stats.cpuModel}, ${stats.cpuCores} threads`} side="left">
        <div>
          <Meter label="Processor" value={stats.cpuUsage} detail={`${Math.round(stats.cpuUsage)}%`} />
        </div>
      </Tip>
      {stats.gpuName && stats.gpuUsage !== null && (
        <Tip text={`${stats.gpuName}${stats.gpuTempC !== null ? `, ${Math.round(stats.gpuTempC)}°C` : ''}`} side="left">
          <div>
            <Meter
              label="Graphics card"
              value={Math.max(stats.gpuUsage, stats.gpuEncoderUsage ?? 0)}
              detail={`${Math.round(stats.gpuUsage)}%${stats.gpuEncoderUsage ? `, encoder ${Math.round(stats.gpuEncoderUsage)}%` : ''}`}
            />
          </div>
        </Tip>
      )}
      <Meter label="Memory" value={ram} detail={`${stats.ramUsedGb.toFixed(1)} of ${stats.ramTotalGb.toFixed(0)} GB`} />
    </div>
  );
}

/** The full ffmpeg output for one job, live while it runs. */
function LogDialog() {
  const id = useQueue((s) => s.logFor);
  const job = useQueue((s) => s.jobs.find((j) => j.id === s.logFor));
  const showLog = useQueue((s) => s.showLog);
  const [lines, setLines] = useState<string[]>([]);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLines([]);
    api.jobLog(id).then((l) => alive && setLines(l)).catch(() => {});
    const off = on('job:log', (entry) => {
      if (entry.id === id) setLines((prev) => [...prev.slice(-399), entry.line]);
    });
    return () => {
      alive = false;
      off.then((f) => f()).catch(() => {});
    };
  }, [id]);

  // Follow the newest line.
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && showLog(null)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log for {job?.source.fileName ?? 'this job'}</DialogTitle>
          <DialogDescription>{job?.error ? 'The encode failed. The reason is at the bottom of the log.' : 'Everything ffmpeg reported for this job.'}</DialogDescription>
        </DialogHeader>
        <pre ref={box} className="selectable h-80 overflow-auto rounded-md border bg-stage p-3 text-xs leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
          {lines.length > 0 ? lines.join('\n') : job?.status === 'queued' ? 'This job has not started yet.' : 'Nothing has been logged.'}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(lines.join('\n')).then(() => toast.success('Log copied'))}>
            Copy log
          </Button>
          <Button size="sm" onClick={() => showLog(null)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
