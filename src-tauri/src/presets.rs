//! Built-in and user presets, plus turning a preset into a job for one file.

use crate::error::{AppError, Result};
use crate::model::*;
use crate::util::{load_json, save_json};
use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

fn video(encoder: VideoEncoder, rate: RateControl, speed: Speed) -> VideoSettings {
    VideoSettings {
        encoder,
        rate,
        two_pass: false,
        speed,
        bit_depth: BitDepth::Auto,
        fps: Fps::Source,
        resolution: Resolution::Source,
        crop: CropMode::None,
        hdr: HdrMode::Keep,
        film_grain: 0,
    }
}

fn settings(container: Container, video: VideoSettings, audio: AudioDefaults) -> EncodeSettings {
    EncodeSettings {
        container,
        video,
        audio,
        subtitles: SubtitleDefault::CopyAll,
        filters: Filters::default(),
        keep_chapters: true,
        keep_metadata: true,
    }
}

const AAC_160: AudioDefaults = AudioDefaults { codec: AudioCodec::Aac, bitrate_kbps: 160, mixdown: Mixdown::Source };
const AAC_128: AudioDefaults = AudioDefaults { codec: AudioCodec::Aac, bitrate_kbps: 128, mixdown: Mixdown::Stereo };
const AAC_96: AudioDefaults = AudioDefaults { codec: AudioCodec::Aac, bitrate_kbps: 96, mixdown: Mixdown::Stereo };
const COPY_AUDIO: AudioDefaults = AudioDefaults { codec: AudioCodec::Copy, bitrate_kbps: 160, mixdown: Mixdown::Source };

fn q(value: u32) -> RateControl {
    RateControl::Quality { value }
}

fn preset(id: &str, name: &str, description: &str, settings: EncodeSettings) -> Preset {
    Preset {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        builtin: true,
        settings,
    }
}

/// The presets that ship with the app.
///
/// The first six carry over the quality levels of the old Max / Balanced / Fast
/// presets (SVT-AV1 CRF 30/40/50 and HEVC-NVENC CQ 26/34/42).
pub fn builtin_presets() -> Vec<Preset> {
    use VideoEncoder::*;
    let mut list = vec![
        preset(
            "balanced",
            "Balanced · AV1",
            "Big savings with good quality. The everyday choice; works on any PC.",
            settings(Container::Mp4, video(SvtAv1, q(40), Speed::Medium), AAC_160),
        ),
        preset(
            "max",
            "Max quality · AV1",
            "Best-looking AV1 result. Slower to encode.",
            settings(Container::Mp4, video(SvtAv1, q(30), Speed::Slow), AAC_160),
        ),
        preset(
            "fast",
            "Smallest · AV1",
            "Smallest files and the quickest AV1 encode; visible quality loss on detailed footage.",
            settings(Container::Mp4, video(SvtAv1, q(50), Speed::Fast), AAC_128),
        ),
        preset(
            "gpu-balanced",
            "GPU Balanced · HEVC",
            "Very fast encode on an NVIDIA graphics card with solid quality.",
            settings(Container::Mp4, video(HevcNvenc, q(34), Speed::Medium), AAC_160),
        ),
        preset(
            "gpu-max",
            "GPU Max quality · HEVC",
            "Highest quality the NVIDIA encoder offers; files are larger than AV1.",
            settings(Container::Mp4, video(HevcNvenc, q(26), Speed::Slow), AAC_160),
        ),
        preset(
            "gpu-fast",
            "GPU Smallest · HEVC",
            "Fastest possible turnaround on an NVIDIA graphics card.",
            settings(Container::Mp4, video(HevcNvenc, q(42), Speed::Medium), AAC_128),
        ),
        preset(
            "compatible",
            "Plays everywhere · H.264",
            "H.264 + AAC in MP4. Larger files, but every phone, TV and browser plays it.",
            settings(Container::Mp4, video(X264, q(23), Speed::Medium), AAC_160),
        ),
        preset(
            "hevc",
            "Efficient · HEVC",
            "x265 software encode: smaller than H.264 and plays on most modern devices.",
            settings(Container::Mp4, video(X265, q(26), Speed::Medium), AAC_160),
        ),
    ];

    // Fit under a size limit (chat apps, email).
    for (id, name, mb, height, audio) in [
        ("fit-10mb", "Fit in 10 MB", 10.0, 720, AAC_96),
        ("fit-25mb", "Fit in 25 MB", 25.0, 720, AAC_96),
        ("fit-100mb", "Fit in 100 MB", 100.0, 1080, AAC_128),
    ] {
        let mut v = video(X264, RateControl::TargetSize { mb }, Speed::Slow);
        v.two_pass = true;
        v.resolution = Resolution::Height { value: height };
        let mut s = settings(Container::Mp4, v, audio);
        s.subtitles = SubtitleDefault::None;
        s.keep_chapters = false;
        list.push(preset(
            id,
            name,
            &format!("Two-pass H.264 sized to land just under {mb:.0} MB, scaled to {height}p at most."),
            s,
        ));
    }

    let mut web = settings(Container::Mp4, video(X264, q(24), Speed::Fast), AAC_128);
    web.video.resolution = Resolution::Height { value: 720 };
    web.subtitles = SubtitleDefault::None;
    list.push(preset("web-720p", "Web 720p · H.264", "Quick 720p H.264 for uploading and sharing.", web));

    let mut archive = settings(Container::Mkv, video(X265, q(18), Speed::Slow), COPY_AUDIO);
    archive.video.bit_depth = BitDepth::Ten;
    list.push(preset(
        "archive",
        "Archive · near-lossless HEVC",
        "Visually lossless 10-bit HEVC in MKV with the original audio and every subtitle kept.",
        archive,
    ));

    list
}

/// User presets on disk, plus the built-ins.
pub struct PresetStore {
    path: Option<PathBuf>,
    user: Mutex<Vec<Preset>>,
}

impl PresetStore {
    pub fn new(path: Option<PathBuf>) -> Self {
        let user = path
            .as_deref()
            .map(load_json::<Vec<Preset>>)
            .unwrap_or_default()
            .into_iter()
            .map(|mut p| {
                p.builtin = false;
                p
            })
            .collect();
        PresetStore { path, user: Mutex::new(user) }
    }

    fn persist(&self, user: &[Preset]) -> Result<()> {
        match &self.path {
            Some(path) => save_json(path, &user),
            None => Ok(()),
        }
    }

    /// Built-ins first, then user presets in the order they were saved.
    pub fn list(&self) -> Vec<Preset> {
        let mut all = builtin_presets();
        all.extend(self.user.lock().iter().cloned());
        all
    }

    pub fn get(&self, id: &str) -> Option<Preset> {
        self.list().into_iter().find(|p| p.id == id)
    }

    /// Create or update a user preset. Saving over a built-in makes a copy.
    pub fn save(&self, mut preset: Preset) -> Result<Preset> {
        let name = preset.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::msg("A preset needs a name."));
        }
        preset.name = name;
        preset.builtin = false;
        let is_builtin_id = builtin_presets().iter().any(|p| p.id == preset.id);
        if preset.id.is_empty() || is_builtin_id {
            preset.id = format!("user-{}", uuid::Uuid::new_v4().simple());
        }
        let mut user = self.user.lock();
        match user.iter_mut().find(|p| p.id == preset.id) {
            Some(existing) => *existing = preset.clone(),
            None => user.push(preset.clone()),
        }
        self.persist(&user)?;
        Ok(preset)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        if builtin_presets().iter().any(|p| p.id == id) {
            return Err(AppError::msg("Built-in presets cannot be deleted."));
        }
        let mut user = self.user.lock();
        let before = user.len();
        user.retain(|p| p.id != id);
        if user.len() == before {
            return Err(AppError::msg("That preset no longer exists."));
        }
        self.persist(&user)
    }

    /// Write the chosen presets to a file others can import.
    pub fn export(&self, ids: &[String], file: &Path) -> Result<u32> {
        let chosen: Vec<Preset> = self.list().into_iter().filter(|p| ids.contains(&p.id)).collect();
        if chosen.is_empty() {
            return Err(AppError::msg("No presets selected to export."));
        }
        save_json(file, &chosen)?;
        Ok(chosen.len() as u32)
    }

    /// Read presets from a file. Accepts a single preset or a list; every
    /// import gets a fresh id so nothing is overwritten.
    pub fn import(&self, file: &Path) -> Result<Vec<Preset>> {
        let text = std::fs::read_to_string(file)?;
        let incoming: Vec<Preset> = match serde_json::from_str::<Vec<Preset>>(&text) {
            Ok(list) => list,
            Err(_) => vec![serde_json::from_str::<Preset>(&text)
                .map_err(|_| AppError::msg("This file does not contain Make Video Small presets."))?],
        };
        let mut added = Vec::new();
        for mut p in incoming {
            p.id = String::new();
            added.push(self.save(p)?);
        }
        Ok(added)
    }
}

// ───────────────────────────── Preset → job ─────────────────────────────

/// Pick an output path that does not collide with the source, an existing
/// file, or another queued job.
pub fn output_path_for(input: &str, container: Container, app: &AppSettings, taken: &HashSet<String>) -> String {
    let input_path = Path::new(input);
    let dir = app
        .output_dir
        .as_deref()
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| input_path.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let stem = input_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "video".into());
    let ext = container.ext();

    let key = |p: &Path| p.to_string_lossy().to_lowercase();
    let input_key = key(input_path);
    for n in 1..10_000 {
        let name = if n == 1 {
            format!("{stem}{}.{ext}", app.output_suffix)
        } else {
            format!("{stem}{} ({n}).{ext}", app.output_suffix)
        };
        let candidate = dir.join(name);
        let k = key(&candidate);
        if k != input_key && !candidate.exists() && !taken.contains(&k) {
            return candidate.to_string_lossy().into_owned();
        }
    }
    dir.join(format!("{stem}{}-{}.{ext}", app.output_suffix, uuid::Uuid::new_v4().simple()))
        .to_string_lossy()
        .into_owned()
}

/// Lower-cased output paths already claimed, for collision checks.
pub fn taken_outputs<'a>(specs: impl Iterator<Item = &'a JobSpec>) -> HashSet<String> {
    specs.map(|s| s.output.to_lowercase()).collect()
}

/// Apply preset settings to one source file: every audio track is kept with
/// the preset's audio settings, subtitles follow the preset's rule.
pub fn spec_for(media: &MediaInfo, settings: &EncodeSettings, output: String) -> JobSpec {
    let audio_tracks = media
        .audio
        .iter()
        .map(|a| AudioTrack {
            order: a.order,
            codec: settings.audio.codec,
            bitrate_kbps: settings.audio.bitrate_kbps,
            mixdown: settings.audio.mixdown,
        })
        .collect();

    let subtitle_tracks = match settings.subtitles {
        SubtitleDefault::None => Vec::new(),
        SubtitleDefault::CopyAll => media
            .subtitles
            .iter()
            .map(|s| SubtitleTrack { order: s.order, mode: SubtitleMode::Copy, default: s.default })
            .collect(),
        SubtitleDefault::BurnFirst => media
            .subtitles
            .iter()
            .find(|s| s.default)
            .or_else(|| media.subtitles.first())
            .map(|s| vec![SubtitleTrack { order: s.order, mode: SubtitleMode::Burn, default: false }])
            .unwrap_or_default(),
    };

    JobSpec {
        input: media.path.clone(),
        output,
        settings: settings.clone(),
        audio_tracks,
        subtitle_tracks,
        trim: None,
        auto_crop: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::command::{plan, PlanOptions};

    fn media() -> MediaInfo {
        MediaInfo {
            path: "C:/in/clip.mkv".into(),
            file_name: "clip.mkv".into(),
            size_bytes: 5e8,
            duration: 120.0,
            bitrate: 3.3e7,
            format_name: "matroska".into(),
            video: Some(VideoStream {
                index: 0, codec: "h264".into(), width: 1920, height: 1080, fps: 30.0, pix_fmt: "yuv420p".into(),
                bit_depth: 8, is_hdr: false, color_transfer: None, color_primaries: None, color_space: None,
                bitrate: 3.2e7, frames: 3600.0, rotation: 0, interlaced: false,
            }),
            audio: vec![
                AudioStream { index: 1, order: 0, codec: "aac".into(), channels: 2, channel_layout: "stereo".into(), sample_rate: 48000, bitrate: 128000.0, language: None, title: None, default: true },
                AudioStream { index: 2, order: 1, codec: "ac3".into(), channels: 6, channel_layout: "5.1".into(), sample_rate: 48000, bitrate: 384000.0, language: None, title: None, default: false },
            ],
            subtitles: vec![
                SubtitleStream { index: 3, order: 0, codec: "subrip".into(), language: None, title: None, default: false, forced: false, is_text: true },
                SubtitleStream { index: 4, order: 1, codec: "ass".into(), language: None, title: None, default: true, forced: false, is_text: true },
            ],
            chapters: 0,
        }
    }

    #[test]
    fn builtins_are_unique_and_plan_cleanly() {
        let presets = builtin_presets();
        let ids: HashSet<_> = presets.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids.len(), presets.len(), "duplicate preset ids");
        assert!(ids.contains("balanced"), "the default preset must exist");
        let m = media();
        for p in &presets {
            assert!(p.builtin);
            let spec = spec_for(&m, &p.settings, format!("C:/out/x.{}", p.settings.container.ext()));
            let plan = plan(&spec, &m, &PlanOptions::default())
                .unwrap_or_else(|e| panic!("preset {} does not plan: {e}", p.id));
            assert!(!plan.passes.is_empty());
        }
    }

    #[test]
    fn spec_for_applies_track_rules() {
        let m = media();
        let mut s = builtin_presets().remove(0).settings;
        let spec = spec_for(&m, &s, "o.mp4".into());
        assert_eq!(spec.audio_tracks.len(), 2);
        assert_eq!(spec.subtitle_tracks.len(), 2);
        assert!(spec.subtitle_tracks.iter().all(|t| t.mode == SubtitleMode::Copy));

        s.subtitles = SubtitleDefault::BurnFirst;
        let spec = spec_for(&m, &s, "o.mp4".into());
        // Burns the track flagged as default, not simply the first.
        assert_eq!(spec.subtitle_tracks, vec![SubtitleTrack { order: 1, mode: SubtitleMode::Burn, default: false }]);

        s.subtitles = SubtitleDefault::None;
        assert!(spec_for(&m, &s, "o.mp4".into()).subtitle_tracks.is_empty());
    }

    #[test]
    fn output_paths_avoid_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("clip.mp4");
        std::fs::write(&input, b"x").unwrap();
        let input = input.to_string_lossy().into_owned();
        let mut app = AppSettings::default();

        let first = output_path_for(&input, Container::Mp4, &app, &HashSet::new());
        assert!(first.ends_with("clip_small.mp4"));

        // Existing file → numbered.
        std::fs::write(&first, b"x").unwrap();
        let second = output_path_for(&input, Container::Mp4, &app, &HashSet::new());
        assert!(second.ends_with("clip_small (2).mp4"), "{second}");

        // Claimed by another queued job → next number.
        let taken: HashSet<String> = [second.to_lowercase()].into();
        assert!(output_path_for(&input, Container::Mp4, &app, &taken).ends_with("clip_small (3).mp4"));

        // An empty suffix must never produce the source path itself.
        app.output_suffix = String::new();
        let same_ext = output_path_for(&input, Container::Mp4, &app, &HashSet::new());
        assert_ne!(same_ext.to_lowercase(), input.to_lowercase());
        assert!(same_ext.ends_with("clip (2).mp4"), "{same_ext}");

        // Custom folder.
        let out = dir.path().join("out");
        app.output_dir = Some(out.to_string_lossy().into_owned());
        assert!(Path::new(&output_path_for(&input, Container::Mkv, &app, &HashSet::new())).starts_with(&out));
    }

    #[test]
    fn user_presets_save_delete_import_export() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("presets.json");
        let store = PresetStore::new(Some(file.clone()));
        let builtin_count = builtin_presets().len();
        assert_eq!(store.list().len(), builtin_count);

        // Saving over a built-in creates a copy with a new id.
        let mut mine = store.get("balanced").unwrap();
        mine.name = "  My AV1  ".into();
        let saved = store.save(mine).unwrap();
        assert_ne!(saved.id, "balanced");
        assert_eq!(saved.name, "My AV1");
        assert!(!saved.builtin);
        assert_eq!(store.list().len(), builtin_count + 1);

        // Updating keeps the id.
        let mut edit = saved.clone();
        edit.description = "changed".into();
        assert_eq!(store.save(edit).unwrap().id, saved.id);
        assert_eq!(store.list().len(), builtin_count + 1);

        // Persisted across restarts.
        let reopened = PresetStore::new(Some(file));
        assert_eq!(reopened.get(&saved.id).unwrap().description, "changed");

        // Export → import yields a new, separate preset.
        let exported = dir.path().join("share.json");
        assert_eq!(reopened.export(&[saved.id.clone(), "max".into()], &exported).unwrap(), 2);
        let imported = reopened.import(&exported).unwrap();
        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|p| !p.builtin && p.id != saved.id && p.id != "max"));

        assert!(reopened.delete("balanced").is_err());
        reopened.delete(&saved.id).unwrap();
        assert!(reopened.get(&saved.id).is_none());
        assert!(reopened.save(Preset { name: " ".into(), ..imported[0].clone() }).is_err());

        std::fs::write(&exported, "nonsense").unwrap();
        assert!(reopened.import(&exported).is_err());
    }
}
