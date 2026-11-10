//! The encode queue: ordering, concurrency, pause/resume/cancel, persistence.
//!
//! The queue is the single source of truth. The UI only renders snapshots and
//! sends commands; it never tracks job state on its own.

use crate::analysis::detect_crop;
use crate::error::{AppError, Result};
use crate::ffmpeg::command::{plan, to_command_line, PlanOptions};
use crate::ffmpeg::locate::Tools;
use crate::ffmpeg::probe;
use crate::ffmpeg::progress::{eta, percent, Tick};
use crate::ffmpeg::runner::{run_ffmpeg, JobControl};
use crate::model::*;
use crate::util::{emit, format_bytes, load_json, now_ms, save_json, EventSink};
use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_LOG_LINES: usize = 400;

/// Remembers probe results so a file is only inspected once per version.
#[derive(Default)]
pub struct ProbeCache {
    entries: Mutex<HashMap<String, (u64, u64, MediaInfo)>>,
}

impl ProbeCache {
    fn stamp(path: &str) -> (u64, u64) {
        std::fs::metadata(path)
            .map(|m| {
                let modified = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                (modified, m.len())
            })
            .unwrap_or((0, 0))
    }

    pub async fn get(&self, tools: &Tools, path: &str) -> Result<MediaInfo> {
        let (modified, size) = Self::stamp(path);
        if let Some((m, s, info)) = self.entries.lock().get(path) {
            if *m == modified && *s == size {
                return Ok(info.clone());
            }
        }
        let info = probe::probe(&tools.ffprobe, path).await?;
        self.entries.lock().insert(path.to_string(), (modified, size, info.clone()));
        Ok(info)
    }
}

struct State {
    jobs: Vec<Job>,
    running: bool,
    paused: bool,
    controls: HashMap<String, Arc<JobControl>>,
    logs: HashMap<String, VecDeque<String>>,
    /// Jobs being stopped that should return to the queue instead of "cancelled".
    requeue: HashSet<String>,
    /// Totals for the current run, reported when the queue drains.
    tally: QueueFinished,
}

struct Inner {
    state: Mutex<State>,
    sink: Arc<dyn EventSink>,
    tools: Option<Tools>,
    temp_dir: PathBuf,
    store: Option<PathBuf>,
    settings: Arc<RwLock<AppSettings>>,
    probes: Arc<ProbeCache>,
    runtime: tokio::runtime::Handle,
}

#[derive(Clone)]
pub struct QueueManager {
    inner: Arc<Inner>,
}

fn empty_tally() -> QueueFinished {
    QueueFinished { done: 0, failed: 0, cancelled: 0, source_bytes: 0.0, output_bytes: 0.0 }
}

fn reset(job: &mut Job) {
    job.status = JobStatus::Queued;
    job.progress = 0.0;
    job.fps = 0.0;
    job.speed = 0.0;
    job.eta_secs = None;
    job.out_bytes = 0.0;
    job.stage = String::new();
    job.error = None;
    job.started_at = None;
    job.finished_at = None;
    job.final_bytes = None;
}

impl QueueManager {
    pub fn new(
        tools: Option<Tools>,
        temp_dir: PathBuf,
        store: Option<PathBuf>,
        settings: Arc<RwLock<AppSettings>>,
        probes: Arc<ProbeCache>,
        sink: Arc<dyn EventSink>,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        // Jobs that were mid-encode when the app closed start over.
        let mut jobs: Vec<Job> = store.as_deref().map(load_json).unwrap_or_default();
        for job in &mut jobs {
            if matches!(job.status, JobStatus::Running | JobStatus::Paused) {
                reset(job);
            }
        }
        QueueManager {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    jobs,
                    running: false,
                    paused: false,
                    controls: HashMap::new(),
                    logs: HashMap::new(),
                    requeue: HashSet::new(),
                    tally: empty_tally(),
                }),
                sink,
                tools,
                temp_dir,
                store,
                settings,
                probes,
                runtime,
            }),
        }
    }

    pub fn snapshot(&self) -> QueueSnapshot {
        self.inner.snapshot()
    }

    /// Output paths claimed by jobs that have not finished.
    pub fn taken_outputs(&self) -> HashSet<String> {
        self.inner
            .state
            .lock()
            .jobs
            .iter()
            .filter(|j| !matches!(j.status, JobStatus::Failed | JobStatus::Cancelled))
            .map(|j| j.spec.output.to_lowercase())
            .collect()
    }

    /// Add jobs to the end of the queue. Returns their ids.
    pub async fn add(&self, specs: Vec<JobSpec>) -> Result<Vec<String>> {
        let tools = self.inner.tools.as_ref().ok_or(AppError::FfmpegMissing)?;
        let mut jobs = Vec::new();
        for spec in specs {
            let media = self.inner.probes.get(tools, &spec.input).await?;
            // Validate now, so a bad job is rejected before it is queued.
            plan(&spec, &media, &PlanOptions::default())?;
            let v = media.video.as_ref();
            jobs.push(Job {
                id: uuid::Uuid::new_v4().simple().to_string(),
                source: SourceSummary {
                    file_name: media.file_name.clone(),
                    size_bytes: media.size_bytes,
                    duration: media.duration,
                    width: v.map(|v| v.width).unwrap_or(0),
                    height: v.map(|v| v.height).unwrap_or(0),
                    codec: v.map(|v| v.codec.clone()).unwrap_or_default(),
                },
                spec,
                status: JobStatus::Queued,
                progress: 0.0,
                fps: 0.0,
                speed: 0.0,
                eta_secs: None,
                out_bytes: 0.0,
                stage: String::new(),
                error: None,
                added_at: now_ms(),
                started_at: None,
                finished_at: None,
                final_bytes: None,
                command: None,
            });
        }
        let ids: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
        self.inner.state.lock().jobs.extend(jobs);
        self.inner.pump();
        Ok(ids)
    }

    /// Remove jobs, cancelling any that are running.
    pub fn remove(&self, ids: &[String]) {
        {
            let mut st = self.inner.state.lock();
            for id in ids {
                if let Some(control) = st.controls.get(id) {
                    control.cancel();
                }
                st.logs.remove(id);
                st.requeue.remove(id);
            }
            st.jobs.retain(|j| !ids.contains(&j.id));
        }
        self.inner.pump();
    }

    /// Move a job to a new position in the list.
    pub fn move_job(&self, id: &str, to_index: usize) {
        {
            let mut st = self.inner.state.lock();
            let Some(from) = st.jobs.iter().position(|j| j.id == id) else { return };
            let job = st.jobs.remove(from);
            let to = to_index.min(st.jobs.len());
            st.jobs.insert(to, job);
        }
        self.inner.changed();
    }

    /// Put a finished, failed or cancelled job back in line.
    pub fn retry(&self, id: &str) {
        {
            let mut st = self.inner.state.lock();
            if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id) {
                if matches!(job.status, JobStatus::Done | JobStatus::Failed | JobStatus::Cancelled) {
                    reset(job);
                }
            }
            st.logs.remove(id);
        }
        self.inner.pump();
    }

    /// Cancel one job. A queued job is marked cancelled; a running one is killed.
    pub fn cancel(&self, id: &str) {
        {
            let mut st = self.inner.state.lock();
            if let Some(control) = st.controls.get(id).cloned() {
                control.cancel();
            } else if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id) {
                if job.status == JobStatus::Queued {
                    job.status = JobStatus::Cancelled;
                    job.finished_at = Some(now_ms());
                }
            }
        }
        self.inner.pump();
    }

    /// Start working through the queue.
    pub fn start(&self) {
        {
            let mut st = self.inner.state.lock();
            if !st.running {
                st.tally = empty_tally();
            }
            st.running = true;
            if st.paused {
                st.paused = false;
                Inner::resume_all(&mut st);
            }
        }
        self.inner.pump();
    }

    /// Freeze the active encodes in place. Nothing new starts until resumed.
    pub fn pause(&self) {
        {
            let mut st = self.inner.state.lock();
            if !st.running || st.paused {
                return;
            }
            st.paused = true;
            let active: Vec<(String, Arc<JobControl>)> =
                st.controls.iter().map(|(id, c)| (id.clone(), c.clone())).collect();
            for (id, control) in active {
                if control.pause().is_ok() {
                    if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id) {
                        if job.status == JobStatus::Running {
                            job.status = JobStatus::Paused;
                        }
                    }
                }
            }
        }
        self.inner.changed();
    }

    pub fn resume(&self) {
        {
            let mut st = self.inner.state.lock();
            if !st.paused {
                return;
            }
            st.paused = false;
            Inner::resume_all(&mut st);
        }
        self.inner.pump();
    }

    /// Stop the queue. Active encodes are abandoned and go back to "queued".
    pub fn stop(&self) {
        {
            let mut st = self.inner.state.lock();
            st.running = false;
            st.paused = false;
            let active: Vec<(String, Arc<JobControl>)> =
                st.controls.iter().map(|(id, c)| (id.clone(), c.clone())).collect();
            for (id, control) in active {
                st.requeue.insert(id);
                control.cancel();
            }
        }
        self.inner.changed();
    }

    /// Drop every job that is done, failed or cancelled.
    pub fn clear_finished(&self) {
        {
            let mut st = self.inner.state.lock();
            let gone: Vec<String> = st
                .jobs
                .iter()
                .filter(|j| matches!(j.status, JobStatus::Done | JobStatus::Failed | JobStatus::Cancelled))
                .map(|j| j.id.clone())
                .collect();
            for id in &gone {
                st.logs.remove(id);
            }
            st.jobs.retain(|j| !gone.contains(&j.id));
        }
        self.inner.changed();
    }

    pub fn job_log(&self, id: &str) -> Vec<String> {
        self.inner
            .state
            .lock()
            .logs
            .get(id)
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// True while any encode is active (used to warn before quitting).
    pub fn is_busy(&self) -> bool {
        !self.inner.state.lock().controls.is_empty()
    }

    /// Kill everything immediately (app is closing).
    pub fn shutdown(&self) {
        let st = self.inner.state.lock();
        for control in st.controls.values() {
            control.cancel();
        }
    }
}

impl Inner {
    fn snapshot(&self) -> QueueSnapshot {
        let st = self.state.lock();
        QueueSnapshot { jobs: st.jobs.clone(), running: st.running, paused: st.paused }
    }

    fn resume_all(st: &mut State) {
        let active: Vec<(String, Arc<JobControl>)> =
            st.controls.iter().map(|(id, c)| (id.clone(), c.clone())).collect();
        for (id, control) in active {
            let _ = control.resume();
            if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id) {
                if job.status == JobStatus::Paused {
                    job.status = JobStatus::Running;
                }
            }
        }
    }

    /// Tell the UI and save to disk.
    fn changed(&self) {
        let snapshot = self.snapshot();
        if let Some(path) = &self.store {
            let _ = save_json(path, &snapshot.jobs);
        }
        emit(&*self.sink, "queue:changed", &snapshot);
    }

    fn log(&self, id: &str, line: &str) {
        {
            let mut st = self.state.lock();
            let log = st.logs.entry(id.to_string()).or_default();
            if log.len() >= MAX_LOG_LINES {
                log.pop_front();
            }
            log.push_back(line.to_string());
        }
        emit(&*self.sink, "job:log", &JobLogLine { id: id.to_string(), line: line.to_string() });
    }

    /// Start as many queued jobs as the parallel limit allows, and notice when
    /// the queue has drained.
    fn pump(self: &Arc<Self>) {
        let limit = self.settings.read().parallel_jobs.clamp(1, 8) as usize;
        let mut finished: Option<QueueFinished> = None;
        loop {
            let next = {
                let mut st = self.state.lock();
                if !st.running || st.paused {
                    break;
                }
                let active = st.controls.len();
                let has_queued = st.jobs.iter().any(|j| j.status == JobStatus::Queued);
                if active == 0 && !has_queued {
                    st.running = false;
                    finished = Some(st.tally.clone());
                    break;
                }
                if active >= limit || !has_queued {
                    break;
                }
                let control = Arc::new(JobControl::new());
                let job = st.jobs.iter_mut().find(|j| j.status == JobStatus::Queued).unwrap();
                job.status = JobStatus::Running;
                job.started_at = Some(now_ms());
                job.stage = "Starting".into();
                let id = job.id.clone();
                st.controls.insert(id.clone(), control.clone());
                st.logs.remove(&id);
                (id, control)
            };
            let me = self.clone();
            self.runtime.spawn(async move {
                let (id, control) = next;
                let result = me.execute(&id, &control).await;
                me.finish(&id, result);
            });
        }
        self.changed();
        if let Some(tally) = finished {
            emit(&*self.sink, "queue:finished", &tally);
        }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        let mut st = self.state.lock();
        if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id) {
            f(job);
        }
    }

    fn on_tick(&self, id: &str, tick: Tick, duration: f64, pass: usize, passes: usize, stage: &str) {
        let progress = JobProgress {
            id: id.to_string(),
            progress: if tick.done { ((pass + 1) as f64 / passes.max(1) as f64) * 100.0 } else { percent(tick.out_time, duration, pass, passes) },
            fps: tick.fps,
            speed: tick.speed,
            eta_secs: eta(tick.out_time, duration, tick.speed, pass, passes),
            out_bytes: tick.total_size,
            stage: stage.to_string(),
        };
        self.update(id, |job| {
            job.progress = progress.progress;
            job.fps = progress.fps;
            job.speed = progress.speed;
            job.eta_secs = progress.eta_secs;
            job.out_bytes = progress.out_bytes;
            job.stage = progress.stage.clone();
        });
        emit(&*self.sink, "job:progress", &progress);
    }

    /// Run one job to completion. Returns the size of the finished file.
    async fn execute(self: &Arc<Self>, id: &str, control: &Arc<JobControl>) -> Result<f64> {
        let tools = self.tools.as_ref().ok_or(AppError::FfmpegMissing)?;
        let mut spec = self
            .state
            .lock()
            .jobs
            .iter()
            .find(|j| j.id == id)
            .map(|j| j.spec.clone())
            .ok_or_else(|| AppError::msg("The job was removed."))?;
        let (impact, hw_decode) = {
            let s = self.settings.read();
            (s.system_impact, s.hardware_decode)
        };

        let media = self.probes.get(tools, &spec.input).await?;

        if spec.settings.video.crop == CropMode::Auto && spec.auto_crop.is_none() {
            self.update(id, |j| j.stage = "Detecting black bars".into());
            self.changed();
            spec.auto_crop = detect_crop(tools, &media, Some(control)).await?;
            let found = spec.auto_crop;
            self.update(id, |j| j.spec.auto_crop = found);
            self.log(id, &match found {
                Some(c) => format!("Black bars found: cropping to {}x{} at ({}, {}).", c.w, c.h, c.x, c.y),
                None => "No black bars found; nothing to crop.".to_string(),
            });
        }

        if let Some(dir) = Path::new(&spec.output).parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| AppError::msg(format!("Cannot create the output folder: {e}")))?;
        }
        std::fs::create_dir_all(&self.temp_dir)?;

        let pass_log = format!("mvs_pass_{id}");
        let mut opts = PlanOptions { hw_decode, pass_log: pass_log.clone() };
        let mut attempt = plan(&spec, &media, &opts)?;
        for warning in &attempt.warnings {
            self.log(id, &format!("Note: {warning}"));
        }

        let result = loop {
            let command = to_command_line("ffmpeg", attempt.passes.last().unwrap());
            self.update(id, |j| j.command = Some(command.clone()));
            self.log(id, &format!("$ {command}"));

            let passes = attempt.passes.len();
            let mut outcome = Ok(());
            for (index, args) in attempt.passes.iter().enumerate() {
                let stage = if passes > 1 {
                    format!("Pass {} of {passes}", index + 1)
                } else {
                    "Encoding".to_string()
                };
                self.update(id, |j| j.stage = stage.clone());
                self.changed();
                let duration = attempt.duration;
                outcome = run_ffmpeg(
                    &tools.ffmpeg,
                    args,
                    Some(&self.temp_dir),
                    Some(impact),
                    control,
                    |tick| self.on_tick(id, tick, duration, index, passes, &stage),
                    |line| self.log(id, line),
                )
                .await;
                if outcome.is_err() {
                    break;
                }
            }

            match outcome {
                // GPU decoding does not work for every source; try once more on the CPU.
                Err(AppError::Msg(reason)) if attempt.hwaccel => {
                    self.log(id, &format!("GPU decode failed ({}). Retrying with software decode.", reason.lines().last().unwrap_or("")));
                    let _ = std::fs::remove_file(&spec.output);
                    opts.hw_decode = false;
                    attempt = plan(&spec, &media, &opts)?;
                }
                other => break other,
            }
        };

        // Two-pass statistics live in the temp folder.
        if let Ok(entries) = std::fs::read_dir(&self.temp_dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&pass_log) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        // A failed or cancelled encode leaves a partial file behind; remove it
        // here, where the output path is known even if the job was deleted.
        if let Err(e) = result {
            let _ = std::fs::remove_file(&spec.output);
            return Err(e);
        }

        let size = std::fs::metadata(&spec.output).map(|m| m.len() as f64).unwrap_or(0.0);
        if size <= 0.0 {
            let _ = std::fs::remove_file(&spec.output);
            return Err(AppError::msg("ffmpeg finished but the output file is empty."));
        }
        self.log(
            id,
            &format!("Done: {} → {}", format_bytes(media.size_bytes), format_bytes(size)),
        );
        if size >= media.size_bytes && spec.trim.is_none() {
            self.log(id, "Note: the result is not smaller than the source. Try a lower quality, a smaller resolution or a more efficient encoder.");
        }
        Ok(size)
    }

    fn finish(self: &Arc<Self>, id: &str, result: Result<f64>) {
        let delete_original = self.settings.read().delete_original;
        let mut trash_source: Option<String> = None;
        {
            let mut st = self.state.lock();
            st.controls.remove(id);
            let requeue = st.requeue.remove(id);
            let State { jobs, tally, .. } = &mut *st;
            // The job may have been removed while it was running; then there
            // is nothing left to update.
            if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                {
                    job.finished_at = Some(now_ms());
                    job.eta_secs = None;
                    job.speed = 0.0;
                    job.fps = 0.0;
                    match result {
                        Ok(size) => {
                            job.status = JobStatus::Done;
                            job.progress = 100.0;
                            job.final_bytes = Some(size);
                            job.out_bytes = size;
                            job.stage = "Done".into();
                            tally.done += 1;
                            tally.source_bytes += job.source.size_bytes;
                            tally.output_bytes += size;
                            if delete_original {
                                trash_source = Some(job.spec.input.clone());
                            }
                        }
                        Err(AppError::Cancelled) => {
                            if requeue {
                                reset(job);
                            } else {
                                job.status = JobStatus::Cancelled;
                                job.stage = "Cancelled".into();
                                tally.cancelled += 1;
                            }
                        }
                        Err(e) => {
                            job.status = JobStatus::Failed;
                            job.stage = "Failed".into();
                            job.error = Some(e.to_string());
                            tally.failed += 1;
                        }
                    }
                }
            }
        }
        if let Some(path) = trash_source {
            match trash::delete(&path) {
                Ok(()) => self.log(id, "The original was moved to the Recycle Bin."),
                Err(e) => self.log(id, &format!("Could not move the original to the Recycle Bin: {e}")),
            }
        }
        self.pump();
    }
}
