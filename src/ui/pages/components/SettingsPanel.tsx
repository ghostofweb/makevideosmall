import { motion, AnimatePresence } from 'framer-motion';
import { X, HardDrive, Cpu, Power, Volume2, Trash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
          />
          <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 h-full w-80 bg-card border-l border-border shadow-2xl z-50 flex flex-col"
            >
             <div className="flex justify-between items-center p-4 border-b border-border/50">
              <h2 className="text-sm font-bold text-foreground">Global Settings</h2>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Output Routing */}
              <div className="space-y-3">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-1">
                  <HardDrive className="w-3 h-3" /> Output Routing
                </h3>
                <RadioGroup defaultValue="original">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="original" id="original" />
                    <Label htmlFor="original" className="text-xs">Save in original folder</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="custom" id="custom" />
                    <Label htmlFor="custom" className="text-xs">Choose custom folder…</Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Hardware Guardrails */}
              <div className="space-y-3">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-1">
                  <Cpu className="w-3 h-3" /> Hardware Guardrails
                </h3>
               <div className="bg-background/50 p-3 rounded border border-border/50">
                  <div className="flex justify-between mb-1">
                    <span className="text-xs">Free CPU cores</span>
                    <span className="text-xs font-bold text-primary">2 cores</span>
                  </div>
                  <Slider defaultValue={[2]} max={8} step={1} />
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Prevents encoder from freezing your PC.
                  </p>
                </div>
              </div>

              {/* Automation */}
              <div className="space-y-3">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-semibold flex items-center gap-1">
                  <Power className="w-3 h-3" /> Automation
                </h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="delete" className="text-xs flex items-center gap-1">
                      <Trash className="w-3 h-3 text-destructive" /> Delete original
                    </Label>
                    <Switch id="delete" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="shutdown" className="text-xs flex items-center gap-1">
                      <Power className="w-3 h-3 text-orange-400" /> Shutdown on finish
                    </Label>
                    <Switch id="shutdown" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sound" className="text-xs flex items-center gap-1">
                      <Volume2 className="w-3 h-3 text-primary" /> Play sound on finish
                    </Label>
                    <Switch id="sound" defaultChecked />
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