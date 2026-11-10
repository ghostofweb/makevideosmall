// Typed bridge to the Rust core. Every call the UI makes goes through here.

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AnalysisProgress,
  AppSettings,
  Bootstrap,
  CapsChanged,
  CommandPreview,
  Container,
  EasyAnalysis,
  EasyOption,
  EncodeSettings,
  Estimate,
  ImageEvent,
  ImageFormat,
  ImageInfo,
  ImageJob,
  JobLogLine,
  JobProgress,
  JobSpec,
  Joined,
  MediaInfo,
  Preset,
  PreviewPair,
  QueueFinished,
  QueueSnapshot,
  SourceAnalysis,
  SystemStats,
} from './types';

export const api = {
  bootstrap: () => invoke<Bootstrap>('bootstrap'),

  expandPaths: (paths: string[], kind: 'video' | 'image') => invoke<string[]>('expand_paths', { paths, kind }),
  probeMedia: (path: string) => invoke<MediaInfo>('probe_media', { path }),
  makeSpec: (path: string, settings: EncodeSettings, alsoTaken: string[]) =>
    invoke<JobSpec>('make_spec', { path, settings, alsoTaken }),
  outputFor: (input: string, container: Container, alsoTaken: string[]) =>
    invoke<string>('output_for', { input, container, alsoTaken }),
  commandPreview: (spec: JobSpec) => invoke<CommandPreview>('command_preview', { spec }),

  easyOptions: () => invoke<EasyOption[]>('easy_options_list'),
  easyAnalyze: (base: JobSpec, token: string) => invoke<EasyAnalysis>('easy_analyze', { base, token }),
  joinSpec: (paths: string[], settings: EncodeSettings, alsoTaken: string[]) =>
    invoke<Joined>('join_spec', { paths, settings, alsoTaken }),
  joinInfo: (spec: JobSpec) => invoke<MediaInfo>('join_info', { spec }),

  presetsList: () => invoke<Preset[]>('presets_list'),
  presetSave: (preset: Preset) => invoke<Preset>('preset_save', { preset }),
  presetDelete: (id: string) => invoke<void>('preset_delete', { id }),
  presetsExport: (ids: string[], file: string) => invoke<number>('presets_export', { ids, file }),
  presetsImport: (file: string) => invoke<Preset[]>('presets_import', { file }),

  queueSnapshot: () => invoke<QueueSnapshot>('queue_snapshot'),
  queueAdd: (specs: JobSpec[]) => invoke<string[]>('queue_add', { specs }),
  queueRemove: (ids: string[]) => invoke<void>('queue_remove', { ids }),
  queueMove: (id: string, index: number) => invoke<void>('queue_move', { id, index }),
  queueRetry: (id: string) => invoke<void>('queue_retry', { id }),
  queueCancel: (id: string) => invoke<void>('queue_cancel', { id }),
  queueStart: () => invoke<void>('queue_start'),
  queuePause: () => invoke<void>('queue_pause'),
  queueResume: () => invoke<void>('queue_resume'),
  queueStop: () => invoke<void>('queue_stop'),
  queueClearFinished: () => invoke<void>('queue_clear_finished'),
  jobLog: (id: string) => invoke<string[]>('job_log', { id }),

  analyzeSource: (path: string, token: string) => invoke<SourceAnalysis>('analyze_source', { path, token }),
  estimateSpec: (spec: JobSpec, token: string) => invoke<Estimate>('estimate_spec', { spec, token }),
  renderPreview: (spec: JobSpec, at: number, length: number, token: string) =>
    invoke<PreviewPair>('render_preview', { spec, at, length, token }),
  renderFrame: (spec: JobSpec, at: number, maxWidth: number) =>
    invoke<string>('render_frame', { spec, at, maxWidth }),
  cancelAnalysis: (token: string) => invoke<void>('cancel_analysis', { token }),

  settingsSet: (settings: AppSettings) => invoke<AppSettings>('settings_set', { settings }),

  imageProbe: (path: string) => invoke<ImageInfo>('image_probe', { path }),
  imageOutputFor: (args: {
    input: string;
    format: ImageFormat;
    suffix: string;
    dir: string | null;
    name: string | null;
    alsoTaken: string[];
  }) => invoke<string>('image_output_for', args),
  imageStart: (jobs: ImageJob[]) => invoke<void>('image_start', { jobs }),
  imageCancel: () => invoke<void>('image_cancel'),

  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  openPath: (path: string) => invoke<void>('open_path', { path }),
  trashPath: (path: string) => invoke<void>('trash_path', { path }),
  pathExists: (path: string) => invoke<boolean>('path_exists', { path }),
  shutdownPc: () => invoke<void>('shutdown_pc'),
};

/** Events the core pushes to the UI. */
export interface CoreEvents {
  'queue:changed': QueueSnapshot;
  'queue:finished': QueueFinished;
  'job:progress': JobProgress;
  'job:log': JobLogLine;
  'analysis:progress': AnalysisProgress;
  'system:stats': SystemStats;
  'caps:changed': CapsChanged;
  'image:event': ImageEvent;
  'image:batch-done': boolean;
}

export function on<K extends keyof CoreEvents>(event: K, handler: (payload: CoreEvents[K]) => void): Promise<UnlistenFn> {
  return listen<CoreEvents[K]>(event, (e) => handler(e.payload));
}

/** URL the web view can load a local file from. `bust` defeats caching. */
export function fileUrl(path: string, bust?: string | number): string {
  const url = convertFileSrc(path);
  return bust === undefined ? url : `${url}?v=${bust}`;
}

/** Errors from the core arrive as plain strings. */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
