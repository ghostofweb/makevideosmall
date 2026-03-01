import { useEffect, useState } from 'react';
import { Cpu, MemoryStick, CpuIcon, Gauge } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';

const { ipcRenderer } = window.require('electron');

interface HardwareInfo {
  cpuModel: string;
  cpuCores: number;
  cpuUsage: number;
  ramUsed: number;
  ramTotal: number;
  gpuName: string;
  gpuUsage?: number;
}

export function DetailedStats() {
  const [stats, setStats] = useState<HardwareInfo>({
    cpuModel: 'Detecting CPU...',
    cpuCores: 0,
    cpuUsage: 0,
    ramUsed: 0,
    ramTotal: 0,
    gpuName: 'Detecting GPU...',
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const sysStats = await ipcRenderer.invoke('get-system-stats');
        setStats(sysStats);
      } catch (err) {
        console.error('Failed to get system stats', err);
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className="bg-card/40 backdrop-blur-sm border-border/50 shadow-lg">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">System Telemetry</h3>
        </div>
        <Separator className="bg-border/50" />

        {/* CPU */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Cpu className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="text-muted-foreground truncate flex-1" title={stats.cpuModel}>
              {stats.cpuModel}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Usage</span>
            <Progress value={stats.cpuUsage} className="h-1.5 flex-1 [&>div]:bg-indigo-400" />
            <span className="text-xs font-mono w-12 text-right">{stats.cpuUsage.toFixed(1)}%</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Cores</span>
            <Badge variant="outline" className="text-xs">{stats.cpuCores} cores</Badge>
          </div>
        </div>

        {/* RAM */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <MemoryStick className="w-4 h-4 text-green-400 shrink-0" />
            <span className="text-muted-foreground">RAM</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16 shrink-0">Used</span>
            <Progress value={(stats.ramUsed / stats.ramTotal) * 100} className="h-1.5 flex-1 [&>div]:bg-green-400" />
            <span className="text-xs font-mono w-20 text-right">
              {stats.ramUsed.toFixed(1)} / {stats.ramTotal.toFixed(0)} GB
            </span>
          </div>
        </div>

        {/* GPU */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <CpuIcon className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="text-muted-foreground">GPU</span>
          </div>
          <p className="text-xs font-mono truncate" title={stats.gpuName}>{stats.gpuName}</p>
          {stats.gpuUsage !== undefined && stats.gpuUsage > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground w-16 shrink-0">Usage</span>
              <Progress value={stats.gpuUsage} className="h-1.5 flex-1 [&>div]:bg-purple-400" />
              <span className="text-xs font-mono w-12 text-right">{stats.gpuUsage.toFixed(1)}%</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}