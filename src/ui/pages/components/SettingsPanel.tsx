import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, HardDrive, Cpu, Power, Volume2, Trash, FolderSearch, FolderOpen, Music } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { toast } from 'sonner';

const { ipcRenderer } = window.require('electron');

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const DEFAULT_SETTINGS = {
  outputRouting: 'original',
  customOutputPath: '',
  freeCpuCores: 2,
  deleteOriginal: false,
  shutdownOnFinish: false,
  playSoundOnFinish: true,
  customSoundPath: '',
};

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('vb_settings');
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });

  const maxThreads = navigator.hardwareConcurrency || 12;

  useEffect(() => {
    localStorage.setItem('vb_settings', JSON.stringify(settings));
  }, [settings]);

  const updateSetting = (key: string, value: any) => {
    setSettings((prev: any) => ({ ...prev, [key]: value }));
  };

  const handleSelectFolder = async () => {
    const folderPath = await ipcRenderer.invoke('select-folder');
    if (folderPath) {
      updateSetting('customOutputPath', folderPath);
      updateSetting('outputRouting', 'custom');
    }
  };

  const handleSelectAudio = async () => {
    const audioPath = await ipcRenderer.invoke('select-audio');
    if (audioPath) {
      updateSetting('customSoundPath', audioPath);
    }
  };

  const handleOpenOutputFolder = () => {
    if (settings.outputRouting === 'custom' && settings.customOutputPath) {
      ipcRenderer.invoke('open-folder', settings.customOutputPath);
    } else if (settings.outputRouting === 'original') {
      toast.info("Videos are saved next to their source files. Click the folder icon on a specific video in the Queue to find it!");
    } else {
      toast.error("Please browse for a custom folder first.");
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
          />
          
          {/* Side Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
className="fixed top-0 right-0 h-full w-[340px] bg-card border-l border-border shadow-2xl z-50 flex flex-col pt-8"          >
            <div className="flex justify-between items-center p-4 border-b border-border/50">
              <h2 className="text-sm font-bold text-foreground">Global Settings</h2>
              <Button variant="ghost" size="icon" onClick={onClose} className="h-6 w-6">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-8 custom-scrollbar">
              
              <div className="space-y-4">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
                  <HardDrive className="w-3.5 h-3.5" /> Output Routing
                </h3>
                
                <RadioGroup 
                  value={settings.outputRouting} 
                  onValueChange={(val) => updateSetting('outputRouting', val)}
                  className="space-y-3"
                >
                  <div className="flex flex-col space-y-1.5">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="original" id="original" />
                      <Label htmlFor="original" className="text-sm cursor-pointer font-medium">Save next to original</Label>
                    </div>
                  </div>

                  <div className="flex flex-col space-y-2">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="custom" id="custom" />
                      <Label htmlFor="custom" className="text-sm cursor-pointer font-medium">Use custom master folder</Label>
                    </div>
                    
                    {settings.outputRouting === 'custom' && (
                      <div className="flex gap-2 ml-6 mt-1 animate-in fade-in slide-in-from-top-1">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="flex-1 flex justify-start truncate border-primary/30 hover:border-primary/60 bg-primary/5" 
                          onClick={handleSelectFolder}
                        >
                          <FolderSearch className="w-3.5 h-3.5 mr-2 text-primary shrink-0" />
                          <span className="truncate text-xs">
                            {settings.customOutputPath || "Click to browse..."}
                          </span>
                        </Button>
                      </div>
                    )}
                  </div>
                </RadioGroup>

                <Button 
                  variant="secondary" 
                  className="w-full flex items-center gap-2 mt-2 bg-secondary/60 hover:bg-secondary border border-border/50"
                  onClick={handleOpenOutputFolder}
                >
                  <FolderOpen className="w-4 h-4 text-primary" />
                  Open Output Folder
                </Button>

              </div>

              <div className="space-y-4">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5" /> Hardware Guardrails
                </h3>
               <div className="bg-background/50 p-4 rounded-xl border border-border/50">
                  <div className="flex justify-between mb-4">
                    <span className="text-sm font-medium">Leave free threads</span>
                    <span className="text-sm font-black text-primary">{settings.freeCpuCores}</span>
                  </div>
                  <Slider 
                    value={[settings.freeCpuCores]} 
                    max={maxThreads - 1} min={0} step={1} 
                    onValueChange={(vals) => updateSetting('freeCpuCores', vals[0])}
                  />
                  <p className="text-[10px] text-muted-foreground mt-4 leading-relaxed">
                    Your PC has <strong>{maxThreads} total threads</strong>. Reserving threads prevents your PC from freezing during heavy 4K encoding.
                  </p>
                </div>
              </div>


              <div className="space-y-4">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-2">
                  <Power className="w-3.5 h-3.5" /> Automation
                </h3>
                <div className="space-y-5 bg-background/50 p-4 rounded-xl border border-border/50">
                  
                  <div className="flex items-center justify-between">
                    <Label htmlFor="delete" className="text-sm flex items-center gap-2 cursor-pointer font-medium">
                      <Trash className="w-4 h-4 text-destructive" /> Delete original
                    </Label>
                    <Switch id="delete" checked={settings.deleteOriginal} onCheckedChange={(val) => updateSetting('deleteOriginal', val)} />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="shutdown" className="text-sm flex items-center gap-2 cursor-pointer font-medium">
                      <Power className="w-4 h-4 text-orange-400" /> Auto-Shutdown
                    </Label>
                    <Switch id="shutdown" checked={settings.shutdownOnFinish} onCheckedChange={(val) => updateSetting('shutdownOnFinish', val)} />
                  </div>

                  <div className="flex flex-col gap-3 pt-3 border-t border-border/50">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="sound" className="text-sm flex items-center gap-2 cursor-pointer font-medium">
                        <Volume2 className="w-4 h-4 text-primary" /> Play completion sound
                      </Label>
                      <Switch id="sound" checked={settings.playSoundOnFinish} onCheckedChange={(val) => updateSetting('playSoundOnFinish', val)} />
                    </div>
                    
                    {/* Custom Audio File Picker */}
                    {settings.playSoundOnFinish && (
                      <div className="flex gap-2 animate-in fade-in slide-in-from-top-1">
                        <Button variant="outline" size="sm" className="flex-1 truncate text-xs justify-start" onClick={handleSelectAudio}>
                          <Music className="w-3.5 h-3.5 mr-2 text-primary shrink-0" />
                          <span className="truncate">{settings.customSoundPath ? settings.customSoundPath.split('\\').pop() : "Default System Beep"}</span>
                        </Button>
                        {settings.customSoundPath && (
                          <Button variant="ghost" size="icon" className="w-9 h-9 shrink-0 hover:text-destructive" onClick={() => updateSetting('customSoundPath', '')}>
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                </div>
              </div>

            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}