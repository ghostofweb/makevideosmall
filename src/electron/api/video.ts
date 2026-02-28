import { ipcMain, app } from "electron";
import { spawn, exec } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

let activePythonProcess: import("child_process").ChildProcess | null = null;
let activeOutputPath: string | null = null;

export function registerVideoAPIs() {
  

  ipcMain.handle("cancel-encode", async () => {
    if (activePythonProcess && activePythonProcess.pid) {
      console.log("[NODE BRIDGE] 🛑 CANCEL SIGNAL RECEIVED. Terminating process tree...");
      const pid = activePythonProcess.pid;

      // Force kill process tree on Windows to ensure FFmpeg dies with Python
      if (process.platform === "win32") {
        exec(`taskkill /pid ${pid} /t /f`);
      } else {
        activePythonProcess.kill('SIGKILL');
      }

      // Clean up the half-finished video file
      if (activeOutputPath) {
        const fileToDelete = activeOutputPath;
        // Short delay to ensure FFmpeg has released its lock on the file
        setTimeout(() => {
          if (fs.existsSync(fileToDelete)) {
            try {
              fs.unlinkSync(fileToDelete);
              console.log(`[NODE BRIDGE] 🗑️ Cleaned up aborted file: ${fileToDelete}`);
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
    return { success: false, error: "No active process" };
  });


  ipcMain.handle("analyze-video", async (event, filePath) => {
    return new Promise((resolve) => {
      const engineDir = path.join(app.getAppPath(), "engine");
      const pythonScript = path.join(engineDir, "compress.py");

      // Safely create OS temp directory for the previews
      const safeTempDir = path.join(os.tmpdir(), "videobake_temp");
      if (!fs.existsSync(safeTempDir)) {
        fs.mkdirSync(safeTempDir, { recursive: true });
      }

      console.log(`\n=================================================`);
      console.log(`[NODE BRIDGE] Launching AI Analysis`);
      console.log(`[NODE BRIDGE] Target File: "${filePath}"`);
      console.log(`[NODE BRIDGE] Safe Temp Dir: "${safeTempDir}"`);
      console.log(`=================================================\n`);

      if (!filePath) {
        resolve({ success: false, error: "File path is empty." });
        return;
      }

      const env = { 
        ...process.env, 
        PATH: `${engineDir}${path.delimiter}${process.env.PATH}` 
      };

      const pythonProcess = spawn("python", [
        pythonScript,
        "--action", "analyze",
        "--input", filePath,
        "--tempdir", safeTempDir 
      ], { env });

      let jsonOutput = "";
      let errorLog = "";

      pythonProcess.on("error", (err) => {
        console.error("[PYTHON SPAWN ERROR]", err);
      });
      
      pythonProcess.stdout.on("data", (data) => {
         jsonOutput += data.toString();
      });
      
      pythonProcess.stderr.on("data", (data) => {
         const str = data.toString();
         errorLog += str;
         console.error(`[PYTHON STDERR]: ${str.trim()}`);
      });

      pythonProcess.on("close", (code) => {
        console.log(`\n[NODE BRIDGE] Python process closed with code: ${code}`);
        if (code !== 0) {
          console.error(`[NODE BRIDGE] ERROR LOG DUMP:\n${errorLog}`);
          resolve({ success: false, error: errorLog.trim() || `Python crashed` });
          return;
        }

        try {
          const result = JSON.parse(jsonOutput.trim());
          console.log("[NODE BRIDGE] Analysis complete. JSON parsed successfully.");
          resolve({ success: true, data: result });
        } catch (e) {
          resolve({ success: false, error: "Failed to parse Python data." });
        }
      });
    });
  });

  ipcMain.handle("start-encode", async (event, { fileId, inputPath, preset, previewsToDelete, settings }) => {
    
    // 1. Create an output path (e.g., "MyVideo_AV1.mp4")
    const parsedPath = path.parse(inputPath);
    let outputPath = path.join(parsedPath.dir, `${parsedPath.name}_AV1${parsedPath.ext}`);

    // If custom routing is enabled and a path exists, override it!
    if (settings?.outputRouting === 'custom' && settings?.customOutputPath) {
      outputPath = path.join(settings.customOutputPath, `${parsedPath.name}_AV1${parsedPath.ext}`);
    }

    const engineDir = path.join(app.getAppPath(), "engine");
    const pythonScript = path.join(engineDir, "compress.py");

    // 2. Clean up temporary preview files from the hard drive to save space
    if (previewsToDelete && Array.isArray(previewsToDelete)) {
      previewsToDelete.forEach(tempFile => {
        if (tempFile && fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
            console.log(`[NODE BRIDGE] Cleaned up temp file: ${tempFile}`);
          } catch (err) {
            console.error(`[NODE BRIDGE] Failed to clean up temp file: ${tempFile}`);
          }
        }
      });
    }

    console.log(`\n=================================================`);
    console.log(`[NODE BRIDGE] Launching Master Encode`);
    console.log(`[NODE BRIDGE] Input: "${inputPath}"`);
    console.log(`[NODE BRIDGE] Output: "${outputPath}"`);
    console.log(`=================================================\n`);

    if (!inputPath) {
      return { success: false, error: "Input path is empty." };
    }

    const env = { 
      ...process.env, 
      PATH: `${engineDir}${path.delimiter}${process.env.PATH}` 
    };

    // Calculate Allowed CPU Threads
    const totalThreads = os.cpus().length;
    const freeThreads = settings?.freeCpuCores ?? 2; // Default to saving 2 cores
    // Ensure we give it at least 1 thread so it doesn't crash
    const threadsToUse = Math.max(1, totalThreads - freeThreads).toString();

    // 3. Spawn Python for the Master Encode
    const pythonProcess = spawn("python", [
      pythonScript,
      "--action", "encode",
      "--input", inputPath,
      "--preset", preset,
      "--output", outputPath,
      "--threads", threadsToUse 
    ], { env });

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
          console.log(`[PYTHON STDOUT]: ${line}`);
        }
      }
    });

    pythonProcess.stderr.on("data", (data) => {
      const str = data.toString().trim();
      if (!str) return;
      
      console.log(str); 
      event.sender.send('encode-log', { fileId, log: str });
    });

    return new Promise((resolve) => {
      pythonProcess.on("close", (code) => {
        console.log(`\n[NODE BRIDGE] Encode finished with code: ${code}`);
        
        // 🔴 CLEAR THE GLOBALS
        activePythonProcess = null;
        activeOutputPath = null;

        if (code === 0) {
          // AUTOMATION: Delete the original video if they checked the box
          if (settings?.deleteOriginal) {
            try {
              if (fs.existsSync(inputPath)) {
                fs.unlinkSync(inputPath);
                console.log(`[NODE BRIDGE] AUTOMATION: Deleted original file -> ${inputPath}`);
              }
            } catch (err) {
              console.error("[NODE BRIDGE] Failed to delete original file.", err);
            }
          }
        }

        resolve({ success: code === 0, outputPath });
      });
    });
  });

}