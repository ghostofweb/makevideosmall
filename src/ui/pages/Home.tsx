import { useState, useRef, useEffect, type DragEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, FileVideo, Zap, FolderArchive, XCircle, Activity, Search, Loader2, Eye, Play } from 'lucide-react';
import { toast } from 'sonner';

import { type AppMode, type DragState, type QueuedFile, type ElectronFile, type AppView } from '../types';
import { AnalyzingView } from '../components/AnalyzingView';
import { PreviewStudio } from '../components/PreviewStudio';
import { Queue } from './Queue';

function formatBytes(bytes: number) {
  if (!+bytes) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${['B', 'KB', 'MB', 'GB'][i]}`;
}

export function Home() {
  const [dragState, setDragState] = useState<DragState>('idle');
  const [appMode, setAppMode] = useState<AppMode>('bulk');
  const [currentView, setCurrentView] = useState<AppView>('workspace');
  const [appStep, setAppStep] = useState<'ingest'|'analyzing'|'preview'>('ingest');
  
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<string[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<number>(2);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ingestFiles = files.filter(f => f.queueState === 'ingest');
  const activeJobs = files.filter(f => f.queueState !== 'ingest');
  const processingCount = files.filter(f => f.queueState === 'processing').length;
  const totalSizeBytes = ingestFiles.reduce((acc, file) => acc + file.size, 0);

  // --- THE MOCK ENGINE ---
  useEffect(() => {
    const interval = setInterval(() => {
      setFiles(prev => prev.map(f => {
        if (f.queueState === 'processing' && f.progress < 100) {
          const newProgress = Math.min(f.progress + (Math.random() * 2), 100);
          const isComplete = newProgress === 100;
          const newLog = `[SVT-AV1] Frame ${Math.floor(newProgress * 140)} encoded | Bitrate: ${(Math.random() * 4 + 2).toFixed(2)} Mbps | Speed: 18.2 fps`;
          return {
            ...f, progress: newProgress, queueState: isComplete ? 'completed' : 'processing',
            eta: isComplete ? 'Done' : `~${Math.floor((100 - newProgress) / 2)}m ${Math.floor(Math.random() * 60)}s left`,
            logs: [...f.logs.slice(-15), newLog]
          };
        }
        return f;
      }));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const processFiles = (fileList: File[]) => {
    const validFiles = (fileList as ElectronFile[]).filter(f => f.type.startsWith('video/') || f.type === "").map(f => ({
      id: Math.random().toString(36).substr(2, 9), path: f.path, name: f.name, size: f.size, preset: 'balanced',
      analysisState: 'none' as const, queueState: 'ingest' as const, progress: 0, eta: 'Calculating...', logs: ['[SYSTEM] File ingested and awaiting processing.']
    }));
    if (validFiles.length > 0) {
      setFiles(prev => [...prev, ...validFiles]);
      toast.success(`${validFiles.length} file(s) added to workspace.`);
    }
  };

  const updateFilePreset = (id: string, preset: string) => setFiles(prev => prev.map(f => f.id === id ? { ...f, preset } : f));
  const removeFile = (id: string) => setFiles(prev => prev.filter(f => f.id !== id));
  const toggleLogs = (id: string) => setExpandedLogs(prev => prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id]);

  const analyzeFile = (id: string) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, analysisState: 'analyzing' } : f));
    setTimeout(() => {
      setFiles(prev => prev.map(f => f.id === id ? { ...f, analysisState: 'done' } : f));
      toast.success("Analysis complete. Preview ready.");
    }, 2000);
  };

  const sendToProcessingQueue = (id: string) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, queueState: 'processing', logs: ['[ENGINE] Initializing SVT-AV1 Encoder...'] } : f));
    toast.success("Job sent to Processing Queue.");
  };

  return (
    <main className="relative flex-1 flex flex-col p-8 gap-6 overflow-hidden bg-background">
      <input type="file" ref={fileInputRef} className="hidden" accept="video/*" multiple onChange={(e) => { if(e.target.files) processFiles(Array.from(e.target.files)); e.target.value = ''; }} />

      <AnimatePresence mode="wait">
        {currentView === 'queue' ? (
          <Queue 
            key="view-queue"
            activeJobs={activeJobs} 
            expandedLogs={expandedLogs} 
            toggleLogs={toggleLogs} 
            removeFile={removeFile} 
            onBack={() => setCurrentView('workspace')} 
          />
        ) : (
          <motion.div key="view-workspace" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex-1 flex flex-col gap-6">
            
            {/* Top Bar Navigation */}
            <div className="relative z-20 flex justify-between items-center shrink-0">
              <h1 className="text-xl font-bold text-white flex items-center gap-2"><FolderArchive className="text-primary w-6 h-6" /> Cognitive Workspace</h1>
              
              {/* THE BUTTON TO OPEN THE QUEUE PAGE */}
              <button 
                onClick={() => setCurrentView('queue')} 
                className="flex items-center gap-2 px-5 py-2.5 bg-surface hover:bg-surface-hover border border-white/10 rounded-lg text-text-main font-semibold transition-colors shadow-lg cursor-pointer group relative"
              >
                <Activity className="w-4 h-4 text-primary group-hover:animate-pulse" /> Processing Queue
                <motion.span key={processingCount} initial={{ scale: 1.5 }} animate={{ scale: 1 }} className="px-2 py-0.5 rounded text-sm ml-2 font-bold bg-primary/20 text-[#818cf8]">
                  {processingCount} Active
                </motion.span>
              </button>
            </div>

            {/* Ingest List / Dropzone */}
            <div 
              className={`relative z-20 flex-1 border-2 rounded-2xl flex flex-col overflow-hidden transition-colors duration-300 ${dragState === 'idle' ? 'border-dashed border-white/10 hover:border-white/20 bg-surface/30' : 'border-solid border-primary bg-primary/5 scale-[0.99]'}`}
              onDragOver={(e) => { e.preventDefault(); setDragState('accept'); }}
              onDragLeave={() => setDragState('idle')}
              onDrop={(e) => { e.preventDefault(); setDragState('idle'); processFiles(Array.from(e.dataTransfer.files)); }}
            >
              {ingestFiles.length === 0 ? (
                <div onClick={() => fileInputRef.current?.click()} className="flex-1 flex flex-col items-center justify-center cursor-pointer group">
                  <UploadCloud className="w-24 h-24 mb-6 text-text-muted opacity-50 group-hover:text-primary group-hover:scale-110 transition-all duration-300" strokeWidth={1} />
                  <h2 className="text-3xl font-bold mb-2 text-text-main group-hover:text-white transition-colors">Drop Videos to Begin</h2>
                </div>
              ) : (
                <div className="flex-1 flex flex-col p-6 w-full max-w-6xl mx-auto">
                  <div className="flex justify-between items-end mb-4 border-b border-white/10 pb-4">
                    <div><h2 className="text-2xl font-bold text-text-main">Ready for Setup</h2><p className="text-text-muted font-semibold mt-1">Total Payload: {formatBytes(totalSizeBytes)}</p></div>
                    <div className="flex gap-3">
                      <button onClick={() => fileInputRef.current?.click()} className="px-4 py-2 rounded-lg bg-surface hover:bg-surface-hover text-text-main font-semibold cursor-pointer border border-white/10 flex items-center gap-2"><Search className="w-4 h-4"/> Add More</button>
                      <button onClick={() => setFiles(prev => prev.map(f => f.queueState === 'ingest' ? { ...f, queueState: 'processing' } : f))} className="px-6 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white font-bold cursor-pointer flex items-center gap-2 shadow-lg shadow-primary/20"><Play className="w-4 h-4 fill-white"/> Compress All</button>
                    </div>
                  </div>

                  <ul className="flex-1 overflow-y-auto flex flex-col gap-3 pr-2 custom-scrollbar">
                    <AnimatePresence>
                      {ingestFiles.map((file) => (
                        <motion.li key={file.id} layout initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, x: -50, height: 0, marginBottom: 0 }} className="flex items-center justify-between p-3 pl-4 bg-background/60 border border-white/5 rounded-xl group hover:border-white/20 transition-all">
                          <div className="flex items-center gap-4 overflow-hidden w-1/3">
                            <FileVideo className="w-6 h-6 text-primary flex-shrink-0" />
                            <div className="flex flex-col overflow-hidden"><span className="text-text-main truncate font-semibold">{file.name}</span><span className="text-xs font-mono text-text-muted">{formatBytes(file.size)}</span></div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <select className="bg-surface text-sm text-text-main border border-white/10 px-3 py-2 rounded-lg cursor-pointer outline-none focus:border-primary transition-colors" value={file.preset} onChange={(e) => updateFilePreset(file.id, e.target.value)}>
                              <option value="max">Max Quality (Slow)</option><option value="balanced">Balanced (Medium)</option><option value="fast">Fast Share (Fast)</option>
                            </select>

                            {file.analysisState === 'none' && <button onClick={() => analyzeFile(file.id)} className="px-4 py-2 rounded-lg bg-surface border border-white/10 hover:bg-white/10 text-sm font-semibold transition-colors cursor-pointer flex items-center gap-2 text-text-main"><Zap className="w-4 h-4 text-yellow-400" /> Analyze</button>}
                            {file.analysisState === 'analyzing' && <button disabled className="px-4 py-2 rounded-lg bg-surface border border-white/10 text-sm font-semibold flex items-center gap-2 text-text-muted"><Loader2 className="w-4 h-4 animate-spin" /> Scanning</button>}
                            {file.analysisState === 'done' && <button onClick={() => { setAppStep('preview'); toast.info("Opening Studio..."); }} className="px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/50 hover:bg-indigo-500/30 text-indigo-300 text-sm font-bold transition-colors cursor-pointer flex items-center gap-2"><Eye className="w-4 h-4" /> View Preview</button>}
                            
                            <button onClick={() => sendToProcessingQueue(file.id)} className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-bold shadow-lg shadow-primary/20 transition-all cursor-pointer flex items-center gap-2">Compress</button>
                            <button onClick={() => removeFile(file.id)} className="text-text-muted hover:text-red-400 ml-2 p-1 transition-colors cursor-pointer"><XCircle className="w-5 h-5" /></button>
                          </div>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">{appStep === 'analyzing' && <AnalyzingView />}</AnimatePresence>
      <AnimatePresence>{appStep === 'preview' && <PreviewStudio file={files[0]} onBack={() => setAppStep('ingest')} selectedPreset={selectedPreset} setSelectedPreset={setSelectedPreset} />}</AnimatePresence>
    </main>
  );
}