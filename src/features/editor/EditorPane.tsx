import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { AlertTriangle, Check, Copy, ListPlus, Loader2, MousePointerClick, ScanSearch, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Empty, Field, Segmented, ShrinkMeter } from '@/components/common';
import { PresetPicker, SavePresetDialog } from '@/features/presets/PresetPicker';
import { PreviewStage } from '@/features/preview/PreviewStage';
import { bitrate, bytes, clock, dirName, fps, span } from '@/lib/format';
import { api, errorText } from '@/lib/ipc';
import { CONTAINER_LABELS, encoderInfo, jobDuration } from '@/lib/spec';
import { useApp } from '@/stores/app';
import { isJoined, useSources, type Source } from '@/stores/sources';
import { EasyEditor } from './EasyEditor';
import { AudioTab, FiltersTab, SubtitlesTab, VideoTab } from './tabs';
import type { CommandPreview, Container, EncodeSettings } from '@/lib/types';

export function EditorPane() {
  const source = useSources((s) => s.sources.find((x) => x.id === s.selectedId));
  const count = useSources((s) => s.sources.length);
  const advanced = useApp((s) => s.settings.advancedMode);

  if (!source) {
    return (
      <section aria-label="Settings" className="min-h-0 min-w-0 bg-background">
        <Empty icon={<MousePointerClick />} title={count === 0 ? 'Nothing to set up yet' : 'Pick a file'}>
          {count === 0
            ? 'Add a video on the left. The app checks it and shows you three sizes to choose from.'
            : 'Choose a video on the left.'}
        </Empty>
      </section>
    );
  }
  // Keyed by file so the playhead and comparison reset when you switch.
  return advanced ? <Editor key={source.id} source={source} /> : <EasyEditor key={source.id} source={source} />;
}

function Editor({ source }: { source: Source }) {
  const { applyPreset, queue } = useSources.getState();
  const [plan, setPlan] = useState<CommandPreview | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [saving, setSaving] = useState<EncodeSettings | null>(null);

  // Ask the core what this job would actually run: it reports problems early.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api
        .commandPreview(source.spec)
        .then((p) => {
          if (!current) return;
          setPlan(p);
          setPlanError(null);
        })
        .catch((e) => current && setPlanError(errorText(e)));
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [source.spec]);

  const tracks = `${source.spec.audioTracks.length}/${source.media.audio.length}`;
  const subs = `${source.spec.subtitleTracks.length}/${source.media.subtitles.length}`;

  return (
    <section aria-label="Settings" className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(200px,44%)_minmax(0,1fr)] overflow-hidden bg-background">
      <PreviewStage source={source} plan={plan} />

      <Tabs defaultValue="summary" className="min-h-0 gap-0">
        <div className="flex h-11 shrink-0 items-center gap-3 border-y px-4">
          <TabsList variant="line" className="h-full gap-4 p-0">
            {[
              ['summary', 'Summary'],
              ['video', 'Video'],
              ['audio', `Audio ${tracks}`],
              ['subtitles', `Subtitles ${subs}`],
              ['filters', 'Filters'],
            ].map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="h-full flex-none px-0 text-[13px] after:!bottom-0 after:!bg-primary">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="ml-auto flex items-center gap-2">
            <PresetPicker
              current={source.presetId}
              className="w-52"
              onPick={(p) => applyPreset([source.id], p)}
              onSaveCurrent={() => setSaving(source.spec.settings)}
            />
            <Button size="sm" disabled={!!planError} onClick={() => queue([source.id])}>
              <ListPlus /> Add to queue
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <div className="max-w-[720px]">
            <TabsContent value="summary">
              <Summary source={source} plan={plan} planError={planError} />
            </TabsContent>
            <TabsContent value="video">
              <VideoTab source={source} />
            </TabsContent>
            <TabsContent value="audio">
              <AudioTab source={source} />
            </TabsContent>
            <TabsContent value="subtitles">
              <SubtitlesTab source={source} />
            </TabsContent>
            <TabsContent value="filters">
              <FiltersTab source={source} />
            </TabsContent>
          </div>
        </div>
      </Tabs>

      <SavePresetDialog
        open={saving !== null}
        onOpenChange={(open) => !open && setSaving(null)}
        settings={saving}
        // Attach the new preset to this file without touching its other state.
        onSaved={(p) => {
          useSources.setState((s) => ({ sources: s.sources.map((x) => (x.id === source.id ? { ...x, presetId: p.id } : x)) }));
        }}
      />
    </section>
  );
}

function Summary({ source, plan, planError }: { source: Source; plan: CommandPreview | null; planError: string | null }) {
  const caps = useApp((s) => s.caps);
  const { estimate, cancelEstimate, analyze, edit, setContainer, setOutput } = useSources.getState();
  const { media, spec } = source;
  const v = media.video;
  const info = encoderInfo(caps, spec.settings.video.encoder);
  const est = source.estimate;
  const analysis = source.analysis;
  const trimmedShare = media.duration > 0 ? jobDuration(spec, media) / media.duration : 1;
  const [copied, setCopied] = useState(false);

  const changeOutput = async () => {
    const ext = spec.settings.container;
    const picked = await save({ defaultPath: spec.output, filters: [{ name: CONTAINER_LABELS[ext], extensions: [ext] }] });
    if (!picked) return;
    if (picked.toLowerCase() === media.path.toLowerCase()) {
      toast.error('That would overwrite the source file. Choose a different name.');
      return;
    }
    setOutput(source.id, picked);
  };

  const containers = (info?.containers ?? ['mp4', 'mkv']) as Container[];

  return (
    <div>
      <div className="rounded-md border bg-panel p-4">
        <ShrinkMeter
          // A trim keeps only part of the source, so compare against that part.
          sourceBytes={media.sizeBytes * trimmedShare}
          outputBytes={est?.sizeBytes ?? null}
          state={est ? 'estimate' : 'unknown'}
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {source.estimateState === 'running' ? (
            <>
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Encoding short samples to measure the result…
              </span>
              <Button variant="ghost" size="xs" onClick={() => cancelEstimate(source.id)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" disabled={!!planError || isJoined(source)} onClick={() => estimate(source.id)}>
              <Timer /> {est ? 'Estimate again' : 'Estimate size and time'}
            </Button>
          )}
          {est && source.estimateState !== 'running' && (
            <span className="readout text-xs text-muted-foreground">
              {est.encodeSecs > 0 ? `About ${span(est.encodeSecs)} to encode. ` : ''}
              {est.sampled ? 'Measured from three short samples; the real file can differ by 10 to 20%.' : 'Worked out from the bitrate, so it is close to exact.'}
            </span>
          )}
        </div>
      </div>

      {planError && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {planError}
        </p>
      )}
      {plan?.warnings.map((w) => (
        <p key={w} className="mt-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" /> {w}
        </p>
      ))}

      <div className="mt-3">
        <Field label="Save as">
          <div className="flex items-center gap-2">
            <p className="selectable min-w-0 flex-1 truncate rounded-md border bg-muted px-2.5 py-1.5" title={spec.output}>
              {spec.output}
            </p>
            <Button variant="outline" size="sm" onClick={changeOutput}>
              Change…
            </Button>
          </div>
        </Field>
        <Field label="File type">
          <Segmented<Container>
            label="File type"
            value={spec.settings.container}
            onChange={(c) => setContainer(source.id, c)}
            options={(['mp4', 'mkv', 'webm', 'mov'] as Container[]).map((c) => ({
              value: c,
              label: CONTAINER_LABELS[c],
              disabled: !containers.includes(c),
              title: containers.includes(c) ? undefined : `${CONTAINER_LABELS[c]} cannot hold video from this encoder`,
            }))}
          />
        </Field>

        <Field label="Source">
          <dl className="readout grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 pt-1.5 text-[13px]">
            <dt className="text-muted-foreground">Video</dt>
            <dd>
              {v ? `${v.codec.toUpperCase()}, ${v.width}×${v.height}, ${fps(v.fps)} fps, ${v.bitDepth}-bit${v.isHdr ? ' HDR' : ''}${v.interlaced ? ', interlaced' : ''}` : 'None'}
            </dd>
            <dt className="text-muted-foreground">Length</dt>
            <dd>
              {clock(media.duration)}, {bytes(media.sizeBytes)}, {bitrate(media.bitrate)}
            </dd>
            <dt className="text-muted-foreground">Folder</dt>
            <dd className="selectable truncate" title={media.path}>
              {dirName(media.path)}
            </dd>
          </dl>
        </Field>

        <Field label="Check the video" hint="Looks for black bars, noise and interlacing so the right fixes can be suggested.">
          <Button variant="outline" size="sm" disabled={source.analysisState === 'running' || isJoined(source)} onClick={() => analyze(source.id)}>
            {source.analysisState === 'running' ? <Loader2 className="animate-spin" /> : <ScanSearch />}
            {source.analysisState === 'running' ? 'Checking…' : analysis ? 'Check again' : 'Check for black bars and noise'}
          </Button>
          {analysis && (
            <ul className="mt-2.5 space-y-2">
              <Finding
                text={analysis.crop ? `Black bars found: the picture itself is ${analysis.crop.w}×${analysis.crop.h}.` : 'No black bars.'}
                action={analysis.crop ? 'Crop them off' : undefined}
                applied={spec.settings.video.crop.mode === 'auto' && !!spec.autoCrop}
                onApply={() =>
                  edit(source.id, (s) => ({
                    ...s,
                    autoCrop: analysis.crop,
                    settings: { ...s.settings, video: { ...s.settings.video, crop: { mode: 'auto' } } },
                  }))
                }
              />
              <Finding
                text={`${analysis.noiseProfile}.`}
                action={
                  analysis.grainLevel === 0
                    ? undefined
                    : info?.supportsFilmGrain
                      ? `Use film grain ${analysis.grainLevel}`
                      : 'Reduce noise lightly'
                }
                applied={
                  info?.supportsFilmGrain
                    ? spec.settings.video.filmGrain === analysis.grainLevel
                    : spec.settings.filters.denoise !== 'off'
                }
                onApply={() =>
                  edit(source.id, (s) => ({
                    ...s,
                    settings: info?.supportsFilmGrain
                      ? { ...s.settings, video: { ...s.settings.video, filmGrain: analysis.grainLevel } }
                      : { ...s.settings, filters: { ...s.settings.filters, denoise: 'light' } },
                  }))
                }
              />
              {analysis.interlaced && (
                <Finding
                  text="This video is interlaced."
                  action="Deinterlace it"
                  applied={spec.settings.filters.deinterlace !== 'off'}
                  onApply={() =>
                    edit(source.id, (s) => ({ ...s, settings: { ...s.settings, filters: { ...s.settings.filters, deinterlace: 'bwdif' } } }))
                  }
                />
              )}
            </ul>
          )}
        </Field>

        {plan && (
          <Field label="ffmpeg command" hint={plan.passes > 1 ? 'Runs twice: an analysis pass, then this one.' : undefined}>
            <details className="group">
              <summary className="cursor-pointer pt-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
                Show what will run
              </summary>
              <pre className="selectable mt-2 max-h-40 overflow-auto rounded-md border bg-stage p-3 text-xs leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                {plan.command}
              </pre>
              <Button
                variant="ghost"
                size="xs"
                className="mt-1"
                onClick={() => {
                  void navigator.clipboard.writeText(plan.command);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy command'}
              </Button>
            </details>
          </Field>
        )}
      </div>
    </div>
  );
}

function Finding({ text, action, applied, onApply }: { text: string; action?: string; applied: boolean; onApply: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{text}</span>
      {action &&
        (applied ? (
          <span className="flex items-center gap-1 text-xs text-saved">
            <Check className="size-3.5" /> Applied
          </span>
        ) : (
          <Button variant="outline" size="xs" onClick={onApply}>
            {action}
          </Button>
        ))}
    </li>
  );
}
