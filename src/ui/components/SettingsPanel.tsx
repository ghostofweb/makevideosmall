import { motion, AnimatePresence } from 'framer-motion';
import { X, HardDrive, Cpu, Power, Volume2, Trash } from 'lucide-react';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Dark overlay to blur the main app */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40"
          />

          {/* The Actual Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 h-full w-96 bg-surface border-l border-white/10 shadow-2xl z-50 flex flex-col"
          >
            {/* Panel Header */}
            <div className="flex justify-between items-center p-6 border-b border-white/5">
              <h2 className="text-xl font-bold text-text-main">Global Settings</h2>
              <button onClick={onClose} className="text-text-muted hover:text-text-main transition-colors cursor-pointer">
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Panel Content (Scrollable) */}
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8">
              
              {/* Output Routing */}
              <div className="flex flex-col gap-4">
                <h3 className="text-sm uppercase tracking-widest text-text-muted font-semibold flex items-center gap-2">
                  <HardDrive className="w-4 h-4" /> Output Routing
                </h3>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input type="radio" name="output" className="accent-primary w-4 h-4" defaultChecked />
                  <span className="text-text-main group-hover:text-primary transition-colors">Save in Original Folder (Adds '_compressed')</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input type="radio" name="output" className="accent-primary w-4 h-4" />
                  <span className="text-text-main group-hover:text-primary transition-colors">Save to Custom Folder...</span>
                </label>
              </div>

              {/* Hardware Guardrails */}
              <div className="flex flex-col gap-4">
                <h3 className="text-sm uppercase tracking-widest text-text-muted font-semibold flex items-center gap-2">
                  <Cpu className="w-4 h-4" /> Hardware Guardrails
                </h3>
                <div className="bg-background/50 p-4 rounded-lg border border-white/5">
                  <div className="flex justify-between mb-2">
                    <span className="text-text-main">Leave CPU Cores Free</span>
                    <span className="text-primary font-bold">2 Cores</span>
                  </div>
                  <input type="range" min="0" max="8" defaultValue="2" className="w-full accent-primary cursor-pointer" />
                  <p className="text-xs text-text-muted mt-2">Prevents the encoder from freezing your PC while you work.</p>
                </div>
              </div>

              {/* Automation & Lifestyle */}
              <div className="flex flex-col gap-4">
                <h3 className="text-sm uppercase tracking-widest text-text-muted font-semibold flex items-center gap-2">
                  <Power className="w-4 h-4" /> Automation & Lifestyle
                </h3>
                
                <label className="flex items-center justify-between cursor-pointer p-3 hover:bg-white/5 rounded-lg transition-colors">
                  <span className="text-text-main flex items-center gap-2"><Trash className="w-4 h-4 text-red-400"/> Delete Original File</span>
                  <input type="checkbox" className="accent-red-500 w-5 h-5 cursor-pointer" />
                </label>

                <label className="flex items-center justify-between cursor-pointer p-3 hover:bg-white/5 rounded-lg transition-colors">
                  <span className="text-text-main flex items-center gap-2"><Power className="w-4 h-4 text-orange-400"/> Shutdown PC on Finish</span>
                  <input type="checkbox" className="accent-orange-500 w-5 h-5 cursor-pointer" />
                </label>

                <label className="flex items-center justify-between cursor-pointer p-3 hover:bg-white/5 rounded-lg transition-colors">
                  <span className="text-text-main flex items-center gap-2"><Volume2 className="w-4 h-4 text-primary"/> Play Sound on Finish</span>
                  <input type="checkbox" className="accent-primary w-5 h-5 cursor-pointer" defaultChecked />
                </label>
              </div>

            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}