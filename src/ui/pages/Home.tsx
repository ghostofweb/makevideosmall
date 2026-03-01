import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  UploadCloud, FileVideo, FolderArchive, XCircle, Activity, Search,
  Eye, Play, BrainCircuit, Sparkles, Info, Save,
  Zap
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

function getQuickEstimate(sizeBytes: number, preset: string) {
  const ratios = { max: 0.80, balanced: 0.55, fast: 0.35 };
  const estimatedSize = sizeBytes * ratios[preset as keyof typeof ratios];
  const percentage = Math.round((1 - ratios[preset as keyof typeof ratios]) * 100);
  return { text: `~${formatBytes(estimatedSize)}`, badge: `-${percentage}%` };
}

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05 } },
};
const itemVariants : any = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 24 } },
};

export function Home() {
  const [dragState, setDragState] = useState<DragState>('idle');
  const [currentView, setCurrentView] = useState<AppView>('workspace');
  const [appStep, setAppStep] = useState<'ingest' | 'analyzing' | 'preview'>('ingest');

  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('balanced');
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

  const [renameModal, setRenameModal] = useState<{
    isOpen: boolean;
    fileId: string;
    preset: string;
    source: 'ingest' | 'studio';
  } | null>(null);
  const [tempFileName, setTempFileName] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const ingestFiles = files.filter((f) => f.queueState === 'ingest');
  const processingCount = files.filter((f) => f.queueState === 'processing').length;
  const queuedCount = files.filter((f) => f.queueState === 'queued').length;
  const completedCount = files.filter((f) => f.queueState === 'completed').length;
  const totalSizeBytes = ingestFiles.reduce((acc, file) => acc + file.size, 0);

  const selectedFile = files.find((f) => f.id === selectedFileId);

  useEffect(() => {
    const loadWorkspace = async () => {
      try {
        const result = await ipcRenderer.invoke('load-workspace');
        if (result.success && result.files && result.files.length > 0) setFiles(result.files);
      } catch (e) {}
    };
    loadWorkspace();
  }, []);

  useEffect(() => {
    if (files.length > 0) ipcRenderer.invoke('save-workspace', files).catch(() => {});
  }, [files]);

  useEffect(() => {
    const handleTelemetry = (_event: any, data: any) => {
      setFiles((prev) => prev.map((f) => {
        if (f.id === data.fileId) {
          return {
            ...f, progress: data.progress, eta: data.eta,
            queueState: data.type === 'complete' ? 'completed' : 'processing',
            completedAt: data.type === 'complete' ? Date.now() : f.completedAt,
          };
        }
        return f;
      }));
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

  const cleanupPreviews = (file: QueuedFile) => {
    if (file?.previewData?.videos?.previews) {
      const previews = file.previewData.videos.previews;
      const pathsToDelete = [previews.max?.video_path, previews.balanced?.video_path, previews.fast?.video_path].filter(Boolean);
      pathsToDelete.forEach(path => {
        if (path) ipcRenderer.invoke('delete-physical-file', path).catch(() => {});
      });
    }
  };

  const cancelJob = async (id: string) => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    if (file.queueState === 'processing') {
      toast.error("Aborting the engine...");
      await ipcRenderer.invoke('cancel-encode');
    } else if (file.queueState === 'queued') {
      setFiles(prev => prev.map(f => f.id === id ? { ...f, queueState: 'ingest', logs: ['[QUEUE] Removed from queue.'] } : f));
      toast.info("Removed from queue.");
    }
  };

  useEffect(() => {
    const activeJob = files.find((f) => f.queueState === 'processing');
    const nextJob = files.find((f) => f.queueState === 'queued');
    if (!activeJob && nextJob) executeEncodeJob(nextJob);
  }, [files]); 

  const executeEncodeJob = async (file: QueuedFile) => {
    setFiles((prev) => prev.map((f) => 
      f.id === file.id ? { ...f, queueState: 'processing', logs: ['[ENGINE] Initializing SVT-AV1 Encoder...'] } : f
    ));
    const settings = JSON.parse(localStorage.getItem('vb_settings') || '{}');

    try {
      const response = await ipcRenderer.invoke('start-encode', {
        fileId: file.id, inputPath: file.path, preset: file.preset, 
        customFileName: file.customName,
        previewsToDelete: [], settings 
      });

      if (response.success) {
        setFiles(prev => prev.map(f => f.id === file.id ? { ...f, queueState: 'completed', outputPath: response.outputPath, progress: 100, eta: 'Done' } : f));
        setTimeout(() => {
          setFiles(currentFiles => {
            const stillBusy = currentFiles.some(f => f.id !== file.id && (f.queueState === 'processing' || f.queueState === 'queued'));
            if (!stillBusy) {
              if (settings.playSoundOnFinish) {
                const formatPath = (p: string) => `local://${encodeURI(p.replace(/\\/g, '/'))}`;
                const audio = new Audio(settings.customSoundPath ? formatPath(settings.customSoundPath) : '/default-sound.mp3');
                audio.play().catch(() => {});
              }
              if (settings.shutdownOnFinish) {
                ipcRenderer.invoke('shutdown-pc');
                toast.error("QUEUE FINISHED! PC SHUTTING DOWN IN 10 SECONDS!", { duration: 10000 });
              } else {
                toast.success("All videos in the queue have finished encoding!");
              }
            }
            return currentFiles;
          });
        }, 500);
      } else {
        toast.error(`Encode failed for ${file.name}`);
        setFiles(prev => prev.map(f => f.id === file.id ? { ...f, queueState: 'ingest' } : f));
      }
    } catch (e) {
      toast.error("Bridge connection failed.");
      setFiles(prev => prev.map(f => f.id === file.id ? { ...f, queueState: 'ingest' } : f));
    }
  };

  const requestCompression = (id: string, preset: string, source: 'ingest' | 'studio') => {
    const file = files.find(f => f.id === id);
    if (!file) return;
    
    // Strip the extension (.mp4) to pre-fill the input nicely
    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
    setTempFileName(`${nameWithoutExt}_AV1`);
    setRenameModal({ isOpen: true, fileId: id, preset, source });
  };

  const confirmCompression = () => {
    if (!renameModal) return;
    const { fileId, preset, source } = renameModal;
    
    setFiles((prev) => prev.map((f) => {
      if (f.id === fileId) {
        cleanupPreviews(f);
        return { 
          ...f, 
          queueState: 'queued', 
          preset: preset, 
          customName: tempFileName, // Save their custom name!
          logs: ['[QUEUE] Waiting for available engine slot...'] 
        };
      }
      return f;
    }));

    toast.success('Added to Queue');
    setRenameModal(null);
    if (source === 'studio') setAppStep('ingest');
    setCurrentView('queue');
  };

  const compressAll = () => {
    setFiles((prev) => {
      return prev.map((f) => {
        if (f.queueState === 'ingest') {
          cleanupPreviews(f); 
          return { ...f, queueState: 'queued', logs: ['[QUEUE] Waiting for available engine slot...'] };
        }
        return f;
      });
    });
    toast.success('All jobs sent to Queue!');
    setCurrentView('queue');
  };

  const analyzeFile = async (id: string, overridePath?: string, autoNavigate = false) => {
    const filePath = overridePath || files.find((f) => f.id === id)?.path;
    if (!filePath) return;

    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'analyzing' } : f)));
    if (autoNavigate) setAppStep('analyzing');

    try {
      const settings = JSON.parse(localStorage.getItem('vb_settings') || '{}');
      const response = await ipcRenderer.invoke('analyze-video', { filePath, settings });
      if (response.success) {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, analysisState: 'done', previewData: response.data } : f));
        if (autoNavigate) setAppStep('preview');
        else toast.success("Analysis Complete. Preview ready.");
      } else {
        toast.error("Analysis Failed");
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'none' } : f)));
        if (autoNavigate) setAppStep('ingest');
      }
    } catch (e) {
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'none' } : f)));
      if (autoNavigate) setAppStep('ingest');
    }
  };

  const processFiles = (fileList: File[]) => {
    const validFiles = (fileList as any[])
      .filter((f) => f.type.startsWith('video/') || f.type === '')
      .map((f) => {
        let physicalPath = webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(f) : (f.path || f.webkitRelativePath || '');
        if (!physicalPath) return null;
        return {
          id: Math.random().toString(36).substr(2, 9),
          path: physicalPath, name: f.name, size: f.size, preset: 'balanced',
          analysisState: 'none' as const, queueState: 'ingest' as const, progress: 0, eta: 'Calculating...',
          logs: ['[SYSTEM] File ingested and awaiting processing.'],
        };
      }).filter(Boolean) as QueuedFile[];

    if (validFiles.length > 0) {
      setFiles((prev) => [...prev, ...validFiles]);
      if (validFiles.length === 1 && files.length === 0) {
        const target = validFiles[0];
        setSelectedFileId(target.id);
        analyzeFile(target.id, target.path, true);
      } else {
        toast.success(`${validFiles.length} file(s) added.`);
      }
    }
  };

  const updateFilePreset = (id: string, preset: string) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, preset } : f)));

  const removeFile = (id: string) => {
    const file = files.find(f => f.id === id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (selectedFileId === id) setSelectedFileId(null);
    if (file) cleanupPreviews(file);
  };

  const toggleLogs = (id: string) => setExpandedLogs((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]));

  const renderPresetOption = (file: QueuedFile, presetValue: string, label: string) => {
    const isDone = file.analysisState === 'done';
    const sizeStr = isDone ? file.previewData?.videos?.previews[presetValue]?.size_formatted : getQuickEstimate(file.size, presetValue).text;
    return (
      <div className="flex justify-between items-center w-full gap-3 pr-1">
        <span>{label}</span>
        <span className="text-[10px] font-mono opacity-60">
          {isDone && <Sparkles className="w-2.5 h-2.5 inline mr-1 text-purple-400" />}
          {sizeStr}
        </span>
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <main className="relative flex-1 flex flex-col px-6 pb-6 pt-12 gap-4 overflow-hidden bg-background">  
        {/* Background Grid */}
        <div className="fixed inset-0 pointer-events-none">
          <motion.div className="absolute inset-0 opacity-20" animate={{ background: ['radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)', 'radial-gradient(circle at 80% 70%, rgba(99,102,241,0.2) 0%, transparent 50%)', 'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)'] }} transition={{ duration: 20, repeat: Infinity, ease: 'linear' }} />
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: `linear-gradient(rgba(99,102,241,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.1) 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />
        </div>

        <input type="file" ref={fileInputRef} className="hidden" accept="video/*" multiple onChange={(e) => { if (e.target.files) processFiles(Array.from(e.target.files)); e.target.value = ''; }} />

        <AnimatePresence>
          {renameModal && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            >
              <motion.div
                initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }}
                className="bg-card border border-border shadow-2xl rounded-2xl w-full max-w-md p-6 flex flex-col gap-4 relative overflow-hidden"
              >
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-purple-500" />
                <div className="flex items-center gap-3 mb-2">
                  <div className="p-2 bg-primary/10 rounded-lg">
                    <Save className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">Save Output As...</h3>
                    <p className="text-xs text-muted-foreground">Name your master encode file.</p>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={tempFileName}
                    onChange={(e) => setTempFileName(e.target.value)}
                    className="w-full bg-black/50 border border-border/50 text-foreground text-sm rounded-md px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all font-mono"
                    autoFocus
                    placeholder="Enter file name"
                  />
                  <p className="text-[10px] text-muted-foreground text-right mr-1">
                    .mp4 extension will be added automatically
                  </p>
                </div>

                <div className="flex justify-end gap-2 mt-4">
                  <Button variant="ghost" onClick={() => setRenameModal(null)}>Cancel</Button>
                  <Button onClick={confirmCompression} className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_15px_rgba(99,102,241,0.3)]">
                    <Zap className="w-4 h-4 mr-2 fill-current" /> Start Engine
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {currentView === 'queue' ? (
            <Queue key="view-queue" activeJobs={files.filter(f => f.queueState !== 'ingest')} expandedLogs={expandedLogs} toggleLogs={toggleLogs} removeFile={removeFile} cancelJob={cancelJob} onBack={() => setCurrentView('workspace')} />
          ) : (
            <motion.div key="view-workspace" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex-1 flex flex-col gap-4 relative z-10">
              <div className="relative z-20 flex flex-wrap justify-between items-center gap-3 bg-card/40 backdrop-blur-md border border-border/50 rounded-2xl p-3 shadow-lg">
                <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                  <FolderArchive className="text-primary w-5 h-5" />
                  <span className="text-sm font-medium opacity-50">Workspace</span> 
                </h1>
                <div className="flex items-center gap-3">
                  <Button onClick={() => setCurrentView('queue')} variant="outline" className="gap-2 border-border/50 bg-background/50 backdrop-blur-sm hover:bg-accent/20 group relative overflow-hidden">
                    <Activity className="w-4 h-4 text-primary group-hover:scale-110 transition-transform" />
                    Processing Queue
                    <Badge variant="secondary" className="ml-1 bg-primary/20 text-primary border-none">{(processingCount + queuedCount)} Active</Badge>
                    {completedCount > 0 && <Badge variant="outline" className="ml-1 bg-green-500/10 text-green-400 border-green-500/20">{completedCount} Done</Badge>}
                  </Button>
                </div>
              </div>

              <div className="flex-1 flex gap-4 overflow-hidden">
                <div className="w-80 shrink-0 hidden lg:block"><DetailedStats /></div>
                <div className="flex-1 flex flex-col gap-4 min-w-0">
                  <motion.div initial={{ scale: 1 }} animate={{ scale: dragState === 'accept' ? 0.99 : 1 }} transition={{ type: 'spring', stiffness: 400 }} className={`relative border-2 rounded-xl overflow-hidden transition-all duration-300 ${dragState === 'idle' ? 'border-dashed border-border/50 hover:border-border bg-card/20' : 'border-solid border-primary bg-primary/5 shadow-lg shadow-primary/20'}`} onDragOver={(e) => { e.preventDefault(); setDragState('accept'); }} onDragLeave={() => setDragState('idle')} onDrop={(e) => { e.preventDefault(); setDragState('idle'); processFiles(Array.from(e.dataTransfer.files)); }}>
                    <div onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center py-12 px-4 cursor-pointer group">
                      <motion.div whileHover={{ scale: 1.1, rotate: 5 }} transition={{ type: 'spring', stiffness: 300 }}>
                        <UploadCloud className="w-16 h-16 mb-3 text-muted-foreground/50 group-hover:text-primary transition-colors" strokeWidth={1.2} />
                      </motion.div>
                      <h2 className="text-xl font-bold text-foreground/80 group-hover:text-foreground transition-colors">Drop Videos to Begin</h2>
                      <p className="text-sm text-muted-foreground">or click to browse</p>
                      <p className="text-xs text-muted-foreground/60 mt-2">Supports MP4, MKV, MOV, AVI</p>
                    </div>
                  </motion.div>

                  {ingestFiles.length > 0 && (
                    <Card className="flex-1 bg-card/40 backdrop-blur-sm border-border/50 shadow-lg overflow-hidden flex flex-col">
                      <CardContent className="p-4 flex-1 flex flex-col gap-3">
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold text-foreground">Ready for Setup</h3>
                            <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary">{formatBytes(totalSizeBytes)}</Badge>
                          </div>
                          <div className="flex gap-2">
                            <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}><Search className="w-4 h-4 mr-1" /> Add More</Button></TooltipTrigger><TooltipContent>Browse for more video files</TooltipContent></Tooltip>
                            <Tooltip><TooltipTrigger asChild><Button size="sm" onClick={compressAll} disabled={ingestFiles.length === 0}><Play className="w-4 h-4 mr-1 fill-current" /> Compress All</Button></TooltipTrigger><TooltipContent>Send all ready files directly to the processing queue</TooltipContent></Tooltip>
                          </div>
                        </div>

                        <Separator className="bg-border/50" />

                        <ScrollArea className="flex-1 pr-2">
                          <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-2">
                            <AnimatePresence>
                              {ingestFiles.map((file) => (
                                <motion.div key={file.id} variants={itemVariants} layout exit={{ opacity: 0, x: -50, height: 0, marginBottom: 0 }} onClick={() => setSelectedFileId(file.id)} className={`flex flex-wrap items-center justify-between p-3 bg-card/60 border rounded-lg group hover:border-primary/50 transition-all cursor-pointer ${selectedFileId === file.id ? 'border-primary bg-primary/5 shadow-[0_0_15px_rgba(99,102,241,0.2)]' : 'border-border/50'}`}>
                                  <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <div className="relative"><FileVideo className="w-5 h-5 text-primary shrink-0" /></div>
                                    <div className="flex flex-col min-w-0">
                                      <span className="text-foreground truncate font-medium text-sm">{file.name}</span>
                                      <span className="text-xs font-mono text-muted-foreground">{formatBytes(file.size)}</span>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap justify-end mt-2 sm:mt-0">
                                    <div className="flex items-center gap-1">
                                      <Select value={file.preset} onValueChange={(val) => updateFilePreset(file.id, val)}>
                                        <SelectTrigger className="w-[165px] h-7 text-xs"><SelectValue placeholder="Preset" /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="max">{renderPresetOption(file, 'max', 'Max Quality')}</SelectItem>
                                          <SelectItem value="balanced">{renderPresetOption(file, 'balanced', 'Balanced')}</SelectItem>
                                          <SelectItem value="fast">{renderPresetOption(file, 'fast', 'Fast')}</SelectItem>
                                        </SelectContent>
                                      </Select>
                                      <Popover>
                                        <PopoverTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={(e) => e.stopPropagation()}><Info className="w-4 h-4" /></Button></PopoverTrigger>
                                        <PopoverContent side="top" className="text-xs max-w-xs p-3">
                                          <div className="space-y-1"><p><strong>Max:</strong> Best visual quality, slowest processing.</p><p><strong>Balanced:</strong> Great quality, normal speed.</p><p><strong>Fast:</strong> Fastest processing, slightly larger file.</p>{file.analysisState === 'none' && (<p className="text-muted-foreground mt-1 pt-1 border-t border-border/50"><em>Note: Estimations shown without Analysis are rough guesses.</em></p>)}</div>
                                        </PopoverContent>
                                      </Popover>
                                    </div>

                                    <AnimatePresence mode="wait">
                                      {file.analysisState === 'none' && (
                                        <motion.div key="ai" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                                          <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); analyzeFile(file.id, undefined, false); }}><BrainCircuit className="w-3 h-3 mr-1 text-purple-400" /> Analyze</Button></TooltipTrigger><TooltipContent>Run a deep scan to generate exact size predictions and visual previews.</TooltipContent></Tooltip>
                                        </motion.div>
                                      )}
                                      {file.analysisState === 'analyzing' && (
                                        <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                          <Button variant="outline" size="icon" disabled className="h-7 w-7 flex items-center justify-center border-primary/20 bg-primary/5 overflow-visible"><AnimatedLogo className="w-8 h-8 text-primary scale-[1.5]" /></Button>
                                        </motion.div>
                                      )}
                                      {file.analysisState === 'done' && (
                                        <motion.div key="preview" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                                          <Tooltip><TooltipTrigger asChild><Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setSelectedFileId(file.id); setAppStep('preview'); }}><Eye className="w-3 h-3 mr-1" /> Preview</Button></TooltipTrigger><TooltipContent>Open the Studio to compare quality before compressing.</TooltipContent></Tooltip>
                                        </motion.div>
                                      )}
                                    </AnimatePresence>

                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button size="sm" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); requestCompression(file.id, file.preset, 'ingest'); }}>Compress</Button>
                                      </TooltipTrigger>
                                      <TooltipContent>{file.analysisState === 'done' ? "Send to queue with your verified, previewed settings." : "Quick compress immediately using the selected preset estimation."}</TooltipContent>
                                    </Tooltip>

                                    <Tooltip>
                                      <TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={(e) => { e.stopPropagation(); removeFile(file.id); }}><XCircle className="w-4 h-4" /></Button></TooltipTrigger>
                                      <TooltipContent>Remove file from workspace</TooltipContent>
                                    </Tooltip>
                                  </div>
                                </motion.div>
                              ))}
                            </AnimatePresence>
                          </motion.div>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  )}
                </div>

                <AnimatePresence>
                  {!selectedFile && (
                    <motion.div key="stats-panel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-80 shrink-0 hidden lg:block">
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
            <PreviewStudio
              file={selectedFile}
              onBack={() => setAppStep('ingest')}
              selectedPreset={selectedPreset}
              setSelectedPreset={setSelectedPreset}
              onEncode={(preset) => requestCompression(selectedFile.id, preset, 'studio')} 
            />
          )}
        </AnimatePresence>
      </main>
    </TooltipProvider>
  );
}