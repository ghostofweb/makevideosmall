import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactCompareSlider } from 'react-compare-slider';
import { toast } from 'sonner';
import { Loader2, Scissors, SplitSquareHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Tip } from '@/components/common';
import { bytes, clock, parseClock, preciseClock, span } from '@/lib/format';
import { api, errorText, fileUrl, on } from '@/lib/ipc';
import { geometryKey, jobDuration } from '@/lib/spec';
import { cn } from '@/lib/utils';
import { isJoined, useSources, type Source } from '@/stores/sources';
import type { CommandPreview, PreviewPair } from '@/lib/types';

const COMPARE_SECONDS = 4;

type Compare =
  | { status: 'idle' }
  | { status: 'rendering'; progress: number; stage: string }
  | { status: 'ready'; pair: PreviewPair; forSpec: unknown };

/** Two matching clips to show side by side. */
export interface ClipPair {
  original: string;
  encoded: string;
  /** What the right-hand clip is, e.g. "Balanced, about 45 MB". */
  caption: string;
}

/**
 * The picture area. Shows a frame you can scrub and cut, or two clips to
 * compare. In the simple view the comparison comes from outside (`pair`) and
 * cutting is tucked behind one button.
 */
export function PreviewStage({
  source,
  plan,
  simple = false,
  pair = null,
  busy = null,
}: {
  source: Source;
  plan: CommandPreview | null;
  simple?: boolean;
  pair?: ClipPair | null;
  /** The video is being checked (simple view). */
  busy?: { progress: number; stage: string } | null;
}) {
  const { media, spec } = source;
  const duration = media.duration;
  const joined = isJoined(source);
  const storeTrim = useSources.getState().setTrim;

  const [position, setPosition] = useState(() => spec.trim?.start ?? Math.min(duration * 0.15, 20));
  const [frame, setFrame] = useState<string | null>(source.thumb);
  const [drawing, setDrawing] = useState(false);
  const [compare, setCompare] = useState<Compare>({ status: 'idle' });
  const [cutting, setCutting] = useState(false);
  const token = `preview-${source.id}`;
  const geometry = geometryKey(spec);

  // Redraw the still whenever the playhead or anything that changes the picture moves.
  const request = useRef(0);
  useEffect(() => {
    const mine = ++request.current;
    const timer = setTimeout(async () => {
      setDrawing(true);
      try {
        const path = await api.renderFrame({ ...spec, extraInputs: [] }, Math.min(position, duration), 1280);
        if (mine === request.current) setFrame(path);
      } catch {
        // Keep showing the last good frame.
      } finally {
        if (mine === request.current) setDrawing(false);
      }
    }, 160);
    return () => clearTimeout(timer);
    // `spec` is covered by `geometry`, which only changes when the picture would.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, geometry]);

  // Leaving this file abandons any comparison still rendering.
  useEffect(() => () => void api.cancelAnalysis(token).catch(() => {}), [token]);

  const startCompare = async () => {
    setCompare({ status: 'rendering', progress: 0, stage: 'Starting' });
    const off = await on('analysis:progress', (p) => {
      if (p.token === token) setCompare((c) => (c.status === 'rendering' ? { ...c, progress: p.progress, stage: p.stage } : c));
    });
    try {
      const made = await api.renderPreview(spec, position, COMPARE_SECONDS, token);
      setCompare({ status: 'ready', pair: made, forSpec: spec });
    } catch (e) {
      setCompare({ status: 'idle' });
      if (errorText(e) !== 'Cancelled') toast.error('Could not make the comparison', { description: errorText(e) });
    } finally {
      off();
    }
  };

  const closeCompare = () => {
    void api.cancelAnalysis(token).catch(() => {});
    setCompare({ status: 'idle' });
  };

  const trim = spec.trim;
  const start = trim?.start ?? 0;
  const end = trim && trim.end > 0 ? trim.end : duration;
  const setTrim = (nextStart: number, nextEnd: number) => {
    const s = Math.min(Math.max(0, nextStart), duration);
    const e = Math.min(Math.max(s, nextEnd), duration);
    const whole = s < 0.05 && duration - e < 0.05;
    storeTrim(source.id, whole || e - s < 0.1 ? null : { start: s, end: e });
  };

  const stale = compare.status === 'ready' && compare.forSpec !== spec;
  // What fills the stage: two clips, or one frame.
  const shown: ClipPair | null = simple
    ? pair && !cutting
      ? pair
      : null
    : compare.status === 'ready'
      ? {
          original: compare.pair.original,
          encoded: compare.pair.encoded,
          caption: `Compressed, about ${bytes(compare.pair.estimate.sizeBytes)} for the whole file${
            compare.pair.estimate.encodeSecs > 0 ? `, ${span(compare.pair.estimate.encodeSecs)} to make` : ''
          }`,
        }
      : null;
  const working = simple ? (cutting ? null : busy) : compare.status === 'rendering' ? compare : null;
  const scrubbing = !simple || cutting;

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-stage">
      <div className="relative min-h-0 flex-1">
        {shown ? (
          <CompareView pair={shown} />
        ) : (
          <>
            {frame && (
              <img
                src={fileUrl(frame)}
                alt={`The video at ${preciseClock(position)}`}
                draggable={false}
                className={cn('absolute inset-0 size-full object-contain transition-opacity', drawing && 'opacity-70')}
              />
            )}
            {working && (
              <div className="absolute inset-0 grid place-items-center bg-stage/80" role="status">
                <div className="w-72 text-center">
                  <Loader2 className="mx-auto mb-3 size-5 animate-spin text-primary" />
                  <p className="font-medium">{working.stage}</p>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-accent">
                    <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${working.progress}%` }} />
                  </div>
                  {!simple && (
                    <Button variant="ghost" size="sm" className="mt-3" onClick={closeCompare}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {!simple && (
          <div className="absolute top-2 right-2 flex gap-1.5">
            {compare.status === 'ready' ? (
              <>
                {stale && (
                  <Button size="sm" variant="secondary" onClick={startCompare}>
                    Settings changed, compare again
                  </Button>
                )}
                <Tip text="Close comparison">
                  <Button size="icon-sm" variant="secondary" aria-label="Close comparison" onClick={closeCompare}>
                    <X />
                  </Button>
                </Tip>
              </>
            ) : (
              compare.status === 'idle' &&
              !joined && (
                <Tip text={`Compresses ${COMPARE_SECONDS} seconds from here with these settings and shows it next to the original`}>
                  <Button size="sm" variant="secondary" onClick={startCompare}>
                    <SplitSquareHorizontal /> Compare before and after
                  </Button>
                </Tip>
              )
            )}
          </div>
        )}

        {shown && (
          <div className="readout pointer-events-none absolute inset-x-2 bottom-2 flex justify-between gap-2 text-xs">
            <span className="rounded-sm bg-black/70 px-2 py-0.5 text-white">Original</span>
            <span className="rounded-sm bg-black/70 px-2 py-0.5 text-white">{shown.caption}</span>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/5 bg-panel px-4 py-2.5">
        {scrubbing ? (
          <>
            {/* The scrubber rides on top of the strip that shows the kept range. */}
            <div className="relative">
              <TrimBar duration={duration} start={start} end={end} active={!!trim} />
              <Slider
                aria-label="Position in the video"
                className="h-4 [&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-track]]:bg-transparent"
                min={0}
                max={Math.max(duration, 0.1)}
                step={duration > 600 ? 1 : 0.1}
                value={[position]}
                onValueChange={([v]) => setPosition(v)}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="readout w-16 text-foreground" aria-label="Position in the video">
                {preciseClock(position)}
              </span>
              {!joined && (
                <>
                  <Scissors className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <Button variant="outline" size="xs" onClick={() => setTrim(position, Math.max(end, position + 0.1))}>
                    Start here
                  </Button>
                  <TimeBox label="Start" value={start} onCommit={(v) => setTrim(v, end)} />
                  <Button variant="outline" size="xs" onClick={() => setTrim(Math.min(start, position - 0.1), position)}>
                    End here
                  </Button>
                  <TimeBox label="End" value={end} onCommit={(v) => setTrim(start, v)} />
                  {trim && (
                    <Button variant="ghost" size="xs" onClick={() => setTrim(0, duration)}>
                      Keep the whole video
                    </Button>
                  )}
                </>
              )}
              <span className="readout ml-auto text-xs text-muted-foreground">
                {trim ? `Keeping ${preciseClock(jobDuration(spec, media))} of ${preciseClock(duration)}` : preciseClock(duration)}
                {!simple && plan && plan.width > 0 ? `, output ${plan.width}×${plan.height}` : ''}
              </span>
              {simple && (
                <Button size="xs" onClick={() => setCutting(false)}>
                  Done
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {!joined && (
              <Tip text="Keep only part of the video: drag to a moment, then mark where it should start and end">
                <Button variant="outline" size="sm" onClick={() => setCutting(true)}>
                  <Scissors /> {trim ? 'Change the cut' : 'Cut the start or end'}
                </Button>
              </Tip>
            )}
            {trim && (
              <>
                <span className="readout text-xs text-primary">
                  Keeping {preciseClock(start)} to {preciseClock(end)}
                </span>
                <Button variant="ghost" size="xs" onClick={() => setTrim(0, duration)}>
                  Keep the whole video
                </Button>
              </>
            )}
            <span className="readout ml-auto text-xs text-muted-foreground">
              {media.video ? `${media.video.width}×${media.video.height}, ` : ''}
              {clock(duration)}, {bytes(media.sizeBytes)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A thin strip under the scrubber showing which part of the video is kept. */
function TrimBar({ duration, start, end, active }: { duration: number; start: number; end: number; active: boolean }) {
  const left = duration > 0 ? (start / duration) * 100 : 0;
  const width = duration > 0 ? ((end - start) / duration) * 100 : 100;
  return (
    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" aria-hidden="true">
      <div
        className={cn('absolute inset-y-0 rounded-full', active ? 'bg-primary' : 'bg-faint/60')}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
    </div>
  );
}

/** A time you can type, e.g. "1:23.5". Commits on Enter or when focus leaves. */
function TimeBox({ label, value, onCommit }: { label: string; value: number; onCommit: (seconds: number) => void }) {
  const shown = useMemo(() => preciseClock(value), [value]);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const commit = () => {
    const parsed = parseClock(text);
    if (parsed === null) setText(shown);
    else onCommit(parsed);
  };

  return (
    <Input
      aria-label={label}
      className="readout h-6 w-[72px] px-1.5 text-xs text-foreground"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(shown);
      }}
    />
  );
}

/** Two looping clips kept in step, with a divider to drag between them. */
function CompareView({ pair }: { pair: ClipPair }) {
  const original = useRef<HTMLVideoElement>(null);
  const encoded = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const a = original.current;
    const b = encoded.current;
    if (!a || !b) return;
    // The original leads; the other clip is nudged back whenever it drifts.
    const sync = () => {
      if (Math.abs(a.currentTime - b.currentTime) > 0.08) b.currentTime = a.currentTime;
    };
    a.addEventListener('timeupdate', sync);
    const start = () => {
      void a.play().catch(() => {});
      void b.play().catch(() => {});
    };
    if (a.readyState >= 2 && b.readyState >= 2) start();
    a.addEventListener('canplay', start);
    b.addEventListener('canplay', start);
    return () => {
      a.removeEventListener('timeupdate', sync);
      a.removeEventListener('canplay', start);
      b.removeEventListener('canplay', start);
    };
  }, [pair.original, pair.encoded]);

  const video = 'size-full object-contain';
  return (
    <ReactCompareSlider
      className="absolute inset-0 size-full"
      itemOne={<video ref={original} src={fileUrl(pair.original)} className={video} loop muted playsInline />}
      itemTwo={<video ref={encoded} src={fileUrl(pair.encoded)} className={video} loop muted playsInline />}
    />
  );
}
