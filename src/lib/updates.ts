// Update checks against the project's GitHub releases.

import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { toast } from 'sonner';
import { errorText } from './ipc';

/**
 * Look for a newer version. On launch this is silent unless there is one;
 * when the person asks (`announce`), every outcome is reported.
 */
export async function checkForUpdate(announce: boolean): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (announce) toast.success('You have the latest version.');
      return;
    }
    toast.info(`Version ${update.version} is available`, {
      description: 'It downloads in the background and installs when you restart.',
      duration: Infinity,
      action: {
        label: 'Install and restart',
        onClick: async () => {
          const progress = toast.loading('Downloading the update…');
          try {
            await update.downloadAndInstall();
            await relaunch();
          } catch (e) {
            toast.error('The update could not be installed', { id: progress, description: errorText(e) });
          }
        },
      },
    });
  } catch (e) {
    if (announce) toast.error('Could not check for updates', { description: errorText(e) });
  }
}
