import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { Toaster } from 'sonner';
import { AlertTriangle, Download } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Logo } from '@/components/common';
import { EditorPane } from '@/features/editor/EditorPane';
import { ImageStudio } from '@/features/image/ImageStudio';
import { QueuePane } from '@/features/queue/QueuePane';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { SourcesPane } from '@/features/sources/SourcesPane';
import { onQueueFinished } from '@/lib/finish';
import { api, on } from '@/lib/ipc';
import { checkForUpdate } from '@/lib/updates';
import { useApp } from '@/stores/app';
import { useImages } from '@/stores/images';
import { useQueue } from '@/stores/queue';
import { useSources } from '@/stores/sources';
import { TitleBar } from './TitleBar';

export function App() {
  const ready = useApp((s) => s.ready);
  const failed = useApp((s) => s.failed);
  const problem = useApp((s) => s.problem);
  const mode = useApp((s) => s.mode);
  const [dropping, setDropping] = useState(false);

  // Start-up: load state from the core, then show the window.
  useEffect(() => {
    const win = getCurrentWindow();
    void (async () => {
      // Show the window first: the loading screen is better than nothing at all.
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
      await useApp.getState().init();
      if (!useApp.getState().ready) return;
      await useSources.getState().restore();
      // Files handed over by "Open with": videos and images each go to their own list.
      const opened = useApp.getState().startupFiles;
      if (opened.length > 0) {
        const [videos, images] = await Promise.all([api.expandPaths(opened, 'video'), api.expandPaths(opened, 'image')]);
        if (images.length > 0) {
          if (videos.length === 0) useApp.getState().setMode('image');
          void useImages.getState().addPaths(images);
        }
        if (videos.length > 0) await useSources.getState().addPaths(videos);
      }
      if (import.meta.env.PROD) void checkForUpdate(false);
    })();
  }, []);

  // Everything the core pushes to the UI.
  useEffect(() => {
    const offs = [
      on('queue:changed', (snapshot) => useQueue.getState().apply(snapshot)),
      on('job:progress', (p) => useQueue.getState().progress(p)),
      on('queue:finished', onQueueFinished),
      on('analysis:progress', (p) => useSources.getState().onEasyProgress(p)),
      on('system:stats', (stats) => useApp.getState().setStats(stats)),
      on('caps:changed', (c) => useApp.setState({ caps: c.capabilities, easyOptions: c.easyOptions })),
      on('image:event', (e) => useImages.getState().onEvent(e)),
      on('image:batch-done', () => useImages.getState().onBatchDone()),
      getCurrentWebview().onDragDropEvent((event) => {
        const { type } = event.payload;
        if (type === 'enter' || type === 'over') setDropping(true);
        else if (type === 'leave') setDropping(false);
        else if (type === 'drop') {
          setDropping(false);
          const { paths } = event.payload;
          if (paths.length === 0 || useApp.getState().problem) return;
          if (useApp.getState().mode === 'image') void useImages.getState().addPaths(paths);
          else void useSources.getState().addPaths(paths);
        }
      }),
      // Closing mid-encode abandons work, so ask first.
      getCurrentWindow().onCloseRequested(async (event) => {
        const active = useQueue.getState().jobs.filter((j) => j.status === 'running' || j.status === 'paused').length;
        if (active === 0 && !useImages.getState().busy) return;
        event.preventDefault();
        const sure = await ask(
          'Encoding is still in progress. If you quit now, the current file starts over the next time you run the queue. Finished files are kept.',
          { title: 'Quit Make Video Small?', kind: 'warning', okLabel: 'Quit', cancelLabel: 'Keep encoding' },
        );
        if (sure) await getCurrentWindow().destroy();
      }),
    ];
    return () => {
      for (const off of offs) off.then((f) => f()).catch(() => {});
    };
  }, []);

  // A desktop app has no use for the browser's context menu or reload keys.
  useEffect(() => {
    const noMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('input, textarea, .selectable')) e.preventDefault();
    };
    const noReload = (e: KeyboardEvent) => {
      if (import.meta.env.PROD && (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r'))) e.preventDefault();
    };
    window.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', noReload);
    return () => {
      window.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', noReload);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full flex-col">
        <TitleBar />
        {problem && (
          <p role="alert" className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {problem}
          </p>
        )}
        {failed ? (
          <div className="grid flex-1 place-items-center px-8 text-center" role="alert">
            <div>
              <p className="text-[15px] font-medium">Make Video Small could not start</p>
              <p className="selectable mt-2 max-w-[60ch] text-muted-foreground">{failed}</p>
            </div>
          </div>
        ) : !ready ? (
          <div className="grid flex-1 place-items-center text-muted-foreground" role="status">
            <div className="flex flex-col items-center gap-3">
              <Logo className="size-9 text-primary" working />
              Checking which encoders this PC can use…
            </div>
          </div>
        ) : mode === 'video' ? (
          <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_340px]">
            <SourcesPane />
            <EditorPane />
            <QueuePane />
          </div>
        ) : (
          <ImageStudio />
        )}

        {dropping && ready && !problem && (
          <div className="pointer-events-none absolute inset-0 top-9 z-50 grid place-items-center bg-background/80 backdrop-blur-[2px]">
            <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary px-14 py-10 text-primary">
              <Download className="size-9" />
              <p className="text-[15px] font-medium">Drop to add {mode === 'image' ? 'images' : 'videos'}</p>
            </div>
          </div>
        )}

        <SettingsDialog />
        <Toaster theme="dark" position="top-center" offset={48} richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
      </div>
    </TooltipProvider>
  );
}
