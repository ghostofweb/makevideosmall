import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileVideo, ChevronLeft, Terminal, Server, Cpu, Shield, Zap, ListVideo, CheckCircle2, Loader2, PlayCircle } from 'lucide-react';
import { type QueuedFile } from '../types';

interface QueueProps {
  activeJobs: QueuedFile[];
  expandedLogs: string[]; // (Kept for prop compatibility, though we use a global terminal now)
  toggleLogs: (id: string) => void;
  removeFile: (id: string) => void;
  onBack: () => void;
}

export function Queue({ activeJobs, onBack }: QueueProps) {
  const [showTerminal, setShowTerminal] = useState(false);
  
  // Live Telemetry Mock State
  const [cpuUsage, setCpuUsage] = useState(82);
  const [ramUsage, setRamUsage] = useState(4.2);
  const [fps, setFps] = useState(18.4);

  // Identify the currently processing job (or the next in line, or the last completed)
  const activeJob = activeJobs.find(j => j.queueState === 'processing') || 
                    activeJobs.find(j => j.queueState === 'ingest') || 
                    activeJobs[activeJobs.length - 1];

  // Mock Hardware Telemetry Jitter
  useEffect(() => {
    if (activeJob?.queueState !== 'processing') return;
    const interval = setInterval(() => {
      setCpuUsage(prev => Math.min(100, Math.max(70, prev + (Math.random() * 10 - 5))));
      setRamUsage(prev => Math.min(12, Math.max(3.5, prev + (Math.random() * 0.4 - 0.2))));
      setFps(prev => Math.min(22, Math.max(15, prev + (Math.random() * 2 - 1))));
    }, 1000);
    return () => clearInterval(interval);
  }, [activeJob?.queueState]);

  // Circular Progress Math
  const radius = 140;
  const circumference = 2 * Math.PI * radius;
  const currentProgress = activeJob ? activeJob.progress : 0;
  const strokeDashoffset = circumference - (currentProgress / 100) * circumference;

  return (
    <motion.div 
      key="queue-page" 
      initial={{ opacity: 0, scale: 0.98 }} 
      animate={{ opacity: 1, scale: 1 }} 
      exit={{ opacity: 0, scale: 0.98 }} 
      className="flex-1 flex flex-col overflow-hidden relative z-20"
    >
      {/* HEADER */}
      <div className="flex items-center gap-4 mb-6 shrink-0 px-2">
        <button onClick={onBack} className="p-2 bg-surface hover:bg-surface-hover text-text-muted hover:text-white rounded-lg transition-colors cursor-pointer">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Server className="text-primary w-7 h-7" /> Telemetry Command Center
        </h1>
      </div>

      {/* 3-PANE DASHBOARD LAYOUT */}
      <div className="flex-1 flex gap-6 overflow-hidden pb-4">
        
        {/* ========================================== */}
        {/* LEFT PANE: INTELLIGENT QUEUE               */}
        {/* ========================================== */}
        <div className="w-1/4 bg-surface/30 border border-white/5 rounded-2xl p-4 flex flex-col shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 mb-4 px-2">
            <ListVideo className="w-5 h-5 text-text-muted" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-text-muted">Job Roster</h2>
          </div>
          
          <ul className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-2">
            {activeJobs.map((file) => {
              const isActive = file.id === activeJob?.id;
              const isDone = file.queueState === 'completed';
              const isPending = file.queueState === 'ingest';

              return (
                <li key={file.id} className={`p-3 rounded-xl border flex items-center gap-3 transition-colors ${isActive ? 'bg-primary/10 border-primary/30' : 'bg-background/50 border-white/5'}`}>
                  {/* Status Indicator */}
                  <div className="relative shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-black/40">
                    {isDone && <CheckCircle2 className="w-5 h-5 text-green-400" />}
                    {isPending && <PlayCircle className="w-5 h-5 text-text-muted" />}
                    {file.queueState === 'processing' && (
                      <>
                        <Loader2 className="w-5 h-5 text-primary animate-spin absolute" />
                        <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                      </>
                    )}
                  </div>
                  
                  <div className="flex flex-col overflow-hidden">
                    <span className={`text-sm font-bold truncate ${isActive ? 'text-white' : 'text-text-main'}`}>{file.name}</span>
                    <span className="text-xs font-mono text-text-muted">
                      {isDone ? 'COMPLETED' : isPending ? 'PENDING' : `${file.progress.toFixed(1)}%`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* ========================================== */}
        {/* CENTER PANE: MAIN HUD                      */}
        {/* ========================================== */}
        <div className="flex-1 bg-surface/20 border border-white/5 rounded-2xl relative flex flex-col items-center justify-center shadow-inner overflow-hidden">
          
          {activeJob ? (
            <div className="relative flex flex-col items-center justify-center z-10 w-full h-full">
              
              {/* Massive SVG Circular Progress */}
              <div className="relative flex items-center justify-center">
                {/* Background Ring */}
                <svg className="transform -rotate-90 w-80 h-80">
                  <circle cx="160" cy="160" r={radius} stroke="currentColor" strokeWidth="12" fill="transparent" className="text-white/5" />
                  
                  {/* Animated Foreground Ring */}
                  <motion.circle
                    cx="160" cy="160" r={radius}
                    stroke={activeJob.queueState === 'completed' ? '#22c55e' : '#6366f1'} // Green if done, Primary if active
                    strokeWidth="12" fill="transparent"
                    strokeDasharray={circumference}
                    animate={{ strokeDashoffset }}
                    transition={{ duration: 0.5, ease: "linear" }}
                    strokeLinecap="round"
                    className="drop-shadow-[0_0_15px_rgba(99,102,241,0.5)]"
                  />
                </svg>

                {/* Center Text Elements */}
                <div className="absolute flex flex-col items-center justify-center">
                  <span className="text-6xl font-black text-white tracking-tighter drop-shadow-lg">
                    {activeJob.progress.toFixed(0)}<span className="text-3xl text-primary">%</span>
                  </span>
                  <span className={`text-sm font-bold uppercase tracking-widest mt-2 ${activeJob.queueState === 'completed' ? 'text-green-400' : 'text-primary animate-pulse'}`}>
                    {activeJob.queueState === 'completed' ? 'Engine Idle' : 'Encoding Active'}
                  </span>
                </div>
              </div>

              {/* ETA Display */}
              <div className="mt-8 flex flex-col items-center bg-black/40 px-8 py-3 rounded-2xl border border-white/5 backdrop-blur-md">
                <span className="text-text-muted text-xs font-bold uppercase tracking-widest mb-1">Estimated Time Remaining</span>
                <span className="text-2xl font-mono text-white">{activeJob.eta}</span>
              </div>
            </div>
          ) : (
            <div className="text-text-muted text-lg font-bold">No Active Jobs</div>
          )}

          {/* ========================================== */}
          {/* BOTTOM TERMINAL OVERLAY (Slide Up)         */}
          {/* ========================================== */}
          <AnimatePresence>
            {showTerminal && activeJob && (
              <motion.div 
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="absolute bottom-0 left-0 right-0 h-1/2 bg-[#0A0A0C] border-t border-white/10 shadow-[0_-20px_50px_rgba(0,0,0,0.5)] flex flex-col z-20"
              >
                <div className="flex items-center justify-between px-4 py-2 bg-white/[0.02] border-b border-white/5">
                  <div className="flex items-center gap-3">
                    <Terminal className="w-4 h-4 text-text-muted" />
                    <span className="text-[10px] font-mono text-text-muted uppercase tracking-widest font-bold">Raw Engineering Output</span>
                  </div>
                  <button onClick={() => setShowTerminal(false)} className="text-text-muted hover:text-white text-xs font-bold uppercase cursor-pointer">Close</button>
                </div>
                <div className="p-4 font-mono text-xs overflow-y-auto custom-scrollbar flex flex-col gap-1">
                  {activeJob.logs.map((log, i) => (
                    <span key={i} className="text-green-400/90"><span className="text-blue-400/60 mr-3">[{new Date().toISOString().split('T')[1].slice(0, 8)}]</span>{log}</span>
                  ))}
                  {activeJob.queueState !== 'completed' && <motion.span animate={{ opacity: [1, 0] }} transition={{ repeat: Infinity, duration: 0.8 }} className="w-2 h-3.5 bg-green-400 inline-block mt-1" />}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          
          {/* Terminal Toggle Button */}
          <button 
            onClick={() => setShowTerminal(!showTerminal)}
            className="absolute bottom-4 right-4 z-30 flex items-center gap-2 bg-surface/80 hover:bg-surface border border-white/10 px-4 py-2 rounded-lg text-xs font-bold uppercase text-text-muted hover:text-white transition-colors cursor-pointer backdrop-blur-md"
          >
            <Terminal className="w-4 h-4" /> {showTerminal ? 'Hide Raw Terminal' : 'Show Raw Terminal'}
          </button>
        </div>

        {/* ========================================== */}
        {/* RIGHT PANE: LIVE HARDWARE TELEMETRY        */}
        {/* ========================================== */}
        <div className="w-1/4 flex flex-col gap-4">
          
          {/* CPU Card */}
          <div className="bg-surface/40 border border-white/5 rounded-2xl p-5 shadow-lg flex flex-col gap-3 relative overflow-hidden">
            <div className="flex items-center gap-3 relative z-10">
              <Cpu className="w-5 h-5 text-indigo-400" />
              <span className="text-sm font-bold uppercase tracking-widest text-text-muted">CPU Load</span>
            </div>
            <div className="relative z-10 flex items-end gap-2">
              <span className="text-3xl font-mono font-bold text-white">{cpuUsage.toFixed(1)}%</span>
              <span className="text-text-muted text-sm mb-1">10 / 12 Cores</span>
            </div>
            {/* Fake CPU Graph background */}
            <div className="absolute bottom-0 left-0 right-0 h-1/2 opacity-20 pointer-events-none flex items-end gap-1 px-2 pb-2">
              {[...Array(12)].map((_, i) => (
                <motion.div key={i} className="flex-1 bg-indigo-500 rounded-t-sm" animate={{ height: `${Math.random() * 80 + 20}%` }} transition={{ repeat: Infinity, duration: 1 + Math.random(), ease: "linear" }} />
              ))}
            </div>
          </div>

          {/* RAM Shield Card */}
          <div className="bg-surface/40 border border-white/5 rounded-2xl p-5 shadow-lg flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Shield className="w-5 h-5 text-green-400" />
              <span className="text-sm font-bold uppercase tracking-widest text-text-muted">RAM Shield</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-mono font-bold text-white">{ramUsage.toFixed(1)}</span>
              <span className="text-text-muted text-sm mb-1">GB Used</span>
            </div>
            <div className="w-full bg-black/50 rounded-full h-1.5 mt-2 overflow-hidden">
              <motion.div className="bg-green-400 h-full" animate={{ width: `${(ramUsage / 12) * 100}%` }} transition={{ duration: 1 }} />
            </div>
            <span className="text-xs font-mono text-green-400/60 mt-1">Protected Mode: ON (Limit: 12GB)</span>
          </div>

          {/* Engine Grid Card */}
          <div className="bg-surface/40 border border-white/5 rounded-2xl p-5 shadow-lg flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Server className="w-5 h-5 text-orange-400" />
              <span className="text-sm font-bold uppercase tracking-widest text-text-muted">Engine Grid</span>
            </div>
            <span className="text-2xl font-mono font-bold text-white">2 <span className="text-text-muted text-lg">Workers</span> x 5 <span className="text-text-muted text-lg">Threads</span></span>
          </div>

          {/* Throughput Card */}
          <div className="bg-surface/40 border border-white/5 rounded-2xl p-5 shadow-lg flex flex-col gap-3 mt-auto">
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 text-yellow-400" />
              <span className="text-sm font-bold uppercase tracking-widest text-text-muted">Throughput</span>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-4xl font-mono font-bold text-white">{fps.toFixed(1)}</span>
              <span className="text-text-muted text-sm mb-1">FPS</span>
            </div>
          </div>

        </div>

      </div>
    </motion.div>
  );
}