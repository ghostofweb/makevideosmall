// What happens when the queue runs dry: a summary, a sound, an optional shutdown.

import { toast } from 'sonner';
import { bytes, savings } from './format';
import { api, errorText, fileUrl } from './ipc';
import { useApp } from '@/stores/app';
import type { QueueFinished } from './types';

/** A short two-note chime, generated so no audio file has to ship. */
function chime() {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = ctx.currentTime + i * 0.16;
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.55);
    });
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    // No audio device: nothing to do.
  }
}

function playSound(custom: string | null) {
  if (!custom) return chime();
  const audio = new Audio(fileUrl(custom));
  audio.play().catch(chime);
}

const SHUTDOWN_SECONDS = 30;

function shutdownCountdown() {
  let left = SHUTDOWN_SECONDS;
  const id = toast.warning(`Shutting down in ${left} seconds`, {
    duration: Infinity,
    action: { label: 'Cancel', onClick: () => clearInterval(timer) },
  });
  const timer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      toast.warning(`Shutting down in ${left} second${left === 1 ? '' : 's'}`, {
        id,
        duration: Infinity,
        action: { label: 'Cancel', onClick: () => clearInterval(timer) },
      });
      return;
    }
    clearInterval(timer);
    toast.dismiss(id);
    api.shutdownPc().catch((e) => toast.error('Could not shut down the PC', { description: errorText(e) }));
  }, 1000);
}

export function onQueueFinished(result: QueueFinished) {
  const { settings, saveSettings } = useApp.getState();
  const finished = result.done + result.failed;
  if (finished === 0) return; // Everything was cancelled: nothing to announce.

  const saved = result.sourceBytes - result.outputBytes;
  const description =
    result.done > 0
      ? `${bytes(result.sourceBytes)} became ${bytes(result.outputBytes)}${saved > 0 ? `: ${bytes(saved)} saved (${savings(result.sourceBytes, result.outputBytes)}% smaller)` : ''}.`
      : undefined;

  if (result.failed > 0) {
    toast.warning(`Queue finished: ${result.done} done, ${result.failed} failed`, { description, duration: 12000 });
  } else {
    toast.success(`Queue finished: ${result.done} file${result.done === 1 ? '' : 's'} compressed`, { description, duration: 12000 });
  }

  if (settings.playSoundOnFinish) playSound(settings.customSoundPath);
  if (settings.shutdownOnFinish) {
    // One-shot: a forgotten switch must not shut the PC down next time too.
    void saveSettings({ shutdownOnFinish: false });
    shutdownCountdown();
  }
}
