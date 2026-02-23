import { motion } from 'framer-motion';
import { ChevronLeft, SlidersHorizontal, CheckCircle2, Zap } from 'lucide-react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { type QueuedFile } from '../types.ts';
interface PreviewStudioProps {
  file: QueuedFile;
  onBack: () => void;
  selectedPreset: number;
  setSelectedPreset: (val: number) => void;
}

export function PreviewStudio({ file, onBack, selectedPreset, setSelectedPreset }: PreviewStudioProps) {
  
  // We map the 3 presets to 3 different "mock" images so the user can see the difference
  const previewImages: Record<number, string> = {
    1: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=100&w=1920&auto=format&fit=crop", // Max (Crisp)
    2: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=1920&auto=format&fit=crop",  // Balanced
    3: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=50&w=1920&auto=format&fit=crop&blur=2" // Fast (Slightly softer)
  };

  return (
    <motion.div 
      key="preview"
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute inset-0 z-40 bg-background flex flex-col p-8 gap-6 overflow-y-auto custom-scrollbar"
    >
      <div className="flex items-center justify-between shrink-0">
        <button onClick={onBack} className="flex items-center gap-2 text-text-muted hover:text-white transition-colors cursor-pointer">
          <ChevronLeft className="w-5 h-5" /> Back to Ingest
        </button>
        <h2 className="text-xl font-bold text-text-main flex items-center gap-2">
          <SlidersHorizontal className="w-5 h-5 text-primary" /> Visual Preview Studio
        </h2>
        <div className="px-4 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-md font-mono text-sm">
          {file?.name}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-8 flex-1 min-h-[500px]">
        {/* LEFT: Dynamic Compare Slider */}
        <div className="flex-1 rounded-2xl border-2 border-white/10 overflow-hidden bg-black flex flex-col shadow-2xl relative group">
          <ReactCompareSlider
            className="flex-1 w-full h-full object-cover"
            itemOne={<ReactCompareSliderImage src="https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=1920&auto=format&fit=crop" alt="Original" style={{ filter: 'blur(3px) contrast(0.9)' }} />}
            itemTwo={<ReactCompareSliderImage src={previewImages[selectedPreset]} alt="Compressed" />}
          />
          <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1 rounded-md text-sm font-semibold text-white/80 border border-white/10 pointer-events-none">
            Original Source (Noisy)
          </div>
          <div className="absolute top-4 right-4 bg-primary/80 backdrop-blur-md px-3 py-1 rounded-md text-sm font-semibold text-white border border-primary/50 pointer-events-none transition-all">
            Previewing: Preset {selectedPreset === 1 ? '4 (Max)' : selectedPreset === 2 ? '5 (Balanced)' : '6 (Fastest)'}
          </div>
        </div>

        {/* RIGHT: Settings Panel */}
        <div className="w-full lg:w-96 flex flex-col gap-6 shrink-0">
          <div className="bg-surface border border-white/10 p-5 rounded-xl shadow-lg">
            <h3 className="text-sm uppercase tracking-widest text-text-muted font-bold mb-4">🧠 AI Treatment Plan</h3>
            <ul className="flex flex-col gap-3 text-sm">
              <li className="flex justify-between border-b border-white/5 pb-2">
                <span className="text-text-muted">Diagnosis</span>
                <span className="text-orange-400 font-semibold text-right">Starved Source<br/>(Lazarus Active)</span>
              </li>
              <li className="flex justify-between border-b border-white/5 pb-2">
                <span className="text-text-muted">Geometry</span>
                <span className="text-text-main font-semibold">1080p Crop</span>
              </li>
              <li className="flex justify-between">
                <span className="text-text-muted">Oracle Estimate</span>
                <span className="text-green-400 font-bold">Saving ~65.2% Space</span>
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm uppercase tracking-widest text-text-muted font-bold ml-1">Select Engine Speed</h3>
            {[
              { id: 1, title: 'Max Quality (Preset 4)', size: '~1.2 GB', time: '120 mins' },
              { id: 2, title: 'Balanced (Preset 5)', size: '~1.0 GB', time: '65 mins' },
              { id: 3, title: 'Fastest (Preset 6)', size: '~900 MB', time: '35 mins' }
            ].map((preset) => (
              <div 
                key={preset.id}
                onClick={() => setSelectedPreset(preset.id)}
                className={`relative flex items-center justify-between p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 
                  ${selectedPreset === preset.id ? 'border-primary bg-primary/10 shadow-[0_0_20px_rgba(99,102,241,0.15)]' : 'border-white/5 bg-surface hover:border-white/20'}`}
              >
                <div className="flex flex-col gap-1">
                  <span className={`font-bold ${selectedPreset === preset.id ? 'text-white' : 'text-text-main'}`}>{preset.title}</span>
                  <span className="text-xs text-text-muted">Est. Size: <span className="text-text-main font-mono">{preset.size}</span> | Time: <span className="text-text-main">{preset.time}</span></span>
                </div>
                {selectedPreset === preset.id && <CheckCircle2 className="w-6 h-6 text-primary absolute right-4" />}
              </div>
            ))}
          </div>

          <button className="mt-auto py-4 bg-primary hover:bg-primary-hover text-white text-lg font-bold rounded-xl shadow-lg shadow-primary/20 cursor-pointer flex items-center justify-center gap-2">
            <Zap className="w-5 h-5"/> ENGAGE MASTER ENCODE
          </button>
        </div>
      </div>
    </motion.div>
  );
}