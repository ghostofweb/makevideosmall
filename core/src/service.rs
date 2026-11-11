//! Everything the interface needs from the engine, in one place.
//!
//! `Core` owns the long-lived pieces (tools, queue, presets, settings, what the
//! hardware can do) and offers one method per thing a person can ask for. It
//! knows nothing about how the interface is drawn.

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
use crate::util::{emit, load_json, save_json, EventSink};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp", "ogv", "vob",
];
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "avif", "gif"];

/// What a job would run, for showing before it is queued.
#[derive(Clone, Debug)]
pub struct CommandPreview {
    pub command: String,
    pub warnings: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub video_kbps: Option<u32>,
    pub passes: u32,
}

#[derive(Serialize, Deserialize)]
struct RememberedCaps {
    key: String,
    capabilities: Capabilities,
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

/// Turn dropped files and folders into a flat list of files of the wanted kind.
pub fn expand_paths(paths: &[String], allowed: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for p in paths {
        collect(Path::new(p), allowed, 4, &mut out);
    }
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.to_lowercase()));
    out
}

/// Output path for a picture job: `<name><suffix>.<ext>`, never the source
/// itself, never an existing file, never one already claimed.
pub fn image_output_for(input: &str, format: ImageFormat, suffix: &str, dir: Option<&str>, also_taken: &[String]) -> String {
    let input_path = Path::new(input);
    let folder = dir
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| input_path.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let stem = format!(
        "{}{suffix}",
        input_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into())
    );
    let taken: HashSet<String> = also_taken.iter().map(|p| p.to_lowercase()).collect();
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

pub struct Core {
    tools: Option<Tools>,
    /// Why encoding is unavailable, when it is (ffmpeg missing).
    pub problem: Option<String>,
    caps: RwLock<Option<Capabilities>>,
    detecting: tokio::sync::Mutex<()>,
    caps_path: PathBuf,
    pub probes: Arc<ProbeCache>,
    pub queue: QueueManager,
    pub presets: PresetStore,
    settings: Arc<RwLock<AppSettings>>,
    settings_path: PathBuf,
    /// No settings existed before this launch.
    pub first_run: bool,
    pub temp_dir: PathBuf,
    frames: parking_lot::Mutex<VecDeque<PathBuf>>,
    pub images: ImageRunner,
    sink: Arc<dyn EventSink>,
}

impl Core {
    /// `data_dir` holds settings, presets, the queue and the remembered
    /// hardware check. `engine_dir` is where bundled tools live, if anywhere.
    pub fn new(data_dir: &Path, engine_dir: Option<&Path>, sink: Arc<dyn EventSink>, runtime: tokio::runtime::Handle) -> Self {
        let _ = std::fs::create_dir_all(data_dir);
        let temp_dir = std::env::temp_dir().join("makevideosmall");
        let _ = std::fs::create_dir_all(&temp_dir);
        analysis::clean_temp(&temp_dir);

        let (tools, problem) = match locate(&default_engine_dirs(engine_dir)) {
            Ok(tools) => (Some(tools), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let settings_path = data_dir.join("settings.json");
        let first_run = !settings_path.exists();
        let settings = Arc::new(RwLock::new(load_json::<AppSettings>(&settings_path)));
        let probes = Arc::new(ProbeCache::default());

        Core {
            queue: QueueManager::new(
                tools.clone(),
                temp_dir.clone(),
                Some(data_dir.join("queue.json")),
                settings.clone(),
                probes.clone(),
                sink.clone(),
                runtime.clone(),
            ),
            images: ImageRunner::new(tools.clone(), temp_dir.clone(), sink.clone(), runtime),
            presets: PresetStore::new(Some(data_dir.join("presets.json"))),
            tools,
            problem,
            caps: RwLock::new(None),
            detecting: tokio::sync::Mutex::new(()),
            caps_path: data_dir.join("capabilities.json"),
            probes,
            settings,
            settings_path,
            first_run,
            temp_dir,
            frames: parking_lot::Mutex::new(VecDeque::new()),
            sink,
        }
    }

    pub fn tools(&self) -> Result<&Tools> {
        self.tools.as_ref().ok_or(AppError::FfmpegMissing)
    }

    // ───────────────────────────── Hardware ─────────────────────────────

    /// What this PC can encode with. The answer is remembered between
    /// launches, so start-up never waits on graphics drivers.
    pub async fn capabilities(&self) -> Result<Capabilities> {
        let tools = self.tools()?;
        if let Some(known) = self.caps.read().clone() {
            return Ok(known);
        }
        let _one_at_a_time = self.detecting.lock().await;
        if let Some(known) = self.caps.read().clone() {
            return Ok(known);
        }
        let remembered: Option<RememberedCaps> = std::fs::read_to_string(&self.caps_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
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

    /// Check the hardware again. Returns the new answer only if it differs
    /// (a new graphics card or driver since it was remembered).
    pub async fn refresh_capabilities(&self) -> Option<Capabilities> {
        let tools = self.tools().ok()?;
        let _one_at_a_time = self.detecting.lock().await;
        let mut fresh = caps::detect(tools).await.ok()?;
        let earlier = self.caps.read().clone();
        if let Some(earlier) = &earlier {
            caps::keep_known_answers(&mut fresh, earlier);
        }
        self.remember(tools, &fresh);
        if earlier.as_ref() == Some(&fresh) {
            return None;
        }
        *self.caps.write() = Some(fresh.clone());
        Some(fresh)
    }

    /// The three simple choices for this PC and the current settings.
    pub async fn easy_options(&self) -> Result<Vec<EasyOption>> {
        let caps = self.capabilities().await?;
        Ok(easy_options(&caps, self.settings.read().prefer_gpu))
    }

    // ───────────────────────────── Settings ─────────────────────────────

    pub fn settings(&self) -> AppSettings {
        self.settings.read().clone()
    }

    pub fn set_settings(&self, mut settings: AppSettings) -> Result<AppSettings> {
        settings.parallel_jobs = settings.parallel_jobs.clamp(1, 8);
        // Characters Windows does not allow in file names.
        settings.output_suffix.retain(|c| !r#"\/:*?"<>|"#.contains(c));
        if settings.output_dir.as_deref().map(|d| d.trim().is_empty()).unwrap_or(false) {
            settings.output_dir = None;
        }
        *self.settings.write() = settings.clone();
        save_json(&self.settings_path, &settings)?;
        Ok(settings)
    }

    // ───────────────────────────── Videos ─────────────────────────────

    pub async fn probe(&self, path: &str) -> Result<MediaInfo> {
        self.probes.get(self.tools()?, path).await
    }

    fn taken(&self, also: &[String]) -> HashSet<String> {
        let mut set = self.queue.taken_outputs();
        set.extend(also.iter().map(|p| p.to_lowercase()));
        set
    }

    /// Where a file's output should go for a given container.
    pub fn output_for(&self, input: &str, container: Container, also_taken: &[String]) -> String {
        output_path_for(input, container, &self.settings.read(), &self.taken(also_taken))
    }

    /// A ready-to-queue job for a file, built from encode settings.
    pub async fn make_spec(&self, path: &str, settings: &EncodeSettings, also_taken: &[String]) -> Result<JobSpec> {
        let media = self.probe(path).await?;
        Ok(spec_for(&media, settings, self.output_for(path, settings.container, also_taken)))
    }

    /// The exact ffmpeg command a job would run, plus any warnings about it.
    pub async fn command_preview(&self, spec: &JobSpec) -> Result<CommandPreview> {
        let tools = self.tools()?;
        let media = self.probes.get(tools, &spec.input).await?;
        let joined = probe_joined(tools, &self.probes, spec).await?;
        let hw_decode = self.settings.read().hardware_decode;
        let p = plan(spec, &media, &PlanOptions { hw_decode, joined, ..PlanOptions::default() })?;
        Ok(CommandPreview {
            command: to_command_line("ffmpeg", p.passes.last().map(Vec::as_slice).unwrap_or(&[])),
            warnings: p.warnings,
            width: p.width,
            height: p.height,
            duration: p.duration,
            video_kbps: p.video_kbps,
            passes: p.passes.len() as u32,
        })
    }

    /// Check a video and try the three simple choices on it.
    ///
    /// `base` carries what belongs to the file rather than to a choice: its
    /// trim is kept and its output path is used.
    pub async fn easy_analyze(
        &self,
        base: &JobSpec,
        control: &JobControl,
        mut on_progress: impl FnMut(f64, &str),
    ) -> Result<EasyAnalysis> {
        let tools = self.tools()?;
        let media = self.probes.get(tools, &base.input).await?;
        let options = self.easy_options().await?;
        let hw_decode = self.settings.read().hardware_decode;

        on_progress(1.0, "Looking for black bars");
        let found = analysis::analyze_source(tools, &media, Some(control)).await?;
        let specs: Vec<JobSpec> = options
            .iter()
            .map(|o| {
                let output = if o.settings.container == base.settings.container {
                    base.output.clone()
                } else {
                    Path::new(&base.output).with_extension(o.settings.container.ext()).to_string_lossy().into_owned()
                };
                let mut spec = spec_for(&media, &o.settings, output);
                spec.trim = base.trim;
                // Black bars are wasted space: crop them whenever they are found.
                if found.crop.is_some() {
                    spec.settings.video.crop = CropMode::Auto;
                    spec.auto_crop = found.crop;
                }
                spec
            })
            .collect();
        let (original, tried) = analysis::compare_choices(tools, &specs, &media, &self.temp_dir, hw_decode, Some(control), |p, stage| {
            on_progress(5.0 + p * 0.95, stage)
        })
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

    /// Prepare several videos to be joined, in the order given.
    pub async fn join_spec(&self, paths: &[String], settings: &EncodeSettings, also_taken: &[String]) -> Result<Joined> {
        let tools = self.tools()?;
        let Some((first_path, rest_paths)) = paths.split_first().filter(|(_, rest)| !rest.is_empty()) else {
            return Err(AppError::msg("Pick at least two videos to join."));
        };
        let first = self.probes.get(tools, first_path).await?;
        let mut rest = Vec::new();
        for path in rest_paths {
            rest.push(self.probes.get(tools, path).await?);
        }
        let mut naming = self.settings.read().clone();
        naming.output_suffix = "_joined".into();
        let output = output_path_for(first_path, settings.container, &naming, &self.taken(also_taken));
        let mut spec = spec_for(&first, settings, output);
        spec.extra_inputs = rest_paths.to_vec();
        spec.audio_tracks.truncate(1);
        spec.subtitle_tracks.clear();
        spec.settings.subtitles = SubtitleDefault::None;
        // Fail now, with a clear reason, rather than when the queue reaches it.
        plan(&spec, &first, &PlanOptions { joined: rest.clone(), ..PlanOptions::default() })?;
        Ok(Joined { spec, media: joined_media(&first, &rest) })
    }

    /// Describe an existing join (its total length and size).
    pub async fn join_info(&self, spec: &JobSpec) -> Result<MediaInfo> {
        let tools = self.tools()?;
        let first = self.probes.get(tools, &spec.input).await?;
        let rest = probe_joined(tools, &self.probes, spec).await?;
        Ok(joined_media(&first, &rest))
    }

    pub async fn analyze_source(&self, path: &str, control: &JobControl) -> Result<SourceAnalysis> {
        let tools = self.tools()?;
        let media = self.probes.get(tools, path).await?;
        analysis::analyze_source(tools, &media, Some(control)).await
    }

    pub async fn estimate(&self, spec: &JobSpec, control: &JobControl, on_progress: impl FnMut(f64, &str)) -> Result<Estimate> {
        let tools = self.tools()?;
        let media = self.probes.get(tools, &spec.input).await?;
        let hw_decode = self.settings.read().hardware_decode;
        analysis::estimate(tools, spec, &media, &self.temp_dir, hw_decode, Some(control), on_progress).await
    }

    pub async fn render_preview(
        &self,
        spec: &JobSpec,
        at: f64,
        length: f64,
        control: &JobControl,
        on_progress: impl FnMut(f64, &str),
    ) -> Result<PreviewPair> {
        let tools = self.tools()?;
        let media = self.probes.get(tools, &spec.input).await?;
        let hw_decode = self.settings.read().hardware_decode;
        analysis::render_preview(tools, spec, &media, at, length, &self.temp_dir, hw_decode, Some(control), on_progress).await
    }

    /// Render one frame (crop, scale and filters applied) and return its path.
    pub async fn render_frame(&self, spec: &JobSpec, at: f64, max_width: u32) -> Result<PathBuf> {
        let tools = self.tools()?;
        let media = self.probes.get(tools, &spec.input).await?;
        let out = self.temp_dir.join(format!("mvs_frame_{}.jpg", uuid::Uuid::new_v4().simple()));
        analysis::render_frame(tools, spec, &media, at, max_width, &out).await?;
        // Keep the temp folder from growing without limit.
        let stale: Vec<PathBuf> = {
            let mut frames = self.frames.lock();
            frames.push_back(out.clone());
            let extra = frames.len().saturating_sub(60);
            frames.drain(..extra).collect()
        };
        for path in stale {
            let _ = std::fs::remove_file(path);
        }
        Ok(out)
    }

    /// One frame out of a short clip, as a JPEG next to the other temp files.
    pub async fn clip_frame(&self, clip: &str, at: f64) -> Result<PathBuf> {
        let tools = self.tools()?;
        let out = self.temp_dir.join(format!("mvs_still_{}.jpg", uuid::Uuid::new_v4().simple()));
        let args: Vec<String> = [
            "-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-ss", &format!("{at:.3}"), "-i", clip, "-frames:v", "1", "-q:v", "2",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(out.to_string_lossy().into_owned()))
        .collect();
        let done = crate::ffmpeg::runner::capture(&tools.ffmpeg, &args, None, None).await?;
        if !done.ok || !out.is_file() {
            return Err(AppError::msg("Could not read a frame of the preview."));
        }
        Ok(out)
    }

    // ───────────────────────────── Pictures ─────────────────────────────

    pub async fn image_probe(&self, path: &str) -> Result<ImageInfo> {
        probe_image(self.tools()?, path).await
    }

    /// A copy of a picture no bigger than `max_side` in either direction, as a
    /// PNG the interface can always open (whatever the original's format) and
    /// that keeps see-through parts.
    pub async fn image_preview(&self, path: &str, max_side: u32) -> Result<PathBuf> {
        let tools = self.tools()?;
        let out = self.temp_dir.join(format!("mvs_pic_{}.png", uuid::Uuid::new_v4().simple()));
        let scale = format!("scale='min(iw,{max_side})':'min(ih,{max_side})':force_original_aspect_ratio=decrease");
        let args: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", &scale, "-compression_level", "1"]
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(out.to_string_lossy().into_owned()))
            .collect();
        let done = crate::ffmpeg::runner::capture(&tools.ffmpeg, &args, None, None).await?;
        if !done.ok || !out.is_file() {
            return Err(AppError::msg("This picture could not be shown."));
        }
        Ok(out)
    }

    // ───────────────────────────── Events ─────────────────────────────

    pub fn emit<T: Serialize>(&self, event: &str, payload: &T) {
        emit(&*self.sink, event, payload);
    }

    /// Stop every encoder (the app is closing).
    pub fn shutdown(&self) {
        self.queue.shutdown();
        self.images.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_folders_and_filters_by_kind() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("trip");
        std::fs::create_dir_all(&sub).unwrap();
        for name in ["a.mp4", "b.MKV", "notes.txt", "trip/c.mov", "trip/pic.jpg"] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let root = dir.path().to_string_lossy().into_owned();
        let videos = expand_paths(&[root.clone(), dir.path().join("a.mp4").to_string_lossy().into_owned()], VIDEO_EXTENSIONS);
        let names: Vec<String> = videos.iter().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["a.mp4", "b.MKV", "c.mov"], "sorted, recursive, no duplicates, extension case ignored");
        let images = expand_paths(&[root], IMAGE_EXTENSIONS);
        assert_eq!(images.len(), 1);
    }

    #[test]
    fn image_outputs_never_collide() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("photo.png");
        std::fs::write(&input, b"x").unwrap();
        let input = input.to_string_lossy().into_owned();

        let first = image_output_for(&input, ImageFormat::Webp, "_small", None, &[]);
        assert!(first.ends_with("photo_small.webp"));
        std::fs::write(&first, b"x").unwrap();
        assert!(image_output_for(&input, ImageFormat::Webp, "_small", None, &[]).ends_with("photo_small (2).webp"));
        // Same name and format as the source, no suffix: must not be the source.
        let same = image_output_for(&input, ImageFormat::Png, "", None, &[]);
        assert_ne!(same.to_lowercase(), input.to_lowercase());
        // Claimed by another job in the same batch.
        let taken = vec![image_output_for(&input, ImageFormat::Jpg, "_small", None, &[])];
        assert!(image_output_for(&input, ImageFormat::Jpg, "_small", None, &taken).ends_with("photo_small (2).jpg"));
        // A chosen folder.
        let out = dir.path().join("out");
        let placed = image_output_for(&input, ImageFormat::Jpg, "_small", Some(&out.to_string_lossy()), &[]);
        assert!(Path::new(&placed).starts_with(&out));
    }
}
