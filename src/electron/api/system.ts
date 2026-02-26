import { ipcMain, dialog, app } from "electron";
import os from "os";
import fs from "fs";
import path from "path";
import si from "systeminformation";

// --- STATIC HARDWARE INFO (cached) ---
let cpuCores = os.cpus().length;
let totalRamGb = os.totalmem() / (1024 ** 3);
let cpuModel = "Detecting CPU...";
let gpuName = "Detecting GPU...";
let gpuUsage = 0;

// Fetch detailed CPU info once
si.cpu()
  .then(data => {
    cpuModel = data.brand;
  })
  .catch(err => console.error("CPU detection failed:", err));

// Fetch GPU info (including usage if possible)
si.graphics()
  .then(data => {
    if (data.controllers.length > 0) {
      const nvidiaGPU = data.controllers.find(c => 
        c.vendor?.toLowerCase().includes('nvidia') || 
        c.name?.toLowerCase().includes('nvidia')
      );
      const amdDedicated = data.controllers.find(c => 
        c.vendor?.toLowerCase().includes('amd') && 
        c.model?.toLowerCase().includes('rx')
      );
      const activeGPU = nvidiaGPU || amdDedicated || data.controllers[0];
      gpuName = activeGPU.model || activeGPU.name || "Unknown GPU";
    }
  })
  .catch(err => console.error("GPU Detection failed:", err));

// --- LIVE TELEMETRY ENGINE ---
let previousCpuInfo = getCpuInfo();

function getCpuInfo() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type as keyof typeof cpu.times];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// --- PERSISTENT STORAGE for completed jobs ---
const userDataPath = app.getPath("userData");
const jobsFilePath = path.join(userDataPath, "completed-jobs.json");

export function registerSystemAPIs() {
  
  // =========================================================
  // NATIVE WINDOWS FILE PICKER
  // =========================================================
  ipcMain.handle("select-files", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select Videos to Compress",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Videos", extensions: ["mp4", "mkv", "avi", "mov", "webm", "flv"] }]
    });
    if (canceled) return [];
    return filePaths.map(filePath => {
      const stats = fs.statSync(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        size: stats.size,
        type: "video/mp4" 
      };
    });
  });

  // =========================================================
  // ENHANCED HARDWARE TELEMETRY (with CPU model & GPU usage)
  // =========================================================
  ipcMain.handle("get-system-stats", async () => {
    const freeRam = os.freemem();
    const usedRamGb = (os.totalmem() - freeRam) / (1024 ** 3);

    const currentCpuInfo = getCpuInfo();
    const idleDifference = currentCpuInfo.idle - previousCpuInfo.idle;
    const totalDifference = currentCpuInfo.total - previousCpuInfo.total;
    const cpuUsage = 100 - Math.floor((idleDifference / totalDifference) * 100);
    previousCpuInfo = currentCpuInfo;

    // Get GPU usage (if available)
    try {
      const gpuData = await si.graphics();
      if (gpuData.controllers.length > 0) {
        gpuUsage = gpuData.controllers[0].utilizationGpu || 0;
      }
    } catch (err) {
      gpuUsage = 0;
    }

    return {
      cpuUsage,
      cpuCores,
      cpuModel,
      ramUsed: usedRamGb,
      ramTotal: totalRamGb,
      gpuName,
      gpuUsage,
    };
  });

  // =========================================================
  // PERSISTENT JOB STORAGE
  // =========================================================
  ipcMain.handle("save-completed-jobs", async (event, jobs: any[]) => {
    try {
      const data = JSON.stringify(jobs, null, 2);
      fs.writeFileSync(jobsFilePath, data, "utf8");
      return { success: true };
    } catch (err) {
      console.error("Failed to save jobs:", err);
      return { success: false, error: err };
    }
  });

  ipcMain.handle("load-completed-jobs", async () => {
    try {
      if (fs.existsSync(jobsFilePath)) {
        const data = fs.readFileSync(jobsFilePath, "utf8");
        return { success: true, jobs: JSON.parse(data) };
      }
      return { success: true, jobs: [] };
    } catch (err) {
      console.error("Failed to load jobs:", err);
      return { success: false, error: err };
    }
  });
}