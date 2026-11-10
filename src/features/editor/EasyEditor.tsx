// The simple view: the app checks the video, shows three choices with real
// numbers, suggests one, and plays it next to the original.

import { useEffect } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { AlertTriangle, Check, ListPlus, RotateCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PreviewStage, type ClipPair } from '@/features/preview/PreviewStage';
import { baseName, bytes, dirName, span } from '@/lib/format';
import { jobDuration } from '@/lib/spec';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';
import { isJoined, scaleEstimate, useSources, type Source } from '@/stores/sources';
import type { EasyChoice, EasyOption, Estimate } from '@/lib/types';

export function EasyEditor({ source }: { source: Source }) {
  const options = useApp((s) => s.easyOptions);
  const { pickChoice, analyzeEasy, queue, setOutput } = useSources.getState();
  const joined = isJoined(source);
  const easy = source.easy;

  // Check the video as soon as it is looked at. One at a time: only the
  // selected file is checked, so adding fifty files stays quick.
  useEffect(() => {
    if (!joined && !easy && source.easyState === 'idle') void analyzeEasy(source.id);
    // Runs when a different file is shown or its check is reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, easy, source.easyState]);

  const tried = (id: string): EasyChoice | undefined => easy?.choices.find((c) => c.id === id);
  // Numbers follow the cut: half the video is half the size.
  const estimateFor = (id: string): Estimate | null => {
    const t = tried(id);
    if (!t) return null;
    return scaleEstimate(t.estimate, jobDuration(source.spec, source.media) / jobDuration(t.spec, source.media));
  };

  const current = source.choice ? tried(source.choice) : undefined;
  const currentOption = options.find((o) => o.id === source.choice);
  const currentEstimate = source.choice ? estimateFor(source.choice) : null;
  const pair: ClipPair | null =
    easy && current
      ? {
          original: easy.original,
          encoded: current.preview,
          caption: `${currentOption?.title ?? 'Compressed'}${currentEstimate ? `, about ${bytes(currentEstimate.sizeBytes)}` : ''}`,
        }
      : null;

  const changeOutput = async () => {
    const picked = await save({ defaultPath: source.spec.output, filters: [{ name: 'Video', extensions: [source.spec.settings.container] }] });
    if (!picked) return;
    const sources = [source.spec.input, ...(source.spec.extraInputs ?? [])].map((p) => p.toLowerCase());
    if (sources.includes(picked.toLowerCase())) {
      toast.error('That would replace one of your original videos. Choose a different name.');
      return;
    }
    setOutput(source.id, picked);
  };

  const checking = source.easyState === 'running';
  const heading = joined
    ? `${(source.spec.extraInputs?.length ?? 0) + 1} videos will be joined into one`
    : checking
      ? 'Checking your video…'
      : 'How small should it be?';

  return (
    <section aria-label="Settings" className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(200px,1fr)_auto] overflow-hidden bg-background">
      <PreviewStage
        source={source}
        plan={null}
        simple
        pair={pair}
        busy={checking ? { progress: source.easyProgress, stage: source.easyStage || 'Starting' } : null}
      />

      <div className="border-t px-5 pt-4 pb-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{heading}</h2>
        {easy && !joined && (
          <p className="mt-1 flex items-start gap-1.5 text-muted-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" /> {easy.advice}
          </p>
        )}

        {joined && (
          <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
            {[source.spec.input, ...(source.spec.extraInputs ?? [])].map((p, i) => (
              <li key={`${p}-${i}`} className="readout">
                {i + 1}. {baseName(p)}
              </li>
            ))}
          </ol>
        )}

        {source.easyState === 'failed' && (
          <p role="alert" className="mt-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">This video could not be checked. You can still compress it. {source.easyError}</span>
            <Button variant="outline" size="xs" onClick={() => analyzeEasy(source.id)}>
              <RotateCw /> Try again
            </Button>
          </p>
        )}

        <div role="radiogroup" aria-label="How small should it be?" className="mt-3 grid grid-cols-3 gap-3">
          {options.map((option) => (
            <ChoiceCard
              key={option.id}
              option={option}
              tried={tried(option.id)}
              estimate={estimateFor(option.id)}
              selected={source.choice === option.id}
              suggested={easy?.recommended === option.id}
              checking={checking}
              onPick={() => pickChoice(source.id, option.id)}
            />
          ))}
        </div>

        {source.choice === null && (
          <p className="mt-3 text-muted-foreground">
            This video uses settings you chose yourself in the advanced view. Pick a card above to go back to a simple choice.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 truncate text-muted-foreground" title={source.spec.output}>
            Saves as <span className="text-foreground">{baseName(source.spec.output)}</span> in {dirName(source.spec.output)}
          </p>
          <Button variant="ghost" size="sm" onClick={changeOutput}>
            Change…
          </Button>
          <Button size="lg" className="px-7 text-[15px]" onClick={() => queue([source.id])}>
            <ListPlus /> Add to queue
          </Button>
        </div>
      </div>
    </section>
  );
}

function ChoiceCard({
  option,
  tried,
  estimate,
  selected,
  suggested,
  checking,
  onPick,
}: {
  option: EasyOption;
  tried: EasyChoice | undefined;
  estimate: Estimate | null;
  selected: boolean;
  suggested: boolean;
  checking: boolean;
  onPick: () => void;
}) {
  const saved = tried ? Math.round(tried.estimate.savingsPercent) : 0;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={cn(
        'relative flex min-h-[132px] flex-col rounded-lg border-2 bg-panel px-4 py-3 text-left outline-none transition-colors',
        'hover:border-faint focus-visible:ring-2 focus-visible:ring-ring/60',
        selected ? 'border-primary bg-primary/[0.07] hover:border-primary' : 'border-border',
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="text-[15px] font-semibold">{option.title}</span>
        {suggested && (
          <span className="rounded-[4px] bg-primary px-1.5 py-px text-[11px] font-semibold text-primary-foreground">Suggested</span>
        )}
        <span
          className={cn(
            'ml-auto grid size-[18px] shrink-0 place-items-center rounded-full border-2',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
          )}
          aria-hidden="true"
        >
          {selected && <Check className="size-3" strokeWidth={3} />}
        </span>
      </span>

      {tried && estimate ? (
        <>
          <span className="readout mt-2 flex items-baseline gap-2">
            <span className="text-[22px] leading-none font-medium">{bytes(estimate.sizeBytes)}</span>
            <span className={cn('font-medium', saved > 0 ? 'text-saved' : 'text-destructive')}>
              {saved > 0 ? `${saved}% smaller` : saved < 0 ? `${-saved}% bigger` : 'same size'}
            </span>
          </span>
          <span className="mt-2 text-foreground/90">{tried.look}</span>
          <span className="readout mt-0.5 text-xs text-muted-foreground">Takes about {span(estimate.encodeSecs)}</span>
        </>
      ) : (
        <>
          <span className="mt-2 text-muted-foreground">{option.hint}</span>
          {checking && <span className="mt-auto pt-2 text-xs text-faint">Working out the size…</span>}
        </>
      )}
    </button>
  );
}
