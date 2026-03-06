import { ipcMain, dialog, app, shell } from "electron";
import os from "os";
import fs from "fs";
import path from "path";
import si from "systeminformation";
import { exec } from "child_process";

let cpuCores = os.cpus().length;
let totalRamGb = os.totalmem() / (1024 ** 3);
let cpuModel = "Detecting CPU...";
let gpuName = "Detecting GPU...";
let gpuUsage = 0;

si.cpu()
  .then(data => {
    cpuModel = data.brand;
  })
  .catch(err => console.error("CPU detection failed:", err));

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

const userDataPath = app.getPath("userData");
const jobsFilePath = path.join(userDataPath, "completed-jobs.json");

export function registerSystemAPIs() {
  
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
  const workspacePath = path.join(app.getPath('userData'), 'videobake_workspace.json');
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

  ipcMain.handle('load-workspace', async () => {
    try {
      if (fs.existsSync(workspacePath)) {
        const data = fs.readFileSync(workspacePath, 'utf-8');
        if (!data || data.trim() === '') return { success: true, files: [] };
        
        const parsedFiles = JSON.parse(data);
        const safeFiles = parsedFiles.map((f: any) => {
          if (f.analysisState === 'analyzing') {
            f.analysisState = 'none';
          }
          if (f.queueState === 'processing') {
            f.queueState = 'ingest'; 
            f.progress = 0;
            f.logs.push("[SYSTEM] App closed during processing. Job reset.");
          }
          return f;
        });

        return { success: true, files: safeFiles };
      }
      return { success: true, files: [] };
    } catch (error) {
      console.error("Failed to load workspace:", error);
      return { success: true, files: [] };
    }
  });

  ipcMain.handle('save-workspace', async (event, files) => {
    try {
      fs.writeFileSync(workspacePath, JSON.stringify(files, null, 2));
      return { success: true };
    } catch (error) {
      console.error("Failed to save workspace:", error);
      return { success: false };
    }
  });

  ipcMain.handle('open-file-location', async (event, filePath) => {
    try {
      shell.showItemInFolder(path.normalize(filePath));
      return { success: true };
    } catch (error) {
      console.error("Failed to open folder:", error);
      return { success: false };
    }
  });

ipcMain.handle('select-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return canceled ? null : filePaths[0];
  });

  
  ipcMain.handle('delete-physical-file', async (event, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath); 
        return { success: true };
      }
      return { success: false, error: "File not found." };
    } catch (error) {
      console.error("Failed to delete file:", error);
      return { success: false };
    }
  });


  ipcMain.handle('open-folder', async (event, folderPath) => {
    if (fs.existsSync(folderPath)) {
      shell.openPath(folderPath);
    }
  });


  ipcMain.handle('select-audio', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'aac'] }]
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('shutdown-pc', () => {
    console.log("[AUTOMATION] Executing OS Shutdown...");
    if (process.platform === 'win32') exec('shutdown /s /t 0');
    else if (process.platform === 'darwin') exec('osascript -e \'tell app "System Events" to shut down\'');
    else exec('shutdown -h now');
  });
}