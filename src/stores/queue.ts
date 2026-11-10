// A mirror of the queue that lives in the Rust core. The UI never changes job
// state itself: it sends a command and waits for the core's next snapshot.

import { create } from 'zustand';
import type { Job, JobProgress, QueueSnapshot } from '@/lib/types';

interface QueueState {
  jobs: Job[];
  running: boolean;
  paused: boolean;
  /** Job whose log is open, if any. */
  logFor: string | null;

  apply: (snapshot: QueueSnapshot) => void;
  progress: (p: JobProgress) => void;
  showLog: (id: string | null) => void;
}

export const useQueue = create<QueueState>((set) => ({
  jobs: [],
  running: false,
  paused: false,
  logFor: null,

  apply: (snapshot) => set({ jobs: snapshot.jobs, running: snapshot.running, paused: snapshot.paused }),

  progress: (p) =>
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === p.id && (job.status === 'running' || job.status === 'paused')
          ? { ...job, progress: p.progress, fps: p.fps, speed: p.speed, etaSecs: p.etaSecs, outBytes: p.outBytes, stage: p.stage }
          : job,
      ),
    })),

  showLog: (logFor) => set({ logFor }),
}));

export interface QueueCounts {
  queued: number;
  active: number;
  done: number;
  failed: number;
  cancelled: number;
}

export function countJobs(jobs: Job[]): QueueCounts {
  const counts: QueueCounts = { queued: 0, active: 0, done: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) {
    if (job.status === 'queued') counts.queued++;
    else if (job.status === 'running' || job.status === 'paused') counts.active++;
    else if (job.status === 'done') counts.done++;
    else if (job.status === 'failed') counts.failed++;
    else counts.cancelled++;
  }
  return counts;
}
