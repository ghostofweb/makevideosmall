import { describe, expect, it } from 'vitest';
import {
  describeSettings,
  geometryKey,
  heightChoices,
  jobDuration,
  qualityFromSlider,
  rateSummary,
  sameSettings,
  sliderFromQuality,
  switchEncoder,
  translateQuality,
  trimBounds,
} from './spec';
import type { Capabilities, EncodeSettings, EncoderInfo, JobSpec, MediaInfo } from './types';

function encoder(patch: Partial<EncoderInfo> & Pick<EncoderInfo, 'id'>): EncoderInfo {
  return {
    label: patch.id,
    codec: 'h264',
    hardware: false,
    vendor: null,
    available: true,
    reason: null,
    qualityMin: 0,
    qualityMax: 51,
    qualityDefault: 23,
    qualityLabel: 'CRF',
    supportsTenBit: true,
    supportsTwoPass: true,
    supportsFilmGrain: false,
    containers: ['mp4', 'mkv', 'mov'],
    ...patch,
  };
}

const x264 = encoder({ id: 'x264' });
const svt = encoder({
  id: 'svtAv1', codec: 'av1', qualityMin: 1, qualityMax: 63, qualityDefault: 32,
  supportsTwoPass: false, supportsFilmGrain: true, containers: ['mp4', 'mkv', 'webm'],
});
const nvenc = encoder({
  id: 'h264Nvenc', hardware: true, vendor: 'NVIDIA', qualityMin: 1, qualityMax: 51, qualityDefault: 25,
  qualityLabel: 'CQ', supportsTenBit: false,
});
const caps: Capabilities = { ffmpegPath: '', ffprobePath: '', ffmpegVersion: '8.1', encoders: [x264, svt, nvenc], upscalerAvailable: true, backgroundRemovalAvailable: true };

const settings: EncodeSettings = {
  container: 'webm',
  video: {
    encoder: 'svtAv1',
    rate: { mode: 'quality', value: 40 },
    twoPass: false,
    speed: 'medium',
    bitDepth: 'ten',
    fps: { mode: 'source' },
    resolution: { mode: 'source' },
    crop: { mode: 'none' },
    hdr: 'keep',
    filmGrain: 8,
  },
  audio: { codec: 'aac', bitrateKbps: 160, mixdown: 'source' },
  subtitles: 'copyAll',
  filters: { denoise: 'off', deinterlace: 'off', rotate: 'none', flipH: false, flipV: false, sharpen: 'off' },
  keepChapters: true,
  keepMetadata: true,
};

const media = { duration: 600 } as MediaInfo;
const spec = (trim: JobSpec['trim']): JobSpec => ({
  input: 'in.mkv', output: 'out.mp4', settings, audioTracks: [], subtitleTracks: [], trim, autoCrop: null, extraInputs: [],
});

describe('quality slider', () => {
  it('puts better quality on the right', () => {
    expect(sliderFromQuality(x264, 0)).toBe(100);
    expect(sliderFromQuality(x264, 51)).toBe(0);
    expect(qualityFromSlider(x264, 100)).toBe(0);
    expect(qualityFromSlider(x264, 0)).toBe(51);
  });
  it('round-trips every native value', () => {
    for (const info of [x264, svt, nvenc]) {
      for (let q = info.qualityMin; q <= info.qualityMax; q++) {
        expect(qualityFromSlider(info, sliderFromQuality(info, q))).toBe(q);
      }
    }
  });
  it('clamps out-of-range input', () => {
    expect(sliderFromQuality(svt, 999)).toBe(0);
    expect(qualityFromSlider(svt, -20)).toBe(63);
    expect(qualityFromSlider(svt, 500)).toBe(1);
  });
});

describe('translateQuality', () => {
  it('maps defaults to defaults', () => {
    expect(translateQuality(x264, svt, 23)).toBe(32);
    expect(translateQuality(svt, x264, 32)).toBe(23);
  });
  it('keeps the same distance from the default, scaled to the new range', () => {
    // 5 steps better than default on x264 (51-wide) → about 6 steps on SVT (62-wide).
    expect(translateQuality(x264, svt, 18)).toBe(26);
  });
  it('never leaves the target range', () => {
    expect(translateQuality(svt, x264, 63)).toBeLessThanOrEqual(51);
    expect(translateQuality(svt, nvenc, 1)).toBeGreaterThanOrEqual(1);
    expect(translateQuality(undefined, x264, 99)).toBe(51);
  });
});

describe('switchEncoder', () => {
  it('repairs everything the new encoder cannot do', () => {
    const next = switchEncoder(settings, svt, nvenc);
    expect(next.video.encoder).toBe('h264Nvenc');
    expect(next.video.filmGrain).toBe(0); // no film grain outside SVT-AV1
    expect(next.video.bitDepth).toBe('auto'); // H.264 NVENC is 8-bit only
    expect(next.container).toBe('mp4'); // H.264 cannot go in WebM
    expect(next.video.rate).toEqual({ mode: 'quality', value: 31 });
  });
  it('drops two-pass when unsupported and leaves bitrates alone', () => {
    const sized: EncodeSettings = { ...settings, container: 'mp4', video: { ...settings.video, encoder: 'x264', rate: { mode: 'targetSize', mb: 25 }, twoPass: true } };
    const next = switchEncoder(sized, x264, svt);
    expect(next.video.twoPass).toBe(false);
    expect(next.video.rate).toEqual({ mode: 'targetSize', mb: 25 });
    expect(next.container).toBe('mp4');
  });
  it('does not mutate its input', () => {
    const before = JSON.stringify(settings);
    switchEncoder(settings, svt, x264);
    expect(JSON.stringify(settings)).toBe(before);
  });
});

describe('summaries', () => {
  it('describes rate control in words', () => {
    expect(rateSummary({ mode: 'quality', value: 28 }, nvenc)).toBe('CQ 28');
    expect(rateSummary({ mode: 'bitrate', kbps: 800 }, x264)).toBe('800 kbps');
    expect(rateSummary({ mode: 'bitrate', kbps: 2500 }, x264)).toBe('2.5 Mbps');
    expect(rateSummary({ mode: 'targetSize', mb: 25 }, x264)).toBe('fit in 25 MB');
    expect(rateSummary({ mode: 'targetSize', mb: 2048 }, x264)).toBe('fit in 2.0 GB');
  });
  it('describes whole settings', () => {
    expect(describeSettings(settings, caps)).toBe('AV1, CRF 40, WebM');
    const gpu: EncodeSettings = { ...settings, container: 'mp4', video: { ...settings.video, encoder: 'h264Nvenc', rate: { mode: 'quality', value: 25 }, resolution: { mode: 'height', value: 720 } } };
    expect(describeSettings(gpu, caps)).toBe('H.264 on GPU, CQ 25, 720p, MP4');
  });
  it('still reads when capabilities are unknown', () => {
    expect(describeSettings(settings, null)).toBe('svtAv1, Quality 40, WebM');
  });
});

describe('geometry helpers', () => {
  it('offers only heights that shrink the source', () => {
    expect(heightChoices(1080)).toEqual([720, 480, 360]);
    expect(heightChoices(2160)).toEqual([1440, 1080, 720, 480, 360]);
    expect(heightChoices(360)).toEqual([]);
  });
  it('changes the redraw key only for picture changes', () => {
    const a = spec(null);
    const trimmed = spec({ start: 5, end: 50 });
    expect(geometryKey(a)).toBe(geometryKey(trimmed));
    const rotated = { ...a, settings: { ...settings, filters: { ...settings.filters, rotate: 'cw90' as const } } };
    expect(geometryKey(a)).not.toBe(geometryKey(rotated));
    const requality = { ...a, settings: { ...settings, video: { ...settings.video, rate: { mode: 'quality' as const, value: 20 } } } };
    expect(geometryKey(a)).toBe(geometryKey(requality));
  });
});

describe('trim maths', () => {
  it('measures the kept duration', () => {
    expect(jobDuration(spec(null), media)).toBe(600);
    expect(jobDuration(spec({ start: 60, end: 90 }), media)).toBe(30);
    // An end of 0 means "to the end".
    expect(jobDuration(spec({ start: 500, end: 0 }), media)).toBe(100);
    // Values past the end are clamped; an empty trim is ignored.
    expect(jobDuration(spec({ start: 550, end: 9999 }), media)).toBe(50);
    expect(jobDuration(spec({ start: 10, end: 10 }), media)).toBe(600);
  });
  it('reports scrub bounds', () => {
    expect(trimBounds(spec(null), media)).toEqual([0, 600]);
    expect(trimBounds(spec({ start: 60, end: 90 }), media)).toEqual([60, 90]);
  });
});

describe('sameSettings', () => {
  it('compares by value', () => {
    expect(sameSettings(settings, JSON.parse(JSON.stringify(settings)))).toBe(true);
    expect(sameSettings(settings, { ...settings, keepChapters: false })).toBe(false);
  });
});
