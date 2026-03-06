// @ts-nocheck
import { useState, useRef, useEffect, type JSX } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  UploadCloud, FileVideo, FolderArchive, XCircle, Activity, Search,
  Eye, Play, BrainCircuit, Sparkles, Info, Save, Zap,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  ListOrdered, Loader2, X,
  Power
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { type DragState, type QueuedFile, type AppView } from '../types';
import { Queue } from './Queue';
import { AnalyzingView } from './components/AnalyzingView';
import { PreviewStudio } from './components/PreviewStudio';
import { DetailedStats } from './components/DetailedStats';
import { AnimatedLogo } from './components/AnimatedLogo';

const { ipcRenderer, webUtils } = window.require('electron');

function formatBytes(bytes: number) {
  if (!+bytes) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB'][i]}`;
}

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
} as any;

// ----------------------------------------------------------------------
// FileListItem Subcomponent
// ----------------------------------------------------------------------
interface FileListItemProps {
  file: QueuedFile;
  onRemove: (id: string) => void;
  onAnalyze: (id: string) => void;
  onPreview: (id: string) => void;
  onCompress: (id: string, preset: string) => void;
  onPresetChange: (id: string, preset: string) => void;
  renderPresetOption: (file: QueuedFile, preset: string, label: string) => JSX.Element;
}

function FileListItem({
  file, onRemove, onAnalyze, onPreview, onCompress, onPresetChange, renderPresetOption,
}: FileListItemProps) {
  
  const isAnalyzed = file.analysisState === 'done';
  const estimate = isAnalyzed
    ? file.previewData?.videos?.previews[file.preset]?.size_formatted
    : "Awaiting Analysis";

  const savings = isAnalyzed
    ? '-' + file.previewData?.videos?.previews[file.preset]?.savings + '%'
    : null;

  return (
    <motion.div
      key={file.id}
      variants={itemVariants}
      layout
      exit={{ opacity: 0, scale: 0.95 }}
      className="flex flex-wrap items-center justify-between p-3 gap-y-3 bg-card/60 border border-border/50 rounded-lg group hover:border-primary/50 transition-all w-full overflow-hidden"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
        <FileVideo className="w-5 h-5 text-primary shrink-0" />
        <div className="flex flex-col min-w-0 flex-1 overflow-hidden">
          <span className="text-foreground truncate font-medium text-sm block w-full">
            {file.name.slice(0, 25) + (file.name.length > 25 ? '...' : '')}
          </span>
          <div className="flex items-center gap-2 text-[10px] sm:text-xs text-muted-foreground mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
            <span className="font-mono">{formatBytes(file.size)}</span>
            <Separator orientation="vertical" className="h-3 mx-1 bg-border/50" />
            <span className="capitalize font-semibold text-primary/80">{file.preset}</span>
            
            <span className={`flex items-center gap-1 ${!isAnalyzed ? 'opacity-60 italic' : 'font-medium'}`}>
              {!isAnalyzed && <Sparkles className="w-3 h-3" />}
              {estimate}
            </span>
            
            {savings && (
              <Badge variant="outline" className="text-[9px] sm:text-[10px] px-1 py-0 h-4 border-primary/30 text-primary">
                {savings}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-end shrink-0 ml-auto w-full sm:w-auto">
        <div className="flex items-center gap-1">
          <Select value={file.preset} onValueChange={(val) => onPresetChange(file.id, val)}>
            <SelectTrigger className="w-30 h-7 text-xs"><SelectValue placeholder="Preset" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="max">{renderPresetOption(file, 'max', 'Max')}</SelectItem>
              <SelectItem value="balanced">{renderPresetOption(file, 'balanced', 'Balanced')}</SelectItem>
              <SelectItem value="fast">{renderPresetOption(file, 'fast', 'Fast')}</SelectItem>
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground shrink-0" onClick={(e) => e.stopPropagation()}>
                <Info className="w-4 h-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="text-xs max-w-xs p-3">
              <div className="space-y-1"><p><strong>Max:</strong> Best visual quality.</p><p><strong>Balanced:</strong> Great quality, normal speed.</p><p><strong>Fast:</strong> Fastest processing.</p></div>
            </PopoverContent>
          </Popover>
        </div>

        <AnimatePresence mode="wait">
          {file.analysisState === 'none' && (
            <motion.div key="ai" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" className="h-7 px-2 text-xs border-purple-500/30 text-purple-400 hover:bg-purple-500/10" onClick={(e) => { e.stopPropagation(); onAnalyze(file.id); }}><BrainCircuit className="w-3 h-3 mr-1" /> Analyze</Button></TooltipTrigger><TooltipContent>Run AI compression estimates</TooltipContent></Tooltip>
            </motion.div>
          )}
          {file.analysisState === 'queued_for_analysis' && (
            <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Button variant="outline" size="sm" disabled className="h-7 px-2 text-xs border-purple-500/20 text-purple-400/70"><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Queued</Button>
            </motion.div>
          )}
          {file.analysisState === 'analyzing' && (
            <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Button variant="outline" size="icon" disabled className="h-7 w-7 flex items-center justify-center shrink-0 border-purple-500/30 bg-purple-500/10"><AnimatedLogo className="w-8 h-8 text-purple-400 scale-[1.5]" /></Button>
            </motion.div>
          )}
          {file.analysisState === 'done' && (
            <motion.div key="preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Tooltip><TooltipTrigger asChild><Button variant="secondary" size="sm" className="h-7 px-2 text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-100" onClick={(e) => { e.stopPropagation(); onPreview(file.id); }}><Eye className="w-3 h-3 mr-1" /> Preview</Button></TooltipTrigger><TooltipContent>Compare visual quality.</TooltipContent></Tooltip>
            </motion.div>
          )}
        </AnimatePresence>

        <Tooltip><TooltipTrigger asChild><Button size="sm" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); onCompress(file.id, file.preset); }}>Compress</Button></TooltipTrigger><TooltipContent>Send to Encode Queue</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0" onClick={(e) => { e.stopPropagation(); onRemove(file.id); }}><XCircle className="w-4 h-4" /></Button></TooltipTrigger><TooltipContent>Remove file</TooltipContent></Tooltip>
      </div>
    </motion.div>
  );
}

// ----------------------------------------------------------------------
// Main Home Component
// ----------------------------------------------------------------------
export function Home() {
  const [dragState, setDragState] = useState<DragState>('idle');
  const [currentView, setCurrentView] = useState<AppView>('workspace');
  const [appStep, setAppStep] = useState<'ingest' | 'analyzing' | 'preview'>('ingest');
  
  const [shutdownCountdown, setShutdownCountdown] = useState<number | null>(null);
  
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('balanced');
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [showAnalysisQueue, setShowAnalysisQueue] = useState(false); 

  const [renameModal, setRenameModal] = useState<{ isOpen: boolean; fileId: string; preset: string; source: 'ingest' | 'studio'; } | null>(null);
  const [tempFileName, setTempFileName] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 🔴 NEW: The Memory Tracker for the Queue
  const wasEncoding = useRef(false);

  const ingestFiles = files.filter((f) => f.queueState === 'ingest');
  const processingCount = files.filter((f) => f.queueState === 'processing').length;
  const queuedCount = files.filter((f) => f.queueState === 'queued').length;
  const completedCount = files.filter((f) => f.queueState === 'completed').length;
  const totalSizeBytes = ingestFiles.reduce((acc, file) => acc + file.size, 0);
  
  const selectedFile = appStep === 'preview' ? files.find((f) => f.id === selectedFileId) : null;

  const activelyAnalyzing = files.find((f) => f.analysisState === 'analyzing');
  const queuedForAnalysis = files.filter((f) => f.analysisState === 'queued_for_analysis');

  useEffect(() => {
    const loadWorkspace = async () => {
      try {
        const result = await ipcRenderer.invoke('load-workspace');
        if (result.success && result.files?.length) setFiles(result.files);
      } catch (e) {}
    };
    loadWorkspace();
  }, []);

  useEffect(() => {
    if (files.length > 0) ipcRenderer.invoke('save-workspace', files).catch(() => {});
  }, [files]);

  useEffect(() => {
    const handleTelemetry = (_event: any, data: any) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id === data.fileId) {
            return {
              ...f, progress: data.progress, eta: data.eta,
              queueState: data.type === 'complete' ? 'completed' : 'processing',
              completedAt: data.type === 'complete' ? Date.now() : f.completedAt,
            };
          }
          return f;
        })
      );
    };
    const handleLogs = (_event: any, data: any) => {
      setFiles((prev) => prev.map((f) => f.id === data.fileId ? { ...f, logs: [...f.logs.slice(-49), data.log] } : f));
    };
    ipcRenderer.on('encode-telemetry', handleTelemetry);
    ipcRenderer.on('encode-log', handleLogs);
    return () => {
      ipcRenderer.removeListener('encode-telemetry', handleTelemetry);
      ipcRenderer.removeListener('encode-log', handleLogs);
    };
  }, []);

  useEffect(() => {
    if (shutdownCountdown === null) return;
    
    if (shutdownCountdown <= 0) {
      ipcRenderer.invoke('shutdown-pc');
      setShutdownCountdown(null);
      return;
    }
    
    const timer = setTimeout(() => {
      setShutdownCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    
    return () => clearTimeout(timer);
  }, [shutdownCountdown]);

  // 🔴 THE BULLETPROOF QUEUE LOGIC
  useEffect(() => {
    // 1. Analysis Queue Manager
    const isAnalyzing = files.some((f) => f.analysisState === 'analyzing');
    if (!isAnalyzing) {
      const nextToAnalyze = files.find((f) => f.analysisState === 'queued_for_analysis');
      if (nextToAnalyze) {
        executeAnalysisJob(nextToAnalyze);
      }
    }

    // 2. Master Encode Queue Manager
    const isEncoding = files.some((f) => f.queueState === 'processing');
    const localQueuedCount = files.filter((f) => f.queueState === 'queued').length;

    // Track if we are currently encoding
    if (isEncoding) {
      wasEncoding.current = true;
    }

    if (!isEncoding) {
      if (localQueuedCount > 0) {
        // Start the next job in line
        const nextToEncode = files.find((f) => f.queueState === 'queued');
        if (nextToEncode) executeEncodeJob(nextToEncode);
      } else if (wasEncoding.current) {
        // 🔴 Trigger: We were encoding, but now we aren't, AND the queue is empty!
        wasEncoding.current = false; // Reset tracker

        const settings = JSON.parse(localStorage.getItem('vb_settings') || '{}');
        
        if (settings.playSoundOnFinish && settings.customSoundPath) {
          const audio = new Audio(`file://${settings.customSoundPath}`);
          
          audio.addEventListener('timeupdate', () => {
            if (audio.currentTime >= 5) {
              audio.pause();
              audio.currentTime = 0;
            }
          });

          audio.play().catch(e => console.error("Could not play sound", e));
        }

        if (settings.shutdownOnFinish) {
          setShutdownCountdown(60); 
          // Turn it off so it doesn't loop
          settings.shutdownOnFinish = false;
          localStorage.setItem('vb_settings', JSON.stringify(settings));
        }
      }
    }
  }, [files]);

  const cleanupPreviews = (file: QueuedFile) => {
    if (file?.previewData?.videos?.previews) {
      const previews = file.previewData.videos.previews;
      const pathsToDelete = [ previews.max?.video_path, previews.balanced?.video_path, previews.fast?.video_path ].filter(Boolean) as string[];
      pathsToDelete.forEach((path) => { ipcRenderer.invoke('delete-physical-file', path).catch(() => {}); });
    }
  };

  const cancelJob = async (id: string) => {
    const file = files.find((f) => f.id === id);
    if (!file) return;
    if (file.queueState === 'processing') {
      toast.error('Aborting the engine...');
      await ipcRenderer.invoke('cancel-encode');
    } else if (file.queueState === 'queued') {
      setFiles((prev) => prev.map((f) => f.id === id ? { ...f, queueState: 'ingest', logs: ['[QUEUE] Removed from queue.'] } : f));
      toast.info('Removed from queue.');
    }
  };

  const executeEncodeJob = async (file: QueuedFile) => {
    setFiles((prev) => prev.map((f) => f.id === file.id ? { ...f, queueState: 'processing', logs: ['[ENGINE] Initializing Encoder...'] } : f));
    const settings = JSON.parse(localStorage.getItem('vb_settings') || '{}');
    try {
      const response = await ipcRenderer.invoke('start-encode', { fileId: file.id, inputPath: file.path, preset: file.preset, customFileName: file.customName, previewsToDelete: [], settings });
      if (response.success) {
        setFiles((prev) => prev.map((f) => f.id === file.id ? { ...f, queueState: 'completed', outputPath: response.outputPath, progress: 100, eta: 'Done' } : f));
      } else {
        toast.error(`Encode failed for ${file.name}`);
        setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, queueState: 'ingest' } : f)));
      }
    } catch (e) {
      setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, queueState: 'ingest' } : f)));
    }
  };

  const analyzeFile = (id: string, overridePath?: string, autoNavigate = false) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'queued_for_analysis' } : f)));
    if (autoNavigate) setAppStep('analyzing');
    toast.success('Added to Analysis Queue'); 
  };

  const executeAnalysisJob = async (file: QueuedFile) => {
    setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, analysisState: 'analyzing' } : f)));
    try {
      const settings = JSON.parse(localStorage.getItem('vb_settings') || '{}');
      const response = await ipcRenderer.invoke('analyze-video', { filePath: file.path, settings });
      if (response.success) {
        setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, analysisState: 'done', previewData: response.data } : f)));
        toast.success('Analysis Complete.');
      } else {
        toast.error('Analysis Failed');
        setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, analysisState: 'none' } : f)));
      }
    } catch (e) {
      setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, analysisState: 'none' } : f)));
    }
  };

  const requestCompression = (id: string, preset: string, source: 'ingest' | 'studio') => {
    const file = files.find((f) => f.id === id);
    if (!file) return;
    setTempFileName(`${file.name.replace(/\.[^/.]+$/, '')}_AV1`);
    setRenameModal({ isOpen: true, fileId: id, preset, source });
  };

  const confirmCompression = () => {
    if (!renameModal) return;
    const { fileId, preset, source } = renameModal;
    setFiles((prev) => prev.map((f) => {
        if (f.id === fileId) {
          cleanupPreviews(f);
          return { ...f, queueState: 'queued', preset, customName: tempFileName, logs: ['[QUEUE] Waiting...'] };
        }
        return f;
      })
    );
    toast.success('Added to Queue');
    setRenameModal(null);
    if (source === 'studio') {
      setAppStep('ingest');
      setSelectedFileId(null);
    }
    setCurrentView('queue');
  };

  const compressAll = () => {
    setFiles((prev) => prev.map((f) => {
        if (f.queueState === 'ingest') {
          cleanupPreviews(f);
          return { ...f, queueState: 'queued', logs: ['[QUEUE] Waiting...'] };
        }
        return f;
      })
    );
    toast.success('All jobs sent to Queue!');
    setCurrentView('queue');
  };

  const processFiles = (fileList: File[]) => {
    const validFiles = (fileList as any[]).filter((f) => {
        const isVideoMime = f.type.startsWith('video/');
        const validExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'];
        return isVideoMime || validExtensions.some((ext) => f.name.toLowerCase().endsWith(ext));
      }).map((f) => {
        let physicalPath = webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(f) : f.path || f.webkitRelativePath || '';
        if (!physicalPath) return null;
        return {
          id: Math.random().toString(36).substr(2, 9),
          path: physicalPath, name: f.name, size: f.size, preset: 'balanced',
          analysisState: 'none' as const, queueState: 'ingest' as const, progress: 0, eta: 'Calculating...', logs: ['[SYSTEM] File ingested.'],
        };
      }).filter(Boolean) as QueuedFile[];

    if (validFiles.length > 0) {
      setFiles((prev) => [...prev, ...validFiles]);
      toast.success(`${validFiles.length} file(s) added.`);
    }
  };

  const updateFilePreset = (id: string, preset: string) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, preset } : f)));

  const removeFile = async (id: string) => {
    const file = files.find((f) => f.id === id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (selectedFileId === id) setSelectedFileId(null);
    if (file) {
      cleanupPreviews(file);
      if (file.analysisState === 'analyzing') await ipcRenderer.invoke('cancel-analysis');
    }
  };

  const toggleLogs = (id: string) => setExpandedLogs((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]));

  const renderPresetOption = (file: QueuedFile, presetValue: string, label: string) => {
    const isDone = file.analysisState === 'done';
    const sizeStr = isDone 
        ? file.previewData?.videos?.previews[presetValue]?.size_formatted 
        : "";

    return (
      <div className="flex justify-between items-center w-full gap-3 pr-1">
        <span>{label}</span>
        {isDone && <span className="text-[10px] font-mono opacity-60"><Sparkles className="w-2.5 h-2.5 inline mr-1 text-purple-400" />{sizeStr}</span>}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <main className="relative flex flex-col h-full bg-background overflow-hidden">
        
        <div className="fixed inset-0 pointer-events-none z-0">
          <motion.div className="absolute inset-0 opacity-20" animate={{ background: [ 'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)', 'radial-gradient(circle at 80% 70%, rgba(99,102,241,0.2) 0%, transparent 50%)', 'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)'] }} transition={{ duration: 20, repeat: Infinity, ease: 'linear' }} />
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: `linear-gradient(rgba(99,102,241,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.1) 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />
        </div>

        <input type="file" ref={fileInputRef} className="hidden" accept="video/*,.mkv,.avi,.mov,.flv,.wmv" multiple onChange={(e) => { if (e.target.files) processFiles(Array.from(e.target.files)); e.target.value = ''; }} />

        {/* Analysis Queue Modal */}
        <AnimatePresence>
          {showAnalysisQueue && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <motion.div 
                initial={{ scale: 0.95, y: 10, opacity: 0 }} 
                animate={{ scale: 1, y: 0, opacity: 1 }} 
                exit={{ scale: 0.95, y: 10, opacity: 0 }} 
                className="bg-background border border-border shadow-[0_0_50px_rgba(0,0,0,0.5)] rounded-2xl w-full max-w-lg flex flex-col relative overflow-hidden"
              >
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 to-indigo-500" />
                <div className="flex justify-between items-center p-5 border-b border-border/50 bg-card/30 shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-purple-500/10 rounded-xl border border-purple-500/20">
                      <BrainCircuit className="w-5 h-5 text-purple-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-foreground">Analysis Queue</h3>
                      <p className="text-xs text-muted-foreground">Deep scanning one file at a time</p>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="rounded-full hover:bg-white/5 shrink-0" onClick={() => setShowAnalysisQueue(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
                <div className="p-5 bg-card/10">
                  <ScrollArea className="h-[280px] pr-4 -mr-4">
                    <div className="flex flex-col gap-3 pb-2">
                      {!activelyAnalyzing && queuedForAnalysis.length === 0 && (
                        <div className="text-center text-muted-foreground text-sm py-12 flex flex-col items-center justify-center">
                          <BrainCircuit className="w-8 h-8 opacity-20 mb-3" />
                          No videos currently in the analysis pipeline.
                        </div>
                      )}
                      {activelyAnalyzing && (
                        <div className="group relative bg-purple-500/10 border border-purple-500/30 rounded-xl p-3 flex items-center gap-3 overflow-hidden shadow-[0_0_15px_rgba(168,85,247,0.1)]">
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.8)]" />
                          <div className="relative flex items-center justify-center shrink-0 w-10 h-10 ml-1">
                             <div className="absolute inset-0 bg-purple-500/20 rounded-full blur-md animate-pulse-ring"></div>
                             <AnimatedLogo className="w-6 h-6 text-purple-400 scale-125" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-purple-50 truncate pr-2" title={activelyAnalyzing.name}>{activelyAnalyzing.name}</p>
                            <p className="text-xs text-purple-400/80 flex items-center gap-1.5 mt-0.5">
                              <span className="relative flex h-2 w-2 shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                              </span>
                              Scanning DNA...
                            </p>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8 text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors" onClick={() => removeFile(activelyAnalyzing.id)}>
                                <XCircle className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Cancel Analysis</TooltipContent>
                          </Tooltip>
                        </div>
                      )}
                      {queuedForAnalysis.map((file, index) => (
                        <div key={file.id} className="bg-card/50 border border-border/50 rounded-xl p-3 flex items-center gap-3 opacity-80 hover:opacity-100 transition-opacity group">
                          <div className="flex items-center justify-center shrink-0 w-8 h-8 rounded-lg bg-background border border-border/50 text-xs font-mono text-muted-foreground">
                            {index + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate pr-2" title={file.name}>{file.name}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><Loader2 className="w-3 h-3 animate-spin" /> Waiting in line...</p>
                          </div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8 text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100" onClick={() => setFiles(prev => prev.map(f => f.id === file.id ? { ...f, analysisState: 'none' } : f))}>
                                <XCircle className="w-4 h-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Remove from Queue</TooltipContent>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rename Modal */}
        <AnimatePresence>
          {renameModal && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} className="bg-card border border-border shadow-2xl rounded-2xl w-full max-w-md p-6 flex flex-col gap-4 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-purple-500" />
                <div className="flex items-center gap-3 mb-2">
                  <div className="p-2 bg-primary/10 rounded-lg"><Save className="w-5 h-5 text-primary" /></div>
                  <div><h3 className="text-lg font-bold">Save Output As...</h3><p className="text-xs text-muted-foreground">Name your master encode file.</p></div>
                </div>
                <div className="flex flex-col gap-2">
                  <input type="text" value={tempFileName} onChange={(e) => setTempFileName(e.target.value)} className="w-full bg-black/50 border border-border/50 text-foreground text-sm rounded-md px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all font-mono" autoFocus placeholder="Enter file name" />
                  <p className="text-[10px] text-muted-foreground text-right mr-1">.mp4 extension will be added automatically</p>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <Button variant="ghost" onClick={() => setRenameModal(null)}>Cancel</Button>
                  <Button onClick={confirmCompression} className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_15px_rgba(99,102,241,0.3)]"><Zap className="w-4 h-4 mr-2 fill-current" /> Start Engine</Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main View (Queue or Workspace) */}
        <AnimatePresence mode="wait">
          {currentView === 'queue' ? (
            <Queue key="view-queue" activeJobs={files.filter((f) => f.queueState !== 'ingest' || f.analysisState === 'analyzing' || f.analysisState === 'queued_for_analysis')} expandedLogs={expandedLogs} toggleLogs={toggleLogs} removeFile={removeFile} cancelJob={cancelJob} onBack={() => setCurrentView('workspace')} />
          ) : (
            <motion.div key="view-workspace" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex-1 flex flex-col h-full min-h-0 p-6 gap-4 overflow-hidden relative z-10">
              
              {/* Header Bar */}
              <div className="relative z-20 flex flex-wrap justify-between items-center gap-3 bg-card/40 backdrop-blur-md border border-border/50 rounded-2xl p-3 shadow-lg shrink-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                    <FolderArchive className="text-primary w-5 h-5" />
                    <span className="text-sm font-medium opacity-50">Workspace</span>
                  </h1>
                  <div className="flex items-center gap-1 ml-4 border-l border-border/50 pl-4">
                    <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => setShowLeftPanel(!showLeftPanel)} className="h-8 w-8 shrink-0">{showLeftPanel ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}</Button></TooltipTrigger><TooltipContent>{showLeftPanel ? 'Hide System Telemetry' : 'Show System Telemetry'}</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => setShowRightPanel(!showRightPanel)} className="h-8 w-8 shrink-0">{showRightPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}</Button></TooltipTrigger><TooltipContent>{showRightPanel ? 'Hide Quick Insights' : 'Show Quick Insights'}</TooltipContent></Tooltip>
                  </div>
                </div>
                
                <div className="flex items-center gap-3">
                  {(activelyAnalyzing || queuedForAnalysis.length > 0) && (
                    <Button onClick={() => setShowAnalysisQueue(true)} variant="outline" className="gap-2 border-purple-500/30 bg-purple-500/10 hover:bg-purple-500/20 text-purple-200 shadow-[0_0_15px_rgba(168,85,247,0.1)] transition-all">
                      <div className="relative flex h-2 w-2 mr-1">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                      </div>
                      Analysis Queue
                      <Badge variant="secondary" className="ml-1 bg-purple-500/20 text-purple-300 border-none">{queuedForAnalysis.length + (activelyAnalyzing ? 1 : 0)}</Badge>
                    </Button>
                  )}

                  <Button onClick={() => setCurrentView('queue')} variant="outline" className="gap-2 border-border/50 bg-background/50 backdrop-blur-sm hover:bg-accent/20 group relative overflow-hidden">
                    <Activity className="w-4 h-4 text-primary group-hover:scale-110 transition-transform" />
                    Master Queue
                    <Badge variant="secondary" className="ml-1 bg-primary/20 text-primary border-none">{processingCount + queuedCount} Active</Badge>
                  </Button>
                </div>
              </div>

              {/* Main Workspace Area */}
              <div className="flex-1 flex gap-4 min-h-0 min-w-0 overflow-hidden">
                <AnimatePresence initial={false}>
                  {showLeftPanel && (
                    <motion.div key="left-panel" initial={{ width: 0 }} animate={{ width: 320 }} exit={{ width: 0 }} transition={{ duration: 0.2, ease: "easeInOut" }} className="shrink-0 hidden lg:block overflow-hidden"><DetailedStats /></motion.div>
                  )}
                </AnimatePresence>

                <div className="flex-1 flex flex-col gap-4 min-w-0 min-h-0 overflow-hidden">
                  <motion.div initial={{ scale: 1 }} animate={{ scale: dragState === 'accept' ? 0.99 : 1 }} transition={{ type: 'spring', stiffness: 400 }} className={`relative border-2 rounded-xl overflow-hidden transition-all duration-300 shrink-0 ${dragState === 'idle' ? 'border-dashed border-border/50 hover:border-border bg-card/20' : 'border-solid border-primary bg-primary/5 shadow-lg shadow-primary/20'}`} onDragOver={(e) => { e.preventDefault(); setDragState('accept'); }} onDragLeave={() => setDragState('idle')} onDrop={(e) => { e.preventDefault(); setDragState('idle'); processFiles(Array.from(e.dataTransfer.files)); }}>
                    <div onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer group">
                      <motion.div whileHover={{ scale: 1.1, rotate: 5 }} transition={{ type: 'spring', stiffness: 300 }}><UploadCloud className="w-16 h-16 mb-3 text-muted-foreground/50 group-hover:text-primary transition-colors" strokeWidth={1.2} /></motion.div>
                      <h2 className="text-xl font-bold text-foreground/80 group-hover:text-foreground transition-colors">Drop Videos to Begin</h2>
                      <p className="text-sm text-muted-foreground">or click to browse</p>
                    </div>
                  </motion.div>

                  {ingestFiles.length > 0 && (
                    <Card className="flex-1 bg-card/40 backdrop-blur-sm border-border/50 shadow-lg flex flex-col min-h-0 overflow-hidden">
                      <CardContent className="p-4 flex-1 flex flex-col gap-3 min-h-0 overflow-hidden">
                        <div className="flex justify-between items-center shrink-0">
                          <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-foreground">Ready for Setup</h3><Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary">{formatBytes(totalSizeBytes)}</Badge></div>
                          <div className="flex gap-2">
                            <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}><Search className="w-4 h-4 mr-1" /> Add More</Button></TooltipTrigger><TooltipContent>Browse for more video files</TooltipContent></Tooltip>
                            <Tooltip><TooltipTrigger asChild><Button size="sm" onClick={compressAll} disabled={ingestFiles.length === 0}><Play className="w-4 h-4 mr-1 fill-current" /> Compress All</Button></TooltipTrigger><TooltipContent>Send all to Master Queue</TooltipContent></Tooltip>
                          </div>
                        </div>
                        <Separator className="bg-border/50 shrink-0" />
                        <div className="flex-1 min-h-0 w-full overflow-hidden">
                          <ScrollArea className="h-full pr-4">
                            <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-2 pb-2">
                              <AnimatePresence>
                                {ingestFiles.map((file) => (
                                  <FileListItem key={file.id} file={file} isSelected={false} onSelect={() => {}} onRemove={removeFile} onAnalyze={(id) => analyzeFile(id, undefined, false)} onPreview={(id) => { setSelectedFileId(id); setAppStep('preview'); }} onCompress={(id, preset) => requestCompression(id, preset, 'ingest')} onPresetChange={updateFilePreset} renderPresetOption={renderPresetOption} />
                                ))}
                              </AnimatePresence>
                            </motion.div>
                          </ScrollArea>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>

                <AnimatePresence initial={false}>
                  {showRightPanel && (
                    <motion.div key="right-panel" initial={{ width: 0 }} animate={{ width: 300 }} exit={{ width: 0 }} transition={{ duration: 0.2, ease: "easeInOut" }} className="shrink-0 hidden lg:block overflow-hidden">
                      <Card className="bg-card/40 backdrop-blur-sm border-border/50 shadow-lg h-full">
                        <CardContent className="p-4 space-y-4">
                          <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" /><h3 className="text-sm font-semibold">Quick Insights</h3></div>
                          <Separator className="bg-border/50" />
                          <div className="space-y-3">
                            <div className="flex justify-between items-center text-sm"><span className="text-muted-foreground">Files ready</span><Badge variant="outline">{ingestFiles.length}</Badge></div>
                            <div className="flex justify-between items-center text-sm"><span className="text-muted-foreground">Processing</span><Badge variant="secondary" className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20">{processingCount}</Badge></div>
                            <div className="flex justify-between items-center text-sm"><span className="text-muted-foreground">Queued</span><Badge variant="secondary" className="bg-blue-500/10 text-blue-400 border-blue-500/20">{queuedCount}</Badge></div>
                            <div className="flex justify-between items-center text-sm"><span className="text-muted-foreground">Completed</span><Badge variant="secondary" className="bg-green-500/10 text-green-400 border-green-500/20">{completedCount}</Badge></div>
                            <div className="flex justify-between items-center text-sm"><span className="text-muted-foreground">Total size</span><span className="font-mono text-xs">{formatBytes(totalSizeBytes)}</span></div>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {appStep === 'analyzing' && <AnalyzingView />}
          {appStep === 'preview' && selectedFile && (
            <PreviewStudio file={selectedFile} onBack={() => setAppStep('ingest')} selectedPreset={selectedPreset} setSelectedPreset={setSelectedPreset} onEncode={(preset) => requestCompression(selectedFile.id, preset, 'studio')} />
          )}
        </AnimatePresence>
        
        {/* 🔴 OVERLAY Z-INDEX 9999 TO COVER EVERYTHING */}
        <AnimatePresence>
          {shutdownCountdown !== null && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ scale: 0.95, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 20 }}
                className="bg-card border border-border/50 shadow-[0_0_50px_rgba(0,0,0,0.5)] rounded-3xl w-full max-w-md overflow-hidden relative flex flex-col items-center p-10 text-center"
              >
                {/* Top accent line */}
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-rose-500" />
                
                {/* Subtle pulsing background glow */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-primary/10 rounded-full blur-[80px] pointer-events-none" />

                <div className="relative z-10 flex items-center justify-center w-16 h-16 bg-background border border-border/50 rounded-2xl mb-6 shadow-inner">
                  <Power className="w-8 h-8 text-primary animate-pulse" />
                </div>

                <h2 className="text-2xl font-bold text-foreground tracking-tight mb-2 relative z-10">
                  System Shutdown
                </h2>
                <p className="text-sm text-muted-foreground max-w-[280px] mb-8 relative z-10 leading-relaxed">
                  All master encodes have successfully completed. Your PC will power off shortly to save energy.
                </p>

                <div className="relative flex items-center justify-center mb-10 z-10">
                  <svg className="transform -rotate-90 w-40 h-40">
                    <circle cx="80" cy="80" r="74" stroke="currentColor" strokeWidth="4" fill="transparent" className="text-white/5" />
                    <motion.circle
                      cx="80" cy="80" r="74"
                      stroke="currentColor"
                      strokeWidth="4" fill="transparent" 
                      strokeDasharray={2 * Math.PI * 74}
                      strokeDashoffset={2 * Math.PI * 74 * (1 - shutdownCountdown / 60)} 
                      className="text-primary drop-shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center">
                    <span className="text-5xl font-black text-foreground font-mono tabular-nums tracking-tighter">
                      {shutdownCountdown}
                    </span>
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mt-1">
                      Seconds
                    </span>
                  </div>
                </div>

                <Button 
                  size="lg" 
                  variant="outline"
                  className="w-full max-w-xs h-12 text-sm font-bold border-border/50 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-all relative z-10"
                  onClick={() => setShutdownCountdown(null)}
                >
                  Cancel Shutdown
                </Button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </TooltipProvider>
  );
}