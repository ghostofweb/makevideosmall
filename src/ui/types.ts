export type AppMode = 'bulk' | 'single';
export type DragState = 'idle' | 'accept' | 'reject';
export type AppView = 'workspace' | 'queue';
export type AnalysisState = 'none' | 'analyzing' | 'done';
export type QueueState = 'ingest' | 'processing' | 'completed' | 'failed';

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
}

// Extend File to include optional `path` for Electron
export interface ElectronFile extends File {
  path?: string;
}