// @ts-nocheck
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, HardDrive, Cpu, Power, Volume2, Trash, 
  FolderSearch, FolderOpen, Music, Terminal, Zap, Shield, Rocket, BrainCircuit, Info
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

const { ipcRenderer } = window.require('electron');

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const DEFAULT_SETTINGS = {
  outputRouting: 'original',
  customOutputPath: '',
  systemImpact: 'balanced', 
  engine: 'gpu', 
  deleteOriginal: false,
  shutdownOnFinish: false,
  playSoundOnFinish: false,
  customSoundPath: '',
};

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const [gpuName, setGpuName] = useState<string>("");
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('vb_settings');
    if (saved) {
      let parsed = JSON.parse(saved);
      // Migration & Defaults Logic
      if (!parsed.systemImpact) parsed.systemImpact = 'balanced';
      if (!parsed.engine) parsed.engine = 'gpu'; 
      return parsed;
    }
    return DEFAULT_SETTINGS;
  });
  
  const [devMode, setDevMode] = useState(() => localStorage.getItem('vb_dev_mode') === 'true');

  // Fetch real system info on mount to avoid hardcoding
  useEffect(() => {
    const fetchSystemInfo = async () => {
      try {
        const stats = await ipcRenderer.invoke('get-system-stats');
        if (stats?.gpuName) setGpuName(stats.gpuName);
      } catch (e) {
        console.error("Failed to probe system for settings UI", e);
      }
    };
    fetchSystemInfo();
  }, []);

  useEffect(() => {
    localStorage.setItem('vb_settings', JSON.stringify(settings));
  }, [settings]);

  const updateSetting = (key: string, value: any) => {
    setSettings((prev: any) => ({ ...prev, [key]: value }));
  };

  const toggleDevMode = (val: boolean) => {
    setDevMode(val);
    localStorage.setItem('vb_dev_mode', String(val));
    ipcRenderer.invoke('toggle-dev-tools', val);
  };

  const handleSelectFolder = async () => {
    const folderPath = await ipcRenderer.invoke('select-folder');
    if (folderPath) {
      updateSetting('customOutputPath', folderPath);
      updateSetting('outputRouting', 'custom');
    }
  };

  const toggleSoundSwitch = async (checked: boolean) => {
    if (checked) {
      const path = await ipcRenderer.invoke('select-audio');
      if (path) {
        updateSetting('customSoundPath', path);
        updateSetting('playSoundOnFinish', true);
      } else {
        toast.error("No audio file selected.");
        updateSetting('playSoundOnFinish', false);
      }
    } else {
      updateSetting('playSoundOnFinish', false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
          />
          
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 h-full w-[360px] bg-card border-l border-border shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-border/50 shrink-0 mt-6">
              <div>
                <h2 className="text-lg font-bold text-foreground">Global Preferences</h2>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Engine Configuration</p>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full hover:bg-white/5">
                <X className="h-5 w-5" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
              
              {/* SECTION: PROCESSING ENGINE */}
              <div className="space-y-4">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-bold flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-yellow-500" /> Processing Engine
                </h3>
                
                <RadioGroup 
                  value={settings.engine} 
                  onValueChange={(val) => updateSetting('engine', val)}
                  className="grid gap-3"
                >
                  <div 
                    onClick={() => updateSetting('engine', 'gpu')}
                    className={`p-4 rounded-xl border-2 transition-all cursor-pointer relative overflow-hidden group ${settings.engine === 'gpu' ? 'border-yellow-500/50 bg-yellow-500/5 shadow-[0_0_20px_rgba(234,179,8,0.1)]' : 'border-border/50 bg-card/30 hover:border-border'}`}
                  >
                    <div className="flex items-center gap-3 mb-1.5">
                      <RadioGroupItem value="gpu" id="engine-gpu" className="border-yellow-500/50 text-yellow-500" />
                      <Label htmlFor="engine-gpu" className="text-sm font-bold cursor-pointer flex items-center gap-2">
                        Hardware Acceleration
                      </Label>
                    </div>
                    {/* 🔴 UPDATED GPU WARNING */}
                    <p className="text-[10px] text-muted-foreground leading-relaxed pl-7">
                      {gpuName ? `Optimized for ${gpuName}.` : "Uses dedicated graphics hardware."} Blazing fast speeds and minimal system heat. <strong>Trade-off: Less efficient compression. File sizes will be larger than CPU processing.</strong>
                    </p>
                    {settings.engine === 'gpu' && <Zap className="absolute -right-2 -bottom-2 w-12 h-12 text-yellow-500/10 rotate-12" />}
                  </div>

                  <div 
                    onClick={() => updateSetting('engine', 'cpu')}
                    className={`p-4 rounded-xl border-2 transition-all cursor-pointer relative overflow-hidden group ${settings.engine === 'cpu' ? 'border-purple-500/50 bg-purple-500/5 shadow-[0_0_20px_rgba(168,85,247,0.1)]' : 'border-border/50 bg-card/30 hover:border-border'}`}
                  >
                    <div className="flex items-center gap-3 mb-1.5">
                      <RadioGroupItem value="cpu" id="engine-cpu" className="border-purple-500/50 text-purple-500" />
                      <Label htmlFor="engine-cpu" className="text-sm font-bold cursor-pointer flex items-center gap-2">
                        Deep Archival (SVT-AV1)
                      </Label>
                    </div>
                    {/* 🔴 UPDATED CPU DESCRIPTION */}
                    <p className="text-[10px] text-muted-foreground leading-relaxed pl-7">
                      Highly complex, CPU-intensive AV1 encoding. <strong>Yields the absolute smallest file sizes possible with pristine quality.</strong> Best when storage space is the priority over speed.
                    </p>
                    {settings.engine === 'cpu' && <BrainCircuit className="absolute -right-2 -bottom-2 w-12 h-12 text-purple-500/10 rotate-12" />}
                  </div>
                </RadioGroup>
              </div>

              {/* SECTION: SYSTEM IMPACT */}
              <div className="space-y-4">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-bold flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-blue-500" /> System Impact
                </h3>
                
                <RadioGroup 
                  value={settings.systemImpact} 
                  onValueChange={(val) => updateSetting('systemImpact', val)}
                  className="grid gap-2"
                >
                  {[
                    { id: 'stealth', label: 'Stealth', icon: Shield, color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/20', desc: 'Background priority. Work or play while encoding.' },
                    { id: 'balanced', label: 'Balanced', icon: Zap, color: 'text-blue-400', bg: 'bg-blue-400/10', border: 'border-blue-400/20', desc: 'Default. High speed but stays responsive.' },
                    { id: 'beast', label: 'Beast Mode', icon: Rocket, color: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/20', desc: 'Full throttle. PC may stutter. Use for overnight jobs.' }
                  ].map((mode) => (
                    <div 
                      key={mode.id}
                      onClick={() => updateSetting('systemImpact', mode.id)}
                      className={`p-3 rounded-lg border flex items-center gap-3 transition-all cursor-pointer ${settings.systemImpact === mode.id ? `${mode.bg} ${mode.border}` : 'bg-card/30 border-border/40 hover:border-border'}`}
                    >
                      <RadioGroupItem value={mode.id} id={mode.id} className={mode.color} />
                      <div className="flex-1">
                        <Label htmlFor={mode.id} className={`text-xs font-bold flex items-center gap-1.5 cursor-pointer ${mode.color}`}>
                          <mode.icon className="w-3 h-3" /> {mode.label}
                        </Label>
                        <p className="text-[9px] text-muted-foreground">{mode.desc}</p>
                      </div>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              {/* SECTION: OUTPUT & AUTOMATION */}
              <div className="space-y-6">
                <div className="space-y-4">
                   <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-bold flex items-center gap-2">
                    <HardDrive className="w-3.5 h-3.5 text-orange-500" /> Storage & Files
                  </h3>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 rounded-lg bg-background/40 border border-border/50">
                      <div className="space-y-0.5">
                        <Label className="text-xs font-bold">Custom Output Folder</Label>
                        <p className="text-[9px] text-muted-foreground">Override the source directory</p>
                      </div>
                      <Switch 
                        checked={settings.outputRouting === 'custom'} 
                        onCheckedChange={(val) => updateSetting('outputRouting', val ? 'custom' : 'original')} 
                      />
                    </div>

                    <AnimatePresence>
                      {settings.outputRouting === 'custom' && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                          <Button variant="outline" size="sm" className="w-full text-[10px] h-9 border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10" onClick={handleSelectFolder}>
                            <FolderSearch className="w-3 h-3 mr-2" />
                            <span className="truncate">{settings.customOutputPath || "Browse for folder..."}</span>
                          </Button>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="flex items-center justify-between p-3 rounded-lg bg-background/40 border border-border/50">
                      <div className="space-y-0.5">
                        <Label className="text-xs font-bold">Auto-Delete Source</Label>
                        <p className="text-[9px] text-muted-foreground text-red-400/80">Danger: Permanent removal after success</p>
                      </div>
                      <Switch checked={settings.deleteOriginal} onCheckedChange={(val) => updateSetting('deleteOriginal', val)} />
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                   <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-bold flex items-center gap-2">
                    <Power className="w-3.5 h-3.5 text-red-500" /> Job Completion
                  </h3>
                  
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 rounded-lg bg-background/40 border border-border/50">
                      <Label className="text-xs font-bold">Shutdown PC when finished</Label>
                      <Switch checked={settings.shutdownOnFinish} onCheckedChange={(val) => updateSetting('shutdownOnFinish', val)} />
                    </div>

                    <div className="flex items-center justify-between p-3 rounded-lg bg-background/40 border border-border/50">
                      <Label className="text-xs font-bold">Play completion sound</Label>
                      <Switch checked={settings.playSoundOnFinish} onCheckedChange={toggleSoundSwitch} />
                    </div>
                  </div>
                </div>
              </div>

              {/* DEVELOPER SECTION */}
              <div className="pt-6 border-t border-border/50 space-y-4">
                <div className="flex items-center justify-between opacity-60 hover:opacity-100 transition-opacity">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5" />
                    <Label className="text-xs font-bold">Developer Tools</Label>
                  </div>
                  <Switch id="devmode" checked={devMode} onCheckedChange={toggleDevMode} />
                </div>
              </div>

            </div>

            {/* Footer button to quickly open folder */}
            <div className="p-6 border-t border-border/50 bg-card/50">
              <Button 
                variant="secondary" 
                className="w-full flex items-center gap-2 h-10 font-bold text-xs"
                onClick={() => {
                  if (settings.outputRouting === 'custom' && settings.customOutputPath) {
                    ipcRenderer.invoke('open-folder', settings.customOutputPath);
                  } else {
                    toast.info("Target: Same as source files");
                  }
                }}
              >
                <FolderOpen className="w-4 h-4" />
                View Encoded Directory
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}