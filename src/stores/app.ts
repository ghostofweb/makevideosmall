// App-wide state: what the machine can do, settings, presets.

import { create } from 'zustand';
import { api, errorText } from '@/lib/ipc';
import { useQueue } from './queue';
import type { AppSettings, Capabilities, EasyOption, EncoderInfo, Preset, SystemStats, VideoEncoder } from '@/lib/types';

export type Mode = 'video' | 'image';

interface AppState {
  ready: boolean;
  /** The core could not start at all. */
  failed: string | null;
  version: string;
  caps: Capabilities | null;
  /** Encoding is unavailable (ffmpeg missing) and why. */
  problem: string | null;
  settings: AppSettings;
  presets: Preset[];
  /** The three choices of the simple view, tuned for this PC. */
  easyOptions: EasyOption[];
  startupFiles: string[];
  mode: Mode;
  settingsOpen: boolean;
  stats: SystemStats | null;

  init: () => Promise<void>;
  setMode: (mode: Mode) => void;
  openSettings: (open: boolean) => void;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setPresets: (presets: Preset[]) => void;
  setStats: (stats: SystemStats) => void;
  encoder: (id: VideoEncoder) => EncoderInfo | undefined;
  /** The preset new files start with, falling back to one this machine can run. */
  defaultPreset: () => Preset | undefined;
  presetUsable: (preset: Preset) => boolean;
  /** A graphics card that can compress video was found. */
  hasGpuEncoder: () => boolean;
}

const EMPTY_SETTINGS: AppSettings = {
  outputDir: null,
  outputSuffix: '_small',
  systemImpact: 'balanced',
  parallelJobs: 1,
  hardwareDecode: true,
  deleteOriginal: false,
  shutdownOnFinish: false,
  playSoundOnFinish: false,
  customSoundPath: null,
  defaultPresetId: 'balanced',
  preferGpu: true,
  advancedMode: false,
};

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  failed: null,
  version: '',
  caps: null,
  problem: null,
  settings: EMPTY_SETTINGS,
  presets: [],
  easyOptions: [],
  startupFiles: [],
  mode: 'video',
  settingsOpen: false,
  stats: null,

  init: async () => {
    try {
      const boot = await api.bootstrap();
      set({
        ready: true,
        version: boot.version,
        caps: boot.capabilities,
        problem: boot.problem,
        settings: boot.settings,
        presets: boot.presets,
        easyOptions: boot.easyOptions,
        startupFiles: boot.startupFiles,
      });
      // The queue store reads its first snapshot from here.
      useQueue.getState().apply(boot.queue);
    } catch (e) {
      set({ failed: errorText(e) });
    }
  },

  setMode: (mode) => set({ mode }),
  openSettings: (settingsOpen) => set({ settingsOpen }),

  saveSettings: async (patch) => {
    const before = get().settings;
    const next = { ...before, ...patch };
    set({ settings: next });
    const saved = await api.settingsSet(next);
    set({ settings: saved });
    // The simple choices depend on whether the graphics card is used.
    if (saved.preferGpu !== before.preferGpu) {
      set({ easyOptions: await api.easyOptions() });
    }
  },

  setPresets: (presets) => set({ presets }),
  setStats: (stats) => set({ stats }),

  encoder: (id) => get().caps?.encoders.find((e) => e.id === id),

  presetUsable: (preset) => get().encoder(preset.settings.video.encoder)?.available ?? false,

  hasGpuEncoder: () =>
    get().caps?.encoders.some((e) => e.available && (e.id === 'hevcNvenc' || e.id === 'hevcAmf' || e.id === 'hevcQsv')) ?? false,

  defaultPreset: () => {
    const { presets, settings, presetUsable } = get();
    const wanted = presets.find((p) => p.id === settings.defaultPresetId);
    if (wanted && presetUsable(wanted)) return wanted;
    return presets.find((p) => p.id === 'balanced' && presetUsable(p)) ?? presets.find(presetUsable) ?? presets[0];
  },
}));
