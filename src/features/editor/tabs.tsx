// The Video, Audio, Subtitles and Filters tabs for the selected file.

import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Field, Segmented } from '@/components/common';
import { bitrate, channels, fps as fpsText, language } from '@/lib/format';
import { heightChoices, qualityFromSlider, sliderFromQuality, switchEncoder } from '@/lib/spec';
import { useApp } from '@/stores/app';
import { useSources, type Source } from '@/stores/sources';
import type {
  AudioCodec,
  AudioTrack,
  BitDepth,
  Deinterlace,
  EncodeSettings,
  Filters,
  JobSpec,
  Mixdown,
  Rotate,
  Speed,
  Strength,
  SubtitleTrack,
  VideoEncoder,
  VideoSettings,
} from '@/lib/types';

/** A number you can type; commits on Enter or blur, and snaps back if invalid. */
export function NumberBox({
  value,
  onCommit,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  suffix,
  className = 'w-24',
  label,
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const snapped = Math.min(max, Math.max(min, step >= 1 ? Math.round(parsed) : parsed));
    setText(String(snapped));
    if (snapped !== value) onCommit(snapped);
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        aria-label={label}
        inputMode="decimal"
        className={`readout h-8 ${className}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </span>
  );
}

function useEditor(source: Source) {
  const edit = useSources.getState().edit;
  const change = (f: (spec: JobSpec) => JobSpec) => edit(source.id, f);
  const settings = (f: (s: EncodeSettings) => EncodeSettings) => change((spec) => ({ ...spec, settings: f(spec.settings) }));
  const video = (patch: Partial<VideoSettings>) => settings((s) => ({ ...s, video: { ...s.video, ...patch } }));
  const filters = (patch: Partial<Filters>) => settings((s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  return { change, settings, video, filters };
}

const STRENGTHS: { value: Strength; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
];

// ───────────────────────────── Video ─────────────────────────────

export function VideoTab({ source }: { source: Source }) {
  const caps = useApp((s) => s.caps);
  const { settings, video } = useEditor(source);
  const { analyze, setContainer } = useSources.getState();
  const vs = source.spec.settings.video;
  const src = source.media.video;
  const info = caps?.encoders.find((e) => e.id === vs.encoder);
  const encoders = caps?.encoders ?? [];
  const software = encoders.filter((e) => !e.hardware && e.id !== 'copy');
  const hardware = encoders.filter((e) => e.hardware);
  const copy = vs.encoder === 'copy';

  const pickEncoder = (id: string) => {
    const to = encoders.find((e) => e.id === (id as VideoEncoder));
    if (!to) return;
    const next = switchEncoder(source.spec.settings, info, to);
    settings(() => next);
    // A different container means a different file extension.
    if (next.container !== source.spec.settings.container) void setContainer(source.id, next.container);
  };

  return (
    <div>
      <Field
        label="Encoder"
        hint={
          copy
            ? 'The picture is copied untouched: instant, no quality loss, and no size change. Use it to cut a clip or swap audio.'
            : info?.hardware
              ? `Runs on your ${info.vendor} graphics card. Much faster than a software encoder; files are larger at the same quality.`
              : 'Runs on the processor. Slower than a graphics-card encoder, but smaller files at the same quality.'
        }
      >
        <Select value={vs.encoder} onValueChange={pickEncoder}>
          <SelectTrigger className="h-8 w-full max-w-sm" aria-label="Encoder">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Software (processor)</SelectLabel>
              {software.map((e) => (
                <SelectItem key={e.id} value={e.id} disabled={!e.available}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Hardware (graphics card)</SelectLabel>
              {hardware.map((e) => (
                <SelectItem key={e.id} value={e.id} disabled={!e.available} title={e.reason ?? undefined}>
                  {e.label}
                  {!e.available && <span className="ml-1 text-muted-foreground">, not available on this PC</span>}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>No re-encode</SelectLabel>
              <SelectItem value="copy">Copy the video as it is</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {!copy && info && (
        <>
          <Field label="Aim for">
            <Segmented
              label="What the encoder aims for"
              value={vs.rate.mode}
              onChange={(mode) => {
                if (mode === 'quality') video({ rate: { mode, value: info.qualityDefault } });
                if (mode === 'bitrate') video({ rate: { mode, kbps: Math.max(300, Math.round((src?.bitrate ?? 8e6) / 1000 / 4)) } });
                if (mode === 'targetSize')
                  video({ rate: { mode, mb: Math.max(1, Math.round(source.media.sizeBytes / 1048576 / 4)) }, twoPass: info.supportsTwoPass });
              }}
              options={[
                { value: 'quality', label: 'A quality level' },
                { value: 'bitrate', label: 'A bitrate' },
                { value: 'targetSize', label: 'A file size' },
              ]}
            />
          </Field>

          {vs.rate.mode === 'quality' && (
            <Field
              label="Quality"
              hint={`${info.qualityLabel} ${vs.rate.value} on this encoder's own scale (${info.qualityMin} is best, ${info.qualityMax} is smallest). The default is ${info.qualityDefault}.`}
            >
              <div className="flex max-w-md items-center gap-3 pt-1.5">
                <span className="w-20 text-xs text-muted-foreground">Smaller file</span>
                <Slider
                  aria-label="Quality"
                  min={0}
                  max={100}
                  step={1}
                  value={[sliderFromQuality(info, vs.rate.value)]}
                  onValueChange={([v]) => video({ rate: { mode: 'quality', value: qualityFromSlider(info, v) } })}
                />
                <span className="w-24 text-right text-xs text-muted-foreground">Better quality</span>
              </div>
            </Field>
          )}

          {vs.rate.mode === 'bitrate' && (
            <Field label="Video bitrate" hint={src ? `The source video is about ${bitrate(src.bitrate)}.` : undefined}>
              <NumberBox label="Video bitrate in kbps" value={vs.rate.kbps} min={50} max={500000} suffix="kbps" onCommit={(kbps) => video({ rate: { mode: 'bitrate', kbps } })} />
            </Field>
          )}

          {vs.rate.mode === 'targetSize' && (
            <Field label="File size" hint="Video and audio together land just under this size. A file that is already smaller is never made bigger.">
              <div className="flex flex-wrap items-center gap-2">
                <NumberBox label="Target size in megabytes" value={vs.rate.mb} min={1} max={1000000} step={0.1} suffix="MB" onCommit={(mb) => video({ rate: { mode: 'targetSize', mb } })} />
                {[10, 25, 50, 100, 500].map((mb) => (
                  <Button key={mb} variant="outline" size="xs" onClick={() => video({ rate: { mode: 'targetSize', mb } })}>
                    {mb} MB
                  </Button>
                ))}
              </div>
            </Field>
          )}

          {vs.rate.mode !== 'quality' && info.supportsTwoPass && (
            <Field label="Two passes" hint="Looks at the whole video first, then encodes. Takes longer and hits the size or bitrate more exactly.">
              <Switch aria-label="Two passes" className="mt-1" checked={vs.twoPass} onCheckedChange={(twoPass) => video({ twoPass })} />
            </Field>
          )}

          <Field label="Speed" hint="Slower settings squeeze out a smaller file at the same quality.">
            <Segmented<Speed>
              label="Encoding speed"
              value={vs.speed}
              onChange={(speed) => video({ speed })}
              options={[
                { value: 'slowest', label: 'Slowest' },
                { value: 'slow', label: 'Slow' },
                { value: 'medium', label: 'Medium' },
                { value: 'fast', label: 'Fast' },
                { value: 'fastest', label: 'Fastest' },
              ]}
            />
          </Field>

          <Field label="Resolution">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={vs.resolution.mode === 'height' ? String(vs.resolution.value) : vs.resolution.mode}
                onValueChange={(v) => {
                  if (v === 'source') video({ resolution: { mode: 'source' } });
                  else if (v === 'custom') video({ resolution: { mode: 'custom', w: src?.width ?? 1280, h: src?.height ?? 720 } });
                  else video({ resolution: { mode: 'height', value: Number(v) } });
                }}
              >
                <SelectTrigger className="h-8 w-56" aria-label="Resolution">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="source">Same as source{src ? ` (${src.width}×${src.height})` : ''}</SelectItem>
                  {heightChoices(src?.height ?? 0).map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {h}p
                    </SelectItem>
                  ))}
                  {vs.resolution.mode === 'height' && !heightChoices(src?.height ?? 0).includes(vs.resolution.value as never) && (
                    <SelectItem value={String(vs.resolution.value)}>{vs.resolution.value}p (no change for this file)</SelectItem>
                  )}
                  <SelectItem value="custom">Custom size</SelectItem>
                </SelectContent>
              </Select>
              {vs.resolution.mode === 'custom' && (
                <>
                  <NumberBox label="Width" className="w-20" value={vs.resolution.w} min={16} max={16384} onCommit={(w) => vs.resolution.mode === 'custom' && video({ resolution: { ...vs.resolution, w } })} />
                  <span className="text-muted-foreground">×</span>
                  <NumberBox label="Height" className="w-20" value={vs.resolution.h} min={16} max={16384} onCommit={(h) => vs.resolution.mode === 'custom' && video({ resolution: { ...vs.resolution, h } })} />
                </>
              )}
            </div>
          </Field>

          <Field label="Frame rate">
            <Select
              value={vs.fps.mode === 'source' ? 'source' : String(vs.fps.value)}
              onValueChange={(v) => video({ fps: v === 'source' ? { mode: 'source' } : { mode: 'fixed', value: Number(v) } })}
            >
              <SelectTrigger className="h-8 w-56" aria-label="Frame rate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="source">Same as source{src ? ` (${fpsText(src.fps)} fps)` : ''}</SelectItem>
                {[60, 50, 30, 29.97, 25, 24, 23.976, 15].map((f) => (
                  <SelectItem key={f} value={String(f)}>
                    {f} fps
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Crop" hint={cropHint(source)}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Crop"
                value={vs.crop.mode}
                onChange={(mode) => {
                  if (mode === 'none') video({ crop: { mode } });
                  if (mode === 'auto') video({ crop: { mode } });
                  if (mode === 'manual') {
                    const c = source.spec.autoCrop ?? { w: src?.width ?? 0, h: src?.height ?? 0, x: 0, y: 0 };
                    video({ crop: { mode, ...c } });
                  }
                }}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'auto', label: 'Remove black bars' },
                  { value: 'manual', label: 'Custom' },
                ]}
              />
              {vs.crop.mode === 'auto' && !source.spec.autoCrop && (
                <Button variant="outline" size="xs" disabled={source.analysisState === 'running'} onClick={() => detectCrop(source, analyze)}>
                  {source.analysisState === 'running' ? 'Looking…' : 'Detect now'}
                </Button>
              )}
            </div>
            {vs.crop.mode === 'manual' && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {(['w', 'h', 'x', 'y'] as const).map((key) => (
                  <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {{ w: 'Width', h: 'Height', x: 'Left', y: 'Top' }[key]}
                    <NumberBox
                      label={`Crop ${key}`}
                      className="w-[72px]"
                      value={vs.crop.mode === 'manual' ? vs.crop[key] : 0}
                      max={16384}
                      onCommit={(n) => vs.crop.mode === 'manual' && video({ crop: { ...vs.crop, [key]: n } })}
                    />
                  </label>
                ))}
              </div>
            )}
          </Field>

          <Field label="Colour depth" hint={info.supportsTenBit ? 'Automatic keeps 10-bit sources 10-bit and uses 10-bit for AV1, which compresses better.' : 'This encoder only produces 8-bit video.'}>
            <Segmented<BitDepth>
              label="Colour depth"
              value={vs.bitDepth}
              onChange={(bitDepth) => video({ bitDepth })}
              options={[
                { value: 'auto', label: 'Automatic' },
                { value: 'eight', label: '8-bit' },
                { value: 'ten', label: '10-bit', disabled: !info.supportsTenBit },
              ]}
            />
          </Field>

          {src?.isHdr && (
            <Field label="HDR" hint="Converting to standard range makes the video look right on screens that cannot show HDR.">
              <Segmented
                label="HDR"
                value={vs.hdr}
                onChange={(hdr) => video({ hdr })}
                options={[
                  { value: 'keep', label: 'Keep HDR' },
                  { value: 'tonemap', label: 'Convert to standard range' },
                ]}
              />
            </Field>
          )}

          {info.supportsFilmGrain && (
            <Field label="Film grain" hint="Removes grain before encoding and adds matching synthetic grain on playback. Saves a lot of space on grainy footage; leave at 0 for clean video.">
              <div className="flex max-w-sm items-center gap-3 pt-1.5">
                <Slider aria-label="Film grain" min={0} max={50} step={1} value={[vs.filmGrain]} onValueChange={([filmGrain]) => video({ filmGrain })} />
                <span className="readout w-6 text-right">{vs.filmGrain}</span>
              </div>
            </Field>
          )}
        </>
      )}
    </div>
  );
}

function cropHint(source: Source): string | undefined {
  const { crop } = source.spec.settings.video;
  if (crop.mode !== 'auto') return undefined;
  const found = source.spec.autoCrop;
  if (found) return `Black bars found. The picture will be cropped to ${found.w}×${found.h}.`;
  if (source.analysis) return 'No black bars were found in this video, so nothing will be cropped.';
  return 'Black bars are looked for when the encode starts. Detect now to see the result in the preview.';
}

async function detectCrop(source: Source, analyze: (id: string) => Promise<void>) {
  await analyze(source.id);
  const found = useSources.getState().sources.find((s) => s.id === source.id)?.analysis?.crop ?? null;
  // Storing the result is not a settings change, so the preset stays attached.
  useSources.setState((s) => ({
    sources: s.sources.map((x) => (x.id === source.id ? { ...x, spec: { ...x.spec, autoCrop: found } } : x)),
  }));
}

// ───────────────────────────── Audio ─────────────────────────────

const AUDIO_CODECS: { value: AudioCodec; label: string }[] = [
  { value: 'copy', label: 'Keep original' },
  { value: 'aac', label: 'AAC' },
  { value: 'opus', label: 'Opus' },
  { value: 'ac3', label: 'AC-3 (Dolby Digital)' },
  { value: 'flac', label: 'FLAC (lossless)' },
];
const AUDIO_BITRATES = [64, 96, 128, 160, 192, 256, 320, 448, 640];

export function AudioTab({ source }: { source: Source }) {
  const { change } = useEditor(source);
  const defaults = source.spec.settings.audio;
  const tracks = source.spec.audioTracks;

  if (source.media.audio.length === 0) {
    return <p className="py-6 text-muted-foreground">This video has no audio.</p>;
  }

  const setTracks = (next: AudioTrack[]) => change((spec) => ({ ...spec, audioTracks: [...next].sort((a, b) => a.order - b.order) }));
  const patch = (order: number, p: Partial<AudioTrack>) => setTracks(tracks.map((t) => (t.order === order ? { ...t, ...p } : t)));

  return (
    <ul className="divide-y">
      {source.media.audio.map((a) => {
        const track = tracks.find((t) => t.order === a.order);
        return (
          <li key={a.order} className="py-3">
            <label className="flex items-start gap-3">
              <Checkbox
                className="mt-0.5"
                checked={!!track}
                onCheckedChange={(on) =>
                  setTracks(on === true ? [...tracks, { order: a.order, ...defaults }] : tracks.filter((t) => t.order !== a.order))
                }
              />
              <span>
                <span className="font-medium">
                  Track {a.order + 1}: {language(a.language)}
                  {a.title ? `, ${a.title}` : ''}
                </span>
                <span className="readout block text-xs text-muted-foreground">
                  {a.codec.toUpperCase()}, {channels(a.channels)}, {a.sampleRate / 1000} kHz{a.bitrate > 0 ? `, ${bitrate(a.bitrate)}` : ''}
                  {a.default ? ', default track' : ''}
                </span>
              </span>
            </label>
            {track && (
              <div className="mt-2.5 ml-7 flex flex-wrap items-center gap-2">
                <Select value={track.codec} onValueChange={(codec) => patch(a.order, { codec: codec as AudioCodec })}>
                  <SelectTrigger className="h-8 w-48" aria-label={`Format for track ${a.order + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIO_CODECS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {track.codec !== 'copy' && track.codec !== 'flac' && (
                  <Select value={String(track.bitrateKbps)} onValueChange={(v) => patch(a.order, { bitrateKbps: Number(v) })}>
                    <SelectTrigger className="h-8 w-28" aria-label={`Bitrate for track ${a.order + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...new Set([...AUDIO_BITRATES, track.bitrateKbps])].sort((x, y) => x - y).map((b) => (
                        <SelectItem key={b} value={String(b)}>
                          {b} kbps
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {track.codec !== 'copy' && (
                  <Select value={track.mixdown} onValueChange={(mixdown) => patch(a.order, { mixdown: mixdown as Mixdown })}>
                    <SelectTrigger className="h-8 w-44" aria-label={`Channels for track ${a.order + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="source">Same channels as source</SelectItem>
                      <SelectItem value="mono">Mono</SelectItem>
                      {a.channels >= 2 && <SelectItem value="stereo">Stereo</SelectItem>}
                      {a.channels >= 6 && <SelectItem value="surround51">5.1 surround</SelectItem>}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────────── Subtitles ─────────────────────────────

type SubChoice = 'off' | 'copy' | 'burn';

export function SubtitlesTab({ source }: { source: Source }) {
  const { change, settings } = useEditor(source);
  const tracks = source.spec.subtitleTracks;
  const s = source.spec.settings;

  const choose = (order: number, choice: SubChoice) =>
    change((spec) => {
      let next: SubtitleTrack[] = spec.subtitleTracks.filter((t) => t.order !== order);
      // Only one subtitle can be burned into the picture.
      if (choice === 'burn') next = next.filter((t) => t.mode !== 'burn');
      if (choice !== 'off') next.push({ order, mode: choice, default: false });
      return { ...spec, subtitleTracks: next.sort((a, b) => a.order - b.order) };
    });

  const makeDefault = (order: number, on: boolean) =>
    change((spec) => ({
      ...spec,
      subtitleTracks: spec.subtitleTracks.map((t) => ({ ...t, default: t.order === order ? on : on ? false : t.default })),
    }));

  return (
    <div>
      {source.media.subtitles.length === 0 ? (
        <p className="py-4 text-muted-foreground">This video has no subtitle tracks.</p>
      ) : (
        <ul className="divide-y">
          {source.media.subtitles.map((sub) => {
            const track = tracks.find((t) => t.order === sub.order);
            const choice: SubChoice = track ? track.mode : 'off';
            return (
              <li key={sub.order} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    Track {sub.order + 1}: {language(sub.language)}
                    {sub.title ? `, ${sub.title}` : ''}
                    {sub.forced ? ' (forced)' : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {sub.codec.toUpperCase()}, {sub.isText ? 'text' : 'picture-based'}
                  </p>
                </div>
                {choice === 'copy' && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={track?.default ?? false} onCheckedChange={(on) => makeDefault(sub.order, on === true)} />
                    Shown by default
                  </label>
                )}
                <Segmented<SubChoice>
                  label={`Subtitle track ${sub.order + 1}`}
                  value={choice}
                  onChange={(c) => choose(sub.order, c)}
                  options={[
                    { value: 'off', label: 'Leave out' },
                    { value: 'copy', label: 'Keep as a track' },
                    { value: 'burn', label: 'Burn into the picture' },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2 border-t pt-2">
        <Field label="Chapters" hint={source.media.chapters > 0 ? `This video has ${source.media.chapters} chapter markers.` : 'This video has no chapter markers.'}>
          <Switch aria-label="Keep chapters" className="mt-1" checked={s.keepChapters} onCheckedChange={(keepChapters) => settings((x) => ({ ...x, keepChapters }))} />
        </Field>
        <Field label="Metadata" hint="Title, creation date and similar tags stored in the file.">
          <Switch aria-label="Keep metadata" className="mt-1" checked={s.keepMetadata} onCheckedChange={(keepMetadata) => settings((x) => ({ ...x, keepMetadata }))} />
        </Field>
      </div>
    </div>
  );
}

// ───────────────────────────── Filters ─────────────────────────────

export function FiltersTab({ source }: { source: Source }) {
  const { filters } = useEditor(source);
  const f = source.spec.settings.filters;
  const copy = source.spec.settings.video.encoder === 'copy';
  const interlaced = source.media.video?.interlaced ?? false;

  if (copy) {
    return <p className="py-6 text-muted-foreground">Filters need the video to be re-encoded. Choose an encoder other than "Copy" on the Video tab to use them.</p>;
  }

  return (
    <div>
      <Field
        label="Deinterlace"
        hint={interlaced ? 'This video is interlaced; deinterlacing removes the comb-like lines on motion.' : 'Only needed for interlaced video such as old TV recordings. This file is not interlaced.'}
      >
        <Segmented<Deinterlace>
          label="Deinterlace"
          value={f.deinterlace}
          onChange={(deinterlace) => filters({ deinterlace })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'yadif', label: 'Standard' },
            { value: 'bwdif', label: 'Higher quality' },
          ]}
        />
      </Field>
      <Field label="Reduce noise" hint="Smooths out sensor noise, which also makes the file smaller. Strong settings blur fine detail.">
        <Segmented<Strength> label="Reduce noise" value={f.denoise} onChange={(denoise) => filters({ denoise })} options={STRENGTHS} />
      </Field>
      <Field label="Sharpen">
        <Segmented<Strength> label="Sharpen" value={f.sharpen} onChange={(sharpen) => filters({ sharpen })} options={STRENGTHS} />
      </Field>
      <Field label="Rotate">
        <Segmented<Rotate>
          label="Rotate"
          value={f.rotate}
          onChange={(rotate) => filters({ rotate })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'cw90', label: '90° right' },
            { value: 'cw180', label: '180°' },
            { value: 'cw270', label: '90° left' },
          ]}
        />
      </Field>
      <Field label="Flip">
        <div className="flex items-center gap-5 pt-1.5">
          <label className="flex items-center gap-2">
            <Switch checked={f.flipH} onCheckedChange={(flipH) => filters({ flipH })} /> Left to right
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={f.flipV} onCheckedChange={(flipV) => filters({ flipV })} /> Upside down
          </label>
        </div>
      </Field>
    </div>
  );
}
