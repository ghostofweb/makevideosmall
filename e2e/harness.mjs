// Drives the real app window for end-to-end tests.
//
// The app's web view (WebView2) is Chromium, so Playwright can attach to it
// over the DevTools protocol. Each run gets its own data and browser profile,
// so tests never touch your real settings, presets or queue.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(import.meta.dirname, '..');

export function appPath() {
  const override = process.env.MVS_APP;
  if (override) return override;
  return path.join(ROOT, 'src-tauri', 'target', process.env.MVS_PROFILE ?? 'release', 'make-video-small.exe');
}

async function waitFor(what, fn, timeoutMs = 30000, everyMs = 150) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * Start the app and attach to its window.
 * @param {{ workDir: string, files?: string[], port?: number, fresh?: boolean }} options
 */
export async function launch({ workDir, files = [], port = 9333, fresh = true }) {
  const dataDir = path.join(workDir, 'data');
  const profileDir = path.join(workDir, 'webview');
  if (fresh) {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const startedAt = Date.now();
  const child = spawn(appPath(), files, {
    env: {
      ...process.env,
      MVS_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  });

  const browser = await waitFor('the app window', () => chromium.connectOverCDP(`http://127.0.0.1:${port}`), 40000, 250);
  const page = await waitFor('the app page', () => {
    for (const context of browser.contexts()) {
      const found = context.pages().find((p) => !p.url().startsWith('devtools://'));
      if (found) return found;
    }
    return null;
  });
  page.setDefaultTimeout(20000);

  return {
    page,
    browser,
    child,
    dataDir,
    startedAt,
    /**
     * End the process, as a crash or a forced close would. With `tree: false`
     * only the app itself is killed, which proves that its encoders do not
     * outlive it.
     */
    async kill({ tree = true } = {}) {
      await browser.close().catch(() => {});
      if (child.exitCode === null) {
        spawn('taskkill', ['/pid', String(child.pid), ...(tree ? ['/t'] : []), '/f'], { stdio: 'ignore' });
        await waitFor('the app to exit', () => child.exitCode !== null || child.signalCode !== null, 10000).catch(() => {});
      }
    },
  };
}

export { waitFor, ROOT };
