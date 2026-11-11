//! `JobSpec` → ffmpeg arguments.
//!
//! This module is pure: no I/O, no process spawning. Everything the app knows
//! about how to drive ffmpeg lives here, which keeps it unit-testable.

use crate::error::{AppError, Result};
use crate::model::*;

/// Knobs that are not part of the job itself.
#[derive(Clone, Debug)]
pub struct PlanOptions {
    /// Allow GPU decoding when the whole pipeline can stay on the GPU.
    pub hw_decode: bool,
    /// File name (no directory) for two-pass statistics. ffmpeg is run with
    /// its working directory set to a temp folder, so a bare name is enough —
    /// and it keeps Windows drive colons out of `-x265-params`.
    pub pass_log: String,
    /// What ffprobe says about each of `JobSpec::extra_inputs`, in the same order.
    pub joined: Vec<MediaInfo>,
}

impl Default for PlanOptions {
    fn default() -> Self {
        PlanOptions {
            hw_decode: true,
            pass_log: "mvs_2pass".into(),
            joined: Vec::new(),
        }
    }
}

/// The ffmpeg invocations needed for one job.
#[derive(Clone, Debug)]
pub struct Plan {
    /// One argument list per pass (two for a real 2-pass encode).
    pub passes: Vec<Vec<String>>,
    /// Length of the output in seconds, used to turn ffmpeg's clock into a percentage.
    pub duration: f64,
    pub warnings: Vec<String>,
    /// GPU decoding was requested; if the encode fails early, retry without it.
    pub hwaccel: bool,
    /// Video bitrate in kbps for bitrate / target-size modes.
    pub video_kbps: Option<u32>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Rate {
    Quality(u32),
    Bitrate(u32),
}

/// Final picture geometry after crop, scale and rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub crop: Option<Crop>,
    pub scale: Option<(u32, u32)>,
    pub width: u32,
    pub height: u32,
}

fn even(n: u32) -> u32 {
    (n & !1).max(2)
}

/// Frame size as displayed, i.e. after ffmpeg applies rotation metadata.
pub fn display_size(v: &VideoStream) -> (u32, u32) {
    if v.rotation.rem_euclid(180) == 90 {
        (v.height, v.width)
    } else {
        (v.width, v.height)
    }
}

fn s(x: impl ToString) -> String {
    x.to_string()
}

fn push(args: &mut Vec<String>, items: &[&str]) {
    args.extend(items.iter().map(|i| i.to_string()));
}

/// Seconds with millisecond precision, without trailing noise.
fn secs(t: f64) -> String {
    let t = (t.max(0.0) * 1000.0).round() / 1000.0;
    format!("{t}")
}

// ───────────────────────────── Trim & duration ─────────────────────────────

/// A trim that actually removes something, clamped to the source length.
pub fn effective_trim(spec: &JobSpec, media: &MediaInfo) -> Option<Trim> {
    let t = spec.trim?;
    let dur = media.duration;
    let start = t.start.clamp(0.0, dur.max(0.0));
    let end = if t.end <= 0.0 { dur } else { t.end.clamp(start, dur.max(start)) };
    if end - start < 0.1 {
        return None;
    }
    if start < 0.05 && (dur - end) < 0.05 {
        return None;
    }
    Some(Trim { start, end })
}

pub fn output_duration(spec: &JobSpec, media: &MediaInfo) -> f64 {
    effective_trim(spec, media)
        .map(|t| t.end - t.start)
        .unwrap_or(media.duration)
}

// ───────────────────────────── Geometry ─────────────────────────────

pub fn geometry(spec: &JobSpec, media: &MediaInfo) -> Geometry {
    let Some(v) = media.video.as_ref() else {
        return Geometry { crop: None, scale: None, width: 0, height: 0 };
    };
    let (sw, sh) = display_size(v);
    let vs = &spec.settings.video;

    let wanted = match vs.crop {
        CropMode::None => None,
        CropMode::Auto => spec.auto_crop,
        CropMode::Manual { w, h, x, y } => Some(Crop { w, h, x, y }),
    };
    let crop = wanted.and_then(|c| {
        if c.x >= sw || c.y >= sh {
            return None;
        }
        let w = even(c.w.min(sw - c.x));
        let h = even(c.h.min(sh - c.y));
        if w < 16 || h < 16 || (w >= sw && h >= sh) {
            return None;
        }
        Some(Crop { w, h, x: c.x, y: c.y })
    });
    let (cw, ch) = crop.map(|c| (c.w, c.h)).unwrap_or((sw, sh));

    let mut scale = match vs.resolution {
        Resolution::Source => None,
        Resolution::Height { value } if value >= 16 && value < ch => {
            let h = even(value);
            let w = even(((cw as f64) * (h as f64) / (ch as f64)).round() as u32);
            Some((w, h))
        }
        Resolution::Height { .. } => None,
        Resolution::Custom { w, h } if w >= 16 && h >= 16 && (w, h) != (cw, ch) => {
            Some((even(w), even(h)))
        }
        Resolution::Custom { .. } => None,
    };
    // 4:2:0 video needs even dimensions.
    if scale.is_none() && (cw % 2 == 1 || ch % 2 == 1) {
        scale = Some((even(cw), even(ch)));
    }

    let (mut width, mut height) = scale.unwrap_or((cw, ch));
    if matches!(spec.settings.filters.rotate, Rotate::Cw90 | Rotate::Cw270) {
        std::mem::swap(&mut width, &mut height);
    }
    Geometry { crop, scale, width, height }
}

// ───────────────────────────── Filters ─────────────────────────────

/// Escape a path for use as the `subtitles` filter's file name.
///
/// Two parsers read it: the filter graph (where single quotes protect
/// everything) and the filter's own option parser (where `:` separates options
/// and `\` / `'` are special).
pub fn escape_filter_path(path: &str) -> String {
    let forward = path.replace('\\', "/");
    let mut out = String::with_capacity(forward.len() + 8);
    out.push('\'');
    for c in forward.chars() {
        match c {
            ':' => out.push_str("\\:"),
            // Option level needs \' ; the graph level needs the quote closed,
            // an escaped quote, and the quote reopened.
            '\'' => out.push_str("\\'\\''"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

fn fps_expr(f: f64) -> String {
    for (target, expr) in [
        (23.976, "24000/1001"),
        (29.97, "30000/1001"),
        (59.94, "60000/1001"),
        (119.88, "120000/1001"),
    ] {
        if (f - target).abs() < 0.01 {
            return expr.to_string();
        }
    }
    if (f - f.round()).abs() < 0.001 {
        format!("{}", f.round() as u32)
    } else {
        format!("{f:.3}")
    }
}

const TONEMAP: &str = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

fn is_tonemapping(spec: &JobSpec, media: &MediaInfo) -> bool {
    spec.settings.video.hdr == HdrMode::Tonemap
        && media.video.as_ref().map(|v| v.is_hdr).unwrap_or(false)
}

/// Which parts of the filter chain to include.
#[derive(Clone, Copy, Debug)]
pub struct ChainParts {
    /// Denoise and sharpen.
    pub cosmetic: bool,
    /// Burned-in subtitles.
    pub burn: bool,
    /// Frame-rate conversion.
    pub fps: bool,
}

impl ChainParts {
    pub const ALL: ChainParts = ChainParts { cosmetic: true, burn: true, fps: true };
    /// Geometry only: what a "before" reference clip should look like.
    pub const GEOMETRY: ChainParts = ChainParts { cosmetic: false, burn: false, fps: false };
}

#[derive(Clone, Debug, PartialEq)]
pub enum Graph {
    None,
    /// A plain `-vf` chain.
    Simple(String),
    /// A `-filter_complex` graph whose output pad is `[vout]`.
    Complex(String),
}

fn burn_track<'a>(spec: &JobSpec, media: &'a MediaInfo) -> Option<&'a SubtitleStream> {
    spec.subtitle_tracks
        .iter()
        .find(|t| t.mode == SubtitleMode::Burn)
        .and_then(|t| media.subtitles.get(t.order as usize))
}

pub fn build_graph(spec: &JobSpec, media: &MediaInfo, geo: &Geometry, parts: ChainParts) -> Graph {
    let f = &spec.settings.filters;
    let vs = &spec.settings.video;
    let mut chain: Vec<String> = Vec::new();

    match f.deinterlace {
        Deinterlace::Off => {}
        Deinterlace::Yadif => chain.push("yadif=0:-1:0".into()),
        Deinterlace::Bwdif => chain.push("bwdif=0:-1:0".into()),
    }
    if let Some(c) = geo.crop {
        chain.push(format!("crop={}:{}:{}:{}", c.w, c.h, c.x, c.y));
    }
    if let Some((w, h)) = geo.scale {
        chain.push(format!("scale={w}:{h}:flags=lanczos"));
    }
    match f.rotate {
        Rotate::None => {}
        Rotate::Cw90 => chain.push("transpose=1".into()),
        Rotate::Cw180 => chain.push("hflip,vflip".into()),
        Rotate::Cw270 => chain.push("transpose=2".into()),
    }
    if f.flip_h {
        chain.push("hflip".into());
    }
    if f.flip_v {
        chain.push("vflip".into());
    }
    if is_tonemapping(spec, media) {
        chain.push(TONEMAP.into());
    }
    if parts.cosmetic {
        match f.denoise {
            Strength::Off => {}
            Strength::Light => chain.push("hqdn3d=1.5:1.5:6:6".into()),
            Strength::Medium => chain.push("hqdn3d=3:3:6:6".into()),
            Strength::Strong => chain.push("hqdn3d=6:6:9:9".into()),
        }
        match f.sharpen {
            Strength::Off => {}
            Strength::Light => chain.push("unsharp=5:5:0.5:5:5:0.0".into()),
            Strength::Medium => chain.push("unsharp=5:5:1.0:5:5:0.0".into()),
            Strength::Strong => chain.push("unsharp=5:5:1.5:5:5:0.0".into()),
        }
    }

    let burn = if parts.burn { burn_track(spec, media) } else { None };
    if let Some(sub) = burn.filter(|s| s.is_text) {
        chain.push(format!(
            "subtitles={}:si={}",
            escape_filter_path(&spec.input),
            sub.order
        ));
    }

    if parts.fps {
        if let (Fps::Fixed { value }, Some(v)) = (vs.fps, media.video.as_ref()) {
            if value > 0.0 && (value - v.fps).abs() > 0.01 {
                chain.push(format!("fps={}", fps_expr(value)));
            }
        }
    }

    // Bitmap subtitles are pictures: they have to be overlaid, which needs a
    // complex graph with two inputs.
    if let Some(sub) = burn.filter(|s| !s.is_text) {
        let rest = chain.join(",");
        return Graph::Complex(if rest.is_empty() {
            format!("[0:v:0][0:s:{}]overlay[vout]", sub.order)
        } else {
            format!("[0:v:0][0:s:{}]overlay[ov];[ov]{rest}[vout]", sub.order)
        });
    }

    if chain.is_empty() {
        Graph::None
    } else {
        Graph::Simple(chain.join(","))
    }
}

// ───────────────────────────── Pixel format ─────────────────────────────

/// Output bit depth after applying the user's choice and encoder limits.
pub fn output_depth(vs: &VideoSettings, src: &VideoStream, tonemapping: bool) -> u32 {
    let ten_ok = vs.encoder.supports_ten_bit();
    match vs.bit_depth {
        BitDepth::Eight => 8,
        BitDepth::Ten => {
            if ten_ok {
                10
            } else {
                8
            }
        }
        BitDepth::Auto => {
            if tonemapping {
                8
            } else if vs.encoder == VideoEncoder::SvtAv1 {
                // 10-bit AV1 compresses better even from 8-bit sources.
                10
            } else if vs.encoder.codec() == Codec::H264 {
                // 10-bit H.264 plays almost nowhere.
                8
            } else if src.bit_depth >= 10 && ten_ok {
                10
            } else {
                8
            }
        }
    }
}

fn pix_fmt(enc: VideoEncoder, depth: u32) -> &'static str {
    match (enc.vendor(), depth) {
        (_, 10) if enc.is_hardware() => "p010le",
        (Vendor::Software, 10) => "yuv420p10le",
        (Vendor::Intel, _) | (Vendor::Amd, _) => "nv12",
        _ => "yuv420p",
    }
}

// ───────────────────────────── Rate control ─────────────────────────────

/// Roughly how many kbps the kept audio tracks will take.
pub fn audio_kbps_total(spec: &JobSpec, media: &MediaInfo) -> f64 {
    spec.audio_tracks
        .iter()
        .filter_map(|t| media.audio.get(t.order as usize).map(|a| (t, a)))
        .map(|(t, a)| match effective_audio_codec(t.codec, spec.settings.container, a) {
            AudioCodec::Copy => {
                if a.bitrate > 0.0 {
                    a.bitrate / 1000.0
                } else {
                    192.0
                }
            }
            AudioCodec::Flac => 800.0,
            _ => t.bitrate_kbps as f64,
        })
        .sum()
}

/// Video bitrate that makes video + audio land on `mb` mebibytes.
pub fn target_video_kbps(mb: f64, duration: f64, audio_kbps: f64) -> u32 {
    if duration <= 0.0 {
        return 1000;
    }
    let total_kbps = mb * 1024.0 * 1024.0 * 8.0 / 1000.0 / duration;
    // Leave 2.5% for container overhead so the result stays under the target.
    (total_kbps * 0.975 - audio_kbps).max(50.0).round() as u32
}

/// The bitrate a job will use, if it is bitrate-driven.
pub fn resolved_video_kbps(spec: &JobSpec, media: &MediaInfo) -> Option<u32> {
    match spec.settings.video.rate {
        RateControl::Quality { .. } => None,
        RateControl::Bitrate { kbps } => Some(kbps.max(50)),
        RateControl::TargetSize { mb } => {
            let wanted = target_video_kbps(mb, output_duration(spec, media), audio_kbps_total(spec, media));
            Some(match source_video_kbps(media) {
                // A size target is a ceiling, not a goal: a file that is
                // already smaller must not be inflated to fill it.
                Some(source) => wanted.min(source.max(50)),
                None => wanted,
            })
        }
    }
}

fn source_video_kbps(media: &MediaInfo) -> Option<u32> {
    media
        .video
        .as_ref()
        .map(|v| v.bitrate)
        .filter(|b| *b > 0.0)
        .map(|b| (b / 1000.0).round() as u32)
}

/// True when a target-size job is limited by the source's own bitrate.
pub fn target_exceeds_source(spec: &JobSpec, media: &MediaInfo) -> bool {
    match spec.settings.video.rate {
        RateControl::TargetSize { mb } => {
            let wanted = target_video_kbps(mb, output_duration(spec, media), audio_kbps_total(spec, media));
            source_video_kbps(media).map(|s| wanted > s.max(50)).unwrap_or(false)
        }
        _ => false,
    }
}

fn resolve_rate(spec: &JobSpec, media: &MediaInfo) -> Rate {
    let vs = &spec.settings.video;
    match vs.rate {
        RateControl::Quality { value } => {
            let (min, max, _) = vs.encoder.quality_range();
            Rate::Quality(value.clamp(min, max))
        }
        _ => Rate::Bitrate(resolved_video_kbps(spec, media).unwrap_or(1000)),
    }
}

// ───────────────────────────── Video encoder ─────────────────────────────

fn speed_name(enc: VideoEncoder, speed: Speed) -> String {
    use Speed::*;
    match enc.vendor() {
        Vendor::Nvidia => match speed {
            Slowest => "p7",
            Slow => "p6",
            Medium => "p5",
            Fast => "p3",
            Fastest => "p1",
        }
        .into(),
        Vendor::Intel => match speed {
            Slowest => "veryslow",
            Slow => "slow",
            Medium => "medium",
            Fast => "fast",
            Fastest => "veryfast",
        }
        .into(),
        Vendor::Amd => match speed {
            Slowest | Slow => "quality",
            Medium => "balanced",
            Fast | Fastest => "speed",
        }
        .into(),
        Vendor::Software => {
            if enc == VideoEncoder::SvtAv1 {
                match speed {
                    Slowest => "2",
                    Slow => "4",
                    Medium => "6",
                    Fast => "8",
                    Fastest => "10",
                }
                .into()
            } else {
                match speed {
                    Slowest => "veryslow",
                    Slow => "slow",
                    Medium => "medium",
                    Fast => "faster",
                    Fastest => "veryfast",
                }
                .into()
            }
        }
    }
}

struct EncodeCtx<'a> {
    vs: &'a VideoSettings,
    rate: Rate,
    depth: u32,
    /// `Some(1)` / `Some(2)` during a real two-pass encode.
    pass: Option<u8>,
    pass_log: &'a str,
    /// Emit `-pix_fmt`. Off when frames stay on the GPU.
    set_pix_fmt: bool,
}

fn video_encoder_args(c: &EncodeCtx) -> Vec<String> {
    let enc = c.vs.encoder;
    let mut a: Vec<String> = vec!["-c:v".into(), enc.ffmpeg_name().into()];
    let speed = speed_name(enc, c.vs.speed);

    match enc {
        VideoEncoder::Copy => return a,
        VideoEncoder::X264 | VideoEncoder::X265 => {
            a.extend(["-preset".into(), speed]);
            match c.rate {
                Rate::Quality(q) => a.extend(["-crf".into(), s(q)]),
                Rate::Bitrate(k) => a.extend(["-b:v".into(), format!("{k}k")]),
            }
            if enc == VideoEncoder::X264 {
                if let Some(p) = c.pass {
                    a.extend(["-pass".into(), s(p), "-passlogfile".into(), c.pass_log.into()]);
                }
            } else {
                let mut params = vec!["log-level=error".to_string()];
                if let Some(p) = c.pass {
                    params.push(format!("pass={p}"));
                    params.push(format!("stats={}.x265", c.pass_log));
                }
                a.extend(["-x265-params".into(), params.join(":")]);
            }
        }
        VideoEncoder::SvtAv1 => {
            a.extend(["-preset".into(), speed]);
            match c.rate {
                Rate::Quality(q) => a.extend(["-crf".into(), s(q)]),
                Rate::Bitrate(k) => a.extend(["-b:v".into(), format!("{k}k")]),
            }
            let mut params = vec!["tune=0".to_string()];
            if c.vs.film_grain > 0 {
                params.push(format!("film-grain={}", c.vs.film_grain.min(50)));
            }
            a.extend(["-svtav1-params".into(), params.join(":")]);
        }
        VideoEncoder::H264Nvenc | VideoEncoder::HevcNvenc | VideoEncoder::Av1Nvenc => {
            a.extend(["-preset".into(), speed]);
            push(&mut a, &["-tune", "hq", "-rc", "vbr"]);
            match c.rate {
                Rate::Quality(q) => a.extend(["-cq".into(), s(q), "-b:v".into(), "0".into()]),
                Rate::Bitrate(k) => a.extend([
                    "-b:v".into(),
                    format!("{k}k"),
                    "-maxrate".into(),
                    format!("{}k", k * 3 / 2),
                    "-bufsize".into(),
                    format!("{}k", k * 2),
                ]),
            }
            push(&mut a, &["-rc-lookahead", "20"]);
            if c.vs.two_pass && matches!(c.rate, Rate::Bitrate(_)) {
                push(&mut a, &["-multipass", "fullres"]);
            }
        }
        VideoEncoder::H264Qsv | VideoEncoder::HevcQsv | VideoEncoder::Av1Qsv => {
            a.extend(["-preset".into(), speed]);
            match c.rate {
                Rate::Quality(q) => a.extend(["-global_quality".into(), s(q)]),
                Rate::Bitrate(k) => a.extend([
                    "-b:v".into(),
                    format!("{k}k"),
                    "-maxrate".into(),
                    format!("{}k", k * 3 / 2),
                ]),
            }
        }
        VideoEncoder::H264Amf | VideoEncoder::HevcAmf | VideoEncoder::Av1Amf => {
            a.extend(["-quality".into(), speed]);
            match c.rate {
                Rate::Quality(q) => {
                    a.extend(["-rc".into(), "cqp".into(), "-qp_i".into(), s(q), "-qp_p".into(), s(q)]);
                    if enc != VideoEncoder::HevcAmf {
                        a.extend(["-qp_b".into(), s(q)]);
                    }
                }
                Rate::Bitrate(k) => a.extend([
                    "-rc".into(),
                    "vbr_peak".into(),
                    "-b:v".into(),
                    format!("{k}k"),
                    "-maxrate".into(),
                    format!("{}k", k * 3 / 2),
                ]),
            }
        }
    }

    if c.set_pix_fmt {
        a.extend(["-pix_fmt".into(), pix_fmt(enc, c.depth).into()]);
    }
    a
}

// ───────────────────────────── Audio & subtitles ─────────────────────────────

fn copy_allowed(container: Container, codec: &str) -> bool {
    match container {
        Container::Mkv => true,
        Container::Mp4 => matches!(codec, "aac" | "mp3" | "ac3" | "eac3" | "opus" | "flac" | "alac"),
        Container::Mov => matches!(codec, "aac" | "mp3" | "ac3" | "eac3" | "alac") || codec.starts_with("pcm_"),
        Container::Webm => matches!(codec, "opus" | "vorbis"),
    }
}

fn container_default_audio(container: Container) -> AudioCodec {
    match container {
        Container::Webm => AudioCodec::Opus,
        _ => AudioCodec::Aac,
    }
}

/// The audio codec that will really be used, after container rules.
pub fn effective_audio_codec(wanted: AudioCodec, container: Container, src: &AudioStream) -> AudioCodec {
    match wanted {
        AudioCodec::Copy => {
            if copy_allowed(container, &src.codec) {
                AudioCodec::Copy
            } else {
                container_default_audio(container)
            }
        }
        codec => match container {
            Container::Webm if codec != AudioCodec::Opus => AudioCodec::Opus,
            Container::Mov if matches!(codec, AudioCodec::Opus | AudioCodec::Flac) => AudioCodec::Aac,
            _ => codec,
        },
    }
}

fn audio_args(spec: &JobSpec, media: &MediaInfo, warnings: &mut Vec<String>) -> Vec<String> {
    let container = spec.settings.container;
    let mut a = Vec::new();
    let mut out = 0usize;
    for t in &spec.audio_tracks {
        let Some(src) = media.audio.get(t.order as usize) else {
            warnings.push(format!("Audio track {} does not exist in the source and was skipped.", t.order + 1));
            continue;
        };
        let codec = effective_audio_codec(t.codec, container, src);
        if codec != t.codec {
            warnings.push(format!(
                "Audio track {}: {} audio cannot go into .{}, so it is converted to {}.",
                t.order + 1,
                if t.codec == AudioCodec::Copy { src.codec.to_uppercase() } else { format!("{:?}", t.codec) },
                container.ext(),
                format!("{codec:?}").to_uppercase()
            ));
        }
        a.extend(["-map".into(), format!("0:a:{}", t.order)]);
        let name = match codec {
            AudioCodec::Copy => "copy",
            AudioCodec::Aac => "aac",
            AudioCodec::Opus => "libopus",
            AudioCodec::Ac3 => "ac3",
            AudioCodec::Flac => "flac",
        };
        a.extend([format!("-c:a:{out}"), name.into()]);
        if codec != AudioCodec::Copy {
            if codec != AudioCodec::Flac {
                a.extend([format!("-b:a:{out}"), format!("{}k", t.bitrate_kbps.clamp(32, 1024))]);
            }
            let channels = match t.mixdown {
                Mixdown::Mono => Some(1),
                Mixdown::Stereo => Some(2),
                Mixdown::Surround51 => Some(6),
                // AC-3 tops out at 5.1.
                Mixdown::Source if codec == AudioCodec::Ac3 && src.channels > 6 => Some(6),
                Mixdown::Source => None,
            }
            // Never invent channels the source does not have.
            .filter(|&n| n <= src.channels.max(1) || t.mixdown == Mixdown::Source);
            match channels {
                Some(n) => a.extend([format!("-ac:a:{out}"), s(n)]),
                None => {
                    // libopus rejects "side" layouts such as 5.1(side); remap them.
                    if codec == AudioCodec::Opus && src.channel_layout.contains("(side)") {
                        let layout = if src.channels >= 8 { "7.1" } else { "5.1" };
                        a.extend([format!("-filter:a:{out}"), format!("aformat=channel_layouts={layout}")]);
                    }
                }
            }
        }
        out += 1;
    }
    a
}

fn subtitle_args(spec: &JobSpec, media: &MediaInfo, warnings: &mut Vec<String>) -> Vec<String> {
    let container = spec.settings.container;
    let mut a = Vec::new();
    let mut out = 0usize;
    for t in spec.subtitle_tracks.iter().filter(|t| t.mode == SubtitleMode::Copy) {
        let Some(src) = media.subtitles.get(t.order as usize) else {
            warnings.push(format!("Subtitle track {} does not exist in the source and was skipped.", t.order + 1));
            continue;
        };
        let codec = match (container, src.is_text) {
            (Container::Mkv, _) => {
                if src.codec == "mov_text" {
                    "srt"
                } else {
                    "copy"
                }
            }
            (Container::Mp4 | Container::Mov, true) => "mov_text",
            (Container::Webm, true) => "webvtt",
            (_, false) => {
                warnings.push(format!(
                    "Subtitle track {} is picture-based and cannot be stored in .{}; burn it in or use MKV.",
                    t.order + 1,
                    container.ext()
                ));
                continue;
            }
        };
        a.extend(["-map".into(), format!("0:s:{}", t.order)]);
        a.extend([format!("-c:s:{out}"), codec.into()]);
        a.extend([format!("-disposition:s:{out}"), if t.default { "default" } else { "0" }.into()]);
        out += 1;
    }
    a
}

// ───────────────────────────── Assembly ─────────────────────────────

/// Codecs NVDEC can decode on the GPU.
fn nvdec_codec(codec: &str) -> bool {
    matches!(codec, "h264" | "hevc" | "av1" | "vp9" | "vp8" | "mpeg2video" | "mpeg4" | "vc1")
}

/// Whether decode → encode can stay entirely on an NVIDIA GPU.
fn can_use_gpu_pipeline(spec: &JobSpec, media: &MediaInfo, graph: &Graph, depth: u32, opts: &PlanOptions) -> bool {
    let Some(v) = media.video.as_ref() else { return false };
    opts.hw_decode
        && spec.settings.video.encoder.vendor() == Vendor::Nvidia
        && *graph == Graph::None
        && nvdec_codec(&v.codec)
        && !v.interlaced
        && match depth {
            8 => matches!(v.pix_fmt.as_str(), "yuv420p" | "yuvj420p" | "nv12"),
            10 => matches!(v.pix_fmt.as_str(), "yuv420p10le" | "p010le"),
            _ => false,
        }
}

/// Build the ffmpeg invocation(s) for a job.
pub fn plan(spec: &JobSpec, media: &MediaInfo, opts: &PlanOptions) -> Result<Plan> {
    let Some(v) = media.video.as_ref() else {
        return Err(AppError::msg("This file has no video stream."));
    };
    if spec.input == spec.output {
        return Err(AppError::msg("The output file would overwrite the source file."));
    }
    if !spec.extra_inputs.is_empty() {
        return plan_join(spec, media, opts);
    }
    let vs = &spec.settings.video;
    let enc = vs.encoder;
    let container = spec.settings.container;
    let mut warnings = Vec::new();

    if enc.codec() == Codec::Av1 && container == Container::Mov {
        warnings.push("AV1 in .mov is poorly supported by players; MP4 or MKV is safer.".into());
    }
    if container == Container::Webm && !matches!(enc.codec(), Codec::Av1 | Codec::Copy) {
        return Err(AppError::msg("WebM only supports AV1 here. Choose an AV1 encoder or another container."));
    }

    let trim = effective_trim(spec, media);
    let duration = output_duration(spec, media);
    let tonemapping = is_tonemapping(spec, media);
    let geo = geometry(spec, media);
    let copy = enc == VideoEncoder::Copy;

    let graph = if copy {
        if build_graph(spec, media, &geo, ChainParts::ALL) != Graph::None {
            warnings.push("Video is copied without re-encoding, so crop, resize and filters are ignored.".into());
        }
        Graph::None
    } else {
        build_graph(spec, media, &geo, ChainParts::ALL)
    };

    let depth = output_depth(vs, v, tonemapping);
    let rate = resolve_rate(spec, media);
    let video_kbps = match rate {
        Rate::Bitrate(k) => Some(k),
        Rate::Quality(_) => None,
    };
    if let (RateControl::TargetSize { mb }, Some(k)) = (vs.rate, video_kbps) {
        if target_exceeds_source(spec, media) {
            warnings.push(format!(
                "The source is already smaller than {mb} MB, so the video keeps its current bitrate instead of growing."
            ));
        } else if k <= 60 {
            warnings.push(format!(
                "{mb} MB is very small for {:.0} seconds of video; quality will be poor.",
                duration
            ));
        }
    }

    let gpu_pipeline = !copy && can_use_gpu_pipeline(spec, media, &graph, depth, opts);
    let two_pass = !copy && vs.two_pass && enc.supports_two_pass() && matches!(rate, Rate::Bitrate(_));
    // Text subtitles are rendered against the original clock, so the trim has
    // to happen after the filter (slower, but the timing stays right).
    let burn_text = burn_track(spec, media).map(|t| t.is_text).unwrap_or(false) && !copy;
    let output_seek = burn_text;

    let build = |pass: Option<u8>| -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        push(&mut a, &["-hide_banner", "-y", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1"]);

        if gpu_pipeline {
            push(&mut a, &["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
        }
        if let Some(t) = trim {
            if !output_seek {
                a.extend(["-ss".into(), secs(t.start)]);
            }
        }
        a.extend(["-i".into(), spec.input.clone()]);
        if let Some(t) = trim {
            if output_seek {
                a.extend(["-ss".into(), secs(t.start)]);
            }
            a.extend(["-t".into(), secs(t.end - t.start)]);
        }

        // Video
        match &graph {
            Graph::Complex(g) => a.extend(["-filter_complex".into(), g.clone(), "-map".into(), "[vout]".into()]),
            Graph::Simple(g) => a.extend(["-map".into(), "0:v:0".into(), "-vf".into(), g.clone()]),
            Graph::None => a.extend(["-map".into(), "0:v:0".into()]),
        }
        a.extend(video_encoder_args(&EncodeCtx {
            vs,
            rate,
            depth,
            pass,
            pass_log: &opts.pass_log,
            set_pix_fmt: !gpu_pipeline,
        }));
        if !copy {
            if tonemapping {
                push(&mut a, &["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]);
            } else if v.is_hdr && depth >= 10 {
                if let Some(p) = &v.color_primaries {
                    a.extend(["-color_primaries".into(), p.clone()]);
                }
                if let Some(t) = &v.color_transfer {
                    a.extend(["-color_trc".into(), t.clone()]);
                }
                if let Some(c) = &v.color_space {
                    a.extend(["-colorspace".into(), c.clone()]);
                }
            }
        }
        let hevc = enc.codec() == Codec::Hevc || (copy && v.codec == "hevc");
        if hevc && matches!(container, Container::Mp4 | Container::Mov) {
            // Apple players only recognise HEVC with this tag.
            push(&mut a, &["-tag:v", "hvc1"]);
        }

        if pass == Some(1) {
            // Analysis pass: video only, output discarded.
            push(&mut a, &["-an", "-sn", "-f", "null", "-"]);
            return a;
        }

        let mut w = Vec::new();
        a.extend(audio_args(spec, media, &mut w));
        a.extend(subtitle_args(spec, media, &mut w));

        push(&mut a, &["-map_metadata", if spec.settings.keep_metadata { "0" } else { "-1" }]);
        push(&mut a, &["-map_chapters", if spec.settings.keep_chapters { "0" } else { "-1" }]);
        push(&mut a, &["-max_muxing_queue_size", "2048"]);
        if matches!(container, Container::Mp4 | Container::Mov) {
            push(&mut a, &["-movflags", "+faststart"]);
        }
        a.push(spec.output.clone());
        a
    };

    // Collect audio/subtitle warnings once (the closure discards its own copy).
    audio_args(spec, media, &mut warnings);
    subtitle_args(spec, media, &mut warnings);

    let passes = if two_pass {
        vec![build(Some(1)), build(Some(2))]
    } else {
        vec![build(None)]
    };

    Ok(Plan {
        passes,
        duration,
        warnings,
        hwaccel: gpu_pipeline,
        video_kbps,
        width: geo.width,
        height: geo.height,
    })
}

/// The joined result seen as one clip: the first clip's shape, everyone's length.
pub fn joined_media(first: &MediaInfo, rest: &[MediaInfo]) -> MediaInfo {
    let mut whole = first.clone();
    whole.duration = first.duration + rest.iter().map(|m| m.duration).sum::<f64>();
    whole.size_bytes = first.size_bytes + rest.iter().map(|m| m.size_bytes).sum::<f64>();
    if whole.duration > 0.0 {
        whole.bitrate = whole.size_bytes * 8.0 / whole.duration;
    }
    whole.file_name = match rest.len() {
        0 => first.file_name.clone(),
        1 => format!("{} + 1 more", first.file_name),
        n => format!("{} + {n} more", first.file_name),
    };
    whole.subtitles.clear();
    whole.chapters = 0;
    whole
}

/// Join several videos end to end.
///
/// Every clip is fitted into the first clip's frame (black bars where the
/// shape differs), brought to one frame rate and one audio layout, and the
/// result is encoded once with the job's settings.
fn plan_join(spec: &JobSpec, first: &MediaInfo, opts: &PlanOptions) -> Result<Plan> {
    let vs = &spec.settings.video;
    let enc = vs.encoder;
    let container = spec.settings.container;
    if opts.joined.len() != spec.extra_inputs.len() {
        return Err(AppError::msg("The videos to join could not be read."));
    }
    if enc == VideoEncoder::Copy {
        return Err(AppError::msg("Joining videos re-encodes them, so \"Copy\" cannot be used. Choose another encoder."));
    }
    if container == Container::Webm && enc.codec() != Codec::Av1 {
        return Err(AppError::msg("WebM only supports AV1 here. Choose an AV1 encoder or another container."));
    }
    if spec.extra_inputs.iter().any(|p| *p == spec.output) {
        return Err(AppError::msg("The output file would overwrite one of the videos being joined."));
    }
    let clips: Vec<&MediaInfo> = std::iter::once(first).chain(opts.joined.iter()).collect();
    if let Some(bad) = clips.iter().find(|c| c.video.is_none()) {
        return Err(AppError::msg(format!("{} has no video, so it cannot be joined.", bad.file_name)));
    }
    let v0 = first.video.as_ref().expect("checked above");
    let (w, h) = display_size(v0);
    let (w, h) = (even(w), even(h));
    let fps = match vs.fps {
        Fps::Fixed { value } if value > 0.0 => value,
        _ => v0.fps,
    };
    let with_audio = !spec.audio_tracks.is_empty() && clips.iter().any(|c| !c.audio.is_empty());
    let mut warnings = Vec::new();
    if clips.iter().any(|c| c.video.as_ref().map(display_size) != Some(display_size(v0))) {
        warnings.push(format!("The videos are different shapes. Each one is fitted into {w}×{h}, with black bars where needed."));
    }
    if clips.iter().any(|c| c.video.as_ref().map(|v| v.is_hdr).unwrap_or(false)) {
        warnings.push("HDR is not kept when videos are joined.".into());
    }

    // From here on the join behaves like one long clip shaped like the first.
    let whole = joined_media(first, &opts.joined);
    let mut one = spec.clone();
    one.extra_inputs.clear();
    one.trim = None;
    one.subtitle_tracks.clear();
    one.settings.video.fps = Fps::Source;
    one.settings.video.hdr = HdrMode::Keep;
    if one.settings.video.crop == CropMode::Auto {
        // Black bars differ from clip to clip.
        one.settings.video.crop = CropMode::None;
    }
    let geo = geometry(&one, &whole);
    let post = match build_graph(&one, &whole, &geo, ChainParts::ALL) {
        Graph::Simple(chain) => chain,
        _ => "null".to_string(),
    };

    let mut parts: Vec<String> = Vec::new();
    for (i, clip) in clips.iter().enumerate() {
        parts.push(format!(
            "[{i}:v:0]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={},format=yuv420p,setpts=PTS-STARTPTS[v{i}]",
            fps_expr(fps)
        ));
        if with_audio {
            parts.push(if clip.audio.is_empty() {
                // A silent clip still needs sound of the right length.
                format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[a{i}]", secs(clip.duration))
            } else {
                format!("[{i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]")
            });
        }
    }
    let n = clips.len();
    let pads: String = (0..n)
        .map(|i| if with_audio { format!("[v{i}][a{i}]") } else { format!("[v{i}]") })
        .collect();
    parts.push(if with_audio {
        format!("{pads}concat=n={n}:v=1:a=1[vcat][acat]")
    } else {
        format!("{pads}concat=n={n}:v=1:a=0[vcat]")
    });
    parts.push(format!("[vcat]{post}[vout]"));
    let graph = parts.join(";");

    let depth = output_depth(vs, v0, true).max(if vs.bit_depth == BitDepth::Ten && enc.supports_ten_bit() { 10 } else { 8 });
    let rate = resolve_rate(&one, &whole);
    let video_kbps = match rate {
        Rate::Bitrate(k) => Some(k),
        Rate::Quality(_) => None,
    };
    let two_pass = vs.two_pass && enc.supports_two_pass() && matches!(rate, Rate::Bitrate(_));

    let audio_codec = spec.audio_tracks.first().map(|t| match (t.codec, container) {
        (_, Container::Webm) => AudioCodec::Opus,
        (AudioCodec::Copy, _) => AudioCodec::Aac,
        (AudioCodec::Opus | AudioCodec::Flac, Container::Mov) => AudioCodec::Aac,
        (codec, _) => codec,
    });
    let audio_kbps = spec.audio_tracks.first().map(|t| t.bitrate_kbps.clamp(64, 1024)).unwrap_or(160);

    let build = |pass: Option<u8>| -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        push(&mut a, &["-hide_banner", "-y", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1"]);
        a.extend(["-i".into(), spec.input.clone()]);
        for extra in &spec.extra_inputs {
            a.extend(["-i".into(), extra.clone()]);
        }
        a.extend(["-filter_complex".into(), graph.clone(), "-map".into(), "[vout]".into()]);
        a.extend(video_encoder_args(&EncodeCtx { vs, rate, depth, pass, pass_log: &opts.pass_log, set_pix_fmt: true }));
        if enc.codec() == Codec::Hevc && matches!(container, Container::Mp4 | Container::Mov) {
            push(&mut a, &["-tag:v", "hvc1"]);
        }
        if pass == Some(1) {
            push(&mut a, &["-an", "-sn", "-f", "null", "-"]);
            return a;
        }
        if let (true, Some(codec)) = (with_audio, audio_codec) {
            let name = match codec {
                AudioCodec::Opus => "libopus",
                AudioCodec::Ac3 => "ac3",
                AudioCodec::Flac => "flac",
                _ => "aac",
            };
            a.extend(["-map".into(), "[acat]".into(), "-c:a".into(), name.into()]);
            if codec != AudioCodec::Flac {
                a.extend(["-b:a".into(), format!("{audio_kbps}k")]);
            }
        }
        push(&mut a, &["-map_metadata", "-1", "-map_chapters", "-1", "-max_muxing_queue_size", "2048"]);
        if matches!(container, Container::Mp4 | Container::Mov) {
            push(&mut a, &["-movflags", "+faststart"]);
        }
        a.push(spec.output.clone());
        a
    };

    let passes = if two_pass { vec![build(Some(1)), build(Some(2))] } else { vec![build(None)] };
    Ok(Plan {
        passes,
        duration: whole.duration,
        warnings,
        hwaccel: false,
        video_kbps,
        width: geo.width,
        height: geo.height,
    })
}

/// A copy of the job cut down to a short, silent sample — used for size
/// estimates and previews. Target-size jobs are pinned to the bitrate the full
/// job would use, since a 3-second sample has its own (wrong) size budget.
pub fn sample_spec(spec: &JobSpec, media: &MediaInfo, start: f64, duration: f64, output: &str) -> JobSpec {
    let mut s = spec.clone();
    if let Some(kbps) = resolved_video_kbps(spec, media) {
        s.settings.video.rate = RateControl::Bitrate { kbps };
    }
    s.settings.video.two_pass = false;
    s.settings.keep_chapters = false;
    s.settings.keep_metadata = false;
    s.audio_tracks.clear();
    s.subtitle_tracks.retain(|t| t.mode == SubtitleMode::Burn);
    let base = effective_trim(spec, media).map(|t| t.start).unwrap_or(0.0);
    let from = (base + start).clamp(0.0, (media.duration - 0.2).max(0.0));
    s.trim = Some(Trim { start: from, end: (from + duration).min(media.duration.max(from + 0.1)) });
    s.output = output.to_string();
    s
}

/// Arguments for a near-lossless H.264 "before" clip with the job's geometry.
pub fn reference_clip_args(spec: &JobSpec, media: &MediaInfo, start: f64, duration: f64, output: &str) -> Vec<String> {
    let geo = geometry(spec, media);
    let mut a: Vec<String> = Vec::new();
    push(&mut a, &["-hide_banner", "-y", "-nostdin", "-loglevel", "error"]);
    a.extend(["-ss".into(), secs(start), "-i".into(), spec.input.clone(), "-t".into(), secs(duration)]);
    a.extend(["-map".into(), "0:v:0".into()]);
    let mut chain = match build_graph(spec, media, &geo, ChainParts::GEOMETRY) {
        Graph::Simple(g) => g,
        _ => String::new(),
    };
    if !chain.is_empty() {
        chain.push(',');
    }
    chain.push_str("format=yuv420p");
    a.extend(["-vf".into(), chain]);
    push(&mut a, &["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-an", "-movflags", "+faststart"]);
    a.push(output.to_string());
    a
}

/// Arguments that turn any clip into something WebView2 can always play.
pub fn web_playable_args(input: &str, output: &str) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    push(&mut a, &["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i"]);
    a.push(input.to_string());
    push(&mut a, &[
        "-map", "0:v:0", "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-an",
        "-movflags", "+faststart",
    ]);
    a.push(output.to_string());
    a
}

/// Arguments for a single still frame with the job's geometry applied.
pub fn frame_args(spec: &JobSpec, media: &MediaInfo, at: f64, max_width: u32, output: &str) -> Vec<String> {
    let geo = geometry(spec, media);
    let mut a: Vec<String> = Vec::new();
    push(&mut a, &["-hide_banner", "-y", "-nostdin", "-loglevel", "error"]);
    a.extend(["-ss".into(), secs(at), "-i".into(), spec.input.clone()]);
    let mut chain = match build_graph(spec, media, &geo, ChainParts { cosmetic: true, burn: false, fps: false }) {
        Graph::Simple(g) => g,
        _ => String::new(),
    };
    if max_width > 0 && geo.width > max_width {
        if !chain.is_empty() {
            chain.push(',');
        }
        chain.push_str(&format!("scale={}:-2", even(max_width)));
    }
    if !chain.is_empty() {
        a.extend(["-vf".into(), chain]);
    }
    push(&mut a, &["-frames:v", "1", "-q:v", "3"]);
    a.push(output.to_string());
    a
}

/// A copy-pasteable command line for display.
pub fn to_command_line(program: &str, args: &[String]) -> String {
    let quote = |a: &str| {
        if a.is_empty() || a.chars().any(|c| c.is_whitespace() || "[]();&|<>'".contains(c)) {
            format!("\"{}\"", a.replace('"', "\\\""))
        } else {
            a.to_string()
        }
    };
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media() -> MediaInfo {
        MediaInfo {
            path: "C:/in/movie.mkv".into(),
            file_name: "movie.mkv".into(),
            size_bytes: 1_000_000_000.0,
            duration: 600.0,
            bitrate: 13_000_000.0,
            format_name: "matroska,webm".into(),
            video: Some(VideoStream {
                index: 0,
                codec: "h264".into(),
                width: 1920,
                height: 1080,
                fps: 23.976,
                pix_fmt: "yuv420p".into(),
                bit_depth: 8,
                is_hdr: false,
                color_transfer: None,
                color_primaries: None,
                color_space: None,
                bitrate: 12_000_000.0,
                frames: 14385.0,
                rotation: 0,
                interlaced: false,
            }),
            audio: vec![
                AudioStream {
                    index: 1,
                    order: 0,
                    codec: "dts".into(),
                    channels: 6,
                    channel_layout: "5.1(side)".into(),
                    sample_rate: 48000,
                    bitrate: 1_536_000.0,
                    language: Some("eng".into()),
                    title: None,
                    default: true,
                },
                AudioStream {
                    index: 2,
                    order: 1,
                    codec: "aac".into(),
                    channels: 2,
                    channel_layout: "stereo".into(),
                    sample_rate: 48000,
                    bitrate: 128_000.0,
                    language: Some("hin".into()),
                    title: None,
                    default: false,
                },
            ],
            subtitles: vec![
                SubtitleStream { index: 3, order: 0, codec: "subrip".into(), language: Some("eng".into()), title: None, default: true, forced: false, is_text: true },
                SubtitleStream { index: 4, order: 1, codec: "hdmv_pgs_subtitle".into(), language: None, title: None, default: false, forced: false, is_text: false },
            ],
            chapters: 4,
        }
    }

    fn settings(encoder: VideoEncoder, container: Container) -> EncodeSettings {
        EncodeSettings {
            container,
            video: VideoSettings {
                encoder,
                rate: RateControl::Quality { value: encoder.quality_range().2 },
                two_pass: false,
                speed: Speed::Medium,
                bit_depth: BitDepth::Auto,
                fps: Fps::Source,
                resolution: Resolution::Source,
                crop: CropMode::None,
                hdr: HdrMode::Keep,
                film_grain: 0,
            },
            audio: AudioDefaults { codec: AudioCodec::Aac, bitrate_kbps: 160, mixdown: Mixdown::Source },
            subtitles: SubtitleDefault::None,
            filters: Filters::default(),
            keep_chapters: true,
            keep_metadata: true,
        }
    }

    fn spec(encoder: VideoEncoder, container: Container) -> JobSpec {
        JobSpec {
            input: "C:/in/movie.mkv".into(),
            output: format!("C:/out/movie.{}", container.ext()),
            settings: settings(encoder, container),
            audio_tracks: vec![AudioTrack { order: 0, codec: AudioCodec::Aac, bitrate_kbps: 160, mixdown: Mixdown::Source }],
            subtitle_tracks: vec![],
            trim: None,
            auto_crop: None,
            extra_inputs: Vec::new(),
        }
    }

    fn opts() -> PlanOptions {
        PlanOptions { hw_decode: false, pass_log: "log".into(), joined: Vec::new() }
    }

    /// Value following a flag, e.g. `val(args, "-crf")`.
    fn val<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    fn has(args: &[String], flag: &str) -> bool {
        args.iter().any(|a| a == flag)
    }

    fn one(spec: &JobSpec) -> Vec<String> {
        let p = plan(spec, &media(), &opts()).unwrap();
        assert_eq!(p.passes.len(), 1);
        p.passes[0].clone()
    }

    #[test]
    fn x264_quality_golden() {
        let a = one(&spec(VideoEncoder::X264, Container::Mp4));
        let expected: Vec<String> = [
            "-hide_banner", "-y", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1",
            "-i", "C:/in/movie.mkv",
            "-map", "0:v:0",
            "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
            "-map", "0:a:0", "-c:a:0", "aac", "-b:a:0", "160k",
            "-map_metadata", "0", "-map_chapters", "0", "-max_muxing_queue_size", "2048",
            "-movflags", "+faststart",
            "C:/out/movie.mp4",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(a, expected);
    }

    #[test]
    fn x265_tags_hvc1_in_mp4_only() {
        let a = one(&spec(VideoEncoder::X265, Container::Mp4));
        assert_eq!(val(&a, "-c:v"), Some("libx265"));
        assert_eq!(val(&a, "-crf"), Some("26"));
        assert_eq!(val(&a, "-tag:v"), Some("hvc1"));
        assert_eq!(val(&a, "-x265-params"), Some("log-level=error"));
        let b = one(&spec(VideoEncoder::X265, Container::Mkv));
        assert!(!has(&b, "-tag:v"));
        assert!(!has(&b, "-movflags"));
    }

    #[test]
    fn svt_av1_uses_ten_bit_and_grain() {
        let mut s = spec(VideoEncoder::SvtAv1, Container::Mkv);
        s.settings.video.film_grain = 8;
        s.settings.video.speed = Speed::Slow;
        let a = one(&s);
        assert_eq!(val(&a, "-c:v"), Some("libsvtav1"));
        assert_eq!(val(&a, "-preset"), Some("4"));
        assert_eq!(val(&a, "-crf"), Some("32"));
        assert_eq!(val(&a, "-pix_fmt"), Some("yuv420p10le"));
        assert_eq!(val(&a, "-svtav1-params"), Some("tune=0:film-grain=8"));
        // Never the option combination that broke the old engine.
        assert!(!has(&a, "-maxrate"));
    }

    #[test]
    fn nvenc_quality_and_bitrate() {
        let mut s = spec(VideoEncoder::HevcNvenc, Container::Mp4);
        let a = one(&s);
        assert_eq!(val(&a, "-c:v"), Some("hevc_nvenc"));
        assert_eq!(val(&a, "-preset"), Some("p5"));
        assert_eq!(val(&a, "-rc"), Some("vbr"));
        assert_eq!(val(&a, "-cq"), Some("28"));
        assert_eq!(val(&a, "-b:v"), Some("0"));
        assert_eq!(val(&a, "-pix_fmt"), Some("yuv420p"));

        s.settings.video.rate = RateControl::Bitrate { kbps: 4000 };
        s.settings.video.two_pass = true;
        let b = one(&s);
        assert_eq!(val(&b, "-b:v"), Some("4000k"));
        assert_eq!(val(&b, "-maxrate"), Some("6000k"));
        assert_eq!(val(&b, "-bufsize"), Some("8000k"));
        assert_eq!(val(&b, "-multipass"), Some("fullres"));
        assert!(!has(&b, "-cq"));
    }

    #[test]
    fn nvenc_ten_bit_only_where_supported() {
        let mut m = media();
        let v = m.video.as_mut().unwrap();
        v.bit_depth = 10;
        v.pix_fmt = "yuv420p10le".into();
        let hevc = plan(&spec(VideoEncoder::HevcNvenc, Container::Mkv), &m, &opts()).unwrap();
        assert_eq!(val(&hevc.passes[0], "-pix_fmt"), Some("p010le"));
        let h264 = plan(&spec(VideoEncoder::H264Nvenc, Container::Mkv), &m, &opts()).unwrap();
        assert_eq!(val(&h264.passes[0], "-pix_fmt"), Some("yuv420p"));
        // Forcing 10-bit on an encoder that cannot do it falls back to 8.
        let mut s = spec(VideoEncoder::H264Nvenc, Container::Mkv);
        s.settings.video.bit_depth = BitDepth::Ten;
        assert_eq!(val(&plan(&s, &m, &opts()).unwrap().passes[0], "-pix_fmt"), Some("yuv420p"));
    }

    #[test]
    fn qsv_and_amf_args() {
        let a = one(&spec(VideoEncoder::H264Qsv, Container::Mp4));
        assert_eq!(val(&a, "-global_quality"), Some("24"));
        assert_eq!(val(&a, "-pix_fmt"), Some("nv12"));
        let b = one(&spec(VideoEncoder::HevcAmf, Container::Mp4));
        assert_eq!(val(&b, "-rc"), Some("cqp"));
        assert_eq!(val(&b, "-qp_i"), Some("26"));
        assert!(!has(&b, "-qp_b"));
        let c = one(&spec(VideoEncoder::H264Amf, Container::Mp4));
        assert_eq!(val(&c, "-qp_b"), Some("24"));
    }

    #[test]
    fn gpu_pipeline_only_without_filters() {
        let mut o = opts();
        o.hw_decode = true;
        let s = spec(VideoEncoder::HevcNvenc, Container::Mp4);
        let p = plan(&s, &media(), &o).unwrap();
        assert!(p.hwaccel);
        assert_eq!(val(&p.passes[0], "-hwaccel"), Some("cuda"));
        assert!(!has(&p.passes[0], "-pix_fmt"));

        let mut scaled = s.clone();
        scaled.settings.video.resolution = Resolution::Height { value: 720 };
        let p2 = plan(&scaled, &media(), &o).unwrap();
        assert!(!p2.hwaccel);
        assert!(!has(&p2.passes[0], "-hwaccel"));

        // Software encoders never ask for GPU decode.
        assert!(!plan(&spec(VideoEncoder::X264, Container::Mp4), &media(), &o).unwrap().hwaccel);
    }

    #[test]
    fn two_pass_x264_and_x265() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.settings.video.rate = RateControl::Bitrate { kbps: 2500 };
        s.settings.video.two_pass = true;
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(p.passes.len(), 2);
        assert_eq!(val(&p.passes[0], "-pass"), Some("1"));
        assert_eq!(val(&p.passes[0], "-passlogfile"), Some("log"));
        assert_eq!(&p.passes[0][p.passes[0].len() - 5..], ["-an", "-sn", "-f", "null", "-"]);
        assert_eq!(val(&p.passes[1], "-pass"), Some("2"));
        assert_eq!(p.passes[1].last().unwrap(), "C:/out/movie.mp4");
        assert!(!has(&p.passes[0], "-map_metadata"));

        s.settings.video.encoder = VideoEncoder::X265;
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(val(&p.passes[0], "-x265-params"), Some("log-level=error:pass=1:stats=log.x265"));
        assert_eq!(val(&p.passes[1], "-x265-params"), Some("log-level=error:pass=2:stats=log.x265"));

        // Quality mode never does two passes.
        s.settings.video.rate = RateControl::Quality { value: 24 };
        assert_eq!(plan(&s, &media(), &opts()).unwrap().passes.len(), 1);
    }

    #[test]
    fn target_size_maths() {
        // 100 MiB over 600 s = 1398.1 kbps total; minus 2.5% and 160k audio.
        let k = target_video_kbps(100.0, 600.0, 160.0);
        assert_eq!(k, 1203);
        assert_eq!(target_video_kbps(0.1, 600.0, 160.0), 50);

        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.settings.video.rate = RateControl::TargetSize { mb: 100.0 };
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(p.video_kbps, Some(1203));
        assert_eq!(val(&p.passes[0], "-b:v"), Some("1203k"));

        // A trim shortens the clip, so the same size buys a higher bitrate.
        s.trim = Some(Trim { start: 0.0, end: 300.0 });
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(p.duration, 300.0);
        assert_eq!(p.video_kbps, Some(2566));
    }

    #[test]
    fn target_size_never_inflates_a_small_source() {
        // 12 Mbps source, 600 s: about 860 MB of video. Ask for 5 GB.
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.settings.video.rate = RateControl::TargetSize { mb: 5000.0 };
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(p.video_kbps, Some(12_000), "capped at the source bitrate");
        assert!(p.warnings.iter().any(|w| w.contains("already smaller")));
        // A reachable target is untouched and does not warn.
        s.settings.video.rate = RateControl::TargetSize { mb: 100.0 };
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(p.video_kbps, Some(1203));
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn trim_uses_fast_seek_unless_burning_text() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.trim = Some(Trim { start: 60.0, end: 90.5 });
        let a = one(&s);
        let ss = a.iter().position(|x| x == "-ss").unwrap();
        let i = a.iter().position(|x| x == "-i").unwrap();
        assert!(ss < i, "fast seek goes before the input");
        assert_eq!(a[ss + 1], "60");
        assert_eq!(val(&a, "-t"), Some("30.5"));

        s.subtitle_tracks = vec![SubtitleTrack { order: 0, mode: SubtitleMode::Burn, default: false }];
        let b = one(&s);
        let ss = b.iter().position(|x| x == "-ss").unwrap();
        let i = b.iter().position(|x| x == "-i").unwrap();
        assert!(ss > i, "accurate seek goes after the input when burning text subtitles");
    }

    #[test]
    fn trim_that_removes_nothing_is_ignored() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.trim = Some(Trim { start: 0.0, end: 600.0 });
        assert!(!has(&one(&s), "-ss"));
        s.trim = Some(Trim { start: 10.0, end: 10.01 });
        assert!(!has(&one(&s), "-t"));
        s.trim = Some(Trim { start: 500.0, end: 99999.0 });
        assert_eq!(plan(&s, &media(), &opts()).unwrap().duration, 100.0);
    }

    #[test]
    fn filter_chain_order() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.settings.filters = Filters {
            denoise: Strength::Medium,
            deinterlace: Deinterlace::Bwdif,
            rotate: Rotate::Cw90,
            flip_h: true,
            flip_v: false,
            sharpen: Strength::Light,
        };
        s.settings.video.crop = CropMode::Manual { w: 1920, h: 800, x: 0, y: 140 };
        s.settings.video.resolution = Resolution::Height { value: 400 };
        s.settings.video.fps = Fps::Fixed { value: 29.97 };
        let p = plan(&s, &media(), &opts()).unwrap();
        assert_eq!(
            val(&p.passes[0], "-vf"),
            Some("bwdif=0:-1:0,crop=1920:800:0:140,scale=960:400:flags=lanczos,transpose=1,hflip,hqdn3d=3:3:6:6,unsharp=5:5:0.5:5:5:0.0,fps=30000/1001")
        );
        // Rotated by 90°, so width and height swap.
        assert_eq!((p.width, p.height), (400, 960));
    }

    #[test]
    fn geometry_rules() {
        let m = media();
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        // Never upscale.
        s.settings.video.resolution = Resolution::Height { value: 2160 };
        assert_eq!(geometry(&s, &m).scale, None);
        // Same fps as source adds no filter.
        s.settings.video.fps = Fps::Fixed { value: 23.976 };
        assert!(!has(&one(&s), "-vf"));
        // Auto crop without a detection result does nothing.
        s.settings.video.crop = CropMode::Auto;
        assert_eq!(geometry(&s, &m).crop, None);
        s.auto_crop = Some(Crop { w: 1920, h: 804, x: 0, y: 138 });
        assert_eq!(geometry(&s, &m).crop, Some(Crop { w: 1920, h: 804, x: 0, y: 138 }));
        // A crop outside the frame is clamped, an all-frame crop is dropped.
        s.settings.video.crop = CropMode::Manual { w: 4000, h: 4000, x: 0, y: 0 };
        assert_eq!(geometry(&s, &m).crop, None);
        s.settings.video.crop = CropMode::Manual { w: 4000, h: 500, x: 100, y: 0 };
        assert_eq!(geometry(&s, &m).crop, Some(Crop { w: 1820, h: 500, x: 100, y: 0 }));
        // Phone footage: rotation metadata swaps the displayed size.
        let mut phone = media();
        phone.video.as_mut().unwrap().rotation = -90;
        let g = geometry(&spec(VideoEncoder::X264, Container::Mp4), &phone);
        assert_eq!((g.width, g.height), (1080, 1920));
    }

    #[test]
    fn audio_tracks_and_container_rules() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.audio_tracks = vec![
            AudioTrack { order: 0, codec: AudioCodec::Copy, bitrate_kbps: 0, mixdown: Mixdown::Source },
            AudioTrack { order: 1, codec: AudioCodec::Copy, bitrate_kbps: 0, mixdown: Mixdown::Source },
            AudioTrack { order: 9, codec: AudioCodec::Aac, bitrate_kbps: 128, mixdown: Mixdown::Stereo },
        ];
        let p = plan(&s, &media(), &opts()).unwrap();
        let a = &p.passes[0];
        // DTS cannot be copied into MP4 → AAC; AAC can.
        assert_eq!(val(a, "-c:a:0"), Some("aac"));
        assert_eq!(val(a, "-c:a:1"), Some("copy"));
        assert!(!has(a, "-c:a:2"));
        assert_eq!(p.warnings.len(), 2, "{:?}", p.warnings);

        // MKV takes anything.
        s.settings.container = Container::Mkv;
        s.output = "C:/out/movie.mkv".into();
        let a = one(&s);
        assert_eq!(val(&a, "-c:a:0"), Some("copy"));
    }

    #[test]
    fn audio_mixdown_and_opus_layout_fix() {
        let mut s = spec(VideoEncoder::SvtAv1, Container::Webm);
        s.audio_tracks = vec![
            AudioTrack { order: 0, codec: AudioCodec::Opus, bitrate_kbps: 256, mixdown: Mixdown::Source },
            AudioTrack { order: 0, codec: AudioCodec::Aac, bitrate_kbps: 128, mixdown: Mixdown::Stereo },
            AudioTrack { order: 1, codec: AudioCodec::Opus, bitrate_kbps: 96, mixdown: Mixdown::Surround51 },
        ];
        let a = one(&s);
        assert_eq!(val(&a, "-c:a:0"), Some("libopus"));
        assert_eq!(val(&a, "-filter:a:0"), Some("aformat=channel_layouts=5.1"));
        // WebM forces Opus.
        assert_eq!(val(&a, "-c:a:1"), Some("libopus"));
        assert_eq!(val(&a, "-ac:a:1"), Some("2"));
        // Stereo source is not blown up to 5.1.
        assert!(!has(&a, "-ac:a:2"));
    }

    #[test]
    fn subtitle_copy_rules() {
        let subs = vec![
            SubtitleTrack { order: 0, mode: SubtitleMode::Copy, default: true },
            SubtitleTrack { order: 1, mode: SubtitleMode::Copy, default: false },
        ];
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.subtitle_tracks = subs.clone();
        let p = plan(&s, &media(), &opts()).unwrap();
        let a = &p.passes[0];
        assert_eq!(val(a, "-c:s:0"), Some("mov_text"));
        assert_eq!(val(a, "-disposition:s:0"), Some("default"));
        assert!(!has(a, "-c:s:1"), "bitmap subtitles cannot go into MP4");
        assert!(p.warnings.iter().any(|w| w.contains("picture-based")));

        s.settings.container = Container::Mkv;
        s.output = "C:/out/movie.mkv".into();
        let a = one(&s);
        assert_eq!(val(&a, "-c:s:0"), Some("copy"));
        assert_eq!(val(&a, "-c:s:1"), Some("copy"));
        assert_eq!(val(&a, "-disposition:s:1"), Some("0"));
    }

    #[test]
    fn burn_in_text_and_bitmap() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.input = r"C:\My Videos\it's here.mkv".into();
        s.subtitle_tracks = vec![SubtitleTrack { order: 0, mode: SubtitleMode::Burn, default: false }];
        let a = one(&s);
        assert_eq!(val(&a, "-vf"), Some(r"subtitles='C\:/My Videos/it\'\''s here.mkv':si=0"));
        assert!(!has(&a, "-c:s:0"), "a burned track is not also copied");

        s.subtitle_tracks = vec![SubtitleTrack { order: 1, mode: SubtitleMode::Burn, default: false }];
        s.settings.video.resolution = Resolution::Height { value: 720 };
        let a = one(&s);
        assert_eq!(
            val(&a, "-filter_complex"),
            Some("[0:v:0][0:s:1]overlay[ov];[ov]scale=1280:720:flags=lanczos[vout]")
        );
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "[vout]"));
        assert!(!has(&a, "-vf"));
    }

    #[test]
    fn hdr_keep_and_tonemap() {
        let mut m = media();
        let v = m.video.as_mut().unwrap();
        v.is_hdr = true;
        v.bit_depth = 10;
        v.pix_fmt = "yuv420p10le".into();
        v.color_transfer = Some("smpte2084".into());
        v.color_primaries = Some("bt2020".into());
        v.color_space = Some("bt2020nc".into());

        let mut s = spec(VideoEncoder::X265, Container::Mkv);
        let keep = plan(&s, &m, &opts()).unwrap();
        assert_eq!(val(&keep.passes[0], "-color_trc"), Some("smpte2084"));
        assert_eq!(val(&keep.passes[0], "-pix_fmt"), Some("yuv420p10le"));

        s.settings.video.hdr = HdrMode::Tonemap;
        let tm = plan(&s, &m, &opts()).unwrap();
        assert!(val(&tm.passes[0], "-vf").unwrap().contains("tonemap=tonemap=hable"));
        assert_eq!(val(&tm.passes[0], "-color_trc"), Some("bt709"));
        assert_eq!(val(&tm.passes[0], "-pix_fmt"), Some("yuv420p"));
    }

    #[test]
    fn stream_copy_ignores_filters() {
        let mut s = spec(VideoEncoder::Copy, Container::Mkv);
        s.settings.video.resolution = Resolution::Height { value: 480 };
        let p = plan(&s, &media(), &opts()).unwrap();
        let a = &p.passes[0];
        assert_eq!(val(a, "-c:v"), Some("copy"));
        assert!(!has(a, "-vf") && !has(a, "-pix_fmt") && !has(a, "-crf"));
        assert!(p.warnings.iter().any(|w| w.contains("copied without re-encoding")));
    }

    #[test]
    fn rejects_bad_jobs() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.output = s.input.clone();
        assert!(plan(&s, &media(), &opts()).is_err());

        assert!(plan(&spec(VideoEncoder::X264, Container::Webm), &media(), &opts()).is_err());

        let mut audio_only = media();
        audio_only.video = None;
        assert!(plan(&spec(VideoEncoder::X264, Container::Mp4), &audio_only, &opts()).is_err());
    }

    #[test]
    fn metadata_and_chapters_can_be_dropped() {
        let mut s = spec(VideoEncoder::X264, Container::Mkv);
        s.settings.keep_chapters = false;
        s.settings.keep_metadata = false;
        let a = one(&s);
        assert_eq!(val(&a, "-map_metadata"), Some("-1"));
        assert_eq!(val(&a, "-map_chapters"), Some("-1"));
    }

    #[test]
    fn sample_spec_pins_bitrate_and_drops_audio() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.settings.video.rate = RateControl::TargetSize { mb: 100.0 };
        s.settings.video.two_pass = true;
        let sample = sample_spec(&s, &media(), 120.0, 3.0, "C:/tmp/s.mkv");
        assert_eq!(sample.settings.video.rate, RateControl::Bitrate { kbps: 1203 });
        assert!(sample.audio_tracks.is_empty());
        assert_eq!(sample.trim, Some(Trim { start: 120.0, end: 123.0 }));
        let p = plan(&sample, &media(), &opts()).unwrap();
        assert_eq!(p.passes.len(), 1);
        assert_eq!(p.duration, 3.0);
    }

    #[test]
    fn joins_clips_into_one() {
        let mut second = media();
        second.file_name = "b.mp4".into();
        second.duration = 30.0;
        second.size_bytes = 5e7;
        second.video.as_mut().unwrap().width = 1280;
        second.video.as_mut().unwrap().height = 720;
        let mut silent = media();
        silent.duration = 12.5;
        silent.audio.clear();

        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.extra_inputs = vec!["C:/in/b.mp4".into(), "C:/in/c.mp4".into()];
        s.trim = Some(Trim { start: 5.0, end: 10.0 });
        s.subtitle_tracks = vec![SubtitleTrack { order: 0, mode: SubtitleMode::Copy, default: true }];
        let o = PlanOptions { joined: vec![second.clone(), silent.clone()], ..opts() };
        let p = plan(&s, &media(), &o).unwrap();
        let a = &p.passes[0];

        // Three inputs, in order.
        let inputs: Vec<&str> = a.windows(2).filter(|w| w[0] == "-i").map(|w| w[1].as_str()).collect();
        assert_eq!(inputs, ["C:/in/movie.mkv", "C:/in/b.mp4", "C:/in/c.mp4"]);
        // Total length; the trim does not apply to a join.
        assert_eq!(p.duration, 642.5);
        assert!(!has(a, "-ss") && !has(a, "-t"));

        let g = val(a, "-filter_complex").unwrap();
        assert!(g.contains("[1:v:0]scale=1920:1080:force_original_aspect_ratio=decrease"), "{g}");
        assert!(g.contains("fps=24000/1001"));
        // The clip without sound gets silence of its own length.
        assert!(g.contains("anullsrc=r=48000:cl=stereo,atrim=duration=12.5[a2]"), "{g}");
        assert!(g.contains("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat]"), "{g}");
        assert!(g.ends_with("[vcat]null[vout]"));
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "[acat]"));
        assert_eq!(val(a, "-c:a"), Some("aac"));
        assert!(!has(a, "-c:s:0"), "subtitles are not carried into a join");
        assert!(p.warnings.iter().any(|w| w.contains("different shapes")));
        assert!(!p.hwaccel);

        // Scaling applies to the joined result; no audio at all drops the audio leg.
        s.settings.video.resolution = Resolution::Height { value: 720 };
        s.audio_tracks.clear();
        let p = plan(&s, &media(), &o).unwrap();
        let g = val(&p.passes[0], "-filter_complex").unwrap();
        assert!(g.contains("concat=n=3:v=1:a=0[vcat]") && g.ends_with("[vcat]scale=1280:720:flags=lanczos[vout]"), "{g}");
        assert!(!has(&p.passes[0], "-c:a"));

        // A size target is spread over the whole joined length.
        s.settings.video.rate = RateControl::TargetSize { mb: 100.0 };
        let p = plan(&s, &media(), &o).unwrap();
        assert_eq!(p.video_kbps, Some(target_video_kbps(100.0, 642.5, 0.0)));
    }

    #[test]
    fn join_rejects_what_cannot_work() {
        let mut s = spec(VideoEncoder::X264, Container::Mp4);
        s.extra_inputs = vec!["C:/in/b.mp4".into()];
        // Media for the second clip is missing.
        assert!(plan(&s, &media(), &opts()).is_err());
        let o = PlanOptions { joined: vec![media()], ..opts() };
        assert!(plan(&s, &media(), &o).is_ok());

        s.settings.video.encoder = VideoEncoder::Copy;
        assert!(plan(&s, &media(), &o).unwrap_err().to_string().contains("Copy"));
        s.settings.video.encoder = VideoEncoder::X264;

        s.output = "C:/in/b.mp4".into();
        assert!(plan(&s, &media(), &o).is_err());
        s.output = "C:/out/joined.mp4".into();

        let mut audio_only = media();
        audio_only.video = None;
        audio_only.file_name = "song.mp3".into();
        let err = plan(&s, &media(), &PlanOptions { joined: vec![audio_only], ..opts() }).unwrap_err();
        assert!(err.to_string().contains("song.mp3"));
    }

    #[test]
    fn joined_media_adds_up() {
        let mut b = media();
        b.duration = 100.0;
        b.size_bytes = 1e8;
        let whole = joined_media(&media(), &[b.clone(), b]);
        assert_eq!(whole.duration, 800.0);
        assert_eq!(whole.size_bytes, 1.2e9);
        assert_eq!(whole.file_name, "movie.mkv + 2 more");
        assert_eq!(whole.video.unwrap().width, 1920);
    }

    #[test]
    fn command_line_quotes_spaces() {
        let line = to_command_line("ffmpeg", &["-i".into(), "C:/My Videos/a.mp4".into(), "out.mp4".into()]);
        assert_eq!(line, "ffmpeg -i \"C:/My Videos/a.mp4\" out.mp4");
    }
}
