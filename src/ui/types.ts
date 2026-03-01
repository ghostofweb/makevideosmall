export type AppMode = 'bulk' | 'single';
export type DragState = 'idle' | 'accept' | 'reject';
export type AppView = 'workspace' | 'queue';
export type AnalysisState = 'none' | 'analyzing' | 'done';
// Add 'queued' to the list of allowed states
export type QueueState = 'ingest' | 'queued' | 'processing' | 'completed';
export interface QueuedFile {
  id: string;
  path: string;
  name: string;
  size: number;
  preset: string;
  analysisState: AnalysisState;
  queueState: QueueState;
  progress: number;
  eta: string;
  logs: string[];
    completedAt?: number;
    previewData?: any;      // Holds the AI JSON from Python
  outputPath?: string;
  customName?: string;
}

// Extend File to include optional `path` for Electron
export interface ElectronFile extends File {
  path?: string;
}