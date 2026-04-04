// @ts-nocheck
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  UploadCloud, Image as ImageIcon, Wand2, Target, Settings2, Shield,
  X, CheckCircle2, Loader2, Layers, Plus, Trash2, Tag, FileEdit,
  ChevronDown, ChevronUp, AlertTriangle, TrendingDown, ArrowRight
} from 'lucide-react';
import { toast } from 'sonner';

// ─────────────────────────────────────────────
// IPC Bridge — resolved once at module load
// ─────────────────────────────────────────────
const { ipcRenderer, webUtils } = (() => {
  try {
    const electron = window.require('electron');
    console.log('[IPC] ✅ Bridge acquired. Keys:', Object.keys(electron));
    return { ipcRenderer: electron.ipcRenderer, webUtils: electron.webUtils };
  } catch (e) {
    console.error('[IPC] ❌ window.require("electron") FAILED:', e);
    return { ipcRenderer: null, webUtils: null };
  }
})();

function getFilePath(file: File): string {
  if (webUtils?.getPathForFile) {
    const p = webUtils.getPathForFile(file);
    console.log(`[PATH] webUtils → "${p}"`);
    return p;
  }
  const legacy = (file as any).path;
  console.warn(`[PATH] webUtils missing, using file.path → "${legacy}"`);
  return legacy;
}

async function safeInvoke(channel: string, payload: any): Promise<any> {
  if (!ipcRenderer) throw new Error(`[IPC] ipcRenderer is null — cannot invoke "${channel}"`);
  console.log(`[IPC] → invoke("${channel}")`, payload);
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    console.log(`[IPC] ← response("${channel}")`, result);
    return result;
  } catch (e) {
    console.error(`[IPC] ❌ invoke("${channel}") threw:`, e);
    throw e;
  }
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
type ProcessState = 'idle' | 'analyzing' | 'ready' | 'processing' | 'complete' | 'error';
type ImageMode   = 'compress' | 'target' | 'upscale';
type ImageFormat = 'webp' | 'avif' | 'jpg';
interface MetaField { key: string; value: string; }
interface QueuedImage {
  id: string;
  file: File;
  previewUrl: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  originalBytes: number;
  newBytes?: number;
  savedPercent?: number;
  outputPath?: string;
  dna?: {
    width: number; height: number; size_bytes: number;
    total_pixels: number; metadata: Record<string, string>;
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const formatBytes = (bytes: number) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
const stripExtension = (name: string) => name.replace(/\.[^/.]+$/, '');

const TARGET_PRESETS = [
  { label: '100 KB', value: 100 },
  { label: '250 KB', value: 250 },
  { label: '500 KB', value: 500 },
  { label: '1 MB',   value: 1024 },
  { label: '2 MB',   value: 2048 },
];

// ─────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────
export function ImageStudio() {
  const [processState, setProcessState] = useState<ProcessState>('idle');
  const [queue, setQueue]               = useState<QueuedImage[]>([]);
  const [activeIndex, setActiveIndex]   = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode]           = useState<ImageMode>('compress');
  const [format, setFormat]       = useState<ImageFormat>('webp');
  const [quality, setQuality]     = useState(80);
  const [targetKb, setTargetKb]   = useState(500);
  const [stripExif, setStripExif] = useState(true);
  const [customFileName, setCustomFileName] = useState('');

  const [metaFields, setMetaFields] = useState<MetaField[]>([]);
  const [showMeta, setShowMeta]     = useState(false);

  const [currentFileProgress, setCurrentFileProgress] = useState(0);
  const [eta, setEta]               = useState('');
  const [processedCount, setProcessedCount] = useState(0);
  const [batchResults, setBatchResults] = useState<{ original: number; final: number } | null>(null);

  // Bridge health check
  useEffect(() => {
    console.log('=== IPC BRIDGE HEALTH CHECK ===');
    if (!ipcRenderer) {
      console.error('[FATAL] ipcRenderer is null.\nCheck: nodeIntegration:true + contextIsolation:false in BrowserWindow webPreferences.');
      toast.error('IPC Bridge failed — see DevTools console.');
    } else {
      console.log('[OK] ipcRenderer is live.');
    }
  }, []);

  // Telemetry listener
  useEffect(() => {
    if (!ipcRenderer) return;
    console.log('[IPC] Registering image-telemetry listener');

    const handler = (_event: any, data: any) => {
      console.log('[TELEMETRY]', data);

      if (data.type === 'telemetry') {
        setCurrentFileProgress(data.progress ?? 0);
        if (data.eta) setEta(data.eta);
      }
      if (data.type === 'complete') {
        setQueue(prev => prev.map(item =>
          item.id === data.fileId
            ? { ...item, newBytes: data.new_bytes, savedPercent: data.savings_percent, outputPath: data.outputPath }
            : item
        ));
      }
      if (data.type === 'error') {
        console.error('[ENGINE ERROR]', data.message);
        toast.error(`Engine error: ${data.message}`, { duration: 7000 });
      }
      if (data.type === 'warning') {
        console.warn('[ENGINE WARNING]', data.message);
        toast.warning(data.message, { duration: 6000 });
      }
    };

    ipcRenderer.on('image-telemetry', handler);
    return () => {
      console.log('[IPC] Removing image-telemetry listener');
      ipcRenderer.removeAllListeners('image-telemetry');
    };
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    if (processState === 'processing') return;
    handleFiles(e.dataTransfer.files);
  }, [processState]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
  };

  const handleFiles = async (fileList: FileList) => {
    const validFiles = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    console.log(`[handleFiles] ${fileList.length} dropped, ${validFiles.length} valid images`);

    if (validFiles.length === 0) { toast.error('No supported images (JPG, PNG, WebP).'); return; }
    if (!ipcRenderer) { toast.error('IPC Bridge missing — check DevTools.'); return; }

    setProcessState('analyzing');
    setBatchResults(null);

    const newItems: QueuedImage[] = validFiles.map(file => ({
      id: Math.random().toString(36).substring(7),
      file, previewUrl: URL.createObjectURL(file),
      status: 'pending', originalBytes: file.size,
    }));

    if (queue.length === 0 && newItems.length > 0)
      setCustomFileName(stripExtension(newItems[0].file.name) + '_Optimized');

    setQueue(prev => [...prev, ...newItems]);

    // Analyze first file
    const firstPath = getFilePath(validFiles[0]);
    console.log(`[ANALYZE] "${validFiles[0].name}" path: "${firstPath}"`);

    try {
      const response = await safeInvoke('analyze-image', { filePath: firstPath });
      if (response?.success) {
        console.log('[ANALYZE] DNA:', response.data);
        setQueue(prev => {
          const next = [...prev];
          const idx = next.findIndex(q => q.id === newItems[0].id);
          if (idx !== -1) next[idx] = { ...next[idx], dna: response.data };
          return next;
        });
        // Auto-import metadata fields from file
        const tags = response.data?.metadata ?? {};
        const ignored = ['encoder', 'vendor_id', 'compatible_brands', 'major_brand', 'minor_version'];
        const fields = Object.entries(tags)
          .filter(([k]) => !ignored.includes(k.toLowerCase()))
          .map(([key, value]) => ({ key, value: String(value) }));
        if (fields.length > 0) {
          setMetaFields(fields);
          setShowMeta(true);
          console.log(`[ANALYZE] Auto-imported ${fields.length} metadata fields`);
        }
      } else {
        console.warn('[ANALYZE] success=false:', response);
      }
    } catch (err) {
      console.error('[ANALYZE] Exception (non-fatal):', err);
    }

    setProcessState('ready');
  };

  const removeFile = (e: React.MouseEvent, idToRemove: string) => {
    e.stopPropagation();
    setQueue(prev => {
      const filtered = prev.filter(q => q.id !== idToRemove);
      if (filtered.length === 0) {
        setProcessState('idle');
        setCustomFileName('');
        setMetaFields([]);
        setShowMeta(false);
      }
      if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
      return filtered;
    });
  };

  // Metadata helpers
  const addMetaField    = () => setMetaFields(prev => [...prev, { key: '', value: '' }]);
  const removeMetaField = (idx: number) => setMetaFields(prev => prev.filter((_, i) => i !== idx));
  const updateMetaField = (idx: number, field: 'key' | 'value', val: string) =>
    setMetaFields(prev => prev.map((f, i) => i === idx ? { ...f, [field]: val } : f));
  const importMetaFromDna = () => {
    const tags = queue[activeIndex]?.dna?.metadata;
    if (!tags || Object.keys(tags).length === 0) { toast.error('No metadata found in this file.'); return; }
    setMetaFields(Object.entries(tags).map(([key, value]) => ({ key, value: String(value) })));
    toast.success(`Imported ${Object.keys(tags).length} fields.`);
  };

  // Batch execution
  const handleStartBatch = async () => {
    if (queue.length === 0) return;
    if (!ipcRenderer) { toast.error('IPC Bridge disconnected — restart app.'); return; }

    setProcessState('processing');
    setProcessedCount(0);
    setBatchResults(null);

    const validMeta = metaFields.filter(f => f.key.trim() && f.value.trim());
    const metadataJson = validMeta.length > 0
      ? JSON.stringify(Object.fromEntries(validMeta.map(f => [f.key.trim(), f.value.trim()])))
      : null;

    const settings = {
      format:      mode !== 'upscale' ? format : undefined,
      quality:     mode === 'compress' ? quality : undefined,
      targetKb:    mode === 'target' ? targetKb : undefined,
      stripExif,
      metadataJson,
    };

    console.log('[BATCH] Start — mode:', mode, 'count:', queue.length, 'settings:', settings);
    let localProcessed = 0, totalOriginal = 0, totalFinal = 0;

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.status === 'done') { console.log(`[BATCH] Skip ${i} (done)`); continue; }

      setActiveIndex(i);
      setCurrentFileProgress(0);
      setEta('Processing...');
      setQueue(prev => prev.map((q, qi) => qi === i ? { ...q, status: 'processing' } : q));

      const inputPath = getFilePath(item.file);
      const fileName  = queue.length > 1 ? `${customFileName}_${i + 1}` : customFileName;
      console.log(`[BATCH] Item ${i + 1}/${queue.length}: "${item.file.name}" → "${fileName}"`);

      try {
        const response = await safeInvoke('start-image-job', {
          fileId: item.id, inputPath, action: mode, settings, customFileName: fileName,
        });

        if (response?.success) {
          console.log(`[BATCH] ✅ Item ${i} done → ${response.outputPath}`);
          setQueue(prev => prev.map((q, qi) =>
            qi === i ? { ...q, status: 'done', outputPath: response.outputPath } : q));
          localProcessed++;
          setProcessedCount(localProcessed);
          totalOriginal += item.originalBytes;
          // newBytes is populated by telemetry; fall back to originalBytes if not yet received
          totalFinal    += item.newBytes ?? item.originalBytes;
        } else {
          console.error(`[BATCH] ❌ Item ${i} failed:`, response);
          setQueue(prev => prev.map((q, qi) => qi === i ? { ...q, status: 'error' } : q));
          toast.error(`Failed: "${item.file.name}" — ${response?.error ?? 'unknown error'}`);
        }
      } catch (err) {
        console.error(`[BATCH] ❌ Fatal on item ${i}:`, err);
        toast.error(`Fatal error on "${item.file.name}" — batch stopped.`);
        setProcessState('error');
        return;
      }
    }

    setBatchResults({ original: totalOriginal, final: totalFinal });
    setProcessState('complete');
    toast.success(`Done! ${localProcessed}/${queue.length} image${queue.length !== 1 ? 's' : ''} processed.`);
  };

  const handleAbort = async () => {
    try { await safeInvoke('cancel-image-job', {}); } catch (e) { console.error('[ABORT]', e); }
    resetStudio();
    toast.info('Batch aborted.');
  };

  const resetStudio = () => {
    setQueue([]); setActiveIndex(0); setProcessState('idle');
    setProcessedCount(0); setCurrentFileProgress(0); setEta('');
    setCustomFileName(''); setMetaFields([]); setShowMeta(false); setBatchResults(null);
  };

  const activeItem = queue[activeIndex];
  const overallProgress = queue.length > 0
    ? ((processedCount / queue.length) * 100) + ((currentFileProgress / 100) * (1 / queue.length) * 100)
    : 0;

  // ─────────────────────────────────────────────
  return (
    <div className="flex h-full w-full p-6 gap-6 bg-background">

      {/* ── Left: Drop / Preview ── */}
      <div
        className={`flex-1 relative rounded-2xl border-2 transition-all duration-300 overflow-hidden flex flex-col
          ${queue.length === 0
            ? 'border-dashed border-border hover:border-primary/50 bg-secondary/10 cursor-pointer'
            : 'border-transparent bg-black/5'}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => queue.length === 0 && fileInputRef.current?.click()}
      >
        <input type="file" ref={fileInputRef} onChange={handleFileInput}
          accept="image/jpeg,image/png,image/webp" multiple className="hidden" />

        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8 pointer-events-none">
            <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mb-6">
              <UploadCloud className="w-10 h-10 text-primary" />
            </div>
            <h2 className="text-2xl font-semibold mb-2 text-foreground">Click or Drop Images Here</h2>
            <p className="text-muted-foreground max-w-sm">JPG · PNG · WebP — single files or whole folders</p>
          </div>
        ) : (
          <div className="flex flex-col h-full w-full p-4 gap-4">
            <div className="relative flex-1 bg-black/10 rounded-xl overflow-hidden backdrop-blur-sm border border-border/50">
              <img src={activeItem.previewUrl} className="w-full h-full object-contain p-2" alt="Preview" />

              {/* Info overlay */}
              <div className="absolute top-4 left-4 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-border text-xs font-medium shadow-sm flex gap-3 flex-wrap max-w-[80%]">
                <span className="text-foreground/80 truncate">{activeItem.file.name}</span>
                <span className="text-muted-foreground">|</span>
                <span className="text-primary">{formatBytes(activeItem.originalBytes)}</span>
                {activeItem.dna && <>
                  <span className="text-muted-foreground">|</span>
                  <span className="text-muted-foreground">{activeItem.dna.width}×{activeItem.dna.height}px</span>
                </>}
                {activeItem.newBytes != null && <>
                  <span className="text-muted-foreground">→</span>
                  <span className="text-emerald-500 font-bold">
                    {formatBytes(activeItem.newBytes)} ({activeItem.savedPercent}% saved)
                  </span>
                </>}
              </div>

              {processState !== 'processing' && (
                <button onClick={(e) => removeFile(e, activeItem.id)}
                  className="absolute top-4 right-4 bg-background/80 hover:bg-destructive/90 hover:text-white backdrop-blur-md p-1.5 rounded-lg border border-border transition-colors shadow-sm">
                  <X className="w-4 h-4" />
                </button>
              )}

              {/* Output path after done */}
              {activeItem.status === 'done' && activeItem.outputPath && (
                <div className="absolute bottom-4 left-4 right-4 bg-background/80 backdrop-blur-md px-3 py-2 rounded-lg border border-emerald-500/30 text-xs text-muted-foreground truncate">
                  ✅ Saved → <span className="text-foreground font-mono">{activeItem.outputPath}</span>
                </div>
              )}
            </div>

            {queue.length > 1 && (
              <div className="h-24 w-full bg-secondary/30 rounded-xl border border-border/50 p-2 flex gap-2 overflow-x-auto hidden-scrollbar">
                {queue.map((item, idx) => (
                  <div key={item.id}
                    onClick={() => processState !== 'processing' && setActiveIndex(idx)}
                    className={`relative h-full aspect-square rounded-lg overflow-hidden cursor-pointer border-2 transition-all flex-shrink-0
                      ${activeIndex === idx ? 'border-primary shadow-md' : 'border-transparent opacity-60 hover:opacity-100'}`}>
                    <img src={item.previewUrl} className="w-full h-full object-cover" alt="" />
                    {item.status === 'done' && (
                      <div className="absolute inset-0 bg-emerald-500/20 flex items-center justify-center backdrop-blur-[1px]">
                        <CheckCircle2 className="w-6 h-6 text-emerald-400 drop-shadow-md" />
                      </div>
                    )}
                    {item.status === 'error' && (
                      <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center backdrop-blur-[1px]">
                        <X className="w-6 h-6 text-red-400 drop-shadow-md" />
                      </div>
                    )}
                    {item.status === 'processing' && (
                      <div className="absolute inset-0 bg-primary/20 flex items-center justify-center backdrop-blur-[1px]">
                        <Loader2 className="w-6 h-6 text-primary animate-spin drop-shadow-md" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Right: Controls Panel ── */}
      <div className="w-[440px] flex flex-col bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="p-6 pb-4 border-b border-border/50 flex-shrink-0">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-primary" /> Studio Controls
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {queue.length > 1 ? `Batch: ${queue.length} images queued` : 'Configure your optimization'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto hidden-scrollbar p-6 space-y-5">

          {/* Output Filename */}
          {queue.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <FileEdit className="w-4 h-4 text-muted-foreground" /> Output Filename
              </label>
              <div className="flex items-center gap-2">
                <input type="text" value={customFileName}
                  onChange={(e) => setCustomFileName(e.target.value)}
                  disabled={processState === 'processing'}
                  placeholder="e.g. hero_image_optimized"
                  className="flex-1 bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary outline-none" />
                <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                  .{mode === 'upscale' ? 'png' : format}
                </span>
              </div>
              {queue.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  Batch naming: <code className="bg-secondary px-1 rounded">{customFileName || 'name'}_1.{format}</code>,{' '}
                  <code className="bg-secondary px-1 rounded">{customFileName || 'name'}_2.{format}</code>…
                </p>
              )}
            </div>
          )}

          {/* Mode Selector */}
          <div className="grid grid-cols-3 gap-2 bg-secondary/30 p-1.5 rounded-xl border border-border/50">
            {(['compress', 'target', 'upscale'] as ImageMode[]).map((m) => (
              <button key={m}
                onClick={() => { console.log('[MODE]', m); setMode(m); }}
                disabled={processState === 'processing'}
                className={`flex flex-col items-center justify-center p-3 rounded-lg text-xs font-medium transition-all
                  ${mode === m
                    ? m === 'upscale' ? 'bg-indigo-500 text-white shadow-md' : 'bg-primary text-primary-foreground shadow-md'
                    : 'text-muted-foreground hover:bg-secondary/50'}`}>
                {m === 'compress' && <><Settings2 className="w-5 h-5 mb-1" />Compress</>}
                {m === 'target'   && <><Target className="w-5 h-5 mb-1" />Target Size</>}
                {m === 'upscale'  && <><Wand2 className="w-5 h-5 mb-1" />AI Upscale</>}
              </button>
            ))}
          </div>

          {/* Format */}
          {mode !== 'upscale' && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Output Format</label>
              <select value={format} onChange={(e) => setFormat(e.target.value as ImageFormat)}
                disabled={processState === 'processing'}
                className="w-full bg-secondary/50 border border-border rounded-lg p-2.5 text-sm text-foreground focus:ring-2 focus:ring-primary outline-none">
                <option value="webp">WebP — Best for web, great compression</option>
                <option value="avif">AVIF — Next-gen, smallest file size</option>
                <option value="jpg">JPEG — Maximum compatibility</option>
              </select>
            </div>
          )}

          {/* Quality */}
          {mode === 'compress' && (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <label className="text-sm font-medium text-foreground">Quality</label>
                <span className={`text-sm font-mono px-2 py-0.5 rounded-md ${
                  quality >= 80 ? 'text-emerald-500 bg-emerald-500/10' :
                  quality >= 50 ? 'text-amber-500 bg-amber-500/10' :
                                  'text-red-500 bg-red-500/10'}`}>{quality}%</span>
              </div>
              <input type="range" min="10" max="100" value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                disabled={processState === 'processing'} className="w-full accent-primary" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Smallest file</span><span>Best quality</span>
              </div>
            </div>
          )}

          {/* Target Size */}
          {mode === 'target' && (
            <div className="space-y-3">
              <label className="text-sm font-medium text-foreground">Target File Size</label>
              <div className="flex flex-wrap gap-2">
                {TARGET_PRESETS.map(p => (
                  <button key={p.value} onClick={() => setTargetKb(p.value)}
                    disabled={processState === 'processing'}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all border
                      ${targetKb === p.value
                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                        : 'bg-secondary/50 text-muted-foreground border-border hover:border-primary/50'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <input type="number" value={targetKb}
                  onChange={(e) => setTargetKb(Math.max(10, Number(e.target.value)))}
                  disabled={processState === 'processing'}
                  className="w-full bg-secondary/50 border border-border rounded-lg p-2.5 pr-14 text-sm text-foreground focus:ring-2 focus:ring-primary outline-none" />
                <span className="absolute right-4 top-2.5 text-sm text-muted-foreground font-mono">KB</span>
              </div>
              <div className="flex items-start gap-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-blue-400 leading-relaxed">
                  Uses 14-iteration binary search to hit the exact target.
                  If the target is physically impossible, the smallest achievable result is saved and you'll be notified.
                </p>
              </div>
            </div>
          )}

          {/* Upscale info */}
          {mode === 'upscale' && (
            <div className="space-y-3">
              <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 space-y-2">
                <h4 className="text-sm font-semibold text-indigo-400 flex items-center gap-2">
                  <Wand2 className="w-4 h-4" /> Real-ESRGAN Engine — 4× Upscale
                </h4>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  AI-powered upscaling using GPU Vulkan compute. Time depends on source resolution and available VRAM.
                  Output is always lossless PNG to preserve upscale quality.
                </p>
              </div>
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-400 leading-relaxed">
                  Images already at or above 4K (8.5 MP / ~3840×2160) are rejected to prevent GPU VRAM crashes.
                  You'll see a toast notification if this happens.
                </p>
              </div>
            </div>
          )}

          {/* Strip EXIF */}
          {mode !== 'upscale' && (
            <div className="flex items-center justify-between p-4 bg-secondary/30 rounded-lg border border-border">
              <div>
                <span className="text-sm font-medium flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-500" /> Strip Metadata
                </span>
                <span className="text-xs text-muted-foreground mt-0.5 block">Removes GPS, camera, copyright fields</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" className="sr-only peer" checked={stripExif}
                  onChange={(e) => setStripExif(e.target.checked)} disabled={processState === 'processing'} />
                <div className="w-9 h-5 bg-muted rounded-full peer relative
                  after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
                  peer-checked:after:translate-x-4 peer-checked:bg-emerald-500" />
              </label>
            </div>
          )}

          {/* ── Metadata Editor ── */}
          {queue.length > 0 && mode !== 'upscale' && (
            <div className="border border-border rounded-xl overflow-hidden">
              <button onClick={() => setShowMeta(p => !p)}
                className="w-full flex items-center justify-between p-4 bg-secondary/20 hover:bg-secondary/40 transition-colors">
                <span className="text-sm font-medium flex items-center gap-2">
                  <Tag className="w-4 h-4 text-primary" />
                  Metadata Editor
                  {metaFields.length > 0 && (
                    <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full">
                      {metaFields.length} field{metaFields.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </span>
                {showMeta ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </button>

              {showMeta && (
                <div className="p-4 space-y-3 border-t border-border/50">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Fields here are written into the output file via FFmpeg. Turn on "Strip Metadata" above to clear original data first — then only your custom fields remain.
                  </p>

                  {queue[activeIndex]?.dna?.metadata && Object.keys(queue[activeIndex].dna.metadata).length > 0 && (
                    <button onClick={importMetaFromDna} disabled={processState === 'processing'}
                      className="text-xs text-primary hover:underline flex items-center gap-1 disabled:opacity-50">
                      ↓ Import from file ({Object.keys(queue[activeIndex].dna.metadata).length} fields detected)
                    </button>
                  )}

                  <div className="space-y-2 max-h-52 overflow-y-auto hidden-scrollbar pr-1">
                    {metaFields.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-4">No fields added yet.</p>
                    )}
                    {metaFields.map((field, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <input type="text" placeholder="Key (e.g. title)" value={field.key}
                          onChange={(e) => updateMetaField(idx, 'key', e.target.value)}
                          disabled={processState === 'processing'}
                          className="w-28 bg-secondary/50 border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none" />
                        <input type="text" placeholder="Value" value={field.value}
                          onChange={(e) => updateMetaField(idx, 'value', e.target.value)}
                          disabled={processState === 'processing'}
                          className="flex-1 bg-secondary/50 border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:ring-1 focus:ring-primary outline-none" />
                        <button onClick={() => removeMetaField(idx)} disabled={processState === 'processing'}
                          className="text-muted-foreground hover:text-destructive transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button onClick={addMetaField} disabled={processState === 'processing'}
                    className="w-full py-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors flex items-center justify-center gap-1 disabled:opacity-50">
                    <Plus className="w-3.5 h-3.5" /> Add Field
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Bottom: Results + Actions ── */}
        <div className="p-6 border-t border-border/50 space-y-4 flex-shrink-0">

          {/* Batch results summary */}
          {processState === 'complete' && batchResults && batchResults.original > 0 && (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-2">
              <p className="text-xs font-semibold text-emerald-500 flex items-center gap-1.5">
                <TrendingDown className="w-3.5 h-3.5" /> Batch Complete
              </p>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{formatBytes(batchResults.original)}</span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="font-semibold text-foreground">{formatBytes(batchResults.final)}</span>
                <span className="text-emerald-500 font-bold ml-auto">
                  -{Math.max(0, Math.round((1 - batchResults.final / batchResults.original) * 100))}%
                </span>
              </div>
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${Math.max(0, Math.round((1 - batchResults.final / batchResults.original) * 100))}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                {processedCount}/{queue.length} processed · output saved alongside originals
              </p>
            </div>
          )}

          {processState === 'idle' && (
            <button disabled className="w-full py-3 rounded-lg bg-secondary text-muted-foreground font-medium text-sm border border-border">
              Waiting for Images…
            </button>
          )}
          {processState === 'analyzing' && (
            <button disabled className="w-full py-3 rounded-lg bg-secondary text-foreground font-medium text-sm flex items-center justify-center gap-2 border border-border">
              <Loader2 className="w-4 h-4 animate-spin" /> Analyzing…
            </button>
          )}
          {processState === 'ready' && (
            <button onClick={handleStartBatch}
              className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg font-medium text-sm transition-all shadow-md hover:shadow-lg active:scale-95
                ${mode === 'upscale' ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}>
              {queue.length > 1 && <Layers className="w-4 h-4" />}
              {mode === 'upscale'
                ? `Upscale ${queue.length} Image${queue.length !== 1 ? 's' : ''}`
                : `Process ${queue.length} Image${queue.length !== 1 ? 's' : ''}`}
            </button>
          )}
          {processState === 'processing' && (
            <div className="space-y-3">
              <div className="flex justify-between text-xs font-medium">
                <span>Processing {activeIndex + 1} of {queue.length} — {activeItem?.file.name}</span>
                <span className="text-muted-foreground ml-2 flex-shrink-0">{eta}</span>
              </div>
              <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, overallProgress))}%` }} />
              </div>
              <button onClick={handleAbort}
                className="w-full py-2.5 rounded-lg bg-destructive/10 text-destructive font-medium text-sm hover:bg-destructive hover:text-white transition-colors">
                Abort Batch
              </button>
            </div>
          )}
          {(processState === 'complete' || processState === 'error') && (
            <button onClick={resetStudio}
              className="w-full py-3 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 font-medium text-sm border border-border transition-colors">
              Clear Studio
            </button>
          )}
        </div>
      </div>
    </div>
  );
}