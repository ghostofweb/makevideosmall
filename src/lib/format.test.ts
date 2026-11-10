import { describe, expect, it } from 'vitest';
import {
  baseName,
  bitrate,
  bytes,
  channels,
  clock,
  dirName,
  fps,
  language,
  parseClock,
  preciseClock,
  savings,
  savingsLabel,
  span,
  withExtension,
} from './format';

describe('bytes', () => {
  it('picks a sensible unit and precision', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.50 KB');
    expect(bytes(15 * 1024)).toBe('15.0 KB');
    expect(bytes(230 * 1024 * 1024)).toBe('230 MB');
    expect(bytes(1.25 * 1024 ** 3)).toBe('1.25 GB');
  });
  it('shows a dash for unknown sizes', () => {
    expect(bytes(null)).toBe('—');
    expect(bytes(undefined)).toBe('—');
    expect(bytes(Number.NaN)).toBe('—');
    expect(bytes(-1)).toBe('—');
  });
});

describe('clock', () => {
  it('formats with and without hours', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(62)).toBe('1:02');
    expect(clock(3723.9)).toBe('1:02:03');
    expect(clock(null)).toBe('—');
  });
  it('keeps tenths for trim points', () => {
    expect(preciseClock(12)).toBe('0:12.0');
    expect(preciseClock(83.46)).toBe('1:23.5');
    // Rounding up must carry into the seconds, not print ".10".
    expect(preciseClock(59.97)).toBe('1:00.0');
  });
});

describe('parseClock', () => {
  it('reads seconds, m:ss and h:mm:ss', () => {
    expect(parseClock('12')).toBe(12);
    expect(parseClock('0:12')).toBe(12);
    expect(parseClock('1:23.5')).toBe(83.5);
    expect(parseClock(' 1:02:03 ')).toBe(3723);
  });
  it('rejects anything else', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('1::2')).toBeNull();
    expect(parseClock('-5')).toBeNull();
    expect(parseClock('1:2:3:4')).toBeNull();
  });
  it('round-trips with preciseClock', () => {
    for (const t of [0, 0.5, 59.9, 60, 3599.9, 7325.3]) {
      expect(parseClock(preciseClock(t))).toBeCloseTo(t, 5);
    }
  });
});

describe('span', () => {
  it('uses the largest useful unit', () => {
    expect(span(0.2)).toBe('1 s');
    expect(span(45)).toBe('45 s');
    expect(span(192)).toBe('3 min');
    expect(span(3600)).toBe('1 h');
    expect(span(4000)).toBe('1 h 7 min');
    expect(span(null)).toBe('—');
  });
});

describe('savings', () => {
  it('reports shrinkage, growth and no change', () => {
    expect(savings(1000, 250)).toBe(75);
    expect(savingsLabel(1000, 250)).toBe('75% smaller');
    expect(savingsLabel(1000, 1200)).toBe('20% larger');
    expect(savingsLabel(1000, 1000)).toBe('same size');
    expect(savings(0, 500)).toBe(0);
  });
});

describe('media labels', () => {
  it('formats bitrates', () => {
    expect(bitrate(128_000)).toBe('128 kbps');
    expect(bitrate(2_500_000)).toBe('2.5 Mbps');
    expect(bitrate(12_000_000)).toBe('12 Mbps');
    expect(bitrate(0)).toBe('—');
  });
  it('formats frame rates', () => {
    expect(fps(30)).toBe('30');
    expect(fps(23.976023976)).toBe('23.976');
    expect(fps(29.97)).toBe('29.97');
    expect(fps(0)).toBe('—');
  });
  it('names channel layouts and languages', () => {
    expect(channels(2)).toBe('Stereo');
    expect(channels(6)).toBe('5.1');
    expect(channels(4)).toBe('4 ch');
    expect(language('eng')).toBe('English');
    expect(language('HIN')).toBe('Hindi');
    expect(language('xyz')).toBe('XYZ');
    expect(language(null)).toBe('Unknown language');
  });
});

describe('paths', () => {
  it('splits Windows and POSIX paths', () => {
    expect(baseName('C:\\Videos\\My clip.mkv')).toBe('My clip.mkv');
    expect(baseName('/home/me/a.mp4')).toBe('a.mp4');
    expect(dirName('C:\\Videos\\My clip.mkv')).toBe('C:\\Videos');
    expect(dirName('clip.mkv')).toBe('');
  });
  it('swaps extensions without touching dots in folder names', () => {
    expect(withExtension('C:\\a.b\\clip.mkv', 'mp4')).toBe('C:\\a.b\\clip.mp4');
    expect(withExtension('C:\\a.b\\clip', 'mp4')).toBe('C:\\a.b\\clip.mp4');
    expect(withExtension('clip.final.mov', 'webm')).toBe('clip.final.webm');
  });
});
