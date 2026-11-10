import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Settings, Square, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Logo, Segmented, Tip } from '@/components/common';
import { useApp, type Mode } from '@/stores/app';
import { useQueue } from '@/stores/queue';

const controls = 'grid h-9 w-11 place-items-center text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent';

export function TitleBar() {
  const mode = useApp((s) => s.mode);
  const setMode = useApp((s) => s.setMode);
  const openSettings = useApp((s) => s.openSettings);
  const advanced = useApp((s) => s.settings.advancedMode);
  const working = useQueue((s) => s.running && !s.paused);
  const [maximized, setMaximized] = useState(false);
  const win = getCurrentWindow();

  useEffect(() => {
    let alive = true;
    const sync = () => win.isMaximized().then((m) => alive && setMaximized(m)).catch(() => {});
    sync();
    const off = win.onResized(sync);
    return () => {
      alive = false;
      off.then((f) => f()).catch(() => {});
    };
    // The window handle is stable for the life of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header data-tauri-drag-region className="relative flex h-9 shrink-0 items-center border-b bg-panel">
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3 text-foreground">
        <Logo className={working ? 'text-primary' : undefined} working={working} />
        <span data-tauri-drag-region className="font-medium tracking-[-0.01em]">
          Make Video Small
        </span>
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <Segmented<Mode>
          label="What to compress"
          value={mode}
          onChange={setMode}
          className="h-7 [&>button]:h-6"
          options={[
            { value: 'video', label: 'Video' },
            { value: 'image', label: 'Images' },
          ]}
        />
      </div>

      <div className="ml-auto flex items-center">
        {mode === 'video' && (
          <Tip text="Show every control: format, quality number, audio tracks, subtitles and filters" side="bottom">
            <label className="mr-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                className="scale-90"
                aria-label="Advanced controls"
                checked={advanced}
                onCheckedChange={(advancedMode) => void useApp.getState().saveSettings({ advancedMode })}
              />
              Advanced
            </label>
          </Tip>
        )}
        <Tip text="Settings" side="bottom">
          <button type="button" aria-label="Settings" className={controls} onClick={() => openSettings(true)}>
            <Settings className="size-4" />
          </button>
        </Tip>
        <div className="mx-1 h-4 w-px bg-border" />
        <button type="button" aria-label="Minimize" className={controls} onClick={() => win.minimize()}>
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          className={controls}
          onClick={() => win.toggleMaximize()}
        >
          {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
        </button>
        <button
          type="button"
          aria-label="Close"
          className={`${controls} hover:bg-destructive hover:text-white focus-visible:bg-destructive`}
          onClick={() => win.close()}
        >
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}
