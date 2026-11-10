// Pure helpers for reading and editing encode settings. Unit-tested in spec.test.ts.

import type {
  Capabilities,
  Container,
  EncodeSettings,
  EncoderInfo,
  JobSpec,
  MediaInfo,
  RateControl,
  Resolution,
  VideoEncoder,
  VideoSettings,
} from './types';

export const HEIGHTS = [2160, 1440, 1080, 720, 480, 360] as const;

export const CONTAINER_LABELS: Record<Container, string> = {
  mp4: 'MP4',
  mkv: 'MKV',
  webm: 'WebM',
  mov: 'MOV',
};

export function encoderInfo(caps: Capabilities | null, id: VideoEncoder): EncoderInfo | undefined {
  return caps?.encoders.find((e) => e.id === id);
}

/**
 * Quality sliders run 0–100 with "better" on the right, whatever the
 * encoder's own scale is (where lower numbers mean better quality).
 */
export function sliderFromQuality(info: EncoderInfo, value: number): number {
  const range = info.qualityMax - info.qualityMin;
  if (range <= 0) return 50;
  const clamped = Math.min(info.qualityMax, Math.max(info.qualityMin, value));
  return Math.round(((info.qualityMax - clamped) / range) * 100);
}

export function qualityFromSlider(info: EncoderInfo, slider: number): number {
  const range = info.qualityMax - info.qualityMin;
  const position = Math.min(100, Math.max(0, slider)) / 100;
  return Math.round(info.qualityMax - position * range);
}

/** Carry a quality value across encoders by its distance from each default. */
export function translateQuality(from: EncoderInfo | undefined, to: EncoderInfo, value: number): number {
  if (!from || from.id === to.id) return Math.min(to.qualityMax, Math.max(to.qualityMin, value));
  const fromRange = from.qualityMax - from.qualityMin || 1;
  const toRange = to.qualityMax - to.qualityMin || 1;
  const moved = to.qualityDefault + ((value - from.qualityDefault) * toRange) / fromRange;
  return Math.min(to.qualityMax, Math.max(to.qualityMin, Math.round(moved)));
}

/** Switch encoder and repair every setting the new encoder cannot honour. */
export function switchEncoder(settings: EncodeSettings, from: EncoderInfo | undefined, to: EncoderInfo): EncodeSettings {
  const video: VideoSettings = { ...settings.video, encoder: to.id };
  if (video.rate.mode === 'quality') {
    video.rate = { mode: 'quality', value: translateQuality(from, to, video.rate.value) };
  }
  if (!to.supportsTwoPass) video.twoPass = false;
  if (!to.supportsFilmGrain) video.filmGrain = 0;
  if (!to.supportsTenBit && video.bitDepth === 'ten') video.bitDepth = 'auto';
  const container = to.containers.includes(settings.container) ? settings.container : to.containers[0];
  return { ...settings, video, container };
}

export function rateSummary(rate: RateControl, info: EncoderInfo | undefined): string {
  switch (rate.mode) {
    case 'quality':
      return `${info?.qualityLabel ?? 'Quality'} ${rate.value}`;
    case 'bitrate':
      return rate.kbps >= 1000 ? `${(rate.kbps / 1000).toFixed(1)} Mbps` : `${rate.kbps} kbps`;
    case 'targetSize':
      return `fit in ${rate.mb >= 1024 ? `${(rate.mb / 1024).toFixed(1)} GB` : `${rate.mb} MB`}`;
  }
}

const CODEC_NAMES: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', copy: 'Copy' };

/** One-line description of settings, e.g. "AV1, CRF 40, 720p, MP4". */
export function describeSettings(settings: EncodeSettings, caps: Capabilities | null): string {
  const info = encoderInfo(caps, settings.video.encoder);
  const parts: string[] = [];
  const codec = info ? (CODEC_NAMES[info.codec] ?? info.codec) : settings.video.encoder;
  parts.push(info?.hardware ? `${codec} on GPU` : codec);
  if (settings.video.encoder !== 'copy') parts.push(rateSummary(settings.video.rate, info));
  const r = settings.video.resolution;
  if (r.mode === 'height') parts.push(`${r.value}p`);
  if (r.mode === 'custom') parts.push(`${r.w}×${r.h}`);
  parts.push(CONTAINER_LABELS[settings.container]);
  return parts.join(', ');
}

export function resolutionLabel(r: Resolution): string {
  if (r.mode === 'source') return 'Same as source';
  if (r.mode === 'height') return `${r.value}p`;
  return `${r.w} × ${r.h}`;
}

/** Heights worth offering for a source: only ones that actually shrink it. */
export function heightChoices(sourceHeight: number): number[] {
  return HEIGHTS.filter((h) => h < sourceHeight);
}

/** Length of the output after trimming. */
export function jobDuration(spec: JobSpec, media: MediaInfo): number {
  if (!spec.trim) return media.duration;
  const start = Math.min(Math.max(0, spec.trim.start), media.duration);
  const end = spec.trim.end <= 0 ? media.duration : Math.min(Math.max(start, spec.trim.end), media.duration);
  return end - start >= 0.1 ? end - start : media.duration;
}

/** Whether a spec's settings still match a preset exactly. */
export function sameSettings(a: EncodeSettings, b: EncodeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The picture-affecting parts of a spec — used to know when to redraw the preview frame. */
export function geometryKey(spec: JobSpec): string {
  const v = spec.settings.video;
  return JSON.stringify([v.crop, v.resolution, v.hdr, spec.autoCrop, spec.settings.filters, spec.input]);
}

/** Where the scrubber may travel: inside the trim if there is one. */
export function trimBounds(spec: JobSpec, media: MediaInfo): [number, number] {
  if (!spec.trim) return [0, media.duration];
  return [spec.trim.start, spec.trim.end <= 0 ? media.duration : spec.trim.end];
}
