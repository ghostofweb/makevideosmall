import { useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { Check, ChevronDown, Download, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { api, errorText } from '@/lib/ipc';
import { describeSettings } from '@/lib/spec';
import { cn } from '@/lib/utils';
import { useApp } from '@/stores/app';
import type { EncodeSettings, Preset } from '@/lib/types';

/** Dropdown for choosing a preset. `current` is the preset in use, or null for hand-tuned settings. */
export function PresetPicker({
  current,
  onPick,
  onSaveCurrent,
  label,
  className,
  variant = 'outline',
}: {
  current: string | null;
  onPick: (preset: Preset) => void;
  /** Show "Save these settings as a preset…" when given. */
  onSaveCurrent?: () => void;
  /** Overrides the button text (used for "Apply a preset to 3 files"). */
  label?: string;
  className?: string;
  variant?: 'outline' | 'secondary' | 'ghost';
}) {
  const presets = useApp((s) => s.presets);
  const caps = useApp((s) => s.caps);
  const encoder = useApp((s) => s.encoder);
  const [managing, setManaging] = useState(false);

  const active = presets.find((p) => p.id === current);
  const builtin = presets.filter((p) => p.builtin);
  const mine = presets.filter((p) => !p.builtin);

  const item = (p: Preset) => {
    const info = encoder(p.settings.video.encoder);
    const usable = info?.available ?? false;
    return (
      <DropdownMenuItem
        key={p.id}
        disabled={!usable}
        onSelect={() => onPick(p)}
        className="flex-col items-start gap-0.5 py-1.5"
      >
        <span className="flex w-full items-center gap-2">
          <span className="font-medium">{p.name}</span>
          {p.id === current && <Check className="ml-auto size-3.5 text-primary" />}
        </span>
        <span className="text-xs text-muted-foreground">
          {usable ? describeSettings(p.settings, caps) : (info?.reason ?? 'Not available on this PC.')}
        </span>
      </DropdownMenuItem>
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size="sm" className={cn('justify-between gap-2 font-normal', className)}>
            <span className="truncate">{label ?? active?.name ?? 'Custom settings'}</span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] w-80 overflow-y-auto">
          {mine.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Your presets</DropdownMenuLabel>
              {mine.map(item)}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Built in</DropdownMenuLabel>
            </>
          )}
          {builtin.map(item)}
          <DropdownMenuSeparator />
          {onSaveCurrent && <DropdownMenuItem onSelect={onSaveCurrent}>Save these settings as a preset…</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => setManaging(true)}>Manage presets…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ManagePresets open={managing} onOpenChange={setManaging} />
    </>
  );
}

/** Ask for a name and store the given settings as a user preset. */
export function SavePresetDialog({
  open: isOpen,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: EncodeSettings | null;
  onSaved: (preset: Preset) => void;
}) {
  const caps = useApp((s) => s.caps);
  const setPresets = useApp((s) => s.setPresets);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!settings || !name.trim()) return;
    setBusy(true);
    try {
      const saved = await api.presetSave({
        id: '',
        name: name.trim(),
        description: describeSettings(settings, caps),
        builtin: false,
        settings,
      });
      setPresets(await api.presetsList());
      onSaved(saved);
      toast.success(`Saved preset "${saved.name}"`);
      setName('');
      onOpenChange(false);
    } catch (e) {
      toast.error('Could not save the preset', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as preset</DialogTitle>
          <DialogDescription>
            {settings ? describeSettings(settings, caps) : ''}. Trim points and the output name are not part of a preset.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input autoFocus placeholder="Preset name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              Save preset
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManagePresets({ open: isOpen, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const presets = useApp((s) => s.presets);
  const caps = useApp((s) => s.caps);
  const setPresets = useApp((s) => s.setPresets);
  const mine = presets.filter((p) => !p.builtin);

  const refresh = async () => setPresets(await api.presetsList());

  const remove = async (p: Preset) => {
    try {
      await api.presetDelete(p.id);
      await refresh();
      toast.success(`Deleted preset "${p.name}"`);
    } catch (e) {
      toast.error('Could not delete the preset', { description: errorText(e) });
    }
  };

  const importFile = async () => {
    const file = await open({ multiple: false, filters: [{ name: 'Presets', extensions: ['json'] }] });
    if (typeof file !== 'string') return;
    try {
      const added = await api.presetsImport(file);
      await refresh();
      toast.success(`Imported ${added.length} preset${added.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error('Could not import presets', { description: errorText(e) });
    }
  };

  const exportAll = async () => {
    const file = await save({ defaultPath: 'make-video-small-presets.json', filters: [{ name: 'Presets', extensions: ['json'] }] });
    if (!file) return;
    try {
      const count = await api.presetsExport(mine.map((p) => p.id), file);
      toast.success(`Exported ${count} preset${count === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error('Could not export presets', { description: errorText(e) });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Your presets</DialogTitle>
          <DialogDescription>Built-in presets cannot be changed. Save your own from the settings of any file.</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {mine.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted-foreground">
              You have not saved any presets yet. Set up a file the way you like it, then choose "Save these settings as a preset".
            </p>
          ) : (
            mine.map((p) => (
              <div key={p.id} className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{describeSettings(p.settings, caps)}</p>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete preset ${p.name}`} onClick={() => remove(p)}>
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={importFile}>
              <Upload /> Import
            </Button>
            <Button variant="outline" size="sm" onClick={exportAll} disabled={mine.length === 0}>
              <Download /> Export all
            </Button>
          </div>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
