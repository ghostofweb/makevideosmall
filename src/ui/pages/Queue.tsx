import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft, Terminal, Server, Cpu, Shield, Zap, ListVideo, 
  CheckCircle2, Loader2, PlayCircle, XCircle, FolderOpen, Trash2, X, StopCircle
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { LineChart, Line, ResponsiveContainer, Area, AreaChart } from 'recharts';
import { type QueuedFile } from '../types';

const { ipcRenderer } = window.require('electron');

interface QueueProps {
  activeJobs: QueuedFile[];
  expandedLogs: string[];
  toggleLogs: (id: string) => void;
  removeFile: (id: string) => void;
  cancelJob: (id: string) => void; 
  onBack: () => void;
}

export function Queue({ activeJobs, expandedLogs, toggleLogs, removeFile, cancelJob, onBack }: QueueProps) {
  const [showTerminal, setShowTerminal] = useState(false);
  const [telemetry, setTelemetry] = useState<{ time: string; cpu: number; ram: number; fps: number }[]>([]);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const activeJob =
    activeJobs.find((j) => j.queueState === 'processing') ||
    activeJobs.find((j) => j.queueState === 'ingest') ||
    activeJobs[activeJobs.length - 1];

  useEffect(() => {
    if (showTerminal && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeJob?.logs, showTerminal]);

  useEffect(() => {
    const handleTelemetry = (_event: any, data: any) => {
      if (data.type === 'telemetry') {
        setTelemetry((prev) => {
          const newPoint = {
            time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            cpu: data.cpu || 0, ram: data.ram || 0, fps: data.fps || 0,
          };
          return [...prev.slice(-19), newPoint];
        });
      }
    };

    if (ipcRenderer) ipcRenderer.on('encode-telemetry', handleTelemetry);
    return () => { if (ipcRenderer) ipcRenderer.removeListener('encode-telemetry', handleTelemetry); };
  }, []);

  const handleOpenLocation = async (job: any) => {
    const targetPath = job.outputPath || job.path;
    await ipcRenderer.invoke('open-file-location', targetPath);
  };

  const handlePhysicalDelete = async (id: string, path: string) => {
    const confirm = window.confirm("WARNING: This will permanently delete the original video file from your hard drive. Are you sure?");
    if (confirm) {
      const res = await ipcRenderer.invoke('delete-physical-file', path);
      if (res.success) {
        toast.success("File deleted from disk.");
        removeFile(id); 
      } else {
        toast.error("Failed to delete file from disk.");
      }
    }
  };

  const radius = 120;
  const circumference = 2 * Math.PI * radius;
  const progress = activeJob ? activeJob.progress : 0;
  const dashOffset = circumference - (progress / 100) * circumference;

  return (
    <motion.div
      key="queue-page"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className="flex-1 flex flex-col overflow-hidden relative z-20"
    >
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <Server className="text-primary w-5 h-5" />
          Processing Queue
        </h1>
      </div>

      <div className="flex-1 flex gap-4 overflow-hidden pb-2">
        {/* Left: Job Roster */}
        <Card className="w-1/4 bg-card/50 border-border/50 flex flex-col min-w-[280px]">
          <CardHeader className="py-3 px-4 shrink-0">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ListVideo className="w-4 h-4 text-muted-foreground" />
              Job Roster
            </CardTitle>
          </CardHeader>
          <CardContent className="p-2 flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-2">
              <div className="flex flex-col gap-1">
                {activeJobs.map((job) => {
                  const isActive = job.id === activeJob?.id;
                  return (
                    <div
                      key={job.id}
                      className={`group p-2 rounded-md flex items-center gap-2 transition-colors ${
                        isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-accent/20'
                      }`}
                    >
                      <div className="relative flex items-center justify-center w-6 h-6 shrink-0">
                        {job.queueState === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                        {job.queueState === 'ingest' && <PlayCircle className="w-4 h-4 text-muted-foreground" />}
                        {job.queueState === 'queued' && <Loader2 className="w-4 h-4 text-muted-foreground animate-pulse" />}
                        {job.queueState === 'processing' && (
                          <>
                            <Loader2 className="w-4 h-4 text-primary animate-spin absolute" />
                            <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                          </>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate" title={job.customName || job.name}>
                          {job.customName || job.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {job.queueState === 'completed'
                            ? 'Completed'
                            : job.queueState === 'ingest'
                            ? 'Pending'
                            : job.queueState === 'queued'
                            ? 'Waiting...'
                            : `${job.progress.toFixed(1)}%`}
                        </p>
                      </div>

                      <TooltipProvider delayDuration={150}>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-200 shrink-0 bg-background/80 backdrop-blur-md rounded-md border border-border/50 p-0.5 shadow-lg translate-x-2 group-hover:translate-x-0">
                          {(job.queueState === 'processing' || job.queueState === 'queued') && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button 
                                  variant="ghost" 
                                  size="icon" 
                                  className="w-7 h-7 hover:bg-destructive/20 hover:text-destructive text-orange-400/80 transition-colors" 
                                  onClick={(e) => { e.stopPropagation(); cancelJob(job.id); }}
                                >
                                  <StopCircle className="w-3.5 h-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-[10px] font-medium">
                                {job.queueState === 'processing' ? "Abort Encoding" : "Remove from Queue"}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="w-7 h-7 hover:bg-blue-500/20 hover:text-blue-400 text-muted-foreground transition-colors" 
                                onClick={(e) => { e.stopPropagation(); handleOpenLocation(job); }}
                              >
                                <FolderOpen className="w-3.5 h-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[10px] font-medium">
                              Open File Location
                            </TooltipContent>
                          </Tooltip>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="w-7 h-7 hover:bg-yellow-500/20 hover:text-yellow-400 text-muted-foreground transition-colors" 
                                onClick={(e) => { e.stopPropagation(); removeFile(job.id); }}
                              >
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[10px] font-medium">
                              Clear from Queue
                            </TooltipContent>
                          </Tooltip>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="w-7 h-7 hover:bg-red-500/20 hover:text-red-500 text-muted-foreground transition-colors" 
                                onClick={(e) => { e.stopPropagation(); handlePhysicalDelete(job.id, job.path); }}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[10px] font-medium text-destructive">
                              Delete Original File from Disk
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </TooltipProvider>

                      {job.queueState === 'processing' && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 group-hover:hidden">
                          {job.eta}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Center: Main HUD */}
        <Card className="flex-1 bg-card/30 border-border/50 relative flex flex-col items-center justify-center overflow-hidden">
          {activeJob ? (
            <>
              <div className="relative flex items-center justify-center my-4 transition-transform duration-300">
                <svg className="transform -rotate-90 w-64 h-64">
                  <circle cx="128" cy="128" r={radius} stroke="currentColor" strokeWidth="10" fill="transparent" className="text-white/5" />
                  <motion.circle
                    cx="128" cy="128" r={radius}
                    stroke={activeJob.queueState === 'completed' ? '#22c55e' : '#6366f1'}
                    strokeWidth="10" fill="transparent" strokeDasharray={circumference}
                    animate={{ strokeDashoffset: dashOffset }}
                    transition={{ duration: 0.5, ease: 'linear' }}
                    strokeLinecap="round"
                    className="drop-shadow-[0_0_10px_rgba(99,102,241,0.5)]"
                  />
                </svg>
                <div className="absolute flex flex-col items-center">
                  <span className="text-4xl font-black text-foreground">
                    {progress.toFixed(0)}<span className="text-xl text-primary">%</span>
                  </span>
                  <span className={`text-xs font-bold uppercase mt-1 ${activeJob.queueState === 'completed' ? 'text-green-400' : 'text-primary animate-pulse'}`}>
                    {activeJob.queueState === 'completed' ? 'Idle' : 'Encoding'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 mt-2 mb-4 z-10 relative">
                <div className="bg-black/40 px-4 py-2 rounded-lg border border-white/5 backdrop-blur-sm text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">ETA</p>
                  <p className="text-sm font-mono">{activeJob.eta}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowTerminal(!showTerminal)} className="bg-background/50 backdrop-blur-sm">
                  <Terminal className="w-3 h-3 mr-1" />
                  {showTerminal ? 'Hide' : 'Show'} Terminal
                </Button>
              </div>

              {/* 🔴 THE FIX: Properly contained absolute overlay */}
              <AnimatePresence>
                {showTerminal && (
                  <motion.div
                    initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                    // Strict absolute positioning constrained to the parent Card!
                    className="absolute bottom-0 left-0 right-0 h-[60%] bg-black/95 border-t border-border/50 shadow-[0_-10px_40px_rgba(0,0,0,0.5)] flex flex-col z-30"
                  >
                    <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/80 border-b border-white/5 shrink-0">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Engine Output</span>
                      </div>
                      <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-white/10 hover:text-white" onClick={() => setShowTerminal(false)}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    
                    {/* Log text area */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-3 font-mono text-[11px] leading-relaxed">
                      {activeJob.logs?.map((log, i) => (
                        <div key={i} className="text-green-400/90 whitespace-pre-wrap break-all mb-1">
                          <span className="text-blue-400/60 mr-2 select-none">[{new Date().toLocaleTimeString()}]</span>
                          {log}
                        </div>
                      ))}
                      {activeJob.queueState !== 'completed' && (
                        <motion.span animate={{ opacity: [1, 0] }} transition={{ repeat: Infinity, duration: 0.8 }} className="inline-block w-2 h-3 bg-green-400 mt-1 ml-1" />
                      )}
                      <div ref={terminalEndRef} className="h-4" /> {/* Padding so last line isn't cut off */}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <p className="text-muted-foreground">No active jobs</p>
          )}
        </Card>

        {/* Right: Live Telemetry */}
        <div className="w-1/4 flex flex-col gap-3 min-w-[240px]">
          <Card className="bg-card/40 border-border/50">
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-xs font-medium flex items-center gap-1">
                <Cpu className="w-3 h-3 text-indigo-400" /> CPU Load
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="flex items-end gap-1">
                <span className="text-2xl font-mono font-bold">{telemetry.length ? telemetry[telemetry.length - 1].cpu.toFixed(1) : '—'}%</span>
                <span className="text-xs text-muted-foreground mb-1">/ 12 cores</span>
              </div>
              <div className="h-16 mt-2" style={{ minHeight: '64px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={telemetry}>
                    <defs>
                      <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#818cf8" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
                      </linearGradient> 
                    </defs>
                    <Area type="monotone" dataKey="cpu" stroke="#818cf8" strokeWidth={2} fill="url(#cpuGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/40 border-white/5">
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-xs font-medium flex items-center gap-1">
                <Shield className="w-3 h-3 text-green-400" /> RAM Shield
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="flex items-end gap-1">
                <span className="text-2xl font-mono font-bold">{telemetry.length ? telemetry[telemetry.length - 1].ram.toFixed(1) : '—'}</span>
                <span className="text-xs text-muted-foreground mb-1">GB</span>
              </div>
              <Progress value={((telemetry[telemetry.length - 1]?.ram || 0) / 12) * 100} className="h-1.5 mt-2" />
              <p className="text-[10px] text-green-400/60 mt-1">Protected Mode: ON</p>
            </CardContent>
          </Card>

          <Card className="bg-card/40 border-white/5 flex-1 flex flex-col">
            <CardHeader className="py-2 px-3 shrink-0">
              <CardTitle className="text-xs font-medium flex items-center gap-1">
                <Zap className="w-3 h-3 text-yellow-400" /> Throughput
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3 flex-1 flex flex-col justify-end">
              <div className="flex items-end gap-1">
                <span className="text-2xl font-mono font-bold">{telemetry.length ? telemetry[telemetry.length - 1].fps.toFixed(1) : '—'}</span>
                <span className="text-xs text-muted-foreground mb-1">FPS</span>
              </div>
              <div className="h-16 mt-2 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={telemetry}>
                    <Line type="monotone" dataKey="fps" stroke="#fbbf24" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </motion.div>
  );
}