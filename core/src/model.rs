//! Data model shared between the Rust core and the UI.
//!
//! These are plain data: the engine fills them in and the interface shows them.

use serde::{Deserialize, Serialize};

// ───────────────────────────── Source media ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub file_name: String,
    pub size_bytes: f64,
    /// Seconds.
    pub duration: f64,
    /// Overall bitrate in bits per second.
    pub bitrate: f64,
    pub format_name: String,
    pub video: Option<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub subtitles: Vec<SubtitleStream>,
    pub chapters: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub index: u32,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub pix_fmt: String,
    pub bit_depth: u32,
    pub is_hdr: bool,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub color_space: Option<String>,
    pub bitrate: f64,
    pub frames: f64,
    pub rotation: i32,
    pub interlaced: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    /// Absolute stream index in the file.
    pub index: u32,
    /// Position among the audio streams (what `0:a:N` refers to).
    pub order: u32,
    pub codec: String,
    pub channels: u32,
    pub channel_layout: String,
    pub sample_rate: u32,
    pub bitrate: f64,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStream {
    pub index: u32,
    /// Position among the subtitle streams (what `0:s:N` refers to).
    pub order: u32,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub default: bool,
    pub forced: bool,
    /// Text subtitles can be converted between formats; bitmap ones cannot.
    pub is_text: bool,
}

// ───────────────────────────── Encode settings ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Container {
    Mp4,
    Mkv,
    Webm,
    Mov,
}

impl Container {
    pub fn ext(self) -> &'static str {
        match self {
            Container::Mp4 => "mp4",
            Container::Mkv => "mkv",
            Container::Webm => "webm",
            Container::Mov => "mov",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum VideoEncoder {
    X264,
    X265,
    SvtAv1,
    H264Nvenc,
    HevcNvenc,
    Av1Nvenc,
    H264Qsv,
    HevcQsv,
    Av1Qsv,
    H264Amf,
    HevcAmf,
    Av1Amf,
    Copy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
    Av1,
    Copy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vendor {
    Software,
    Nvidia,
    Intel,
    Amd,
}

impl VideoEncoder {
    pub const ALL: [VideoEncoder; 13] = [
        VideoEncoder::X264,
        VideoEncoder::X265,
        VideoEncoder::SvtAv1,
        VideoEncoder::H264Nvenc,
        VideoEncoder::HevcNvenc,
        VideoEncoder::Av1Nvenc,
        VideoEncoder::H264Qsv,
        VideoEncoder::HevcQsv,
        VideoEncoder::Av1Qsv,
        VideoEncoder::H264Amf,
        VideoEncoder::HevcAmf,
        VideoEncoder::Av1Amf,
        VideoEncoder::Copy,
    ];

    /// Name ffmpeg knows the encoder by.
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            VideoEncoder::X264 => "libx264",
            VideoEncoder::X265 => "libx265",
            VideoEncoder::SvtAv1 => "libsvtav1",
            VideoEncoder::H264Nvenc => "h264_nvenc",
            VideoEncoder::HevcNvenc => "hevc_nvenc",
            VideoEncoder::Av1Nvenc => "av1_nvenc",
            VideoEncoder::H264Qsv => "h264_qsv",
            VideoEncoder::HevcQsv => "hevc_qsv",
            VideoEncoder::Av1Qsv => "av1_qsv",
            VideoEncoder::H264Amf => "h264_amf",
            VideoEncoder::HevcAmf => "hevc_amf",
            VideoEncoder::Av1Amf => "av1_amf",
            VideoEncoder::Copy => "copy",
        }
    }

    pub fn codec(self) -> Codec {
        use VideoEncoder::*;
        match self {
            X264 | H264Nvenc | H264Qsv | H264Amf => Codec::H264,
            X265 | HevcNvenc | HevcQsv | HevcAmf => Codec::Hevc,
            SvtAv1 | Av1Nvenc | Av1Qsv | Av1Amf => Codec::Av1,
            Copy => Codec::Copy,
        }
    }

    pub fn vendor(self) -> Vendor {
        use VideoEncoder::*;
        match self {
            X264 | X265 | SvtAv1 | Copy => Vendor::Software,
            H264Nvenc | HevcNvenc | Av1Nvenc => Vendor::Nvidia,
            H264Qsv | HevcQsv | Av1Qsv => Vendor::Intel,
            H264Amf | HevcAmf | Av1Amf => Vendor::Amd,
        }
    }

    pub fn is_hardware(self) -> bool {
        self.vendor() != Vendor::Software
    }

    pub fn supports_ten_bit(self) -> bool {
        use VideoEncoder::*;
        matches!(self, X264 | X265 | SvtAv1 | HevcNvenc | Av1Nvenc | HevcQsv | Av1Qsv | HevcAmf | Av1Amf)
    }

    /// True 2-pass (a separate analysis pass) is only wired up for x264/x265.
    pub fn supports_two_pass(self) -> bool {
        matches!(self, VideoEncoder::X264 | VideoEncoder::X265)
    }

    /// (min, max, default) of the encoder's native quality scale. Lower = better.
    pub fn quality_range(self) -> (u32, u32, u32) {
        use VideoEncoder::*;
        match self {
            X264 => (0, 51, 23),
            X265 => (0, 51, 26),
            SvtAv1 => (1, 63, 32),
            H264Nvenc => (1, 51, 25),
            HevcNvenc => (1, 51, 28),
            Av1Nvenc => (1, 63, 34),
            H264Qsv => (1, 51, 24),
            HevcQsv => (1, 51, 26),
            Av1Qsv => (1, 51, 28),
            H264Amf => (0, 51, 24),
            HevcAmf => (0, 51, 26),
            Av1Amf => (0, 51, 30),
            Copy => (0, 0, 0),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum RateControl {
    /// Constant quality on the encoder's native scale (CRF / CQ / QP).
    Quality { value: u32 },
    /// Average video bitrate.
    Bitrate { kbps: u32 },
    /// Hit a final file size (video + audio) in megabytes.
    TargetSize { mb: f64 },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Speed {
    Slowest,
    Slow,
    Medium,
    Fast,
    Fastest,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BitDepth {
    Auto,
    Eight,
    Ten,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Fps {
    Source,
    Fixed { value: f64 },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Resolution {
    Source,
    /// Scale down to this height, keeping the aspect ratio. Never upscales.
    Height { value: u32 },
    Custom { w: u32, h: u32 },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum CropMode {
    None,
    /// Detect and remove black bars.
    Auto,
    Manual { w: u32, h: u32, x: u32, y: u32 },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub w: u32,
    pub h: u32,
    pub x: u32,
    pub y: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HdrMode {
    /// Keep HDR colour information when the source has it.
    Keep,
    /// Tone-map HDR sources to standard dynamic range.
    Tonemap,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub encoder: VideoEncoder,
    pub rate: RateControl,
    /// Use a separate analysis pass (bitrate / target-size modes, x264 & x265).
    pub two_pass: bool,
    pub speed: Speed,
    pub bit_depth: BitDepth,
    pub fps: Fps,
    pub resolution: Resolution,
    pub crop: CropMode,
    pub hdr: HdrMode,
    /// SVT-AV1 film grain synthesis, 0 (off) – 50.
    pub film_grain: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioCodec {
    Copy,
    Aac,
    Opus,
    Ac3,
    Flac,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mixdown {
    Source,
    Mono,
    Stereo,
    Surround51,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDefaults {
    pub codec: AudioCodec,
    pub bitrate_kbps: u32,
    pub mixdown: Mixdown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleDefault {
    /// Drop all subtitles.
    None,
    /// Keep every subtitle track as a selectable track.
    CopyAll,
    /// Burn the first (or default) track into the picture.
    BurnFirst,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Strength {
    Off,
    Light,
    Medium,
    Strong,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Deinterlace {
    Off,
    Yadif,
    Bwdif,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Rotate {
    None,
    Cw90,
    Cw180,
    Cw270,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    pub denoise: Strength,
    pub deinterlace: Deinterlace,
    pub rotate: Rotate,
    pub flip_h: bool,
    pub flip_v: bool,
    pub sharpen: Strength,
}

impl Default for Filters {
    fn default() -> Self {
        Filters {
            denoise: Strength::Off,
            deinterlace: Deinterlace::Off,
            rotate: Rotate::None,
            flip_h: false,
            flip_v: false,
            sharpen: Strength::Off,
        }
    }
}

/// Everything a preset stores: settings that make sense for any file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncodeSettings {
    pub container: Container,
    pub video: VideoSettings,
    pub audio: AudioDefaults,
    pub subtitles: SubtitleDefault,
    pub filters: Filters,
    pub keep_chapters: bool,
    pub keep_metadata: bool,
}

// ───────────────────────────── Per-file job spec ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// Which source audio stream (`0:a:order`).
    pub order: u32,
    pub codec: AudioCodec,
    pub bitrate_kbps: u32,
    pub mixdown: Mixdown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleMode {
    Copy,
    Burn,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    /// Which source subtitle stream (`0:s:order`).
    pub order: u32,
    pub mode: SubtitleMode,
    pub default: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trim {
    pub start: f64,
    pub end: f64,
}

/// One fully specified encode: a source file, where it goes, and how.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub input: String,
    pub output: String,
    pub settings: EncodeSettings,
    /// Audio tracks to keep, in output order.
    pub audio_tracks: Vec<AudioTrack>,
    /// Subtitle tracks to keep. At most one may be `Burn`.
    pub subtitle_tracks: Vec<SubtitleTrack>,
    pub trim: Option<Trim>,
    /// Result of black-bar detection, used when `video.crop` is `Auto`.
    pub auto_crop: Option<Crop>,
    /// More videos to join onto the end of `input`, in this order.
    #[serde(default)]
    pub extra_inputs: Vec<String>,
}

// ───────────────────────────── Presets ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub builtin: bool,
    pub settings: EncodeSettings,
}

// ───────────────────────────── Queue ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub file_name: String,
    pub size_bytes: f64,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub codec: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub spec: JobSpec,
    pub source: SourceSummary,
    pub status: JobStatus,
    /// 0 – 100.
    pub progress: f64,
    pub fps: f64,
    /// Encoding speed relative to real time (2.0 = twice as fast as playback).
    pub speed: f64,
    pub eta_secs: Option<f64>,
    /// Bytes written so far.
    pub out_bytes: f64,
    pub stage: String,
    pub error: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub added_at: f64,
    pub started_at: Option<f64>,
    pub finished_at: Option<f64>,
    pub final_bytes: Option<f64>,
    /// The ffmpeg command line, for the curious.
    pub command: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub jobs: Vec<Job>,
    /// The queue is working through jobs.
    pub running: bool,
    /// Active jobs are suspended.
    pub paused: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub id: String,
    pub progress: f64,
    pub fps: f64,
    pub speed: f64,
    pub eta_secs: Option<f64>,
    pub out_bytes: f64,
    pub stage: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobLogLine {
    pub id: String,
    pub line: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueFinished {
    pub done: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub source_bytes: f64,
    pub output_bytes: f64,
}

// ───────────────────────────── Capabilities ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub id: VideoEncoder,
    pub label: String,
    /// "h264" | "hevc" | "av1" | "copy"
    pub codec: String,
    pub hardware: bool,
    pub vendor: Option<String>,
    /// The encoder exists in ffmpeg *and* a real test encode succeeded.
    pub available: bool,
    pub reason: Option<String>,
    pub quality_min: u32,
    pub quality_max: u32,
    pub quality_default: u32,
    pub quality_label: String,
    pub supports_ten_bit: bool,
    pub supports_two_pass: bool,
    pub supports_film_grain: bool,
    pub containers: Vec<Container>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub ffmpeg_version: String,
    pub encoders: Vec<EncoderInfo>,
    pub upscaler_available: bool,
    pub background_removal_available: bool,
}

// ───────────────────────────── Analysis ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceAnalysis {
    pub crop: Option<Crop>,
    /// 0 – 50, suggested SVT-AV1 film-grain level.
    pub grain_level: u32,
    pub noise_profile: String,
    pub interlaced: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub size_bytes: f64,
    /// Percent smaller than the source (can be negative).
    pub savings_percent: f64,
    pub encode_secs: f64,
    pub video_kbps: f64,
    /// True when the numbers come from real sample encodes rather than maths.
    pub sampled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPair {
    /// Reference clip (geometry filters applied, near-lossless).
    pub original: String,
    /// The same clip encoded with the job's settings.
    pub encoded: String,
    pub start: f64,
    pub duration: f64,
    pub encoded_bytes: f64,
    pub estimate: Estimate,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisProgress {
    pub token: String,
    pub progress: f64,
    pub stage: String,
}

/// One of the three choices offered in the simple view.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EasyOption {
    /// "best" | "balanced" | "smallest"
    pub id: String,
    pub title: String,
    pub hint: String,
    pub settings: EncodeSettings,
}

/// A simple choice after it has been tried on the video.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EasyChoice {
    pub id: String,
    /// The job this choice would queue (black bars already cropped).
    pub spec: JobSpec,
    pub estimate: Estimate,
    /// A short clip encoded with this choice, playable in the app.
    pub preview: String,
    /// 0 – 1: how close the clip looks to the original (VMAF ÷ 100).
    pub similarity: f64,
    /// The same thing in words, e.g. "Looks the same as the original".
    pub look: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EasyAnalysis {
    pub analysis: SourceAnalysis,
    /// The matching clip from the source, for side-by-side comparison.
    pub original: String,
    pub choices: Vec<EasyChoice>,
    /// Id of the suggested choice.
    pub recommended: String,
    /// Why, in one sentence.
    pub advice: String,
}

/// A set of videos prepared for joining.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Joined {
    pub spec: JobSpec,
    /// Describes the joined result: total length and size, shape of the first clip.
    pub media: MediaInfo,
}

// ───────────────────────────── System ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_model: String,
    pub cpu_cores: u32,
    pub cpu_usage: f64,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub gpu_name: Option<String>,
    pub gpu_usage: Option<f64>,
    pub gpu_encoder_usage: Option<f64>,
    pub gpu_mem_used_gb: Option<f64>,
    pub gpu_mem_total_gb: Option<f64>,
    pub gpu_temp_c: Option<f64>,
}

// ───────────────────────────── App settings ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SystemImpact {
    /// Lowest priority: the PC stays fully usable.
    Stealth,
    Balanced,
    /// Above-normal priority: finish as fast as possible.
    Beast,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Write next to the source (`None`) or into this folder.
    pub output_dir: Option<String>,
    /// Appended to the source file name, e.g. `clip` + `_small`.
    pub output_suffix: String,
    pub system_impact: SystemImpact,
    /// How many encodes may run at once.
    pub parallel_jobs: u32,
    pub hardware_decode: bool,
    /// Move the source to the Recycle Bin after a successful encode.
    pub delete_original: bool,
    pub shutdown_on_finish: bool,
    pub play_sound_on_finish: bool,
    pub custom_sound_path: Option<String>,
    pub default_preset_id: String,
    /// Use the graphics card for the simple choices when it can encode video.
    pub prefer_gpu: bool,
    /// Show the detailed controls instead of the three simple choices.
    pub advanced_mode: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            output_dir: None,
            output_suffix: "_small".into(),
            system_impact: SystemImpact::Balanced,
            parallel_jobs: 1,
            hardware_decode: true,
            delete_original: false,
            shutdown_on_finish: false,
            play_sound_on_finish: false,
            custom_sound_path: None,
            default_preset_id: "balanced".into(),
            prefer_gpu: true,
            advanced_mode: false,
        }
    }
}

// ───────────────────────────── Images ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub path: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: f64,
    pub metadata: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    Webp,
    Avif,
    Jpg,
    Png,
}

impl ImageFormat {
    pub fn ext(self) -> &'static str {
        match self {
            ImageFormat::Webp => "webp",
            ImageFormat::Avif => "avif",
            ImageFormat::Jpg => "jpg",
            ImageFormat::Png => "png",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ImageAction {
    /// Re-encode at a quality of 1 – 100.
    Compress { quality: u32 },
    /// Search for the best quality that fits under this many kilobytes.
    Target { kb: u32 },
    /// 4× AI upscale with Real-ESRGAN. Output is always PNG.
    Upscale,
    /// Cut the subject out; the background becomes transparent. Output is always PNG.
    RemoveBackground,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageJob {
    pub id: String,
    pub input: String,
    pub output: String,
    pub action: ImageAction,
    pub format: ImageFormat,
    /// Keep only this part of the picture.
    #[serde(default)]
    pub crop: Option<Crop>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageEvent {
    pub id: String,
    /// "progress" | "done" | "error" | "warning"
    pub kind: String,
    pub progress: f64,
    pub message: String,
    pub output: Option<String>,
    pub original_bytes: f64,
    pub new_bytes: f64,
}
