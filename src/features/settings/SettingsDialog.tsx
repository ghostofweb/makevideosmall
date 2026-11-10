import { useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { baseName } from '@/lib/format';
import { errorText } from '@/lib/ipc';
import { checkForUpdate } from '@/lib/updates';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';
import type { AppSettings, SystemImpact } from '@/lib/types';

/** One question, with its answer underneath. */
function Question({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-4 first:pt-1">
      <h3 className="mb-2.5 text-[14px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A big either/or answer with a line explaining what it means. */
function Answer<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  label: string;
  options: { value: T; title: string; detail: string }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-lg border-2 px-3 py-2.5 text-left outline-none transition-colors hover:border-faint focus-visible:ring-2 focus-visible:ring-ring/60',
            value === o.value ? 'border-primary bg-primary/[0.07] hover:border-primary' : 'border-border',
          )}
        >
          <span className="block font-medium">{o.title}</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{o.detail}</span>
        </button>
      ))}
    </div>
  );
}

/** An on/off answer. */
function Toggle({ checked, onChange, title, detail }: { checked: boolean; onChange: (on: boolean) => void; title: string; detail?: string }) {
  return (
    <label className="flex items-start gap-3 py-1.5">
      <Switch className="mt-0.5" checked={checked} onCheckedChange={onChange} />
      <span>
        <span className="block">{title}</span>
        {detail && <span className="block text-xs leading-snug text-muted-foreground">{detail}</span>}
      </span>
    </label>
  );
}

export function SettingsDialog() {
  const isOpen = useApp((s) => s.settingsOpen);
  const openSettings = useApp((s) => s.openSettings);
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const presets = useApp((s) => s.presets);
  const presetUsable = useApp((s) => s.presetUsable);
  const hasGpu = useApp((s) => s.hasGpuEncoder());
  const caps = useApp((s) => s.caps);
  const version = useApp((s) => s.version);
  const [checking, setChecking] = useState(false);

  const save = (patch: Partial<AppSettings>) =>
    saveSettings(patch).catch((e) => toast.error('Could not save that setting', { description: errorText(e) }));

  const pickFolder = async () => {
    const dir = await open({ directory: true, title: 'Choose a folder for finished files' });
    if (typeof dir === 'string') void save({ outputDir: dir });
  };

  const pickSound = async () => {
    const file = await open({ multiple: false, title: 'Choose a sound', filters: [{ name: 'Sound', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'] }] });
    if (typeof file === 'string') void save({ customSoundPath: file, playSoundOnFinish: true });
  };

  const gpuNames = caps?.encoders.filter((e) => e.hardware && e.available).map((e) => e.label) ?? [];

  return (
    <Dialog open={isOpen} onOpenChange={openSettings}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Changes are saved straight away.</DialogDescription>
        </DialogHeader>

        <div className="divide-y">
          <Question title="Where should finished files go?">
            <Answer
              label="Where finished files go"
              value={settings.outputDir ? 'folder' : 'beside'}
              onChange={(v) => (v === 'beside' ? void save({ outputDir: null }) : void pickFolder())}
              options={[
                { value: 'beside', title: 'Next to the original', detail: 'The small copy appears in the same folder as the video you added.' },
                { value: 'folder', title: 'In one folder', detail: 'Every finished file goes to a folder you choose.' },
              ]}
            />
            {settings.outputDir && (
              <div className="mt-2 flex items-center gap-2">
                <p className="selectable min-w-0 flex-1 truncate rounded-md border bg-muted px-2.5 py-1.5" title={settings.outputDir}>
                  {settings.outputDir}
                </p>
                <Button variant="outline" size="sm" onClick={pickFolder}>
                  Choose another…
                </Button>
              </div>
            )}
            <label className="mt-3 flex flex-wrap items-center gap-2 text-muted-foreground" htmlFor="suffix">
              Add this to the end of the name:
              <Input
                id="suffix"
                className="h-8 w-32 text-foreground"
                defaultValue={settings.outputSuffix}
                maxLength={30}
                onBlur={(e) => e.target.value !== settings.outputSuffix && void save({ outputSuffix: e.target.value })}
              />
              <span className="text-xs">
                so "holiday.mp4" becomes "holiday{settings.outputSuffix}.mp4". Your original is never replaced.
              </span>
            </label>
          </Question>

          {hasGpu && (
            <Question title="What matters more to you?">
              <Answer
                label="Speed or size"
                value={settings.preferGpu ? 'gpu' : 'cpu'}
                onChange={(v) => save({ preferGpu: v === 'gpu' })}
                options={[
                  { value: 'gpu', title: 'Finish quickly', detail: 'Uses your graphics card. Several times faster; files come out a little bigger.' },
                  { value: 'cpu', title: 'Smallest files', detail: 'Uses the processor and the AV1 format. Much slower, but the smallest result.' },
                ]}
              />
            </Question>
          )}

          <Question title="While it is working, how should your PC feel?">
            <Answer<SystemImpact>
              label="How the PC feels while compressing"
              value={settings.systemImpact}
              onChange={(systemImpact) => save({ systemImpact })}
              options={[
                { value: 'stealth', title: 'Normal', detail: 'Other programs always go first. Compressing takes longer.' },
                { value: 'balanced', title: 'A bit busy', detail: 'A good middle. Fine for browsing and office work.' },
                { value: 'beast', title: 'As fast as possible', detail: 'Compressing goes first. Everything else may feel slow.' },
              ]}
            />
          </Question>

          <Question title="When a video is finished">
            <Toggle
              checked={settings.deleteOriginal}
              onChange={(deleteOriginal) => save({ deleteOriginal })}
              title="Move the original to the Recycle Bin"
              detail="Only after the small copy was made without problems. You can get it back from the Recycle Bin."
            />
          </Question>

          <Question title="When everything in the queue is finished">
            <Toggle checked={settings.playSoundOnFinish} onChange={(playSoundOnFinish) => save({ playSoundOnFinish })} title="Play a sound" />
            {settings.playSoundOnFinish && (
              <div className="mb-1 ml-12 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">{settings.customSoundPath ? baseName(settings.customSoundPath) : 'A short chime'}</span>
                <Button variant="outline" size="xs" onClick={pickSound}>
                  Use my own sound…
                </Button>
                {settings.customSoundPath && (
                  <Button variant="ghost" size="xs" onClick={() => save({ customSoundPath: null })}>
                    Back to the chime
                  </Button>
                )}
              </div>
            )}
            <Toggle
              checked={settings.shutdownOnFinish}
              onChange={(shutdownOnFinish) => save({ shutdownOnFinish })}
              title="Turn the PC off"
              detail="You get 30 seconds to cancel. This switches itself back off afterwards."
            />
          </Question>

          <Question title="For experts">
            <Toggle
              checked={settings.advancedMode}
              onChange={(advancedMode) => save({ advancedMode })}
              title="Show advanced video controls"
              detail="Choose the exact format, quality number, size, audio tracks, subtitles and filters yourself, and save your own presets."
            />
            {settings.advancedMode && (
              <div className="mt-2 space-y-3 rounded-lg border bg-muted/40 p-3">
                <label className="flex flex-wrap items-center gap-2">
                  <span className="w-44 text-muted-foreground">New videos start with</span>
                  <Select value={settings.defaultPresetId} onValueChange={(defaultPresetId) => save({ defaultPresetId })}>
                    <SelectTrigger className="h-8 w-64" aria-label="Preset for new videos">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((p) => (
                        <SelectItem key={p.id} value={p.id} disabled={!presetUsable(p)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <span className="w-44 text-muted-foreground">Videos compressed at once</span>
                  <Select value={String(settings.parallelJobs)} onValueChange={(v) => save({ parallelJobs: Number(v) })}>
                    <SelectTrigger className="h-8 w-20" aria-label="Videos compressed at once">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">More than one only helps with a graphics card.</span>
                </label>
                <Toggle
                  checked={settings.hardwareDecode}
                  onChange={(hardwareDecode) => save({ hardwareDecode })}
                  title="Also read videos with the graphics card"
                  detail="Faster when the graphics card does the compressing. Falls back by itself if a video does not support it."
                />
              </div>
            )}
          </Question>

          <Question title="About">
            <dl className="readout grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
              <dt className="text-muted-foreground">Version</dt>
              <dd>{version}</dd>
              <dt className="text-muted-foreground">Video engine</dt>
              <dd className="selectable truncate" title={caps?.ffmpegPath}>
                {caps ? `ffmpeg ${caps.ffmpegVersion}` : 'Not found'}
              </dd>
              <dt className="text-muted-foreground">Graphics card</dt>
              <dd>{gpuNames.length > 0 ? `Can compress video (${gpuNames.length} formats)` : 'Cannot compress video on this PC'}</dd>
            </dl>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                await checkForUpdate(true);
                setChecking(false);
              }}
            >
              {checking ? 'Checking…' : 'Check for a newer version'}
            </Button>
          </Question>
        </div>
      </DialogContent>
    </Dialog>
  );
}
