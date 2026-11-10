//! Source analysis, size/time estimates and preview clips.

use crate::error::{AppError, Result};
use crate::ffmpeg::command::{
    self, audio_kbps_total, display_size, effective_trim, frame_args, output_duration, plan,
    reference_clip_args, resolved_video_kbps, sample_spec, web_playable_args, PlanOptions,
};
use crate::ffmpeg::locate::Tools;
use crate::ffmpeg::runner::{capture, last_line, JobControl};
use crate::model::*;
use crate::util::join_all;
use std::path::Path;
use std::time::Instant;

// ───────────────────────────── Black-bar detection ─────────────────────────────

/// All `crop=W:H:X:Y` values printed by ffmpeg's cropdetect filter.
pub fn parse_cropdetect(stderr: &str) -> Vec<Crop> {
    let mut found = Vec::new();
    for line in stderr.lines() {
        let Some(pos) = line.rfind("crop=") else { continue };
        let nums: Vec<i64> = line[pos + 5..]
            .split(|c: char| c == ':' || c.is_whitespace())
            .take(4)
            .filter_map(|n| n.parse::<i64>().ok())
            .collect();
        if let [w, h, x, y] = nums[..] {
            // cropdetect reports negative sizes for fully black frames.
            if w > 0 && h > 0 && x >= 0 && y >= 0 {
                found.push(Crop { w: w as u32, h: h as u32, x: x as u32, y: y as u32 });
            }
        }
    }
    found
}

/// Smallest box that contains every detected picture area. Using the union
/// means one dark scene can never crop into real content.
pub fn union_crop(crops: &[Crop], width: u32, height: u32) -> Option<Crop> {
    if crops.is_empty() {
        return None;
    }
    let left = crops.iter().map(|c| c.x).min()?;
    let top = crops.iter().map(|c| c.y).min()?;
    let right = crops.iter().map(|c| c.x + c.w).max()?.min(width);
    let bottom = crops.iter().map(|c| c.y + c.h).max()?.min(height);
    if right <= left || bottom <= top {
        return None;
    }
    let (w, h) = (right - left, bottom - top);
    // Ignore slivers: bars thinner than 16 px in both directions are noise.
    if w + 16 > width && h + 16 > height {
        return None;
    }
    // Refuse absurd results (more than 60% of either dimension removed).
    if (w as f64) < width as f64 * 0.4 || (h as f64) < height as f64 * 0.4 {
        return None;
    }
    Some(Crop { w: w & !1, h: h & !1, x: left, y: top })
}

/// Look for black bars at three points in the file.
pub async fn detect_crop(tools: &Tools, media: &MediaInfo, control: Option<&JobControl>) -> Result<Option<Crop>> {
    let Some(v) = media.video.as_ref() else { return Ok(None) };
    let (width, height) = display_size(v);
    let duration = media.duration.max(0.0);
    let stamps: Vec<f64> = if duration < 6.0 {
        vec![0.0]
    } else {
        vec![duration * 0.2, duration * 0.5, duration * 0.8]
    };
    let window = if duration < 6.0 { duration.max(0.5) } else { 2.0 };

    let runs = stamps.iter().map(|&at| {
        let args: Vec<String> = vec![
            "-hide_banner".into(), "-nostdin".into(),
            "-ss".into(), format!("{at:.3}"),
            "-i".into(), media.path.clone(),
            "-t".into(), format!("{window:.3}"),
            "-vf".into(), "cropdetect=limit=24:round=2:reset=0".into(),
            "-an".into(), "-sn".into(), "-f".into(), "null".into(), "-".into(),
        ];
        async move { capture(&tools.ffmpeg, &args, None, control).await }
    });

    let mut crops = Vec::new();
    for out in join_all(runs.collect()).await {
        // Keep only the settled value from each sample.
        if let Some(last) = parse_cropdetect(&out?.stderr).last() {
            crops.push(*last);
        }
    }
    Ok(union_crop(&crops, width, height))
}

// ───────────────────────────── Noise ─────────────────────────────

/// Bit planes sampled for the noise score. Low planes saturate with any
/// noise at all; these three separate "a little" from "a lot".
const NOISE_PLANES: [u32; 3] = [3, 4, 5];

/// Noise score from ffmpeg's `bitplanenoise` metadata: the mean randomness of
/// luma bit planes 3, 4 and 5 added together (0 = clean, 3 = pure noise).
pub fn parse_bitplane_noise(text: &str) -> Option<f64> {
    let mut score = 0.0;
    for plane in NOISE_PLANES {
        let key = format!("lavfi.bitplanenoise.0.{plane}=");
        let values: Vec<f64> = text
            .lines()
            .filter_map(|l| l.trim().strip_prefix(key.as_str()))
            .filter_map(|v| v.trim().parse::<f64>().ok())
            .collect();
        if values.is_empty() {
            return None;
        }
        score += values.iter().sum::<f64>() / values.len() as f64;
    }
    Some(score)
}

/// Map the noise score to a film-grain suggestion.
///
/// Calibrated on synthetic clips: clean 0.10, fine detail 0.44, light noise
/// 2.05, medium 2.79, heavy 2.96.
pub fn classify_noise(noise: Option<f64>) -> (u32, String) {
    match noise {
        None => (0, "Unknown".into()),
        Some(n) if n < 0.35 => (0, "Clean (animation or screen capture)".into()),
        Some(n) if n < 1.2 => (4, "Low noise (modern digital)".into()),
        Some(n) if n < 2.5 => (8, "Moderate noise".into()),
        Some(_) => (12, "Heavy grain or noise".into()),
    }
}

async fn measure_noise(tools: &Tools, media: &MediaInfo, control: Option<&JobControl>) -> Option<f64> {
    let at = (media.duration * 0.3).max(0.0);
    let args: Vec<String> = vec![
        "-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(),
        "-ss".into(), format!("{at:.3}"),
        "-i".into(), media.path.clone(),
        "-t".into(), "1".into(),
        "-vf".into(),
        format!(
            "{},metadata=mode=print:file=-",
            NOISE_PLANES.map(|p| format!("bitplanenoise=bitplane={p}")).join(",")
        ),
        "-an".into(), "-sn".into(), "-f".into(), "null".into(), "-".into(),
    ];
    let out = capture(&tools.ffmpeg, &args, None, control).await.ok()?;
    parse_bitplane_noise(&out.stdout)
}

/// Black bars, noise level and interlacing for one source.
pub async fn analyze_source(tools: &Tools, media: &MediaInfo, control: Option<&JobControl>) -> Result<SourceAnalysis> {
    // Both checks are independent ffmpeg processes, so run them together.
    let (crop, noise) = tokio::join!(detect_crop(tools, media, control), measure_noise(tools, media, control));
    let crop = crop?;
    let (grain_level, noise_profile) = classify_noise(noise);
    Ok(SourceAnalysis {
        crop,
        grain_level,
        noise_profile,
        interlaced: media.video.as_ref().map(|v| v.interlaced).unwrap_or(false),
    })
}

// ───────────────────────────── Estimates ─────────────────────────────

fn savings(size: f64, source: f64) -> f64 {
    if source > 0.0 {
        ((1.0 - size / source) * 100.0 * 10.0).round() / 10.0
    } else {
        0.0
    }
}

/// Share of the source that the job keeps (after a trim), for fair savings.
fn source_bytes_for(spec: &JobSpec, media: &MediaInfo) -> f64 {
    if media.duration > 0.0 {
        media.size_bytes * (output_duration(spec, media) / media.duration).clamp(0.0, 1.0)
    } else {
        media.size_bytes
    }
}

/// Size estimate that needs no encoding: bitrate-driven jobs and stream copy.
pub fn estimate_by_maths(spec: &JobSpec, media: &MediaInfo) -> Option<Estimate> {
    let duration = output_duration(spec, media);
    let audio_kbps = audio_kbps_total(spec, media);
    let video_kbps = if spec.settings.video.encoder == VideoEncoder::Copy {
        media.video.as_ref().map(|v| v.bitrate / 1000.0)?
    } else {
        resolved_video_kbps(spec, media)? as f64
    };
    let size_bytes = (video_kbps + audio_kbps) * 1000.0 / 8.0 * duration;
    Some(Estimate {
        size_bytes,
        savings_percent: savings(size_bytes, source_bytes_for(spec, media)),
        encode_secs: 0.0,
        video_kbps,
        sampled: false,
    })
}

/// Where to take sample clips from: (start offset within the job, length).
pub fn sample_windows(duration: f64) -> Vec<(f64, f64)> {
    if duration <= 0.0 {
        vec![(0.0, 1.0)]
    } else if duration < 12.0 {
        vec![(0.0, duration.min(4.0))]
    } else {
        [0.2, 0.5, 0.8].iter().map(|f| (duration * f, 3.0)).collect()
    }
}

struct Sample {
    bytes: f64,
    secs: f64,
    wall: f64,
}

async fn encode_sample(
    tools: &Tools,
    spec: &JobSpec,
    media: &MediaInfo,
    start: f64,
    length: f64,
    out: &Path,
    hw_decode: bool,
    control: Option<&JobControl>,
) -> Result<Sample> {
    let sample = sample_spec(spec, media, start, length, &out.to_string_lossy());
    let opts = PlanOptions { hw_decode, pass_log: "mvs_sample".into() };
    let plan = plan(&sample, media, &opts)?;
    let args = plan.passes.last().cloned().unwrap_or_default();
    let started = Instant::now();
    let mut result = capture(&tools.ffmpeg, &args, None, control).await?;
    if !result.ok && plan.hwaccel {
        // GPU decode can fail on unusual sources; fall back to software decode.
        let plan = command::plan(&sample, media, &PlanOptions { hw_decode: false, ..opts })?;
        result = capture(&tools.ffmpeg, plan.passes.last().unwrap(), None, control).await?;
    }
    let wall = started.elapsed().as_secs_f64();
    if !result.ok {
        return Err(AppError::msg(format!("The test encode failed: {}", last_line(&result.stderr))));
    }
    let bytes = std::fs::metadata(out).map(|m| m.len() as f64).unwrap_or(0.0);
    if bytes <= 0.0 {
        return Err(AppError::msg("The test encode produced no output."));
    }
    Ok(Sample { bytes, secs: plan.duration.max(0.1), wall })
}

fn estimate_from_samples(spec: &JobSpec, media: &MediaInfo, samples: &[Sample]) -> Estimate {
    let duration = output_duration(spec, media);
    let secs: f64 = samples.iter().map(|s| s.secs).sum();
    let bytes: f64 = samples.iter().map(|s| s.bytes).sum();
    let wall: f64 = samples.iter().map(|s| s.wall).sum();
    // Every sample pays for process start-up and encoder initialisation once;
    // a full encode pays it once in total.
    let overhead = 0.35 * samples.len() as f64;
    let video_bytes = bytes / secs * duration;
    let audio_bytes = audio_kbps_total(spec, media) * 1000.0 / 8.0 * duration;
    let size_bytes = video_bytes + audio_bytes;
    Estimate {
        size_bytes,
        savings_percent: savings(size_bytes, source_bytes_for(spec, media)),
        encode_secs: ((wall - overhead).max(wall * 0.3) / secs * duration).max(1.0),
        video_kbps: bytes * 8.0 / secs / 1000.0,
        sampled: true,
    }
}

/// Estimate final size and encode time for a job.
///
/// Quality-based jobs are measured by encoding short samples from three places
/// in the file; bitrate-driven jobs are plain arithmetic.
pub async fn estimate(
    tools: &Tools,
    spec: &JobSpec,
    media: &MediaInfo,
    temp_dir: &Path,
    hw_decode: bool,
    control: Option<&JobControl>,
    mut on_progress: impl FnMut(f64, &str),
) -> Result<Estimate> {
    if let Some(e) = estimate_by_maths(spec, media) {
        // Still time one sample so the UI can show how long it will take.
        on_progress(10.0, "Timing a sample");
        let windows = sample_windows(output_duration(spec, media));
        let (start, length) = windows[windows.len() / 2];
        let out = temp_dir.join(format!("mvs_est_{}.mkv", uuid::Uuid::new_v4().simple()));
        let timed = encode_sample(tools, spec, media, start, length, &out, hw_decode, control).await;
        let _ = std::fs::remove_file(&out);
        let mut e = e;
        if let Ok(s) = timed {
            e.encode_secs = estimate_from_samples(spec, media, &[s]).encode_secs;
        }
        on_progress(100.0, "Done");
        return Ok(e);
    }

    std::fs::create_dir_all(temp_dir)?;
    let windows = sample_windows(output_duration(spec, media));
    let mut samples = Vec::new();
    for (i, (start, length)) in windows.iter().enumerate() {
        on_progress(
            i as f64 / windows.len() as f64 * 100.0,
            &format!("Encoding sample {} of {}", i + 1, windows.len()),
        );
        let out = temp_dir.join(format!("mvs_est_{}.mkv", uuid::Uuid::new_v4().simple()));
        let sample = encode_sample(tools, spec, media, *start, *length, &out, hw_decode, control).await;
        let _ = std::fs::remove_file(&out);
        samples.push(sample?);
    }
    on_progress(100.0, "Done");
    Ok(estimate_from_samples(spec, media, &samples))
}

// ───────────────────────────── Preview clips ─────────────────────────────

/// Encode a short clip with the job's settings and a matching reference clip,
/// both in a format the app's web view can always play.
pub async fn render_preview(
    tools: &Tools,
    spec: &JobSpec,
    media: &MediaInfo,
    at: f64,
    length: f64,
    temp_dir: &Path,
    hw_decode: bool,
    control: Option<&JobControl>,
    mut on_progress: impl FnMut(f64, &str),
) -> Result<PreviewPair> {
    std::fs::create_dir_all(temp_dir)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let job_start = effective_trim(spec, media).map(|t| t.start).unwrap_or(0.0);
    let job_len = output_duration(spec, media);
    let length = length.clamp(1.0, 10.0).min(job_len.max(1.0));
    // `at` is a position in the source; keep the clip inside the job's range.
    let start = at.clamp(job_start, (job_start + job_len - length).max(job_start));

    on_progress(5.0, "Rendering the original");
    let original = temp_dir.join(format!("mvs_prev_{id}_orig.mp4"));
    let reference = reference_clip_args(spec, media, start, length, &original.to_string_lossy());
    let out = capture(&tools.ffmpeg, &reference, None, control).await?;
    if !out.ok {
        return Err(AppError::msg(format!("Could not render the preview: {}", last_line(&out.stderr))));
    }

    on_progress(35.0, "Encoding with your settings");
    let master = temp_dir.join(format!("mvs_prev_{id}_enc.mkv"));
    let sample = encode_sample(tools, spec, media, start - job_start, length, &master, hw_decode, control).await?;

    on_progress(80.0, "Preparing playback");
    let encoded = temp_dir.join(format!("mvs_prev_{id}_enc.mp4"));
    let web = capture(
        &tools.ffmpeg,
        &web_playable_args(&master.to_string_lossy(), &encoded.to_string_lossy()),
        None,
        control,
    )
    .await?;
    let _ = std::fs::remove_file(&master);
    if !web.ok {
        return Err(AppError::msg(format!("Could not prepare the preview: {}", last_line(&web.stderr))));
    }

    let estimate = estimate_by_maths(spec, media)
        .map(|mut e| {
            e.encode_secs = estimate_from_samples(spec, media, std::slice::from_ref(&sample)).encode_secs;
            e
        })
        .unwrap_or_else(|| estimate_from_samples(spec, media, std::slice::from_ref(&sample)));

    on_progress(100.0, "Done");
    Ok(PreviewPair {
        original: original.to_string_lossy().into_owned(),
        encoded: encoded.to_string_lossy().into_owned(),
        start,
        duration: length,
        encoded_bytes: sample.bytes,
        estimate,
    })
}

/// Write one still frame (with crop/scale/rotate/filters applied) as a JPEG.
pub async fn render_frame(
    tools: &Tools,
    spec: &JobSpec,
    media: &MediaInfo,
    at: f64,
    max_width: u32,
    out: &Path,
) -> Result<()> {
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let at = at.clamp(0.0, (media.duration - 0.1).max(0.0));
    let args = frame_args(spec, media, at, max_width, &out.to_string_lossy());
    let result = capture(&tools.ffmpeg, &args, None, None).await?;
    if !result.ok || !out.is_file() {
        return Err(AppError::msg(format!("Could not read a frame: {}", last_line(&result.stderr))));
    }
    Ok(())
}

/// Delete preview and estimate leftovers from earlier runs.
pub fn clean_temp(temp_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(temp_dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("mvs_") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cropdetect_lines() {
        let log = "[Parsed_cropdetect_0 @ 000] x1:0 x2:1919 y1:138 y2:941 w:1920 h:804 x:0 y:138 pts:1 t:0.04 limit:0.094118 crop=1920:804:0:138\n\
                   [Parsed_cropdetect_0 @ 000] x1:0 x2:1919 y1:140 y2:939 w:1920 h:800 x:0 y:140 pts:2 t:0.08 crop=1920:800:0:140\n\
                   [Parsed_cropdetect_0 @ 000] crop=-1904:-1072:1912:1076\n\
                   frame=   60 fps=0.0 q=-0.0 size=N/A";
        let crops = parse_cropdetect(log);
        assert_eq!(crops, vec![
            Crop { w: 1920, h: 804, x: 0, y: 138 },
            Crop { w: 1920, h: 800, x: 0, y: 140 },
        ]);
    }

    #[test]
    fn union_never_cuts_content() {
        // A dark scene reports a tighter box; the union keeps the larger one.
        let crops = [
            Crop { w: 1920, h: 800, x: 0, y: 140 },
            Crop { w: 1600, h: 600, x: 160, y: 240 },
            Crop { w: 1920, h: 804, x: 0, y: 138 },
        ];
        assert_eq!(union_crop(&crops, 1920, 1080), Some(Crop { w: 1920, h: 804, x: 0, y: 138 }));
        // Full-frame picture → no crop.
        assert_eq!(union_crop(&[Crop { w: 1920, h: 1080, x: 0, y: 0 }], 1920, 1080), None);
        // Thin 4-px bars are ignored.
        assert_eq!(union_crop(&[Crop { w: 1920, h: 1072, x: 0, y: 4 }], 1920, 1080), None);
        // A nearly black sample must not shrink the frame to a postage stamp.
        assert_eq!(union_crop(&[Crop { w: 200, h: 100, x: 800, y: 500 }], 1920, 1080), None);
        assert_eq!(union_crop(&[], 1920, 1080), None);
        // Pillarbox.
        assert_eq!(union_crop(&[Crop { w: 1440, h: 1080, x: 240, y: 0 }], 1920, 1080), Some(Crop { w: 1440, h: 1080, x: 240, y: 0 }));
    }

    #[test]
    fn noise_parsing_and_classes() {
        let text = "frame:0    pts:0       pts_time:0
            lavfi.bitplanenoise.0.3=0.900000
lavfi.bitplanenoise.1.3=0.1
            lavfi.bitplanenoise.0.4=0.600000
lavfi.bitplanenoise.0.5=0.300000
            frame:1    pts:1
            lavfi.bitplanenoise.0.3=1.000000
lavfi.bitplanenoise.0.4=0.800000
lavfi.bitplanenoise.0.5=0.500000
";
        // Means: 0.95 + 0.70 + 0.40
        let n = parse_bitplane_noise(text).unwrap();
        assert!((n - 2.05).abs() < 1e-9, "{n}");
        assert_eq!(parse_bitplane_noise("nothing"), None);
        // A missing plane means the measurement is unusable.
        assert_eq!(parse_bitplane_noise("lavfi.bitplanenoise.0.3=0.5"), None);
        assert_eq!(classify_noise(Some(0.10)).0, 0);
        assert_eq!(classify_noise(Some(0.44)).0, 4);
        assert_eq!(classify_noise(Some(2.05)).0, 8);
        assert_eq!(classify_noise(Some(2.96)).0, 12);
        assert_eq!(classify_noise(None).0, 0);
    }

    #[test]
    fn sample_windows_fit_the_clip() {
        assert_eq!(sample_windows(600.0), vec![(120.0, 3.0), (300.0, 3.0), (480.0, 3.0)]);
        assert_eq!(sample_windows(8.0), vec![(0.0, 4.0)]);
        assert_eq!(sample_windows(2.0), vec![(0.0, 2.0)]);
        assert_eq!(sample_windows(0.0), vec![(0.0, 1.0)]);
    }
}
