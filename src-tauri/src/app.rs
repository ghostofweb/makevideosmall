//! Tauri glue: application state, the commands the UI can call, and start-up.

use crate::analysis;
use crate::error::{AppError, Result};
use crate::ffmpeg::caps;
use crate::ffmpeg::command::{joined_media, plan, to_command_line, PlanOptions};
use crate::ffmpeg::locate::{default_engine_dirs, locate, Tools};
use crate::ffmpeg::runner::JobControl;
use crate::image::{probe_image, ImageRunner};
use crate::model::*;
use crate::presets::{easy_options, output_path_for, spec_for, PresetStore};
use crate::queue::{probe_joined, ProbeCache, QueueManager};
use crate::system::spawn_monitor;
use crate::util::{emit, load_json, save_json, EventSink};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use ts_rs::TS;

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp", "ogv", "vob",
];
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "avif", "gif"];

/// Forwards core events to every window.
struct TauriSink(tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
}

pub struct AppState {
    tools: Option<Tools>,
    /// What this PC can encode with. Remembered between launches so start-up
    /// never waits on graphics drivers; refreshed quietly in the background.
    caps: RwLock<Option<Capabilities>>,
    /// Only one hardware check runs at a time.
    detecting: tokio::sync::Mutex<()>,
    caps_path: PathBuf,
    probes: Arc<ProbeCache>,
    queue: QueueManager,
    presets: PresetStore,
    settings: Arc<RwLock<AppSettings>>,
    settings_path: PathBuf,
    /// No settings file existed at launch: pick smart defaults once.
    first_run: AtomicBool,
    temp_dir: PathBuf,
    /// Running analysis / preview tasks, by the token the UI gave them.
    analyses: Mutex<HashMap<String, Arc<JobControl>>>,
    /// Recently rendered preview frames, oldest first, so they can be pruned.
    frames: Mutex<VecDeque<PathBuf>>,
    images: ImageRunner,
    sink: Arc<dyn EventSink>,
    startup_files: Vec<String>,
}

impl AppState {
    fn tools(&self) -> Result<&Tools> {
        self.tools.as_ref().ok_or(AppError::FfmpegMissing)
    }

    async fn capabilities(&self) -> Result<Capabilities> {
        let tools = self.tools()?;
        if let Some(known) = self.caps.read().clone() {
            return Ok(known);
        }
        let _one_at_a_time = self.detecting.lock().await;
        if let Some(known) = self.caps.read().clone() {
            return Ok(known);
        }
        // An answer from an earlier launch is good as long as ffmpeg is the same.
        let remembered: Option<RememberedCaps> = load_json(&self.caps_path);
        let found = match remembered.filter(|r| r.key == caps_key(tools)) {
            Some(r) => Capabilities {
                // What is bundled can change between versions; never trust the file for it.
                upscaler_available: tools.upscaler.is_some(),
                background_removal_available: tools.bg_model.is_some(),
                ..r.capabilities
            },
            None => {
                let fresh = caps::detect(tools).await?;
                self.remember(tools, &fresh);
                fresh
            }
        };
        *self.caps.write() = Some(found.clone());
        Ok(found)
    }

    fn remember(&self, tools: &Tools, capabilities: &Capabilities) {
        // A check that got no answer is not worth remembering: ask again next time.
        if capabilities.encoders.iter().any(caps::timed_out) {
            let _ = std::fs::remove_file(&self.caps_path);
            return;
        }
        let _ = save_json(&self.caps_path, &RememberedCaps { key: caps_key(tools), capabilities: capabilities.clone() });
    }

    /// Check the hardware again and tell the UI if anything changed (a new
    /// graphics card or driver since the answer was remembered).
    async fn refresh_capabilities(&self) {
        let Ok(tools) = self.tools() else { return };
        let _one_at_a_time = self.detecting.lock().await;
        let Ok(mut fresh) = caps::detect(tools).await else { return };
        let earlier = self.caps.read().clone();
        if let Some(earlier) = &earlier {
            caps::keep_known_answers(&mut fresh, earlier);
        }
        self.remember(tools, &fresh);
        if earlier.as_ref() != Some(&fresh) {
            *self.caps.write() = Some(fresh.clone());
            let prefer_gpu = self.settings.read().prefer_gpu;
            emit(&*self.sink, "caps:changed", &CapsChanged { easy_options: easy_options(&fresh, prefer_gpu), capabilities: fresh });
        }
    }

    fn begin(&self, token: &str) -> Arc<JobControl> {
        let control = Arc::new(JobControl::new());
        // A new task with the same token replaces (and cancels) the old one.
        if let Some(old) = self.analyses.lock().insert(token.to_string(), control.clone()) {
            old.cancel();
        }
        control
    }

    fn end(&self, token: &str, control: &Arc<JobControl>) {
        let mut map = self.analyses.lock();
        if map.get(token).map(|c| Arc::ptr_eq(c, control)).unwrap_or(false) {
            map.remove(token);
        }
    }

    fn progress(&self, token: &str) -> impl FnMut(f64, &str) + '_ {
        let token = token.to_string();
        move |progress, stage| {
            emit(&*self.sink, "analysis:progress", &AnalysisProgress {
                token: token.clone(),
                progress,
                stage: stage.to_string(),
            });
        }
    }
}

/// Identifies the ffmpeg a remembered hardware check belongs to.
fn caps_key(tools: &Tools) -> String {
    let (size, modified) = std::fs::metadata(&tools.ffmpeg)
        .map(|m| {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (m.len(), modified)
        })
        .unwrap_or((0, 0));
    format!("{}|{size}|{modified}", tools.ffmpeg.display())
}

#[derive(Serialize, serde::Deserialize)]
struct RememberedCaps {
    key: String,
    capabilities: Capabilities,
}

/// Sent when a background hardware check finds something different.
#[derive(Serialize, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapsChanged {
    pub capabilities: Capabilities,
    pub easy_options: Vec<EasyOption>,
}

// ───────────────────────────── Bootstrap ─────────────────────────────

#[derive(Serialize, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Bootstrap {
    pub version: String,
    pub capabilities: Option<Capabilities>,
    /// Why encoding is unavailable (ffmpeg missing), if it is.
    pub problem: Option<String>,
    pub settings: AppSettings,
    pub presets: Vec<Preset>,
    /// The three choices of the simple view, for this PC.
    pub easy_options: Vec<EasyOption>,
    pub queue: QueueSnapshot,
    /// Files passed on the command line ("Open with").
    pub startup_files: Vec<String>,
}

/// Everything the UI needs to draw its first frame, in one call.
#[tauri::command]
async fn bootstrap(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Bootstrap> {
    let (capabilities, problem) = match state.capabilities().await {
        Ok(c) => (Some(c), None),
        Err(e) => (None, Some(e.to_string())),
    };

    // First launch: default to the GPU preset when the GPU can do it.
    if state.first_run.swap(false, Ordering::SeqCst) {
        let gpu = capabilities
            .as_ref()
            .map(|c| c.encoders.iter().any(|e| e.id == VideoEncoder::HevcNvenc && e.available))
            .unwrap_or(false);
        let mut settings = state.settings.write();
        if gpu {
            settings.default_preset_id = "gpu-balanced".into();
        }
        let _ = save_json(&state.settings_path, &*settings);
    }

    let prefer_gpu = state.settings.read().prefer_gpu;
    Ok(Bootstrap {
        version: app.package_info().version.to_string(),
        easy_options: capabilities.as_ref().map(|c| easy_options(c, prefer_gpu)).unwrap_or_default(),
        capabilities,
        problem,
        settings: state.settings.read().clone(),
        presets: state.presets.list(),
        queue: state.queue.snapshot(),
        startup_files: state.startup_files.clone(),
    })
}

// ───────────────────────────── Sources ─────────────────────────────

fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .map(|e| allowed.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn collect(path: &Path, allowed: &[&str], depth: u32, out: &mut Vec<String>) {
    if path.is_file() {
        if has_extension(path, allowed) {
            out.push(path.to_string_lossy().into_owned());
        }
    } else if path.is_dir() && depth > 0 {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .map(|rd| rd.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        entries.sort();
        for entry in entries {
            collect(&entry, allowed, depth - 1, out);
        }
    }
}

/// Turn dropped files and folders into a flat list of media files.
/// `kind` is "video" or "image".
#[tauri::command]
fn expand_paths(paths: Vec<String>, kind: String) -> Vec<String> {
    let allowed = if kind == "image" { IMAGE_EXTENSIONS } else { VIDEO_EXTENSIONS };
    let mut out = Vec::new();
    for p in paths {
        collect(Path::new(&p), allowed, 4, &mut out);
    }
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.to_lowercase()));
    out
}

#[tauri::command]
async fn probe_media(state: State<'_, AppState>, path: String) -> Result<MediaInfo> {
    state.probes.get(state.tools()?, &path).await
}

fn taken(state: &AppState, also: Vec<String>) -> HashSet<String> {
    let mut set = state.queue.taken_outputs();
    set.extend(also.into_iter().map(|p| p.to_lowercase()));
    set
}

/// A ready-to-queue job for a file, built from encode settings.
#[tauri::command]
async fn make_spec(
    state: State<'_, AppState>,
    path: String,
    settings: EncodeSettings,
    also_taken: Vec<String>,
) -> Result<JobSpec> {
    let media = state.probes.get(state.tools()?, &path).await?;
    let app = state.settings.read().clone();
    let output = output_path_for(&path, settings.container, &app, &taken(&state, also_taken));
    Ok(spec_for(&media, &settings, output))
}

/// Where a file's output should go for a given container.
#[tauri::command]
fn output_for(state: State<'_, AppState>, input: String, container: Container, also_taken: Vec<String>) -> String {
    let app = state.settings.read().clone();
    output_path_for(&input, container, &app, &taken(&state, also_taken))
}

#[derive(Serialize, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandPreview {
    pub command: String,
    pub warnings: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub video_kbps: Option<u32>,
    pub passes: u32,
}

/// The exact ffmpeg command a job would run, plus any warnings about it.
#[tauri::command]
async fn command_preview(state: State<'_, AppState>, spec: JobSpec) -> Result<CommandPreview> {
    let tools = state.tools()?;
    let media = state.probes.get(tools, &spec.input).await?;
    let joined = probe_joined(tools, &state.probes, &spec).await?;
    let hw_decode = state.settings.read().hardware_decode;
    let p = plan(&spec, &media, &PlanOptions { hw_decode, joined, ..PlanOptions::default() })?;
    Ok(CommandPreview {
        command: to_command_line("ffmpeg", p.passes.last().unwrap()),
        warnings: p.warnings,
        width: p.width,
        height: p.height,
        duration: p.duration,
        video_kbps: p.video_kbps,
        passes: p.passes.len() as u32,
    })
}

// ───────────────────────────── Simple view ─────────────────────────────

/// The three simple choices for this PC (they depend on the "use the graphics card" setting).
#[tauri::command]
async fn easy_options_list(state: State<'_, AppState>) -> Result<Vec<EasyOption>> {
    let caps = state.capabilities().await?;
    Ok(easy_options(&caps, state.settings.read().prefer_gpu))
}

/// Check a video and try the three simple choices on it.
///
/// `base` carries what belongs to the file rather than to a choice: its trim
/// and the audio/subtitle selection are kept; the output folder comes from it.
#[tauri::command]
async fn easy_analyze(state: State<'_, AppState>, base: JobSpec, token: String) -> Result<EasyAnalysis> {
    let tools = state.tools()?;
    let media = state.probes.get(tools, &base.input).await?;
    let caps = state.capabilities().await?;
    let (prefer_gpu, hw_decode) = {
        let s = state.settings.read();
        (s.prefer_gpu, s.hardware_decode)
    };
    let options = easy_options(&caps, prefer_gpu);
    let control = state.begin(&token);
    let mut progress = state.progress(&token);

    let result: Result<EasyAnalysis> = async {
        progress(1.0, "Looking for black bars");
        let found = analysis::analyze_source(tools, &media, Some(&control)).await?;
        let specs: Vec<JobSpec> = options
            .iter()
            .map(|o| {
                let mut spec = spec_for(&media, &o.settings, base.output.clone());
                spec.trim = base.trim;
                // Black bars are wasted space: crop them whenever they are found.
                if found.crop.is_some() {
                    spec.settings.video.crop = CropMode::Auto;
                    spec.auto_crop = found.crop;
                }
                spec
            })
            .collect();
        let (original, tried) = analysis::compare_choices(
            tools, &specs, &media, &state.temp_dir, hw_decode, Some(&control),
            |p, stage| progress(5.0 + p * 0.95, stage),
        )
        .await?;
        let scores: Vec<(f64, f64)> = tried.iter().map(|t| (t.estimate.savings_percent, t.similarity)).collect();
        let (pick, advice) = analysis::recommend(&scores);
        let choices: Vec<EasyChoice> = options
            .iter()
            .zip(specs)
            .zip(tried)
            .map(|((option, spec), t)| EasyChoice {
                id: option.id.clone(),
                spec,
                look: analysis::describe_look(t.similarity).to_string(),
                estimate: t.estimate,
                preview: t.preview,
                similarity: t.similarity,
            })
            .collect();
        Ok(EasyAnalysis {
            analysis: found,
            original,
            recommended: choices.get(pick).map(|c| c.id.clone()).unwrap_or_default(),
            choices,
            advice,
        })
    }
    .await;
    drop(progress);
    state.end(&token, &control);
    result
}

/// Prepare several videos to be joined, in the order given.
#[tauri::command]
async fn join_spec(
    state: State<'_, AppState>,
    paths: Vec<String>,
    settings: EncodeSettings,
    also_taken: Vec<String>,
) -> Result<Joined> {
    let tools = state.tools()?;
    let Some((first_path, rest_paths)) = paths.split_first() else {
        return Err(AppError::msg("Pick at least two videos to join."));
    };
    if rest_paths.is_empty() {
        return Err(AppError::msg("Pick at least two videos to join."));
    }
    let first = state.probes.get(tools, first_path).await?;
    let mut rest = Vec::new();
    for path in rest_paths {
        rest.push(state.probes.get(tools, path).await?);
    }
    let mut naming = state.settings.read().clone();
    naming.output_suffix = "_joined".into();
    let output = output_path_for(first_path, settings.container, &naming, &taken(&state, also_taken));
    let mut spec = spec_for(&first, &settings, output);
    spec.extra_inputs = rest_paths.to_vec();
    spec.audio_tracks.truncate(1);
    spec.subtitle_tracks.clear();
    spec.settings.subtitles = SubtitleDefault::None;
    // Fail now, with a clear reason, rather than when the queue reaches it.
    plan(&spec, &first, &PlanOptions { joined: rest.clone(), ..PlanOptions::default() })?;
    Ok(Joined { spec, media: joined_media(&first, &rest) })
}

/// Describe an existing join (used when the list is restored at launch).
#[tauri::command]
async fn join_info(state: State<'_, AppState>, spec: JobSpec) -> Result<MediaInfo> {
    let tools = state.tools()?;
    let first = state.probes.get(tools, &spec.input).await?;
    let rest = probe_joined(tools, &state.probes, &spec).await?;
    Ok(joined_media(&first, &rest))
}

// ───────────────────────────── Presets ─────────────────────────────

#[tauri::command]
fn presets_list(state: State<'_, AppState>) -> Vec<Preset> {
    state.presets.list()
}

#[tauri::command]
fn preset_save(state: State<'_, AppState>, preset: Preset) -> Result<Preset> {
    state.presets.save(preset)
}

#[tauri::command]
fn preset_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.presets.delete(&id)
}

#[tauri::command]
fn presets_export(state: State<'_, AppState>, ids: Vec<String>, file: String) -> Result<u32> {
    state.presets.export(&ids, Path::new(&file))
}

#[tauri::command]
fn presets_import(state: State<'_, AppState>, file: String) -> Result<Vec<Preset>> {
    state.presets.import(Path::new(&file))
}

// ───────────────────────────── Queue ─────────────────────────────

#[tauri::command]
fn queue_snapshot(state: State<'_, AppState>) -> QueueSnapshot {
    state.queue.snapshot()
}

#[tauri::command]
async fn queue_add(state: State<'_, AppState>, specs: Vec<JobSpec>) -> Result<Vec<String>> {
    state.queue.add(specs).await
}

#[tauri::command]
fn queue_remove(state: State<'_, AppState>, ids: Vec<String>) {
    state.queue.remove(&ids);
}

#[tauri::command]
fn queue_move(state: State<'_, AppState>, id: String, index: u32) {
    state.queue.move_job(&id, index as usize);
}

#[tauri::command]
fn queue_retry(state: State<'_, AppState>, id: String) {
    state.queue.retry(&id);
}

#[tauri::command]
fn queue_cancel(state: State<'_, AppState>, id: String) {
    state.queue.cancel(&id);
}

#[tauri::command]
fn queue_start(state: State<'_, AppState>) {
    state.queue.start();
}

#[tauri::command]
fn queue_pause(state: State<'_, AppState>) {
    state.queue.pause();
}

#[tauri::command]
fn queue_resume(state: State<'_, AppState>) {
    state.queue.resume();
}

#[tauri::command]
fn queue_stop(state: State<'_, AppState>) {
    state.queue.stop();
}

#[tauri::command]
fn queue_clear_finished(state: State<'_, AppState>) {
    state.queue.clear_finished();
}

#[tauri::command]
fn job_log(state: State<'_, AppState>, id: String) -> Vec<String> {
    state.queue.job_log(&id)
}

// ───────────────────────────── Analysis & preview ─────────────────────────────

#[tauri::command]
async fn analyze_source(state: State<'_, AppState>, path: String, token: String) -> Result<SourceAnalysis> {
    let tools = state.tools()?;
    let media = state.probes.get(tools, &path).await?;
    let control = state.begin(&token);
    let result = analysis::analyze_source(tools, &media, Some(&control)).await;
    state.end(&token, &control);
    result
}

#[tauri::command]
async fn estimate_spec(state: State<'_, AppState>, spec: JobSpec, token: String) -> Result<Estimate> {
    let tools = state.tools()?;
    let media = state.probes.get(tools, &spec.input).await?;
    let hw_decode = state.settings.read().hardware_decode;
    let control = state.begin(&token);
    let result = analysis::estimate(tools, &spec, &media, &state.temp_dir, hw_decode, Some(&control), state.progress(&token)).await;
    state.end(&token, &control);
    result
}

#[tauri::command]
async fn render_preview(
    state: State<'_, AppState>,
    spec: JobSpec,
    at: f64,
    length: f64,
    token: String,
) -> Result<PreviewPair> {
    let tools = state.tools()?;
    let media = state.probes.get(tools, &spec.input).await?;
    let hw_decode = state.settings.read().hardware_decode;
    let control = state.begin(&token);
    let result = analysis::render_preview(
        tools, &spec, &media, at, length, &state.temp_dir, hw_decode, Some(&control), state.progress(&token),
    )
    .await;
    state.end(&token, &control);
    result
}

/// Render one frame (crop, scale and filters applied) and return its path.
#[tauri::command]
async fn render_frame(state: State<'_, AppState>, spec: JobSpec, at: f64, max_width: u32) -> Result<String> {
    let tools = state.tools()?;
    let media = state.probes.get(tools, &spec.input).await?;
    let out = state.temp_dir.join(format!("mvs_frame_{}.jpg", uuid::Uuid::new_v4().simple()));
    analysis::render_frame(tools, &spec, &media, at, max_width, &out).await?;
    // Keep the temp folder from growing without limit.
    let stale: Vec<PathBuf> = {
        let mut frames = state.frames.lock();
        frames.push_back(out.clone());
        let extra = frames.len().saturating_sub(60);
        frames.drain(..extra).collect()
    };
    for path in stale {
        let _ = std::fs::remove_file(path);
    }
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
fn cancel_analysis(state: State<'_, AppState>, token: String) {
    if let Some(control) = state.analyses.lock().remove(&token) {
        control.cancel();
    }
}

// ───────────────────────────── Settings ─────────────────────────────

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> AppSettings {
    state.settings.read().clone()
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, mut settings: AppSettings) -> Result<AppSettings> {
    settings.parallel_jobs = settings.parallel_jobs.clamp(1, 8);
    // Characters Windows does not allow in file names.
    settings.output_suffix.retain(|c| !r#"\/:*?"<>|"#.contains(c));
    if settings.output_dir.as_deref().map(|d| d.trim().is_empty()).unwrap_or(false) {
        settings.output_dir = None;
    }
    *state.settings.write() = settings.clone();
    save_json(&state.settings_path, &settings)?;
    Ok(settings)
}

// ───────────────────────────── Images ─────────────────────────────

#[tauri::command]
async fn image_probe(state: State<'_, AppState>, path: String) -> Result<ImageInfo> {
    probe_image(state.tools()?, &path).await
}

/// Output path for an image job: `<name><suffix>.<ext>`, never the source itself.
#[tauri::command]
fn image_output_for(
    input: String,
    format: ImageFormat,
    suffix: String,
    dir: Option<String>,
    name: Option<String>,
    also_taken: Vec<String>,
) -> String {
    let input_path = Path::new(&input);
    let folder = dir
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| input_path.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let stem = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .map(|n| {
            // Drop an extension the user may have typed.
            Path::new(&n).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(n)
        })
        .unwrap_or_else(|| {
            format!(
                "{}{suffix}",
                input_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into())
            )
        });
    let taken: HashSet<String> = also_taken.into_iter().map(|p| p.to_lowercase()).collect();
    let ext = format.ext();
    for n in 1..10_000 {
        let file = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} ({n}).{ext}") };
        let candidate = folder.join(file);
        let key = candidate.to_string_lossy().to_lowercase();
        if key != input.to_lowercase() && !candidate.exists() && !taken.contains(&key) {
            return candidate.to_string_lossy().into_owned();
        }
    }
    folder.join(format!("{stem}-{}.{ext}", uuid::Uuid::new_v4().simple())).to_string_lossy().into_owned()
}

#[tauri::command]
fn image_start(state: State<'_, AppState>, jobs: Vec<ImageJob>) -> Result<()> {
    state.images.start(jobs)
}

#[tauri::command]
fn image_cancel(state: State<'_, AppState>) {
    state.images.cancel();
}

// ───────────────────────────── Files & system ─────────────────────────────

#[tauri::command]
fn reveal_path(path: String) -> Result<()> {
    if !Path::new(&path).exists() {
        return Err(AppError::msg("That file no longer exists."));
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| AppError::msg(e.to_string()))
}

#[tauri::command]
fn open_path(path: String) -> Result<()> {
    if !Path::new(&path).exists() {
        return Err(AppError::msg("That file or folder no longer exists."));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
}

/// Move a file to the Recycle Bin.
#[tauri::command]
fn trash_path(path: String) -> Result<()> {
    if !Path::new(&path).exists() {
        return Err(AppError::msg("That file no longer exists."));
    }
    trash::delete(&path).map_err(|e| AppError::msg(format!("Could not move the file to the Recycle Bin: {e}")))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn shutdown_pc() -> Result<()> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("shutdown");
        c.args(["/s", "/t", "0"]);
        c
    } else {
        let mut c = std::process::Command::new("shutdown");
        c.args(["-h", "now"]);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| AppError::msg(format!("Could not shut down the PC: {e}")))
}

// ───────────────────────────── Start-up ─────────────────────────────

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    // Tests point this at a scratch folder so they never touch real data.
    if let Some(dir) = std::env::var_os("MVS_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("makevideosmall-data"))
}

fn build_state(app: &tauri::AppHandle) -> AppState {
    let data = data_dir(app);
    let _ = std::fs::create_dir_all(&data);
    let temp_dir = std::env::temp_dir().join("makevideosmall");
    let _ = std::fs::create_dir_all(&temp_dir);
    analysis::clean_temp(&temp_dir);

    let resource_dir = app.path().resource_dir().ok();
    let tools = locate(&default_engine_dirs(resource_dir.as_deref())).ok();

    let settings_path = data.join("settings.json");
    let first_run = !settings_path.exists();
    let settings = Arc::new(RwLock::new(load_json::<AppSettings>(&settings_path)));

    let sink: Arc<dyn EventSink> = Arc::new(TauriSink(app.clone()));
    let runtime = tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() });
    let probes = Arc::new(ProbeCache::default());

    let startup_files = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-') && Path::new(a).exists())
        .collect();

    AppState {
        queue: QueueManager::new(
            tools.clone(),
            temp_dir.clone(),
            Some(data.join("queue.json")),
            settings.clone(),
            probes.clone(),
            sink.clone(),
            runtime.clone(),
        ),
        images: ImageRunner::new(tools.clone(), temp_dir.clone(), sink.clone(), runtime),
        presets: PresetStore::new(Some(data.join("presets.json"))),
        tools,
        caps: RwLock::new(None),
        detecting: tokio::sync::Mutex::new(()),
        caps_path: data.join("capabilities.json"),
        probes,
        settings,
        settings_path,
        first_run: AtomicBool::new(first_run),
        temp_dir,
        analyses: Mutex::new(HashMap::new()),
        frames: Mutex::new(VecDeque::new()),
        sink,
        startup_files,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state = build_state(app.handle());
            spawn_monitor(state.sink.clone());
            app.manage(state);
            // Once the window has settled, check the hardware again in the
            // background. Start-up itself uses the remembered answer.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                handle.state::<AppState>().refresh_capabilities().await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window ends the app: stop every encoder first.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.queue.shutdown();
                    state.images.cancel();
                    for control in state.analyses.lock().values() {
                        control.cancel();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            expand_paths,
            probe_media,
            make_spec,
            output_for,
            command_preview,
            easy_options_list,
            easy_analyze,
            join_spec,
            join_info,
            presets_list,
            preset_save,
            preset_delete,
            presets_export,
            presets_import,
            queue_snapshot,
            queue_add,
            queue_remove,
            queue_move,
            queue_retry,
            queue_cancel,
            queue_start,
            queue_pause,
            queue_resume,
            queue_stop,
            queue_clear_finished,
            job_log,
            analyze_source,
            estimate_spec,
            render_preview,
            render_frame,
            cancel_analysis,
            settings_get,
            settings_set,
            image_probe,
            image_output_for,
            image_start,
            image_cancel,
            reveal_path,
            open_path,
            trash_path,
            path_exists,
            shutdown_pc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Make Video Small");
}
