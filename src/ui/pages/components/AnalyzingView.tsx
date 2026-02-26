import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Zap, Cpu, Sparkles, Activity, FileSearch, Film } from 'lucide-react';

// The steps the "AI" is taking. It will cycle through these to keep the user patient.
const PROCESSING_STEPS = [
  { text: "Extracting video DNA & colorimetry...", icon: FileSearch, color: "text-blue-400" },
  { text: "Analyzing motion vectors & sensor noise...", icon: Activity, color: "text-indigo-400" },
  { text: "Generating lossless reference clip...", icon: Film, color: "text-purple-400" },
  { text: "Benchmarking Max Quality (CRF) profile...", icon: Cpu, color: "text-pink-400" },
  { text: "Benchmarking Balanced profile...", icon: Zap, color: "text-yellow-400" },
  { text: "Benchmarking Max Compression profile...", icon: Sparkles, color: "text-emerald-400" },
  { text: "Finalizing VMAF quality predictions...", icon: Activity, color: "text-primary" },
];

export function AnalyzingView() {
  const [stepIndex, setStepIndex] = useState(0);

  // Cycle through the text steps every 8 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((prev) => {
        // Stop at the last step so it doesn't loop back to the beginning awkwardly
        if (prev === PROCESSING_STEPS.length - 1) return prev;
        return prev + 1;
      });
    }, 8000);

    return () => clearInterval(interval);
  }, []);

  const CurrentIcon = PROCESSING_STEPS[stepIndex].icon;

  return (
    <motion.div
      key="analyzing"
      initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
      animate={{ opacity: 1, backdropFilter: "blur(12px)" }}
      exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
      className="absolute inset-0 z-50 bg-background/80 flex flex-col items-center justify-center"
    >
      {/* Animated Orb Container */}
      <div className="relative flex items-center justify-center w-40 h-40 mb-8">
        {/* Deep background glow */}
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-3xl animate-pulse" />
        
        {/* Outer slow spinning ring */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 12, ease: "linear" }}
          className="absolute inset-0 rounded-full border-t-2 border-r-2 border-primary/30"
        />
        
        {/* Inner fast reverse spinning ring */}
        <motion.div
          animate={{ rotate: -360 }}
          transition={{ repeat: Infinity, duration: 7, ease: "linear" }}
          className="absolute inset-4 rounded-full border-b-2 border-l-2 border-purple-500/40"
        />

        {/* Center Icons */}
        <div className="relative flex items-center justify-center bg-background/50 rounded-full p-4 border border-white/10 shadow-2xl backdrop-blur-md">
          <Loader2 className="w-12 h-12 text-primary animate-spin" strokeWidth={1.5} />
          <motion.div 
            key={stepIndex}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            className="absolute"
          >
            <CurrentIcon className={`w-5 h-5 ${PROCESSING_STEPS[stepIndex].color}`} />
          </motion.div>
        </div>
      </div>

      {/* Main Title */}
      <h2 className="text-3xl font-bold text-foreground mb-6 tracking-tight">
        Engine <span className="text-primary">Processing</span>
      </h2>

      {/* Dynamic Text Cycler */}
      <div className="h-8 relative flex items-center justify-center overflow-hidden w-full max-w-md">
        <AnimatePresence mode="popLayout">
          <motion.p
            key={stepIndex}
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -20, opacity: 0 }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
            className="text-muted-foreground font-mono text-sm absolute text-center"
          >
            {PROCESSING_STEPS[stepIndex].text}
          </motion.p>
        </AnimatePresence>
      </div>

      {/* Indeterminate "Cylon" style progress bar */}
      <div className="w-64 h-1 bg-white/5 rounded-full mt-8 overflow-hidden relative">
        <motion.div
          className="absolute top-0 bottom-0 w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent"
          animate={{
            x: ["-100%", "300%"],
          }}
          transition={{
            repeat: Infinity,
            duration: 1.5,
            ease: "easeInOut",
          }}
        />
      </div>
      
      <p className="text-xs text-muted-foreground/50 mt-4 font-mono">
        Please wait, rendering physical preview files...
      </p>
    </motion.div>
  );
}