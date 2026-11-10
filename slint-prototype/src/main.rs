//! Make Video Small with a native Slint interface.
//!
//! A prototype to answer one question: how much memory does the app need when
//! the interface is drawn natively instead of in a web view? It uses the same
//! Rust engine as the real app (probing, the three measured choices, the
//! queue) and covers the main flow: add a video, see three sizes, compare,
//! add to the queue, encode.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mvs_lib::analysis;
use mvs_lib::ffmpeg::caps;
use mvs_lib::ffmpeg::locate::{default_engine_dirs, locate, Tools};
use mvs_lib::ffmpeg::probe::probe;
use mvs_lib::ffmpeg::runner::capture;
use mvs_lib::model::*;
use mvs_lib::presets::{easy_options, output_path_for, spec_for};
use mvs_lib::queue::{ProbeCache, QueueManager};
use mvs_lib::util::EventSink;
use parking_lot::{Mutex, RwLock};
use slint::{ComponentHandle, Image, ModelRc, SharedString, VecModel};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

slint::include_modules!();

const VIDEO_TYPES: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "ts", "mts", "m2ts", "mpg", "mpeg"];

// ───────────────────────────── State ─────────────────────────────

/// One of the three choices after it was tried on a video.
struct Measured {
    spec: JobSpec,
    estimate: Estimate,
    look: &'static str,
    /// A frame of the video encoded with this choice.
    frame: PathBuf,
}

struct Checked {
    choices: Vec<Measured>,
    /// The same frame from the original.
    original_frame: PathBuf,
    recommended: usize,
    advice: String,
}

struct Entry {
    id: u64,
    media: MediaInfo,
    thumb: Option<PathBuf>,
    checked: Option<Checked>,
    checking: bool,
    progress: f64,
    stage: String,
    error: Option<String>,
    chosen: usize,
    picked_by_user: bool,
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    selected: Option<u64>,
    options: Vec<EasyOption>,
    queue: Option<QueueSnapshot>,
    status: String,
}

/// Everything a background task needs.
struct Ctx {
    tools: Tools,
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
    ui: slint::Weak<App>,
    queue: QueueManager,
    settings: Arc<RwLock<AppSettings>>,
    temp: PathBuf,
    next_id: AtomicU64,
}

/// Queue events arrive before the context exists, so the sink looks it up late.
struct Sink(Arc<OnceLock<Arc<Ctx>>>);

impl EventSink for Sink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let Some(ctx) = self.0.get() else { return };
        match event {
            "queue:changed" => {
                if let Ok(snapshot) = serde_json::from_value::<QueueSnapshot>(payload) {
                    ctx.state.lock().queue = Some(snapshot);
                    show_queue(ctx);
                }
            }
            "job:progress" => {
                if let Ok(p) = serde_json::from_value::<JobProgress>(payload) {
                    if let Some(snapshot) = ctx.state.lock().queue.as_mut() {
                        if let Some(job) = snapshot.jobs.iter_mut().find(|j| j.id == p.id) {
                            job.progress = p.progress;
                            job.speed = p.speed;
                            job.eta_secs = p.eta_secs;
                            job.out_bytes = p.out_bytes;
                            job.stage = p.stage;
                        }
                    }
                    show_queue(ctx);
                }
            }
            _ => {}
        }
    }
}

// ───────────────────────────── Formatting ─────────────────────────────

fn bytes(n: f64) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let (mut value, mut unit) = (n.max(0.0), 0);
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let digits = if unit == 0 || value >= 100.0 { 0 } else if value >= 10.0 { 1 } else { 2 };
    format!("{value:.digits$} {}", units[unit])
}

fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

fn span(seconds: f64) -> String {
    if seconds < 60.0 {
        return format!("{} s", seconds.round().max(1.0));
    }
    let minutes = (seconds / 60.0).round() as u64;
    if minutes < 60 { format!("{minutes} min") } else { format!("{} h {} min", minutes / 60, minutes % 60) }
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn image(path: Option<&Path>) -> Image {
    path.and_then(|p| Image::load_from_path(p).ok()).unwrap_or_default()
}

// ───────────────────────────── Showing state ─────────────────────────────

/// Run `f` on the interface thread.
fn on_ui(ctx: &Arc<Ctx>, f: impl FnOnce(&App, &Ctx) + Send + 'static) {
    let ctx = ctx.clone();
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = ctx.ui.upgrade() {
            f(&app, &ctx);
        }
    });
}

fn show_videos(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let rows: Vec<VideoRow> = state
            .entries
            .iter()
            .map(|e| {
                let size = e.media.video.as_ref().map(|v| format!("{}×{}", v.width, v.height)).unwrap_or_default();
                VideoRow {
                    name: e.media.file_name.clone().into(),
                    detail: format!("{size}  ·  {}  ·  {}", clock(e.media.duration), bytes(e.media.size_bytes)).into(),
                    has_thumb: e.thumb.is_some(),
                    thumb: image(e.thumb.as_deref()),
                }
            })
            .collect();
        let selected = state.selected.and_then(|id| state.entries.iter().position(|e| e.id == id));
        app.set_selected(selected.map(|i| i as i32).unwrap_or(-1));
        app.set_video_count(if rows.is_empty() { SharedString::new() } else { rows.len().to_string().into() });
        app.set_videos(ModelRc::new(VecModel::from(rows)));
        app.set_status(state.status.clone().into());
    });
}

fn show_detail(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let entry = state.selected.and_then(|id| state.entries.iter().find(|e| e.id == id));
        let cards: Vec<Choice> = state
            .options
            .iter()
            .enumerate()
            .map(|(i, option)| {
                let measured = entry.and_then(|e| e.checked.as_ref()).and_then(|c| c.choices.get(i).map(|m| (c, m)));
                let mut card = Choice {
                    title: option.title.clone().into(),
                    hint: option.hint.clone().into(),
                    ..Default::default()
                };
                if let Some((checked, m)) = measured {
                    let saved = m.estimate.savings_percent.round();
                    card.measured = true;
                    card.suggested = checked.recommended == i;
                    card.size = bytes(m.estimate.size_bytes).into();
                    card.bigger = saved < 0.0;
                    card.saving = if saved > 0.0 { format!("{saved}% smaller") } else if saved < 0.0 { format!("{}% bigger", -saved) } else { "same size".into() }.into();
                    card.look = m.look.into();
                    card.time = format!("Takes about {}", span(m.estimate.encode_secs)).into();
                }
                card
            })
            .collect();
        app.set_choices(ModelRc::new(VecModel::from(cards)));

        let Some(e) = entry else {
            app.set_heading("Nothing to set up yet".into());
            app.set_advice("".into());
            app.set_info("".into());
            app.set_save_as("".into());
            app.set_checking(false);
            app.set_has_frame(false);
            app.set_has_compare(false);
            return;
        };
        app.set_chosen(e.chosen as i32);
        app.set_checking(e.checking);
        app.set_check_progress((e.progress / 100.0) as f32);
        app.set_check_stage(e.stage.clone().into());
        app.set_heading(if e.checking { "Checking your video…" } else { "How small should it be?" }.into());
        app.set_advice(match (&e.error, &e.checked) {
            (Some(error), _) => format!("This video could not be checked. You can still compress it. {error}"),
            (None, Some(c)) => c.advice.clone(),
            _ => String::new(),
        }.into());
        let v = e.media.video.as_ref();
        app.set_info(format!("{}×{}, {}, {}", v.map(|v| v.width).unwrap_or(0), v.map(|v| v.height).unwrap_or(0), clock(e.media.duration), bytes(e.media.size_bytes)).into());

        match &e.checked {
            Some(c) => {
                let m = &c.choices[e.chosen.min(c.choices.len() - 1)];
                app.set_original(image(Some(&c.original_frame)));
                app.set_result(image(Some(&m.frame)));
                app.set_result_caption(format!("{}, about {}", state.options[e.chosen].title, bytes(m.estimate.size_bytes)).into());
                app.set_has_compare(true);
                app.set_has_frame(true);
                app.set_save_as(format!("Saves as {}", file_name(&m.spec.output)).into());
            }
            None => {
                app.set_original(image(e.thumb.as_deref()));
                app.set_has_compare(false);
                app.set_has_frame(e.thumb.is_some());
                app.set_save_as("".into());
            }
        }
    });
}

fn show_queue(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let Some(q) = state.queue.as_ref() else { return };
        let rows: Vec<JobRow> = q
            .jobs
            .iter()
            .map(|j| {
                let active = matches!(j.status, JobStatus::Running | JobStatus::Paused);
                let done = j.status == JobStatus::Done;
                let status = match j.status {
                    JobStatus::Queued => "Waiting".to_string(),
                    JobStatus::Running => format!(
                        "{} {:.0}%{}",
                        if j.stage.is_empty() { "Encoding" } else { &j.stage },
                        j.progress,
                        j.eta_secs.map(|s| format!(", {} left", span(s))).unwrap_or_default()
                    ),
                    JobStatus::Paused => format!("Paused {:.0}%", j.progress),
                    JobStatus::Done => {
                        let after = j.final_bytes.unwrap_or(0.0);
                        let saved = if j.source.size_bytes > 0.0 { ((1.0 - after / j.source.size_bytes) * 100.0).round() } else { 0.0 };
                        format!("{saved}% smaller: {} to {}", bytes(j.source.size_bytes), bytes(after))
                    }
                    JobStatus::Failed => j.error.as_deref().and_then(|e| e.lines().last()).unwrap_or("Failed").to_string(),
                    JobStatus::Cancelled => "Cancelled".to_string(),
                };
                JobRow {
                    name: j.source.file_name.clone().into(),
                    detail: file_name(&j.spec.output).into(),
                    status: status.into(),
                    progress: if done { 1.0 } else { (j.progress / 100.0) as f32 },
                    active,
                    done,
                    failed: j.status == JobStatus::Failed,
                }
            })
            .collect();
        let waiting = q.jobs.iter().filter(|j| j.status == JobStatus::Queued).count();
        let done = q.jobs.iter().filter(|j| j.status == JobStatus::Done).count();
        let mut summary = Vec::new();
        if q.running { summary.push("encoding".to_string()); }
        if waiting > 0 { summary.push(format!("{waiting} waiting")); }
        if done > 0 { summary.push(format!("{done} done")); }
        app.set_queue_summary(summary.join(", ").into());
        app.set_can_start(!q.running && waiting > 0);
        app.set_jobs(ModelRc::new(VecModel::from(rows)));
    });
}

// ───────────────────────────── Actions ─────────────────────────────

fn taken(ctx: &Ctx) -> HashSet<String> {
    ctx.queue.taken_outputs()
}

/// Read a video and put it in the list.
async fn add_video(ctx: Arc<Ctx>, path: String) {
    let Ok(media) = probe(&ctx.tools.ffprobe, &path).await else { return };
    if media.video.is_none() {
        return;
    }
    let id = ctx.next_id.fetch_add(1, Ordering::SeqCst);
    let first = {
        let mut state = ctx.state.lock();
        if state.entries.iter().any(|e| e.media.path.eq_ignore_ascii_case(&path)) {
            return;
        }
        state.entries.push(Entry {
            id,
            media: media.clone(),
            thumb: None,
            checked: None,
            checking: false,
            progress: 0.0,
            stage: String::new(),
            error: None,
            chosen: 1,
            picked_by_user: false,
        });
        state.selected.is_none()
    };
    show_videos(&ctx);
    if first {
        select(&ctx, id);
    }

    // A frame for the list and for the preview until the check is done.
    let thumb = ctx.temp.join(format!("mvs_proto_thumb_{id}.jpg"));
    let settings = ctx.state.lock().options.get(1).map(|o| o.settings.clone());
    if let Some(settings) = settings {
        let spec = spec_for(&media, &settings, String::new());
        let at = (media.duration * 0.15).min(20.0);
        if analysis::render_frame(&ctx.tools, &spec, &media, at, 960, &thumb).await.is_ok() {
            if let Some(e) = ctx.state.lock().entries.iter_mut().find(|e| e.id == id) {
                e.thumb = Some(thumb);
            }
            show_videos(&ctx);
            show_detail(&ctx);
        }
    }
}

fn select(ctx: &Arc<Ctx>, id: u64) {
    let needs_check = {
        let mut state = ctx.state.lock();
        state.selected = Some(id);
        state.entries.iter().find(|e| e.id == id).map(|e| e.checked.is_none() && !e.checking && e.error.is_none()).unwrap_or(false)
    };
    show_videos(ctx);
    show_detail(ctx);
    if needs_check {
        let ctx2 = ctx.clone();
        ctx.runtime.spawn(async move { check(ctx2, id).await });
    }
}

/// One frame out of a short clip, as a JPEG.
async fn frame_of(ctx: &Ctx, clip: &str, out: &Path) -> bool {
    let args: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-ss", "1", "-i", clip, "-frames:v", "1", "-q:v", "2"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(out.to_string_lossy().into_owned()))
        .collect();
    matches!(capture(&ctx.tools.ffmpeg, &args, None, None).await, Ok(c) if c.ok) && out.is_file()
}

/// Try the three choices on a video and suggest one.
async fn check(ctx: Arc<Ctx>, id: u64) {
    let (media, options) = {
        let mut state = ctx.state.lock();
        let options = state.options.clone();
        let Some(e) = state.entries.iter_mut().find(|e| e.id == id) else { return };
        e.checking = true;
        e.stage = "Looking for black bars".into();
        e.progress = 1.0;
        (e.media.clone(), options)
    };
    show_detail(&ctx);

    let result: Result<Checked, String> = async {
        let found = analysis::analyze_source(&ctx.tools, &media, None).await.map_err(|e| e.to_string())?;
        let app_settings = ctx.settings.read().clone();
        let specs: Vec<JobSpec> = options
            .iter()
            .map(|o| {
                let output = output_path_for(&media.path, o.settings.container, &app_settings, &taken(&ctx));
                let mut spec = spec_for(&media, &o.settings, output);
                if found.crop.is_some() {
                    spec.settings.video.crop = CropMode::Auto;
                    spec.auto_crop = found.crop;
                }
                spec
            })
            .collect();
        let progress_ctx = ctx.clone();
        let (original, tried) = analysis::compare_choices(&ctx.tools, &specs, &media, &ctx.temp, true, None, move |p, stage| {
            if let Some(e) = progress_ctx.state.lock().entries.iter_mut().find(|e| e.id == id) {
                e.progress = 5.0 + p * 0.9;
                e.stage = stage.to_string();
            }
            show_detail(&progress_ctx);
        })
        .await
        .map_err(|e| e.to_string())?;

        let original_frame = ctx.temp.join(format!("mvs_proto_{id}_orig.jpg"));
        frame_of(&ctx, &original, &original_frame).await;
        let scores: Vec<(f64, f64)> = tried.iter().map(|t| (t.estimate.savings_percent, t.similarity)).collect();
        let (recommended, advice) = analysis::recommend(&scores);
        let mut choices = Vec::new();
        for (i, (spec, t)) in specs.into_iter().zip(tried).enumerate() {
            let frame = ctx.temp.join(format!("mvs_proto_{id}_{i}.jpg"));
            frame_of(&ctx, &t.preview, &frame).await;
            let _ = std::fs::remove_file(&t.preview);
            choices.push(Measured { spec, look: analysis::describe_look(t.similarity), estimate: t.estimate, frame });
        }
        let _ = std::fs::remove_file(&original);
        Ok(Checked { choices, original_frame, recommended, advice })
    }
    .await;

    {
        let mut state = ctx.state.lock();
        if let Some(e) = state.entries.iter_mut().find(|e| e.id == id) {
            e.checking = false;
            match result {
                Ok(checked) => {
                    if !e.picked_by_user {
                        e.chosen = checked.recommended;
                    }
                    e.checked = Some(checked);
                }
                Err(error) => e.error = Some(error),
            }
        }
    }
    show_detail(&ctx);
}

async fn add_to_queue(ctx: Arc<Ctx>) {
    let spec = {
        let state = ctx.state.lock();
        let Some(e) = state.selected.and_then(|id| state.entries.iter().find(|e| e.id == id)) else { return };
        match &e.checked {
            Some(c) => c.choices[e.chosen].spec.clone(),
            // Not measured yet (or the check failed): the plain choice still works.
            None => {
                let Some(option) = state.options.get(e.chosen) else { return };
                let output = output_path_for(&e.media.path, option.settings.container, &ctx.settings.read(), &taken(&ctx));
                spec_for(&e.media, &option.settings, output)
            }
        }
    };
    let input = spec.input.clone();
    match ctx.queue.add(vec![spec]).await {
        Ok(_) => {
            let next = {
                let mut state = ctx.state.lock();
                state.entries.retain(|e| e.media.path != input);
                state.selected = state.entries.first().map(|e| e.id);
                state.selected
            };
            match next {
                Some(id) => select(&ctx, id),
                None => {
                    show_videos(&ctx);
                    show_detail(&ctx);
                }
            }
        }
        Err(e) => {
            ctx.state.lock().status = format!("Could not add to the queue: {e}");
            show_videos(&ctx);
        }
    }
}

// ───────────────────────────── Start-up ─────────────────────────────

fn main() -> Result<(), slint::PlatformError> {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
    let app = App::new()?;

    let tools = match locate(&default_engine_dirs(None)) {
        Ok(tools) => tools,
        Err(e) => {
            app.set_status(e.to_string().into());
            return app.run();
        }
    };
    let temp = std::env::temp_dir().join("makevideosmall-prototype");
    let _ = std::fs::create_dir_all(&temp);
    analysis::clean_temp(&temp);

    let settings = Arc::new(RwLock::new(AppSettings::default()));
    let late: Arc<OnceLock<Arc<Ctx>>> = Arc::new(OnceLock::new());
    let queue = QueueManager::new(
        Some(tools.clone()),
        temp.clone(),
        None,
        settings.clone(),
        Arc::new(ProbeCache::default()),
        Arc::new(Sink(late.clone())),
        runtime.handle().clone(),
    );
    let ctx = Arc::new(Ctx {
        tools,
        runtime: runtime.handle().clone(),
        state: Mutex::new(State { status: "Checking which encoders this PC can use…".into(), ..State::default() }),
        ui: app.as_weak(),
        queue,
        settings,
        temp,
        next_id: AtomicU64::new(1),
    });
    let _ = late.set(ctx.clone());

    // Hardware check, then any videos the app was opened with.
    {
        let ctx = ctx.clone();
        let opened: Vec<String> = std::env::args().skip(1).filter(|a| Path::new(a).is_file()).collect();
        runtime.spawn(async move {
            match caps::detect(&ctx.tools).await {
                Ok(found) => {
                    let options = easy_options(&found, true);
                    let encoder = options.first().map(|o| format!("{:?}", o.settings.video.encoder)).unwrap_or_default();
                    let mut state = ctx.state.lock();
                    let version = found.ffmpeg_version.split('-').next().unwrap_or("").to_string();
                    state.status = format!("ffmpeg {version}, {encoder}");
                    state.options = options;
                }
                Err(e) => ctx.state.lock().status = e.to_string(),
            }
            show_videos(&ctx);
            show_detail(&ctx);
            for path in opened {
                add_video(ctx.clone(), path).await;
            }
        });
    }

    {
        let ctx = ctx.clone();
        app.on_add_videos(move || {
            let Some(files) = rfd::FileDialog::new().set_title("Add videos").add_filter("Videos", VIDEO_TYPES).pick_files() else { return };
            for file in files {
                let ctx2 = ctx.clone();
                ctx.runtime.spawn(add_video(ctx2, file.to_string_lossy().into_owned()));
            }
        });
    }
    {
        let ctx = ctx.clone();
        app.on_select_video(move |index| {
            let id = ctx.state.lock().entries.get(index as usize).map(|e| e.id);
            if let Some(id) = id {
                select(&ctx, id);
            }
        });
    }
    {
        let ctx = ctx.clone();
        app.on_remove_video(move |index| {
            let next = {
                let mut state = ctx.state.lock();
                if (index as usize) < state.entries.len() {
                    let removed = state.entries.remove(index as usize);
                    if state.selected == Some(removed.id) {
                        state.selected = state.entries.first().map(|e| e.id);
                    }
                }
                state.selected
            };
            match next {
                Some(id) => select(&ctx, id),
                None => {
                    show_videos(&ctx);
                    show_detail(&ctx);
                }
            }
        });
    }
    {
        let ctx = ctx.clone();
        app.on_choose(move |index| {
            {
                let mut state = ctx.state.lock();
                let selected = state.selected;
                if let Some(e) = state.entries.iter_mut().find(|e| Some(e.id) == selected) {
                    e.chosen = index.max(0) as usize;
                    e.picked_by_user = true;
                }
            }
            show_detail(&ctx);
        });
    }
    {
        let ctx = ctx.clone();
        app.on_add_to_queue(move || {
            ctx.runtime.spawn(add_to_queue(ctx.clone()));
        });
    }
    {
        let ctx = ctx.clone();
        app.on_start_queue(move || ctx.queue.start());
    }
    {
        let ctx = ctx.clone();
        app.on_clear_finished(move || ctx.queue.clear_finished());
    }

    // For automated checks: start the queue by itself and/or save a picture of the window.
    if std::env::var_os("MVS_PROTO_AUTOSTART").is_some() {
        let ctx = ctx.clone();
        runtime.spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let ready = {
                    let state = ctx.state.lock();
                    state.selected.is_some() && state.entries.iter().all(|e| !e.checking) && state.entries.iter().any(|e| e.checked.is_some())
                };
                if ready {
                    add_to_queue(ctx.clone()).await;
                    ctx.queue.start();
                    break;
                }
            }
        });
    }
    if let (Some(path), Some(after)) = (std::env::var_os("MVS_PROTO_SNAPSHOT"), std::env::var("MVS_PROTO_SNAPSHOT_AFTER").ok().and_then(|s| s.parse::<u64>().ok())) {
        let weak = app.as_weak();
        let timer = slint::Timer::default();
        timer.start(slint::TimerMode::SingleShot, std::time::Duration::from_secs(after), move || {
            if let Some(app) = weak.upgrade() {
                if let Ok(pixels) = app.window().take_snapshot() {
                    let header = format!("{}x{}", pixels.width(), pixels.height());
                    let _ = std::fs::write(Path::new(&path).with_extension("size"), header);
                    let _ = std::fs::write(&path, pixels.as_bytes());
                }
            }
        });
        // The timer must outlive this block.
        std::mem::forget(timer);
    }

    // The display's scaling is only known once the window exists.
    app.show()?;
    let scale = app.window().scale_factor();
    app.window().set_size(slint::PhysicalSize::new((1360.0 * scale) as u32, (820.0 * scale) as u32));
    let result = slint::run_event_loop();
    ctx.queue.shutdown();
    result
}
