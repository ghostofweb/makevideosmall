export interface ElectronFile extends File {
  path: string;
}

export interface QueuedFile {
  path: string;
  name: string;
  size: number;
}

export type DragState = 'idle' | 'accept' | 'reject';
export type AppMode = 'single' | 'bulk';
export type AppStep = 'ingest' | 'analyzing' | 'preview';
export type AppView = 'workspace' | 'queue';

export interface QueuedFile {
  id: string;
  path: string;
  name: string;
  size: number;
  preset: string;
  analysisState: 'none' | 'analyzing' | 'done';
  queueState: 'ingest' | 'processing' | 'completed';
  
  // NEW: Processing Telemetry Data
  progress: number;
  eta: string;
  logs: string[];
}