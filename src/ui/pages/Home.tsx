import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  UploadCloud,
  FileVideo,
  FolderArchive,
  XCircle,
  Activity,
  Search,
  Loader2,
  Eye,
  Play,
  BrainCircuit,
  Sparkles,
} from 'lucide-react';

// shadcn/ui components
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

import { type DragState, type QueuedFile, type ElectronFile, type AppView } from '../types';
import { Queue } from './Queue';
import { AnalyzingView } from './components/AnalyzingView';
import { PreviewStudio } from './components/PreviewStudio';
import { HardwareWidget } from './components/HardwareWidget';
import { DetailedStats } from './components/DetailedStats';
import { VideoDNAPanel } from './components/VideoDNAPanel';

const { ipcRenderer, webUtils } = window.require('electron');

function formatBytes(bytes: number) {
  if (!+bytes) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB'][i]}`;
}

// Quick estimate function for instant feedback
function getQuickEstimate(sizeBytes: number, preset: string) {
  // Rough AV1 compression ratios
  const ratios = {
    max: 0.65,      // Retains 65% of original size
    balanced: 0.45, // Retains 45% of original size
    fast: 0.25,     // Retains 25% of original size
  };
  
  const estimatedSize = sizeBytes * ratios[preset as keyof typeof ratios];
  const percentage = Math.round((1 - ratios[preset as keyof typeof ratios]) * 100);
  
  return {
    text: `~${formatBytes(estimatedSize)}`,
    badge: `-${percentage}%`
  };
}

// Stagger animations for file list
const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};
const itemVariants = {
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const ingestFiles = files.filter((f) => f.queueState === 'ingest');
  const processingCount = files.filter((f) => f.queueState === 'processing').length;
  const completedCount = files.filter((f) => f.queueState === 'completed').length;
  const totalSizeBytes = ingestFiles.reduce((acc, file) => acc + file.size, 0);

  const selectedFile = files.find((f) => f.id === selectedFileId);

  // Load completed jobs on mount
  useEffect(() => {
    const loadJobs = async () => {
      const result = await ipcRenderer.invoke('load-completed-jobs');
      if (result.success && result.jobs.length > 0) {
        setFiles(prev => {
          const existingIds = new Set(prev.map(f => f.id));
          const newJobs = result.jobs.filter((j: QueuedFile) => !existingIds.has(j.id));
          return [...prev, ...newJobs];
        });
      }
    };
    loadJobs();
  }, []);

  // Mock engine updates + save completed jobs
  useEffect(() => {
    const interval = setInterval(() => {
      setFiles((prev) => {
        const updated = prev.map((f) => {
          if (f.queueState === 'processing' && f.progress < 100) {
            const newProgress = Math.min(f.progress + Math.random() * 2, 100);
            const isComplete = newProgress === 100;
            const newLog = `[SVT-AV1] Frame ${Math.floor(newProgress * 1.4)} encoded | Bitrate: ${(Math.random() * 4 + 2).toFixed(2)} Mbps | Speed: 18.2 fps`;
            return {
              ...f,
              progress: newProgress,
              queueState: isComplete ? 'completed' : 'processing',
              eta: isComplete ? 'Done' : `~${Math.floor((100 - newProgress) / 2)}m ${Math.floor(Math.random() * 60)}s left`,
              logs: [...f.logs.slice(-15), newLog],
              completedAt: isComplete ? Date.now() : f.completedAt,
            };
          }
          return f;
        });
        // Save completed jobs to disk
        const completed = updated.filter(f => f.queueState === 'completed');
        if (completed.length > 0) {
          ipcRenderer.invoke('save-completed-jobs', completed);
        }
        return updated;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const analyzeFile = async (id: string, overridePath?: string, autoNavigate = false) => {
    const filePath = overridePath || files.find((f) => f.id === id)?.path;
    if (!filePath) {
      toast.error("Invalid file path. Cannot analyze.");
      return;
    }

    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'analyzing' } : f)));
    if (autoNavigate) setAppStep('analyzing');

    try {
      const response = await ipcRenderer.invoke('analyze-video', filePath);
      if (response.success) {
        setFiles(prev => prev.map(f => f.id === id ? { 
          ...f, 
          analysisState: 'done',
          previewData: response.data 
        } : f));
        if (autoNavigate) {
          setAppStep('preview');
        } else {
          toast.success("AI Analysis Complete. Preview ready.");
        }
      } else {
        toast.error("Analysis Failed: " + response.error);
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'none' } : f)));
        if (autoNavigate) setAppStep('ingest');
      }
    } catch (e) {
      toast.error("Bridge Connection Failed.");
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, analysisState: 'none' } : f)));
      if (autoNavigate) setAppStep('ingest');
    }
  };

  const processFiles = (fileList: File[]) => {
    const validFiles = (fileList as any[])
      .filter((f) => f.type.startsWith('video/') || f.type === '')
      .map((f) => {
        let physicalPath = '';
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
          physicalPath = webUtils.getPathForFile(f);
        } else {
          physicalPath = f.path || f.webkitRelativePath || '';
        }
        if (!physicalPath) {
          toast.error(`Cannot read disk path for ${f.name}. Are you running in a web browser?`);
          return null;
        }
        return {
          id: Math.random().toString(36).substr(2, 9),
          path: physicalPath,
          name: f.name,
          size: f.size,
          preset: 'balanced',
          analysisState: 'none' as const,
          queueState: 'ingest' as const,
          progress: 0,
          eta: 'Calculating...',
          logs: ['[SYSTEM] File ingested and awaiting processing.'],
        };
      })
      .filter(Boolean) as QueuedFile[];

    if (validFiles.length > 0) {
      setFiles((prev) => [...prev, ...validFiles]);
      if (validFiles.length === 1 && files.length === 0) {
        const target = validFiles[0];
        setSelectedFileId(target.id);
        analyzeFile(target.id, target.path, true);
      } else {
        toast.success(`${validFiles.length} file(s) added to workspace.`);
      }
    }
  };

  const updateFilePreset = (id: string, preset: string) =>
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, preset } : f)));

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (selectedFileId === id) setSelectedFileId(null);
  };

  const toggleLogs = (id: string) =>
    setExpandedLogs((prev) => (prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]));

  const sendToProcessingQueue = (id: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, queueState: 'processing', logs: ['[ENGINE] Initializing SVT-AV1 Encoder...'] }
          : f
      )
    );
    toast.success('Job sent to Processing Queue.');
  };

  const compressAll = () => {
    setFiles((prev) =>
      prev.map((f) =>
        f.queueState === 'ingest'
          ? { ...f, queueState: 'processing', logs: ['[ENGINE] Initializing SVT-AV1 Encoder...'] }
          : f
      )
    );
    toast.success('All jobs sent to Processing Queue.');
  };

  return (
    <main className="relative flex-1 flex flex-col p-6 gap-4 overflow-hidden bg-background">
      {/* Animated background gradient with subtle grid */}
      <div className="fixed inset-0 pointer-events-none">
        <motion.div
          className="absolute inset-0 opacity-20"
          animate={{
            background: [
              'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)',
              'radial-gradient(circle at 80% 70%, rgba(99,102,241,0.2) 0%, transparent 50%)',
              'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.2) 0%, transparent 50%)',
            ],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
        />
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `linear-gradient(rgba(99,102,241,0.1) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(99,102,241,0.1) 1px, transparent 1px)`,
            backgroundSize: '40px 40px',
          }}
        />
      </div>

      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="video/*"
        multiple
        onChange={(e) => {
          if (e.target.files) processFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />

      <AnimatePresence mode="wait">
        {currentView === 'queue' ? (
          <Queue
            key="view-queue"
            activeJobs={files.filter(f => f.queueState !== 'ingest')}
            expandedLogs={expandedLogs}
            toggleLogs={toggleLogs}
            removeFile={removeFile}
            onBack={() => setCurrentView('workspace')}
          />
        ) : (
          <motion.div
            key="view-workspace"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col gap-4 relative z-10"
          >
            {/* Top Bar */}
            <div className="relative z-20 flex flex-wrap justify-between items-center gap-3 bg-card/40 backdrop-blur-md border border-border/50 rounded-2xl p-3 shadow-lg">
              <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                <FolderArchive className="text-primary w-5 h-5" />
              </h1>

              <div className="flex items-center gap-3">
                {/* <div className="hidden md:block">
                  <HardwareWidget />
                </div> */}
                <Button
                  onClick={() => setCurrentView('queue')}
                  variant="outline"
                  className="gap-2 border-border/50 bg-background/50 backdrop-blur-sm hover:bg-accent/20 group relative overflow-hidden"
                >
                  <Activity className="w-4 h-4 text-primary group-hover:scale-110 transition-transform" />
                  Processing Queue
                  <Badge variant="secondary" className="ml-1 bg-primary/20 text-primary border-none">
                    {processingCount} Active
                  </Badge>
                  {completedCount > 0 && (
                    <Badge variant="outline" className="ml-1 bg-green-500/10 text-green-400 border-green-500/20">
                      {completedCount} Done
                    </Badge>
                  )}
                  <motion.div
                    className="absolute inset-0 bg-primary/5"
                    initial={{ x: '-100%' }}
                    whileHover={{ x: 0 }}
                    transition={{ duration: 0.3 }}
                  />
                </Button>
              </div>
            </div>

            {/* Main area: 3 columns */}
            <div className="flex-1 flex gap-4 overflow-hidden">
              {/* Left column: Detailed Stats */}
              <div className="w-80 shrink-0 hidden lg:block">
                <DetailedStats />
              </div>

              {/* Center column: Dropzone + File List */}
              <div className="flex-1 flex flex-col gap-4 min-w-0">
                {/* Dropzone */}
                <motion.div
                  initial={{ scale: 1 }}
                  animate={{ scale: dragState === 'accept' ? 0.99 : 1 }}
                  transition={{ type: 'spring', stiffness: 400 }}
                  className={`relative border-2 rounded-xl overflow-hidden transition-all duration-300 ${
                    dragState === 'idle'
                      ? 'border-dashed border-border/50 hover:border-border bg-card/20'
                      : 'border-solid border-primary bg-primary/5 shadow-lg shadow-primary/20'
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragState('accept');
                  }}
                  onDragLeave={() => setDragState('idle')}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragState('idle');
                    processFiles(Array.from(e.dataTransfer.files));
                  }}
                >
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="flex flex-col items-center justify-center py-12 px-4 cursor-pointer group"
                  >
                    <motion.div
                      whileHover={{ scale: 1.1, rotate: 5 }}
                      transition={{ type: 'spring', stiffness: 300 }}
                    >
                      <UploadCloud
                        className="w-16 h-16 mb-3 text-muted-foreground/50 group-hover:text-primary transition-colors"
                        strokeWidth={1.2}
                      />
                    </motion.div>
                    <h2 className="text-xl font-bold text-foreground/80 group-hover:text-foreground transition-colors">
                      Drop Videos to Begin
                    </h2>
                    <p className="text-sm text-muted-foreground">or click to browse</p>
                    <p className="text-xs text-muted-foreground/60 mt-2">Supports MP4, MKV, MOV, AVI</p>
                  </div>
                </motion.div>

                {/* File List (only shown if files exist) */}
                {ingestFiles.length > 0 && (
                  <Card className="flex-1 bg-card/40 backdrop-blur-sm border-border/50 shadow-lg overflow-hidden flex flex-col">
                    <CardContent className="p-4 flex-1 flex flex-col gap-3">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-foreground">Ready for Setup</h3>
                          <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary">
                            {formatBytes(totalSizeBytes)}
                          </Badge>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                            <Search className="w-4 h-4 mr-1" /> Add More
                          </Button>
                          <Button size="sm" onClick={compressAll} disabled={ingestFiles.length === 0}>
                            <Play className="w-4 h-4 mr-1 fill-current" /> Compress All
                          </Button>
                        </div>
                      </div>

                      <Separator className="bg-border/50" />

                      <ScrollArea className="flex-1 pr-2">
                        <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-2">
                          <AnimatePresence>
                            {ingestFiles.map((file) => (
                              <motion.div
                                key={file.id}
                                variants={itemVariants}
                                layout
                                exit={{ opacity: 0, x: -50, height: 0, marginBottom: 0 }}
                                onClick={() => setSelectedFileId(file.id)}
                                className={`flex flex-wrap items-center justify-between p-3 bg-card/60 border rounded-lg group hover:border-primary/50 transition-all cursor-pointer ${
                                  selectedFileId === file.id
                                    ? 'border-primary bg-primary/5 shadow-[0_0_15px_rgba(99,102,241,0.2)]'
                                    : 'border-border/50'
                                }`}
                              >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <div className="relative">
                                    <FileVideo className="w-5 h-5 text-primary shrink-0" />
                                    {file.analysisState === 'analyzing' && (
                                      <motion.div
                                        className="absolute -top-1 -right-1 w-2 h-2"
                                        animate={{ scale: [1, 1.5, 1] }}
                                        transition={{ repeat: Infinity, duration: 1 }}
                                      >
                                        <div className="w-2 h-2 bg-purple-400 rounded-full" />
                                      </motion.div>
                                    )}
                                  </div>
                                  <div className="flex flex-col min-w-0">
                                    <span className="text-foreground truncate font-medium text-sm">{file.name}</span>
                                    <span className="text-xs font-mono text-muted-foreground">{formatBytes(file.size)}</span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 flex-wrap justify-end mt-2 sm:mt-0">
                                  {/* Enhanced preset dropdown with estimate */}
                                  <div className="flex flex-col items-end gap-1">
                                    <Select value={file.preset} onValueChange={(val) => updateFilePreset(file.id, val)}>
                                      <SelectTrigger className="w-[130px] h-7 text-xs">
                                        <SelectValue placeholder="Preset" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="max">Max Quality</SelectItem>
                                        <SelectItem value="balanced">Balanced</SelectItem>
                                        <SelectItem value="fast">Fast</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    
                                    {/* DYNAMIC ESTIMATE TEXT */}
                                    <div className="text-[10px] pr-1 flex items-center gap-1.5">
                                      {file.analysisState === 'done' ? (
                                        <>
                                          <Sparkles className="w-3 h-3 text-purple-400" />
                                          <span className="text-green-400 font-mono">
                                            {file.previewData?.videos?.previews[file.preset]?.size_formatted || ''}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          <span className="text-muted-foreground">Target:</span>
                                          <span className="text-foreground font-mono">
                                            {getQuickEstimate(file.size, file.preset).text}
                                          </span>
                                          <span className="text-emerald-500/70">
                                            ({getQuickEstimate(file.size, file.preset).badge})
                                          </span>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  <AnimatePresence mode="wait">
                                    {file.analysisState === 'none' && (
                                      <motion.div
                                        key="ai"
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.8 }}
                                      >
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-7 px-2 text-xs"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            analyzeFile(file.id, undefined, false);
                                          }}
                                        >
                                          <BrainCircuit className="w-3 h-3 mr-1 text-purple-400" />
                                          AI Scan
                                        </Button>
                                      </motion.div>
                                    )}
                                    {file.analysisState === 'analyzing' && (
                                      <motion.div key="scanning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                        <Button variant="outline" size="sm" disabled className="h-7 px-2 text-xs">
                                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                          Scanning
                                        </Button>
                                      </motion.div>
                                    )}
                                    {file.analysisState === 'done' && (
                                      <motion.div
                                        key="preview"
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.8 }}
                                      >
                                        <Button
                                          variant="secondary"
                                          size="sm"
                                          className="h-7 px-2 text-xs"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedFileId(file.id);
                                            setAppStep('preview');
                                          }}
                                        >
                                          <Eye className="w-3 h-3 mr-1" />
                                          Preview
                                        </Button>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>

                                  <Button
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      sendToProcessingQueue(file.id);
                                    }}
                                  >
                                    Compress
                                  </Button>

                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeFile(file.id);
                                    }}
                                  >
                                    <XCircle className="w-4 h-4" />
                                  </Button>
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

              {/* Right column: Quick Insights or Video DNA */}
              <AnimatePresence>
                {selectedFile ? (
                  <motion.div
                    key="dna-panel"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="w-80 shrink-0"
                  >
                    {/* <VideoDNAPanel file={selectedFile} onClose={() => setSelectedFileId(null)} /> */}
                  </motion.div>
                ) : (
                  <motion.div
                    key="stats-panel"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="w-80 shrink-0 hidden lg:block"
                  >
                    <Card className="bg-card/40 backdrop-blur-sm border-border/50 shadow-lg h-full">
                      <CardContent className="p-4 space-y-4">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-primary" />
                          <h3 className="text-sm font-semibold">Quick Insights</h3>
                        </div>
                        <Separator className="bg-border/50" />
                        <div className="space-y-3">
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Files ready</span>
                            <Badge variant="outline">{ingestFiles.length}</Badge>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Processing</span>
                            <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20">
                              {processingCount}
                            </Badge>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Completed</span>
                            <Badge variant="secondary" className="bg-green-500/10 text-green-400 border-green-500/20">
                              {completedCount}
                            </Badge>
                          </div>
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Total size</span>
                            <span className="font-mono text-xs">{formatBytes(totalSizeBytes)}</span>
                          </div>
                        </div>
                        <Separator className="bg-border/50" />
                        <div className="text-xs text-muted-foreground">
                          <p>Select a file to view its Video DNA and AI analysis.</p>
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
          />
        )}
      </AnimatePresence>
    </main>
  );
}