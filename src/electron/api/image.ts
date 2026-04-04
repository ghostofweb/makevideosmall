import { ipcMain, app } from "electron";
import { spawn, exec, ChildProcess } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

let activeImageProcess: ChildProcess | null = null;

app.on('before-quit', () => {
  if (activeImageProcess?.pid) {
    if (process.platform === "win32") exec(`taskkill /pid ${activeImageProcess.pid} /t /f`);
    else activeImageProcess.kill('SIGKILL');
  }
});

function getEngineDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine")
    : path.join(app.getAppPath(), "engine");
}

export function registerImageAPIs() {

  // ── 1. CANCEL ──
  ipcMain.handle("cancel-image-job", async () => {
    if (activeImageProcess?.pid) {
      console.log("[NODE] Killing image process...");
      if (process.platform === "win32") exec(`taskkill /pid ${activeImageProcess.pid} /t /f`);
      else activeImageProcess.kill('SIGKILL');
      activeImageProcess = null;
      return { success: true };
    }
    return { success: false, error: "No active process" };
  });

  // ── 2. ANALYZE ──
  ipcMain.handle("analyze-image", async (_event, { filePath }) => {
    return new Promise((resolve) => {
      if (!filePath) {
        resolve({ success: false, error: "File path is empty." });
        return;
      }

      const engineDir  = getEngineDir();
      const executable = path.join(engineDir, "image.exe");
      const env        = { ...process.env, PATH: `${engineDir}${path.delimiter}${process.env.PATH}` };

      console.log(`[NODE] analyze-image: "${filePath}"`);

      const proc = spawn(executable, ["--action", "analyze", "--input", filePath], { env });
      let stdout = "";

      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { console.log(`[ENGINE STDERR] ${d.toString().trim()}`); });

      proc.on("close", (code) => {
        if (code !== 0) { resolve({ success: false, error: `Engine exited ${code}` }); return; }
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.type === "analyze_complete") resolve({ success: true, data: parsed.data });
          else resolve({ success: false, error: "Unexpected response type from engine." });
        } catch (e) {
          resolve({ success: false, error: `JSON parse failed: ${e}` });
        }
      });
    });
  });

  // ── 3. START JOB ──
  ipcMain.handle("start-image-job", async (event, {
    fileId, inputPath, action, settings, customFileName
  }) => {
    if (!inputPath) {
      return { success: false, error: "inputPath is undefined — file.path was not resolved correctly." };
    }

    const parsedPath = path.parse(inputPath);

    // Output extension: from format setting, or keep original
    let outExt = parsedPath.ext;
    if (action === "compress" || action === "target") {
      outExt = settings.format ? `.${settings.format}` : parsedPath.ext;
    } else if (action === "upscale") {
      outExt = ".png"; // Real-ESRGAN always outputs PNG
    }

    const baseName   = customFileName?.trim()
      ? customFileName.replace(/\.[^/.]+$/, "") // strip any ext the user typed
      : `${parsedPath.name}_Optimized`;

    const outputPath = path.join(
      settings?.customOutputPath ?? parsedPath.dir,
      `${baseName}${outExt}`
    );

    const engineDir  = getEngineDir();
    const executable = path.join(engineDir, "image.exe");
    const tempDir    = path.join(os.tmpdir(), "imagestudio_temp");

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[NODE] JOB: ${action.toUpperCase()}`);
    console.log(`[NODE] Input:  "${inputPath}"`);
    console.log(`[NODE] Output: "${outputPath}"`);
    console.log(`[NODE] Custom name: "${baseName}"`);
    if (settings.metadataJson) console.log(`[NODE] Metadata JSON: ${settings.metadataJson}`);
    console.log("=".repeat(60));

    const env = { ...process.env, PATH: `${engineDir}${path.delimiter}${process.env.PATH}` };

    // Build args
    const args = [
      "--action", action,
      "--input",  inputPath,
      "--output", outputPath,
      "--tempdir", tempDir,
    ];

    if (action === "compress" || action === "target") {
      if (settings.format)    args.push("--format", settings.format);
      if (settings.stripExif) args.push("--strip-exif");
      if (settings.metadataJson) args.push("--metadata-json", settings.metadataJson);
    }
    if (action === "compress" && settings.quality != null) {
      args.push("--quality", String(settings.quality));
    }
    if (action === "target" && settings.targetKb != null) {
      args.push("--target-kb", String(settings.targetKb));
    }

    console.log(`[NODE] Engine args: ${args.join(" ")}`);

    const proc = spawn(executable, args, { env });
    activeImageProcess = proc;

    // Stream telemetry lines to React
    proc.stdout.on("data", (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          // Inject fileId so React can match to queue item
          event.sender.send('image-telemetry', { fileId, ...parsed });
        } catch {
          console.log(`[ENGINE STDOUT] ${line.trim()}`);
        }
      }
    });

    proc.stderr.on("data", (data) => {
      console.log(`[ENGINE STDERR] ${data.toString().trim()}`);
    });

    return new Promise((resolve) => {
      proc.on("close", (code) => {
        console.log(`[NODE] Job finished. Exit code: ${code}, output: "${outputPath}"`);
        activeImageProcess = null;

        if (code === 0 && fs.existsSync(outputPath)) {
          if (settings?.deleteOriginal && fs.existsSync(inputPath)) {
            try { fs.unlinkSync(inputPath); } catch {}
          }
          resolve({ success: true, outputPath });
        } else {
          resolve({ success: false, error: `Engine exited with code ${code}` });
        }
      });
    });
  });
}