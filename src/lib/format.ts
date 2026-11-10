// Pure formatting helpers. No DOM, no IPC — unit-tested in format.test.ts.

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 3723.4 → "1:02:03", 62 → "1:02" */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Like `clock`, with tenths — for trim points. */
export function preciseClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const tenths = Math.round(seconds * 10);
  const whole = Math.floor(tenths / 10);
  return `${clock(whole)}.${tenths % 10}`;
}

/** "1:02:03.5", "62.5" or "1:02" → seconds. Returns null when unreadable. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => p.trim() === '')) return null;
  let total = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return null;
    total = total * 60 + value;
  }
  return total;
}

/** 192 → "3 min", 45 → "45 s", 4000 → "1 h 7 min" */
export function span(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Percent smaller than the source; negative means the file grew. */
export function savings(sourceBytes: number, outputBytes: number): number {
  if (!(sourceBytes > 0)) return 0;
  return Math.round((1 - outputBytes / sourceBytes) * 100);
}

export function savingsLabel(sourceBytes: number, outputBytes: number): string {
  const pct = savings(sourceBytes, outputBytes);
  if (pct > 0) return `${pct}% smaller`;
  if (pct < 0) return `${-pct}% larger`;
  return 'same size';
}

export function bitrate(bitsPerSecond: number): string {
  if (!(bitsPerSecond > 0)) return '—';
  const kbps = bitsPerSecond / 1000;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10000 ? 0 : 1)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function fps(value: number): string {
  if (!(value > 0)) return '—';
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(rounded * 100 === Math.round(rounded * 100) ? 2 : 3);
}

/** File name without its folder. Handles both slash styles. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return index <= 0 ? '' : path.slice(0, index);
}

/** Swap a path's extension: ("a/b.mkv", "mp4") → "a/b.mp4" */
export function withExtension(path: string, ext: string): string {
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const dot = path.lastIndexOf('.');
  const stem = dot > slash ? path.slice(0, dot) : path;
  return `${stem}.${ext}`;
}

const LANGUAGES: Record<string, string> = {
  eng: 'English', en: 'English', hin: 'Hindi', hi: 'Hindi', spa: 'Spanish', es: 'Spanish', fre: 'French',
  fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian',
  jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic',
  pan: 'Punjabi', pa: 'Punjabi', tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu', ben: 'Bengali',
  bn: 'Bengali', urd: 'Urdu', ur: 'Urdu', tur: 'Turkish', tr: 'Turkish', nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
};

export function language(code: string | null | undefined): string {
  if (!code) return 'Unknown language';
  return LANGUAGES[code.toLowerCase()] ?? code.toUpperCase();
}

export function channels(count: number): string {
  if (count === 1) return 'Mono';
  if (count === 2) return 'Stereo';
  if (count === 6) return '5.1';
  if (count === 8) return '7.1';
  return `${count} ch`;
}
