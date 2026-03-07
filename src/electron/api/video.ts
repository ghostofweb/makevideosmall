import { ipcMain, app } from "electron";
import { spawn, exec } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

let activePythonProcess: import("child_process").ChildProcess | null = null;
let activeAnalysisProcess: import("child_process").ChildProcess | null = null;
let activeOutputPath: string | null = null;

app.on('before-quit', () => {
  console.log("[SYSTEM] App closing. Hunting down zombie processes...");
  if (activePythonProcess && activePythonProcess.pid) {
    if (process.platform === "win32") exec(`taskkill /pid ${activePythonProcess.pid} /t /f`);
    else activePythonProcess.kill('SIGKILL');
  }
  if (activeAnalysisProcess && activeAnalysisProcess.pid) {
    if (process.platform === "win32") exec(`taskkill /pid ${activeAnalysisProcess.pid} /t /f`);
    else activeAnalysisProcess.kill('SIGKILL');
  }
});

export function registerVideoAPIs() {

  ipcMain.handle("cancel-encode", async () => {
    if (activePythonProcess && activePythonProcess.pid) {
      console.log("[NODE BRIDGE] Terminating Master Encode process tree...");
      
      if (process.platform === "win32") {
        exec(`taskkill /pid ${activePythonProcess.pid} /t /f`);
      } else {
        activePythonProcess.kill('SIGKILL');
      }

      if (activeOutputPath) {
        const fileToDelete = activeOutputPath;
        setTimeout(() => {
          if (fs.existsSync(fileToDelete)) {
            try {
              fs.unlinkSync(fileToDelete);
              console.log(`[NODE BRIDGE] Cleaned up aborted file: ${fileToDelete}`);
            } catch (e) {
              console.error("[NODE BRIDGE] Failed to delete aborted file", e);
            }
          }
        }, 1500); 
      }

      activePythonProcess = null;
      activeOutputPath = null;
      return { success: true };
    }
    return { success: false, error: "No active encode process" };
  });

  ipcMain.handle("cancel-analysis", async () => {
    if (activeAnalysisProcess && activeAnalysisProcess.pid) {
      console.log("[NODE BRIDGE] Terminating Analysis process tree...");
      if (process.platform === "win32") {
        exec(`taskkill /pid ${activeAnalysisProcess.pid} /t /f`);
      } else {
        activeAnalysisProcess.kill('SIGKILL');
      }
      activeAnalysisProcess = null;
      return { success: true };
    }
    return { success: false, error: "No active analysis process" };
  });

  ipcMain.handle("analyze-video", async (event, { filePath, settings }) => {
    return new Promise((resolve) => {
      const engineDir = app.isPackaged 
        ? path.join(process.resourcesPath, "engine") 
        : path.join(app.getAppPath(), "engine");

      const engineChoice = settings?.engine || 'gpu';
      const pythonScript = path.join(engineDir, "compress.py");

      const safeTempDir = path.join(os.tmpdir(), "videobake_temp");
      if (!fs.existsSync(safeTempDir)) {
        fs.mkdirSync(safeTempDir, { recursive: true });
      }

      console.log(`\n=================================================`);
      console.log(`[NODE BRIDGE] 🧬 LAUNCHING AI ANALYSIS`);
      console.log(`[NODE BRIDGE] Target File: "${filePath}"`);
      console.log(`[NODE BRIDGE] Requested Engine: ${engineChoice.toUpperCase()}`);
      console.log(`=================================================\n`);

      if (!filePath) {
        console.error("[NODE BRIDGE] Failed: File path is empty.");
        resolve({ success: false, error: "File path is empty." });
        return;
      }

      const env = { 
        ...process.env, 
        PATH: `${engineDir}${path.delimiter}${process.env.PATH}` 
      };
      
      const pythonArgs = [
        pythonScript, 
        "--action", "analyze", 
        "--input", filePath,
        "--tempdir", safeTempDir, 
        "--impact", "stealth", 
        "--engine", engineChoice
      ];

      console.log(`[NODE BRIDGE] Executing command: python ${pythonArgs.join(" ")}`);
      
      const pythonProcess = spawn("python", pythonArgs, { env });
      activeAnalysisProcess = pythonProcess;

      let jsonOutput = "";
      let errorLog = "";

      pythonProcess.on("error", (err) => {
        console.error("[NODE BRIDGE] [PYTHON SPAWN ERROR]", err);
      });
      
      pythonProcess.stdout.on("data", (data) => {
        const str = data.toString();
        try {
           const parsed = JSON.parse(str.trim());
           if (parsed.type === 'analysis_progress') {
             // We don't log every progress tick here to avoid spamming the console, 
             // but we send it to the UI.
             event.sender.send('analyze-telemetry', parsed);
             return;
           }
        } catch(e) {
           // Not a progress JSON, append to our final output buffer
        }
        jsonOutput += str;
      });
      
      pythonProcess.stderr.on("data", (data) => {
         const str = data.toString();
         console.log(`[PYTHON ANALYZE LOG] ${str.trim()}`);
         errorLog += str;
      });

      pythonProcess.on("close", (code) => {
        console.log(`[NODE BRIDGE] Analysis process closed with code: ${code}`);
        activeAnalysisProcess = null;

        if (code !== 0) {
          console.error(`[NODE BRIDGE] Analysis Failed. Error Log:\n${errorLog}`);
          resolve({ success: false, error: errorLog.trim() || `Process crashed or was killed` });
          return;
        }

        try {
          // Extract just the final JSON payload in case other text got mixed in
          const lines = jsonOutput.trim().split('\n');
          const finalLine = lines[lines.length - 1];
          const result = JSON.parse(finalLine);
          
          console.log(`[NODE BRIDGE] Analysis complete. Detected Engine: ${result.active_engine?.toUpperCase()}`);
          resolve({ success: true, data: result });
        } catch (e) {
          console.error(`[NODE BRIDGE] Failed to parse Python JSON output. Output was:`, jsonOutput);
          resolve({ success: false, error: "Failed to parse Python data." });
        }
      });
    });
  });

  ipcMain.handle("start-encode", async (event, { fileId, inputPath, preset, previewsToDelete, settings, customFileName }) => {
    
    const parsedPath = path.parse(inputPath);
    
    const finalBaseName = customFileName 
      ? customFileName.replace(/\.[^/.]+$/, "") 
      : `${parsedPath.name}_AV1`;

    let outputPath = path.join(parsedPath.dir, `${finalBaseName}${parsedPath.ext}`);
    if (settings?.outputRouting === 'custom' && settings?.customOutputPath) {
      outputPath = path.join(settings.customOutputPath, `${finalBaseName}${parsedPath.ext}`);
    }

    const engineChoice = settings?.engine || 'gpu';
    const impactLevel = settings?.systemImpact || 'balanced';

    const engineDir = app.isPackaged 
      ? path.join(process.resourcesPath, "engine") 
      : path.join(app.getAppPath(), "engine"); 
      
    const pythonScript = path.join(engineDir, "compress.py");

    // Clean up temporary preview files
    if (previewsToDelete && Array.isArray(previewsToDelete)) {
      console.log(`[NODE BRIDGE] Cleaning up ${previewsToDelete.length} temporary preview files...`);
      previewsToDelete.forEach(tempFile => {
        if (tempFile && fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch (err) {
            console.warn(`[NODE BRIDGE] Failed to delete temp file: ${tempFile}`);
          }
        }
      });
    }

    console.log(`\n=================================================`);
    console.log(`[NODE BRIDGE] 🚀 LAUNCHING MASTER ENCODE`);
    console.log(`[NODE BRIDGE] Input: "${inputPath}"`);
    console.log(`[NODE BRIDGE] Output: "${outputPath}"`);
    console.log(`[NODE BRIDGE] Target Engine: ${engineChoice.toUpperCase()}`);
    console.log(`[NODE BRIDGE] OS Impact Level: ${impactLevel.toUpperCase()}`);
    console.log(`[NODE BRIDGE] Preset: ${preset.toUpperCase()}`);
    console.log(`=================================================\n`);

    if (!inputPath) {
      console.error("[NODE BRIDGE] Encode Failed: Input path is empty.");
      return { success: false, error: "Input path is empty." };
    }

    const env = { 
      ...process.env, 
      PATH: `${engineDir}${path.delimiter}${process.env.PATH}` 
    };

    const pythonArgs = [
      pythonScript,
      "--action", "encode",
      "--input", inputPath,
      "--preset", preset,
      "--output", outputPath,
      "--impact", impactLevel,
      "--engine", engineChoice
    ];

    console.log(`[NODE BRIDGE] Executing command: python ${pythonArgs.join(" ")}`);

    const pythonProcess = spawn("python", pythonArgs, { env });

    activePythonProcess = pythonProcess;
    activeOutputPath = outputPath;

    pythonProcess.stdout.on("data", (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          event.sender.send('encode-telemetry', { fileId, ...parsed });
        } catch (e) {
          // If it's not JSON, it might just be standard output we want to see in the console
          console.log(`[PYTHON STDOUT] ${line.trim()}`);
        }
      }
    });

    pythonProcess.stderr.on("data", (data) => {
      const str = data.toString().trim();
      if (!str) return;
      
      // We log the raw FFmpeg/Python stderr output to the Node console for debugging
      console.log(`[PYTHON STDERR] ${str}`);
      
      if (str.includes("[PYTHON WARN] Hardware probe failed") || str.includes("Fallback to CPU")) {
         console.warn("[NODE BRIDGE] Intercepted GPU Fallback Warning. Sending to UI.");
         event.sender.send('encode-log', { 
           fileId, 
           log: "[SYSTEM WARN] GPU Not Detected. Forcing Deep CPU Mode. ETA will increase significantly." 
         });
      } else {
         // Send standard logs to the UI's log console
         event.sender.send('encode-log', { fileId, log: str });
      }
    });

    return new Promise((resolve) => {
      pythonProcess.on("close", (code) => {
        console.log(`\n[NODE BRIDGE] Encode finished with exit code: ${code}`);
        
        activePythonProcess = null;
        activeOutputPath = null;

        if (code === 0) {
          console.log(`[NODE BRIDGE] Encode SUCCESS! File ready at: ${outputPath}`);
          
          if (settings?.deleteOriginal) {
            console.log(`[NODE BRIDGE] Auto-Delete enabled. Removing original file: ${inputPath}`);
            try {
              if (fs.existsSync(inputPath)) {
                fs.unlinkSync(inputPath);
              }
            } catch (err) {
              console.error(`[NODE BRIDGE] Failed to delete original file:`, err);
            }
          }
        } else {
          console.error(`[NODE BRIDGE] Encode FAILED.`);
        }
        
        resolve({ success: code === 0, outputPath });
      });
    });
  });
}