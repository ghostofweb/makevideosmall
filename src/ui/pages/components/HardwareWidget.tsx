import { useEffect, useState } from 'react';
import { Cpu, Shield, Monitor } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

interface SystemStats {
  cpuUsage: number;
  cpuCores: number;
  ramUsed: number;
  ramTotal: number;
  gpuName: string;
}

export function HardwareWidget() {
  const [stats, setStats] = useState<SystemStats>({
    cpuUsage: 0,
    cpuCores: 0,
    ramUsed: 0,
    ramTotal: 0,
    gpuName: "Loading...",
  });

  useEffect(() => {
    // Initial fetch instantly
    ipcRenderer.invoke('get-system-stats').then(setStats).catch(console.error);

    // Ping the backend every 2 seconds for live updates
    const interval = setInterval(async () => {
      try {
        const liveStats = await ipcRenderer.invoke('get-system-stats');
        setStats(liveStats);
      } catch (error) {
        console.error("IPC Telemetry Failed:", error);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  // Clean up the GPU name so "NVIDIA GeForce RTX 3060 Laptop GPU" becomes "RTX 3060"
  const cleanGpuName = stats.gpuName
    .replace("NVIDIA GeForce ", "")
    .replace("AMD Radeon ", "")
    .replace(" Laptop GPU", "");

  return (
    <div className="flex items-center gap-6 text-sm bg-surface/50 border border-white/5 px-4 py-2 rounded-xl shadow-inner">
      
      {/* CPU Block */}
      <div className="flex items-center gap-2" title={`${stats.cpuCores} CPU Cores Detected`}>
        <Cpu className="w-4 h-4 text-indigo-400" />
        <div className="flex flex-col">
          <span className="font-mono text-white leading-none font-bold">{stats.cpuUsage.toFixed(1)}%</span>
          <span className="text-[10px] text-text-muted leading-none mt-1 uppercase tracking-wider">{stats.cpuCores} Cores</span>
        </div>
      </div>

      <div className="w-px h-6 bg-white/10" /> {/* Divider */}

      {/* RAM Block */}
      <div className="flex items-center gap-2" title="System Memory">
        <Shield className="w-4 h-4 text-green-400" />
        <div className="flex flex-col">
          <span className="font-mono text-white leading-none font-bold">{stats.ramUsed.toFixed(1)} GB</span>
          <span className="text-[10px] text-text-muted leading-none mt-1 uppercase tracking-wider">/ {stats.ramTotal.toFixed(0)} GB Total</span>
        </div>
      </div>

      <div className="w-px h-6 bg-white/10" /> {/* Divider */}

      {/* GPU Block */}
      <div className="flex items-center gap-2" title="Dedicated Graphics Card">
        <Monitor className="w-4 h-4 text-purple-400" />
        <div className="flex flex-col">
          <span className="font-mono text-white leading-none font-bold truncate max-w-[120px]">{cleanGpuName}</span>
          <span className="text-[10px] text-text-muted leading-none mt-1 uppercase tracking-wider">Active GPU</span>
        </div>
      </div>

    </div>
  );
}