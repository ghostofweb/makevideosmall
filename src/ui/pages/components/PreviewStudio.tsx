import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, SlidersHorizontal, CheckCircle2, Zap, Activity, FileVideo, AlertCircle } from 'lucide-react';
import { ReactCompareSlider } from 'react-compare-slider';
import { useState, useRef, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface PreviewStudioProps {
  file: any;
  onBack: () => void;
  selectedPreset: string;
  setSelectedPreset: (val: string) => void;
  onEncode: (preset: string) => void;
}

export function PreviewStudio({ file, onBack, selectedPreset, setSelectedPreset, onEncode }: PreviewStudioProps) {
  const [videoErrors, setVideoErrors] = useState<string[]>([]);
  const [videosLoaded, setVideosLoaded] = useState({ orig: false, comp: false });
  const videoRefOriginal = useRef<HTMLVideoElement>(null);
  const videoRefCompressed = useRef<HTMLVideoElement>(null);

  const payload = file?.previewData;

  useEffect(() => {
    const orig = videoRefOriginal.current;
    const comp = videoRefCompressed.current;
    if (!orig || !comp) return;

    const syncVideos = () => {
      if (orig.paused && !orig.ended) orig.play();
      if (comp.paused && !comp.ended) comp.play();

      const timeDiff = Math.abs(orig.currentTime - comp.currentTime);
      if (timeDiff > 0.1) {
        const targetTime = Math.min(orig.currentTime, comp.currentTime);
        orig.currentTime = targetTime;
        comp.currentTime = targetTime;
      }
    };

    const interval = setInterval(syncVideos, 300);

    const onLoop = () => {
      setTimeout(() => {
        if (orig.currentTime > 0.5 || comp.currentTime > 0.5) {
          const targetTime = Math.min(orig.currentTime, comp.currentTime);
          orig.currentTime = targetTime;
          comp.currentTime = targetTime;
        }
      }, 10);
    };

    orig.addEventListener('ended', onLoop);
    comp.addEventListener('ended', onLoop);

    return () => {
      clearInterval(interval);
      orig.removeEventListener('ended', onLoop);
      comp.removeEventListener('ended', onLoop);
    };
  }, []);

  useEffect(() => {
    const orig = videoRefOriginal.current;
    const comp = videoRefCompressed.current;
    if (orig && comp) {
      orig.currentTime = 0;
      comp.currentTime = 0;
      orig.play();
      comp.play();
    }
  }, [selectedPreset]);

  if (!payload || payload.status !== 'success') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-40 bg-background flex flex-col items-center justify-center p-6"
      >
        <div className="relative">
          <Activity className="w-16 h-16 text-primary animate-pulse" />
          <motion.div
            className="absolute inset-0 rounded-full border-4 border-primary/30"
            animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        </div>
        <h2 className="text-2xl font-bold mt-6 bg-gradient-to-r from-primary to-purple-400 bg-clip-text text-transparent">
          Initializing AI Preview
        </h2>
        <p className="text-muted-foreground mt-2">Extracting video essence…</p>
        <Button onClick={onBack} variant="outline" className="mt-8 border-border/50">
          <ChevronLeft className="w-4 h-4 mr-2" /> Return
        </Button>
      </motion.div>
    );
  }

  const { dna, videos } = payload;
  const estimates = videos.previews;

  const formatVidPath = (path: string) => {
    if (!path) return '';
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    return `file://${encodeURI(normalized)}`; 
  };

  const origVid = formatVidPath(videos.original);
  const currentPreviewVid = formatVidPath(estimates[selectedPreset].video_path);
  const activeStats = estimates[selectedPreset];

  const containerVariants = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } },
  };

  return (
    <motion.div
      key="preview"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className="absolute inset-0 z-40 bg-background flex flex-col p-4 sm:p-6 gap-4 sm:gap-6 overflow-hidden"
    >
      <motion.div
        className="fixed inset-0 pointer-events-none opacity-20"
        animate={{
          background: [
            'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)',
            'radial-gradient(circle at 80% 70%, rgba(99,102,241,0.2) 0%, transparent 50%)',
            'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)',
          ],
        }}
        transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
      />

      <motion.div
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="shrink-0 relative z-10 flex flex-wrap items-center justify-between gap-3 bg-card/70 backdrop-blur-md border border-border/50 rounded-2xl p-3 shadow-sm"
      >
        <Button onClick={onBack} variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" /> Back
        </Button>
        <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
          <SlidersHorizontal className="w-5 h-5 text-primary" />
          Visual Preview Studio
        </h2>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary/80 rounded-full border border-border/50 max-w-[250px] sm:max-w-xs truncate">
          <FileVideo className="w-4 h-4 text-primary shrink-0" />
          <span className="font-mono text-xs truncate">{file.name}</span>
        </div>
      </motion.div>

      <div className="relative z-10 flex-1 flex flex-col md:flex-row gap-4 sm:gap-6 min-h-0 overflow-hidden">
        
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className="flex-1 flex flex-col min-h-[200px] sm:min-h-[300px] rounded-2xl overflow-hidden bg-black/40 border border-border/50 shadow-2xl relative"
        >
          <ReactCompareSlider
            className="w-full h-full"
            itemOne={
              <div className="relative w-full h-full bg-black">
                <video
                  ref={videoRefOriginal}
                  src={origVid}
                  autoPlay loop muted playsInline preload="auto"
                  className="w-full h-full object-contain"
                  onLoadedData={() => setVideosLoaded(prev => ({ ...prev, orig: true }))}
                  onError={(e) => {
                    console.error('Original video error', e);
                    setVideoErrors(prev => [...prev, 'Original']);
                  }}
                />
                {!videosLoaded.orig && !videoErrors.includes('Original') && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Activity className="w-8 h-8 text-primary animate-spin" />
                  </div>
                )}
              </div>
            }
            itemTwo={
              <div className="relative w-full h-full bg-black">
                <video
                  ref={videoRefCompressed}
                  src={currentPreviewVid}
                  key={selectedPreset}
                  autoPlay loop muted playsInline preload="auto"
                  className="w-full h-full object-contain"
                  onLoadedData={() => setVideosLoaded(prev => ({ ...prev, comp: true }))}
                  onError={(e) => {
                    console.error('Compressed video error', e);
                    setVideoErrors(prev => [...prev, 'Compressed']);
                  }}
                />
                {!videosLoaded.comp && !videoErrors.includes('Compressed') && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Activity className="w-8 h-8 text-primary animate-spin" />
                  </div>
                )}
              </div>
            }
          />
          <div className="absolute top-4 left-4 right-4 flex justify-between pointer-events-none z-10">
            <Badge variant="secondary" className="bg-black/80 text-white/90 border-white/10 backdrop-blur-md shadow-lg">
              Original
            </Badge>
            <Badge className="bg-primary/90 text-primary-foreground border-primary/50 backdrop-blur-md shadow-[0_0_15px_rgba(99,102,241,0.5)] transition-all">
              AV1 (CRF {activeStats.crf_used})
            </Badge>
          </div>
          {videoErrors.length > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-destructive/90 text-destructive-foreground text-xs px-4 py-2 rounded-full flex items-center gap-2 shadow-lg z-20">
              <AlertCircle className="w-4 h-4" />
              Failed to load: {videoErrors.join(', ')}
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
          className="w-full md:w-96 shrink-0 flex flex-col h-full min-h-0"
        >
          <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-6 pr-2">
            <Card className="border-border/50 bg-card/70 backdrop-blur-sm shadow-md shrink-0">
              <CardContent className="p-5">
                <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-bold mb-4 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-purple-400" />
                  AI Treatment Plan
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-[10px]">RESOLUTION</p>
                    <p className="font-mono font-bold truncate">{dna.width}x{dna.height}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-[10px]">FPS</p>
                    <p className="font-mono font-bold">{dna.fps.toFixed(2)}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-[10px]">CODEC</p>
                    <p className="font-mono font-bold truncate">{dna.v_codec}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-[10px]">BIT DEPTH</p>
                    <p className="font-mono font-bold truncate">{dna.bit_depth}-bit {dna.is_hdr ? 'HDR' : 'SDR'}</p>
                  </div>
                  <div className="col-span-1 sm:col-span-2 space-y-1">
                    <p className="text-muted-foreground text-[10px]">SENSOR CLONE</p>
                    <p className="text-indigo-400 font-bold truncate">{dna.noise_profile}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3 shrink-0">
              <h3 className="text-xs uppercase tracking-widest text-muted-foreground font-bold ml-1 flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-400" /> Target Profile
              </h3>
              <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-3">
                {['max', 'balanced', 'fast'].map((key) => {
                  const presetData = estimates[key];
                  const isSelected = selectedPreset === key;
                  const titles: Record<string, string> = {
                    max: 'Max Quality (Slow)',
                    balanced: 'Balanced (Medium)',
                    fast: 'Max Compression (Fast)',
                  };

                  return (
                    <motion.div
                      key={key}
                      variants={itemVariants}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSelectedPreset(key)}
                      className={`relative flex items-center justify-between p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 
                        ${isSelected ? 'border-primary bg-primary/10 shadow-[0_0_20px_rgba(99,102,241,0.2)]' : 'border-border/50 bg-card/50 hover:border-border hover:bg-card/80'}`}
                    >
                      <div className="flex flex-col gap-1">
                        <span className={`font-bold ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                          {titles[key]}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                          <span className="flex items-center gap-1">
                            <span className="text-green-400">▼</span> {presetData.size_formatted}
                          </span>
                          <span className="w-1 h-1 rounded-full bg-border" />
                          <span className="flex items-center gap-1">
                            <span className="text-yellow-400">⏱️</span> {presetData.time_formatted}
                          </span>
                        </span>
                      </div>
                      {isSelected && (
                        <motion.div initial={{ scale: 0, rotate: -180 }} animate={{ scale: 1, rotate: 0 }} className="absolute right-4">
                          <CheckCircle2 className="w-6 h-6 text-primary" />
                        </motion.div>
                      )}
                    </motion.div>
                  );
                })}
              </motion.div>
            </div>
          </div>

          <div className="shrink-0 pt-4 mt-4 lg:mt-2 border-t border-border/30 sticky bottom-0 bg-background/95 backdrop-blur-sm lg:static lg:bg-transparent lg:backdrop-blur-none z-20 pb-2 lg:pb-0">
            <Button
              size="lg"
              className="w-full h-12 md:h-14 text-sm md:text-base font-bold bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_20px_rgba(99,102,241,0.4)]"
              onClick={() => onEncode(selectedPreset)} // 🔴 Cleaned this up! Just triggers the modal now.
            >
              <Zap className="w-4 h-4 md:w-5 md:h-5 mr-2 fill-current" /> ENGAGE MASTER ENCODE
            </Button>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}