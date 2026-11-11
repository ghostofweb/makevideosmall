//! The queue pane: jobs, their progress, what happens when all are finished,
//! and the hardware load underneath.

use crate::ctx::*;
use crate::fmt::*;
use crate::{settings_ui, video, App, JobRow, A, Q};
use mvs_core::model::*;
use mvs_core::platform;
use slint::ComponentHandle;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
pub struct QueueState {
    pub jobs: Vec<Job>,
    pub running: bool,
    pub paused: bool,
    /// The job whose log is open.
    pub log_job: Option<String>,
}

fn job_name(job: &Job) -> String {
    if job.spec.extra_inputs.is_empty() { job.source.file_name.clone() } else { format!("{} videos joined", job.spec.extra_inputs.len() + 1) }
}

/// The size of the part of the original that this job keeps. A video that was
/// cut is compared with the part that was kept, not with the whole file.
fn kept_bytes(job: &Job) -> f64 {
    let whole = job.source.size_bytes;
    match job.spec.trim {
        Some(t) if job.source.duration > 0.0 => {
            let end = if t.end > 0.0 { t.end.min(job.source.duration) } else { job.source.duration };
            whole * ((end - t.start).max(0.0) / job.source.duration).clamp(0.0, 1.0)
        }
        _ => whole,
    }
}

fn status_text(job: &Job) -> String {
    match job.status {
        JobStatus::Queued => "Waiting".into(),
        JobStatus::Running => {
            let left = job.eta_secs.filter(|s| s.is_finite() && *s > 0.0).map(|s| format!(", about {} left", span(s))).unwrap_or_default();
            let stage = if job.stage.is_empty() || job.progress > 0.5 { String::new() } else { format!(" {}", job.stage) };
            format!("{:.0}%{left}{stage}", job.progress)
        }
        JobStatus::Paused => format!("Paused at {:.0}%", job.progress),
        JobStatus::Done => match job.final_bytes {
            Some(out) if job.spec.trim.is_some() => format!("Cut out and saved: {}, {} than that part was", bytes(out), savings_label(kept_bytes(job), out)),
            Some(out) => format!("{} to {}, {}", bytes(job.source.size_bytes), bytes(out), savings_label(job.source.size_bytes, out)),
            None => "Done".into(),
        },
        JobStatus::Failed => job.error.as_deref().and_then(|e| e.lines().next()).unwrap_or("Something went wrong").to_string(),
        JobStatus::Cancelled => "Cancelled".into(),
    }
}

pub fn show_queue(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let q = app.global::<Q>();
        let jobs = &state.q.jobs;
        let list: Vec<JobRow> = jobs
            .iter()
            .map(|job| JobRow {
                name: job_name(job).into(),
                detail: describe_settings(&job.spec.settings, state.caps.as_ref()).into(),
                status: status_text(job).into(),
                state: match job.status {
                    JobStatus::Queued => 0,
                    JobStatus::Running => 1,
                    JobStatus::Paused => 2,
                    JobStatus::Done => 3,
                    JobStatus::Failed => 4,
                    JobStatus::Cancelled => 5,
                },
                progress: (job.progress / 100.0) as f32,
                ratio: match job.final_bytes {
                    Some(out) if kept_bytes(job) > 0.0 => (out / kept_bytes(job)) as f32,
                    _ => -1.0,
                },
            })
            .collect();
        let count = |wanted: &[JobStatus]| jobs.iter().filter(|j| wanted.contains(&j.status)).count();
        let waiting = count(&[JobStatus::Queued]);
        let active = count(&[JobStatus::Running, JobStatus::Paused]);
        let finished = count(&[JobStatus::Done, JobStatus::Failed, JobStatus::Cancelled]);
        q.set_jobs(rows(list));
        q.set_summary(
            if active > 0 && waiting > 0 { format!("{waiting} waiting") } else if active > 0 { "working".into() } else if waiting > 0 { format!("{waiting} waiting") } else { String::new() }.into(),
        );
        q.set_running(state.q.running);
        q.set_paused(state.q.paused);
        q.set_can_start(waiting > 0 && ctx.core.problem.is_none());
        q.set_finished(finished as i32);
        q.set_sound(state.settings.play_sound_on_finish);
        q.set_shutdown(state.settings.shutdown_on_finish);
    });
}

pub fn on_event(ctx: &Arc<Ctx>, event: &str, payload: serde_json::Value) {
    match event {
        "queue:changed" => {
            let Ok(snapshot) = serde_json::from_value::<QueueSnapshot>(payload) else { return };
            {
                let mut state = ctx.state.lock();
                state.q.jobs = snapshot.jobs;
                state.q.running = snapshot.running;
                state.q.paused = snapshot.paused;
            }
            show_queue(ctx);
        }
        "job:progress" => {
            let Ok(p) = serde_json::from_value::<JobProgress>(payload) else { return };
            if let Some(job) = ctx.state.lock().q.jobs.iter_mut().find(|j| j.id == p.id) {
                job.progress = p.progress;
                job.fps = p.fps;
                job.speed = p.speed;
                job.eta_secs = p.eta_secs;
                job.out_bytes = p.out_bytes;
                job.stage = p.stage;
            }
            show_queue(ctx);
        }
        "job:log" => {
            let Ok(line) = serde_json::from_value::<JobLogLine>(payload) else { return };
            if ctx.state.lock().q.log_job.as_deref() != Some(line.id.as_str()) {
                return;
            }
            on_ui(ctx, move |app, _| {
                let a = app.global::<A>();
                let mut text = a.get_log_text().to_string();
                // A log that is being watched must not grow without limit.
                if text.len() > 200_000 {
                    text = text.split_off(text.len() - 150_000);
                }
                text.push('\n');
                text.push_str(&line.line);
                a.set_log_text(text.into());
            });
        }
        "queue:finished" => {
            if let Ok(tally) = serde_json::from_value::<QueueFinished>(payload) {
                finished(ctx, tally);
            }
        }
        "system:stats" => {
            let Ok(s) = serde_json::from_value::<SystemStats>(payload) else { return };
            on_ui(ctx, move |app, _| {
                let q = app.global::<Q>();
                q.set_cpu((s.cpu_usage / 100.0) as f32);
                q.set_cpu_text(format!("{:.0}%", s.cpu_usage).into());
                q.set_ram(if s.ram_total_gb > 0.0 { (s.ram_used_gb / s.ram_total_gb) as f32 } else { 0.0 });
                q.set_ram_text(format!("{:.1} of {:.0} GB", s.ram_used_gb, s.ram_total_gb).into());
                match s.gpu_usage {
                    Some(usage) => {
                        // While encoding, the encoder chip is the part that is busy.
                        let busy = usage.max(s.gpu_encoder_usage.unwrap_or(0.0));
                        q.set_gpu((busy / 100.0) as f32);
                        q.set_gpu_text(format!("{busy:.0}%{}", s.gpu_temp_c.map(|t| format!(", {t:.0} °C")).unwrap_or_default()).into());
                    }
                    None => q.set_gpu(-1.0),
                }
            });
        }
        _ => {}
    }
}

/// Everything in the queue has been worked through.
fn finished(ctx: &Arc<Ctx>, tally: QueueFinished) {
    let settings = ctx.core.settings();
    let videos = |n: u32| if n == 1 { "1 video".to_string() } else { format!("{n} videos") };
    if tally.failed > 0 {
        toast(ctx, 3, format!("{} could not be compressed", videos(tally.failed)), "Choose \"Log\" on it in the queue to see why.");
    } else if tally.done > 0 {
        // With a cut video in the batch, "smaller than the original" would
        // mostly measure the cut, so only the result is reported.
        let any_cut = ctx.state.lock().q.jobs.iter().any(|j| j.status == JobStatus::Done && j.spec.trim.is_some());
        let detail = if any_cut {
            format!("{} saved", bytes(tally.output_bytes))
        } else {
            format!("{} to {}, {}", bytes(tally.source_bytes), bytes(tally.output_bytes), savings_label(tally.source_bytes, tally.output_bytes))
        };
        toast(ctx, 1, format!("{} finished", videos(tally.done)), detail);
    }
    if tally.done == 0 {
        return;
    }
    if settings.play_sound_on_finish {
        chime();
    }
    if settings.shutdown_on_finish {
        // One time only: it must never surprise anyone on a later day.
        settings_ui::change(ctx, |s| s.shutdown_on_finish = false);
        ctx.shutdown_cancelled.store(false, Ordering::SeqCst);
        let ctx = ctx.clone();
        ctx.runtime.clone().spawn(async move {
            for left in (1..=30).rev() {
                if ctx.shutdown_cancelled.load(Ordering::SeqCst) {
                    return;
                }
                toast_with(&ctx, 2, format!("Turning the PC off in {left} seconds"), "Everything in the queue is finished.", ToastAction::CancelShutdown, "Cancel");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            if !ctx.shutdown_cancelled.load(Ordering::SeqCst) {
                ctx.core.shutdown();
                if let Err(e) = platform::shutdown_pc() {
                    error_toast(&ctx, "Could not turn the PC off", e);
                }
            }
        });
    }
}

fn act(ctx: &Arc<Ctx>, index: usize, what: &str) {
    let Some(job) = ctx.state.lock().q.jobs.get(index).cloned() else { return };
    let queue = &ctx.core.queue;
    match what {
        "cancel" => queue.cancel(&job.id),
        "retry" => queue.retry(&job.id),
        "remove" => queue.remove(&[job.id.clone()]),
        "up" => queue.move_job(&job.id, index.saturating_sub(1)),
        "down" => queue.move_job(&job.id, index + 1),
        "reveal" => {
            if let Err(e) = platform::reveal(&job.spec.output) {
                error_toast(ctx, "Could not show the file", e);
            }
        }
        "play" => {
            if let Err(e) = platform::open(&job.spec.output) {
                error_toast(ctx, "Could not open the file", e);
            }
        }
        "edit" => {
            queue.remove(&[job.id.clone()]);
            video::add_from_job(ctx, job);
        }
        "log" => {
            let mut lines = queue.job_log(&job.id);
            if let Some(command) = &job.command {
                lines.insert(0, format!("{command}\n"));
            }
            if lines.is_empty() {
                lines.push("Nothing yet. The log fills in once this video starts.".into());
            }
            ctx.state.lock().q.log_job = Some(job.id.clone());
            let title = format!("Log: {}", job_name(&job));
            on_ui(ctx, move |app, _| {
                let a = app.global::<A>();
                a.set_log_title(title.into());
                a.set_log_text(lines.join("\n").into());
                a.set_log_open(true);
            });
        }
        _ => {}
    }
}

pub fn wire(app: &App, ctx: &Arc<Ctx>) {
    let q = app.global::<Q>();
    macro_rules! on {
        ($setter:ident, |$c:ident $(, $arg:ident)*| $body:expr) => {{
            let $c = ctx.clone();
            q.$setter(move |$($arg),*| $body);
        }};
    }
    on!(on_start, |c| c.core.queue.start());
    on!(on_pause, |c| c.core.queue.pause());
    on!(on_resume, |c| c.core.queue.resume());
    on!(on_stop, |c| c.core.queue.stop());
    on!(on_clear_finished, |c| c.core.queue.clear_finished());
    on!(on_act, |c, index, what| act(&c, index.max(0) as usize, &what));
    on!(on_put, |c, name, on| {
        settings_ui::change(&c, |s| match name.as_str() {
            "sound" => s.play_sound_on_finish = on,
            "shutdown" => s.shutdown_on_finish = on,
            _ => {}
        });
    });
}
