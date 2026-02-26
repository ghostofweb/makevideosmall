import { ipcMain, app } from "electron";
import { spawn } from "child_process";
import path from "path";
import os from "os"; 
import fs from "fs"; 
export function registerVideoAPIs() {
  
  ipcMain.handle("analyze-video", async (event, filePath) => {
    return new Promise((resolve) => {
      const engineDir = path.join(app.getAppPath(), "engine");
      const pythonScript = path.join(engineDir, "compress.py");

      // 1. CREATE A SAFE, CLEAN TEMP DIRECTORY
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

      // 2. PASS THE SAFE TEMP DIRECTORY TO PYTHON
     const pythonProcess = spawn("python", [
        pythonScript,
        "--action", "analyze",
        "--input", filePath,
        "--tempdir", safeTempDir // <--- Ensure this is exactly like this
      ], { env });

      let jsonOutput = "";
      let errorLog = "";

      // ... keep your existing CATCHER 1, 2, 3, and 4 exactly the same ...
      pythonProcess.on("error", (err) => { /* ... */ });
      pythonProcess.stdout.on("data", (data) => {
         const str = data.toString();
         jsonOutput += str;
         console.log(`[PYTHON STDOUT]: ${str.trim()}`);
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

  ipcMain.handle("start-encode", async (event, config) => {
    console.log(`[NODE BRIDGE] Encode queued for:`, config);
    return { success: true, message: "Encode simulated." };
  });

}