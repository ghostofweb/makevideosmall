// Files the user is setting up, before they are sent to the queue.

import { create } from 'zustand';
import { toast } from 'sonner';
import { api, errorText } from '@/lib/ipc';
import { jobDuration } from '@/lib/spec';
import { useApp } from './app';
import type { AnalysisProgress, Container, EasyAnalysis, Estimate, Job, JobSpec, MediaInfo, Preset, SourceAnalysis, Trim } from '@/lib/types';

export type TaskState = 'idle' | 'running' | 'failed';

export interface Source {
  id: string;
  /** For joined videos this describes the whole result. */
  media: MediaInfo;
  spec: JobSpec;
  /** Preset the settings came from; null once they have been changed by hand. */
  presetId: string | null;
  /** Simple choice in use ("best" | "balanced" | "smallest"); null for hand-tuned settings. */
  choice: string | null;
  /** The person picked the choice themselves, so a suggestion must not replace it. */
  pickedByUser: boolean;
  /** The user picked the output path, so it must not be regenerated. */
  customOutput: boolean;
  thumb: string | null;
  analysis: SourceAnalysis | null;
  analysisState: TaskState;
  estimate: Estimate | null;
  estimateState: TaskState;
  /** Result of trying the three simple choices on this video. */
  easy: EasyAnalysis | null;
  easyState: TaskState;
  easyStage: string;
  easyProgress: number;
  easyError: string | null;
}

interface SourcesState {
  sources: Source[];
  selectedId: string | null;
  /** Ticked files, in the order they were ticked (that is the join order). */
  checked: string[];
  /** Files still being read. */
  loading: number;

  addPaths: (paths: string[]) => Promise<void>;
  addFromJob: (job: Job) => Promise<void>;
  remove: (ids: string[]) => void;
  select: (id: string | null) => void;
  toggle: (id: string) => void;
  checkAll: (on: boolean) => void;
  /** Change a file's settings by hand (the detailed controls). */
  edit: (id: string, change: (spec: JobSpec) => JobSpec) => void;
  /** Keep only part of the video. Belongs to the file, not to a choice or preset. */
  setTrim: (id: string, trim: Trim | null) => void;
  setContainer: (id: string, container: Container) => Promise<void>;
  setOutput: (id: string, output: string) => void;
  applyPreset: (ids: string[], preset: Preset) => Promise<void>;
  /** Use one of the three simple choices. */
  pickChoice: (id: string, choiceId: string, byUser?: boolean) => Promise<void>;
  /** Try the three simple choices on this video and suggest one. */
  analyzeEasy: (id: string) => Promise<void>;
  onEasyProgress: (p: AnalysisProgress) => void;
  /** Turn several files into one job that plays them one after another. */
  join: (ids: string[]) => Promise<void>;
  analyze: (id: string) => Promise<void>;
  estimate: (id: string) => Promise<void>;
  cancelEstimate: (id: string) => void;
  queue: (ids: string[]) => Promise<boolean>;
  restore: () => Promise<void>;
}

const STORAGE_KEY = 'mvs.sources.v2';
let counter = 0;
const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

export const isJoined = (source: Pick<Source, 'spec'>) => (source.spec.extraInputs?.length ?? 0) > 0;

function patch(state: SourcesState, id: string, change: Partial<Source>): Partial<SourcesState> {
  return { sources: state.sources.map((s) => (s.id === id ? { ...s, ...change } : s)) };
}

function otherOutputs(sources: Source[], except?: string): string[] {
  return sources.filter((s) => s.id !== except).map((s) => s.spec.output);
}

/** An estimate for a different length of the same video. */
export function scaleEstimate(estimate: Estimate, factor: number): Estimate {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return estimate;
  return { ...estimate, sizeBytes: estimate.sizeBytes * factor, encodeSecs: estimate.encodeSecs * factor };
}

/** Run tasks a few at a time, in order. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        await work(items[next++]);
      }
    }),
  );
}

async function loadThumb(id: string, spec: JobSpec, media: MediaInfo) {
  try {
    const at = Math.min(media.duration * 0.15, 20);
    const thumb = await api.renderFrame({ ...spec, extraInputs: [] }, at, 320);
    useSources.setState((s) => patch(s, id, { thumb }));
  } catch {
    // A missing thumbnail is not worth interrupting anyone for.
  }
}

function fresh(media: MediaInfo, spec: JobSpec, presetId: string | null, choice: string | null): Source {
  return {
    id: newId(),
    media,
    spec: { ...spec, extraInputs: spec.extraInputs ?? [] },
    presetId,
    choice,
    pickedByUser: false,
    customOutput: false,
    thumb: null,
    analysis: null,
    analysisState: 'idle',
    estimate: null,
    estimateState: 'idle',
    easy: null,
    easyState: 'idle',
    easyStage: '',
    easyProgress: 0,
    easyError: null,
  };
}

/** Settings a newly added file starts with, and how they are labelled. */
function startingPoint(): { settings: JobSpec['settings']; presetId: string | null; choice: string | null } | null {
  const app = useApp.getState();
  const balanced = app.easyOptions.find((o) => o.id === 'balanced');
  if (!app.settings.advancedMode && balanced) return { settings: balanced.settings, presetId: null, choice: 'balanced' };
  const preset = app.defaultPreset();
  if (preset) return { settings: preset.settings, presetId: preset.id, choice: null };
  return balanced ? { settings: balanced.settings, presetId: null, choice: 'balanced' } : null;
}

/** Keep what belongs to the file when its settings are replaced wholesale. */
function carryOver(source: Source, made: JobSpec): JobSpec {
  const joined = isJoined(source);
  return {
    ...made,
    trim: source.spec.trim,
    autoCrop: source.spec.autoCrop,
    extraInputs: source.spec.extraInputs ?? [],
    audioTracks: joined ? made.audioTracks.slice(0, 1) : made.audioTracks,
    subtitleTracks: joined ? [] : made.subtitleTracks,
    output: source.customOutput ? source.spec.output.replace(/\.[^.\\/]+$/, `.${made.settings.container}`) : made.output,
  };
}

export const useSources = create<SourcesState>((set, get) => ({
  sources: [],
  selectedId: null,
  checked: [],
  loading: 0,

  addPaths: async (paths) => {
    const start = startingPoint();
    if (!start) {
      toast.error('This PC has no video encoder the app can use.');
      return;
    }
    const files = await api.expandPaths(paths, 'video');
    const known = new Set(get().sources.filter((s) => !isJoined(s)).map((s) => s.media.path.toLowerCase()));
    const incoming = files.filter((f) => !known.has(f.toLowerCase()));
    if (incoming.length === 0) {
      toast.info(files.length === 0 ? 'No video files were found there.' : 'Those files are already in the list.');
      return;
    }

    set((s) => ({ loading: s.loading + incoming.length }));
    const failures: string[] = [];
    await pool(incoming, 3, async (path) => {
      try {
        const media = await api.probeMedia(path);
        if (!media.video) throw 'This file has no video in it.';
        const spec = await api.makeSpec(path, start.settings, otherOutputs(get().sources));
        const source = fresh(media, spec, start.presetId, start.choice);
        set((s) => ({
          sources: [...s.sources, source],
          selectedId: s.selectedId ?? source.id,
          loading: s.loading - 1,
        }));
        void loadThumb(source.id, spec, media);
      } catch (e) {
        failures.push(`${path.split(/[\\/]/).pop()}: ${errorText(e)}`);
        set((s) => ({ loading: s.loading - 1 }));
      }
    });
    if (failures.length > 0) {
      toast.error(`${failures.length} file${failures.length === 1 ? '' : 's'} could not be added`, {
        description: failures.slice(0, 3).join('\n'),
      });
    }
  },

  // "Change settings" on a queued job: bring it back with every setting intact.
  addFromJob: async (job) => {
    try {
      const media = (job.spec.extraInputs?.length ?? 0) > 0 ? await api.joinInfo(job.spec) : await api.probeMedia(job.spec.input);
      const source = { ...fresh(media, job.spec, null, null), customOutput: true, pickedByUser: true };
      set((s) => ({ sources: [...s.sources, source], selectedId: source.id }));
      void loadThumb(source.id, job.spec, media);
    } catch (e) {
      toast.error('That file can no longer be read.', { description: errorText(e) });
    }
  },

  remove: (ids) => {
    for (const id of ids) {
      api.cancelAnalysis(`estimate-${id}`).catch(() => {});
      api.cancelAnalysis(`easy-${id}`).catch(() => {});
    }
    set((s) => {
      const sources = s.sources.filter((x) => !ids.includes(x.id));
      const selectedId = s.selectedId && ids.includes(s.selectedId) ? (sources[0]?.id ?? null) : s.selectedId;
      return { sources, selectedId, checked: s.checked.filter((c) => !ids.includes(c)) };
    });
  },

  select: (selectedId) => set({ selectedId }),

  toggle: (id) =>
    set((s) => ({ checked: s.checked.includes(id) ? s.checked.filter((c) => c !== id) : [...s.checked, id] })),

  checkAll: (on) => set((s) => ({ checked: on ? s.sources.map((x) => x.id) : [] })),

  edit: (id, change) =>
    set((s) => ({
      sources: s.sources.map((x) =>
        // Any manual change makes the old estimate stale and the settings "custom".
        x.id === id
          ? { ...x, spec: change(x.spec), presetId: null, choice: null, pickedByUser: true, estimate: null, estimateState: 'idle' }
          : x,
      ),
    })),

  setTrim: (id, trim) =>
    set((s) => ({
      sources: s.sources.map((x) => {
        if (x.id !== id) return x;
        const spec = { ...x.spec, trim };
        // The size scales with the length that is kept.
        const tried = x.easy?.choices.find((c) => c.id === x.choice);
        const estimate = tried
          ? scaleEstimate(tried.estimate, jobDuration(spec, x.media) / jobDuration(tried.spec, x.media))
          : x.estimate
            ? scaleEstimate(x.estimate, jobDuration(spec, x.media) / jobDuration(x.spec, x.media))
            : null;
        return { ...x, spec, estimate };
      }),
    })),

  setContainer: async (id, container) => {
    const source = get().sources.find((s) => s.id === id);
    if (!source) return;
    get().edit(id, (spec) => ({ ...spec, settings: { ...spec.settings, container } }));
    const output = source.customOutput
      ? source.spec.output.replace(/\.[^.\\/]+$/, `.${container}`)
      : await api.outputFor(source.spec.input, container, otherOutputs(get().sources, id));
    set((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, spec: { ...x.spec, output } } : x)) }));
  },

  setOutput: (id, output) =>
    set((s) => ({
      sources: s.sources.map((x) => (x.id === id ? { ...x, spec: { ...x.spec, output }, customOutput: true } : x)),
    })),

  applyPreset: async (ids, preset) => {
    for (const id of ids) {
      const source = get().sources.find((s) => s.id === id);
      if (!source) continue;
      try {
        const made = await api.makeSpec(source.spec.input, preset.settings, otherOutputs(get().sources, id));
        set((s) =>
          patch(s, id, { spec: carryOver(source, made), presetId: preset.id, choice: null, pickedByUser: true, estimate: null, estimateState: 'idle' }),
        );
      } catch (e) {
        toast.error(`Could not apply "${preset.name}"`, { description: errorText(e) });
      }
    }
  },

  pickChoice: async (id, choiceId, byUser = true) => {
    const source = get().sources.find((s) => s.id === id);
    if (!source) return;
    const tried = source.easy?.choices.find((c) => c.id === choiceId);
    try {
      let spec: JobSpec;
      let estimate: Estimate | null = null;
      if (tried) {
        // Already tried on this video: the spec includes the black-bar crop.
        spec = {
          ...tried.spec,
          extraInputs: [],
          trim: source.spec.trim,
          output: source.customOutput ? source.spec.output : tried.spec.output,
        };
        estimate = scaleEstimate(tried.estimate, jobDuration(spec, source.media) / jobDuration(tried.spec, source.media));
      } else {
        const option = useApp.getState().easyOptions.find((o) => o.id === choiceId);
        if (!option) return;
        const made = await api.makeSpec(source.spec.input, option.settings, otherOutputs(get().sources, id));
        spec = carryOver(source, made);
      }
      set((s) =>
        patch(s, id, { spec, choice: choiceId, presetId: null, estimate, estimateState: 'idle', pickedByUser: source.pickedByUser || byUser }),
      );
    } catch (e) {
      toast.error('Could not use that choice', { description: errorText(e) });
    }
  },

  analyzeEasy: async (id) => {
    const source = get().sources.find((s) => s.id === id);
    if (!source || source.easyState === 'running' || isJoined(source)) return;
    // One at a time: two checks running together would slow each other down
    // and make every "takes about" figure too high. The other one starts over
    // when its video is looked at again.
    for (const other of get().sources) {
      if (other.id !== id && other.easyState === 'running') api.cancelAnalysis(`easy-${other.id}`).catch(() => {});
    }
    set((s) => patch(s, id, { easyState: 'running', easyStage: 'Starting', easyProgress: 0, easyError: null }));
    try {
      const easy = await api.easyAnalyze(source.spec, `easy-${id}`);
      const now = get().sources.find((s) => s.id === id);
      if (!now) return;
      set((s) => patch(s, id, { easy, easyState: 'idle', analysis: easy.analysis }));
      // Still on a simple choice: switch to the measured version of it, or to
      // the suggestion if the person has not chosen for themselves.
      if (now.choice !== null) {
        await get().pickChoice(id, now.pickedByUser ? now.choice : easy.recommended, false);
      }
    } catch (e) {
      const text = errorText(e);
      set((s) => patch(s, id, text === 'Cancelled' ? { easyState: 'idle' } : { easyState: 'failed', easyError: text }));
    }
  },

  onEasyProgress: (p) => {
    if (!p.token.startsWith('easy-')) return;
    set((s) => patch(s, p.token.slice(5), { easyStage: p.stage, easyProgress: p.progress }));
  },

  join: async (ids) => {
    const all = get().sources;
    const chosen = ids.map((id) => all.find((s) => s.id === id)).filter((s): s is Source => !!s);
    if (chosen.length < 2) return;
    if (chosen.some(isJoined)) {
      toast.error('One of these is already a joined video. Untick it and try again.');
      return;
    }
    const balanced = useApp.getState().easyOptions.find((o) => o.id === 'balanced');
    const settings = useApp.getState().settings.advancedMode || !balanced ? chosen[0].spec.settings : balanced.settings;
    try {
      const made = await api.joinSpec(
        chosen.map((s) => s.media.path),
        settings,
        all.filter((s) => !ids.includes(s.id)).map((s) => s.spec.output),
      );
      const source: Source = {
        ...fresh(made.media, made.spec, null, useApp.getState().settings.advancedMode ? null : 'balanced'),
        customOutput: true,
        thumb: chosen[0].thumb,
      };
      for (const id of ids) api.cancelAnalysis(`easy-${id}`).catch(() => {});
      set((s) => {
        const at = s.sources.findIndex((x) => x.id === ids[0]);
        const rest = s.sources.filter((x) => !ids.includes(x.id));
        rest.splice(Math.min(Math.max(at, 0), rest.length), 0, source);
        return { sources: rest, selectedId: source.id, checked: [] };
      });
      toast.success(`${chosen.length} videos will be joined into one`);
    } catch (e) {
      toast.error('Those videos cannot be joined', { description: errorText(e) });
    }
  },

  analyze: async (id) => {
    const source = get().sources.find((s) => s.id === id);
    if (!source) return;
    set((s) => patch(s, id, { analysisState: 'running' }));
    try {
      const analysis = await api.analyzeSource(source.spec.input, `analyze-${id}`);
      set((s) => patch(s, id, { analysis, analysisState: 'idle' }));
    } catch (e) {
      set((s) => patch(s, id, { analysisState: 'failed' }));
      if (errorText(e) !== 'Cancelled') toast.error('Could not check the video', { description: errorText(e) });
    }
  },

  estimate: async (id) => {
    const source = get().sources.find((s) => s.id === id);
    if (!source) return;
    set((s) => patch(s, id, { estimateState: 'running' }));
    const asked = source.spec;
    try {
      const estimate = await api.estimateSpec(asked, `estimate-${id}`);
      // Drop the answer if the settings changed while it was being worked out.
      set((s) => {
        const now = s.sources.find((x) => x.id === id);
        return now && now.spec === asked ? patch(s, id, { estimate, estimateState: 'idle' }) : {};
      });
    } catch (e) {
      set((s) => patch(s, id, { estimateState: errorText(e) === 'Cancelled' ? 'idle' : 'failed' }));
      if (errorText(e) !== 'Cancelled') toast.error('Could not estimate the size', { description: errorText(e) });
    }
  },

  cancelEstimate: (id) => {
    api.cancelAnalysis(`estimate-${id}`).catch(() => {});
    set((s) => patch(s, id, { estimateState: 'idle' }));
  },

  queue: async (ids) => {
    const chosen = get().sources.filter((s) => ids.includes(s.id));
    if (chosen.length === 0) return false;
    try {
      await api.queueAdd(chosen.map((s) => s.spec));
      get().remove(ids);
      return true;
    } catch (e) {
      toast.error('Could not add to the queue', { description: errorText(e) });
      return false;
    }
  },

  restore: async () => {
    type Saved = { spec: JobSpec; presetId: string | null; choice: string | null; customOutput: boolean; pickedByUser: boolean };
    let saved: Saved[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      saved = [];
    }
    if (!Array.isArray(saved) || saved.length === 0) return;
    set((s) => ({ loading: s.loading + saved.length }));
    await pool(saved, 3, async (item) => {
      try {
        const spec = { ...item.spec, extraInputs: item.spec.extraInputs ?? [] };
        const media = spec.extraInputs.length > 0 ? await api.joinInfo(spec) : await api.probeMedia(spec.input);
        const source = {
          ...fresh(media, spec, item.presetId, item.choice ?? null),
          customOutput: !!item.customOutput,
          pickedByUser: !!item.pickedByUser,
        };
        set((s) => ({ sources: [...s.sources, source], selectedId: s.selectedId ?? source.id, loading: s.loading - 1 }));
        void loadThumb(source.id, spec, media);
      } catch {
        // The file was moved or deleted since last time; quietly forget it.
        set((s) => ({ loading: s.loading - 1 }));
      }
    });
  },
}));

// Remember the list between launches.
useSources.subscribe((state, previous) => {
  if (state.sources === previous.sources) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        state.sources.map((s) => ({
          spec: s.spec,
          presetId: s.presetId,
          choice: s.choice,
          customOutput: s.customOutput,
          pickedByUser: s.pickedByUser,
        })),
      ),
    );
  } catch {
    // Storage being unavailable only costs the convenience of restoring the list.
  }
});

// The simple choices change when "use the graphics card" is switched: earlier
// measurements no longer apply, so forget them and re-apply each file's choice.
useApp.subscribe((state, previous) => {
  if (state.easyOptions === previous.easyOptions || previous.easyOptions.length === 0) return;
  const { sources, pickChoice } = useSources.getState();
  for (const source of sources) api.cancelAnalysis(`easy-${source.id}`).catch(() => {});
  useSources.setState((s) => ({ sources: s.sources.map((x) => ({ ...x, easy: null, easyState: 'idle' as const, easyError: null })) }));
  for (const source of sources) {
    if (source.choice) void pickChoice(source.id, source.choice, false);
  }
});
