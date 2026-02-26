import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
  Terminal,
  Server,
  Cpu,
  Shield,
  Zap,
  ListVideo,
  CheckCircle2,
  Loader2,
  PlayCircle,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

// shadcn/ui
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Recharts for live graphs
import { LineChart, Line, ResponsiveContainer, Area, AreaChart, YAxis, Tooltip } from 'recharts';

import { type QueuedFile } from '../types';

interface QueueProps {
  activeJobs: QueuedFile[];
  expandedLogs: string[];
  toggleLogs: (id: string) => void;
  removeFile: (id: string) => void;
  onBack: () => void;
}

export function Queue({ activeJobs, expandedLogs, toggleLogs, removeFile, onBack }: QueueProps) {
  const [showTerminal, setShowTerminal] = useState(false);
  const [telemetry, setTelemetry] = useState<{ time: string; cpu: number; ram: number; fps: number }[]>([]);

  // Identify current job
  const activeJob =
    activeJobs.find((j) => j.queueState === 'processing') ||
    activeJobs.find((j) => j.queueState === 'ingest') ||
    activeJobs[activeJobs.length - 1];

  // Mock telemetry updates
  useEffect(() => {
    if (activeJob?.queueState !== 'processing') return;
    const interval = setInterval(() => {
      setTelemetry((prev) => {
        const newPoint = {
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          cpu: Math.min(100, Math.max(70, (prev[prev.length - 1]?.cpu || 80) + (Math.random() * 6 - 3))),
          ram: Math.min(12, Math.max(3.5, (prev[prev.length - 1]?.ram || 4.2) + (Math.random() * 0.4 - 0.2))),
          fps: Math.min(22, Math.max(15, (prev[prev.length - 1]?.fps || 18) + (Math.random() * 2 - 1))),
        };
        return [...prev.slice(-20), newPoint];
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [activeJob?.queueState]);

  // Circular progress calculation
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
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <Server className="text-primary w-5 h-5" />
          Telemetry Command Center
        </h1>
      </div>

      {/* 3‑column layout */}
      <div className="flex-1 flex gap-4 overflow-hidden pb-2">
        {/* Left: Job Roster */}
        <Card className="w-1/4 bg-card/50 border-border/50 flex flex-col">
          <CardHeader className="py-3 px-4">
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
                      className={`p-2 rounded-md flex items-center gap-2 transition-colors ${
                        isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-accent/20'
                      }`}
                    >
                      <div className="relative flex items-center justify-center w-6 h-6">
                        {job.queueState === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                        {job.queueState === 'ingest' && <PlayCircle className="w-4 h-4 text-muted-foreground" />}
                        {job.queueState === 'processing' && (
                          <>
                            <Loader2 className="w-4 h-4 text-primary animate-spin absolute" />
                            <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                          </>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{job.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {job.queueState === 'completed'
                            ? 'Completed'
                            : job.queueState === 'ingest'
                            ? 'Pending'
                            : `${job.progress.toFixed(1)}%`}
                        </p>
                      </div>
                      {job.queueState === 'processing' && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
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
<Card className="flex-1 bg-card/30 border-border/50 relative flex flex-col items-center justify-center overflow-hidden">          {activeJob ? (
            <>
              {/* Big circular progress */}
              <div className="relative flex items-center justify-center my-4">
                <svg className="transform -rotate-90 w-64 h-64">
                  <circle
                    cx="128"
                    cy="128"
                    r={radius}
                    stroke="currentColor"
                    strokeWidth="10"
                    fill="transparent"
                    className="text-white/5"
                  />
                  <motion.circle
                    cx="128"
                    cy="128"
                    r={radius}
                    stroke={activeJob.queueState === 'completed' ? '#22c55e' : '#6366f1'}
                    strokeWidth="10"
                    fill="transparent"
                    strokeDasharray={circumference}
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
                  <span
                    className={`text-xs font-bold uppercase mt-1 ${
                      activeJob.queueState === 'completed' ? 'text-green-400' : 'text-primary animate-pulse'
                    }`}
                  >
                    {activeJob.queueState === 'completed' ? 'Idle' : 'Encoding'}
                  </span>
                </div>
              </div>

              {/* ETA and logs toggle */}
              <div className="flex items-center gap-4 mt-2">
                <div className="bg-black/40 px-4 py-2 rounded-lg border border-white/5 backdrop-blur-sm text-center">
                  <p className="text-[10px] text-muted-foreground uppercase">ETA</p>
                  <p className="text-sm font-mono">{activeJob.eta}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowTerminal(!showTerminal)}>
                  <Terminal className="w-3 h-3 mr-1" />
                  {showTerminal ? 'Hide' : 'Show'} Terminal
                </Button>
              </div>

              {/* Terminal overlay */}
              <AnimatePresence>
                {showTerminal && (
                  <motion.div
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                     className="absolute bottom-0 left-0 right-0 h-1/2 bg-black/90 border-t border-border backdrop-blur-md flex flex-col z-20"
                  >
                    <div className="flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/5">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-3 h-3 text-muted-foreground" />
                        <span className="text-[10px] font-mono uppercase">Raw Output</span>
                      </div>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowTerminal(false)}>
                        <XCircle className="w-3 h-3" />
                      </Button>
                    </div>
                    <ScrollArea className="flex-1 p-2 font-mono text-[10px]">
                      {activeJob.logs.map((log, i) => (
                        <div key={i} className="text-green-400/80 whitespace-pre-wrap">
                          <span className="text-blue-400/60 mr-2">[{new Date().toLocaleTimeString()}]</span>
                          {log}
                        </div>
                      ))}
                      {activeJob.queueState !== 'completed' && (
                        <motion.span
                          animate={{ opacity: [1, 0] }}
                          transition={{ repeat: Infinity, duration: 0.8 }}
                          className="inline-block w-2 h-3.5 bg-green-400 mt-1"
                        />
                      )}
                    </ScrollArea>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <p className="text-muted-foreground">No active jobs</p>
          )}
        </Card>

        {/* Right: Live Telemetry */}
        <div className="w-1/4 flex flex-col gap-3">
          <Card className="bg-card/40 border-border/50">
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-xs font-medium flex items-center gap-1">
                <Cpu className="w-3 h-3 text-indigo-400" />
                CPU Load
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="flex items-end gap-1">
                <span className="text-2xl font-mono font-bold">
                  {telemetry.length ? telemetry[telemetry.length - 1].cpu.toFixed(1) : '—'}%
                </span>
                <span className="text-xs text-muted-foreground mb-1">/ 12 cores</span>
              </div>
              <div className="h-16 mt-2">
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
                <Shield className="w-3 h-3 text-green-400" />
                RAM Shield
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="flex items-end gap-1">
                <span className="text-2xl font-mono font-bold">
                  {telemetry.length ? telemetry[telemetry.length - 1].ram.toFixed(1) : '—'}
                </span>
                <span className="text-xs text-muted-foreground mb-1">GB</span>
              </div>
              <Progress
                value={((telemetry[telemetry.length - 1]?.ram || 0) / 12) * 100}
                className="h-1.5 mt-2"
                indicatorClassName="bg-green-400"
              />
              <p className="text-[10px] text-green-400/60 mt-1">Protected Mode: ON</p>
            </CardContent>
          </Card>

          <Card className="bg-card/40 border-white/5">
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-xs font-medium flex items-center gap-1">
                <Zap className="w-3 h-3 text-yellow-400" />
                Throughput
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              <div className="flex items-end gap-1">
                <span className="text-2xl font-mono font-bold">
                  {telemetry.length ? telemetry[telemetry.length - 1].fps.toFixed(1) : '—'}
                </span>
                <span className="text-xs text-muted-foreground mb-1">FPS</span>
              </div>
              <div className="h-16 mt-2">
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