import { motion } from 'framer-motion';
import { Loader2, Zap } from 'lucide-react';

export function AnalyzingView() {
  return (
    <motion.div 
      key="analyzing"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      className="absolute inset-0 z-50 bg-background flex flex-col items-center justify-center"
    >
      <div className="relative">
        <Loader2 className="w-20 h-20 text-primary animate-spin" strokeWidth={1.5} />
        <Zap className="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-50 animate-pulse" />
      </div>
      <h2 className="text-3xl font-bold mt-8 text-text-main">Extracting Video DNA...</h2>
      <p className="text-text-muted text-lg mt-2">Generating Visual Previews (Est. 15 secs)</p>
      
      {/* Fake Progress Bar */}
      <div className="w-64 h-2 bg-surface rounded-full mt-6 overflow-hidden">
        <motion.div 
          initial={{ width: "0%" }} 
          animate={{ width: "100%" }} 
          transition={{ duration: 2.5, ease: "linear" }} 
          className="h-full bg-primary"
        />
      </div>
    </motion.div>
  );
}