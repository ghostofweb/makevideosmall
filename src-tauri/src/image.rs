//! Image Studio: compress, hit a target size, or AI-upscale still images.

use crate::error::{AppError, Result};
use crate::ffmpeg::locate::Tools;
use crate::ffmpeg::runner::{capture, last_line, JobControl};
use crate::model::*;
use crate::util::{emit, EventSink};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Semaphore;

/// Largest input (in pixels) the 4× upscaler accepts: roughly 4K.
const UPSCALE_PIXEL_LIMIT: u64 = 8_500_000;

/// Read an image's size and metadata tags.
pub async fn probe_image(tools: &Tools, path: &str) -> Result<ImageInfo> {
    if !Path::new(path).is_file() {
        return Err(AppError::msg(format!("File not found: {path}")));
    }
    let args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(path.to_string()))
        .collect();
    let out = capture(&tools.ffprobe, &args, None, None).await?;
    if !out.ok {
        return Err(AppError::msg(format!("This file could not be read as an image. {}", last_line(&out.stderr))));
    }
    let root: Value = serde_json::from_str(&out.stdout)?;
    let stream = root["streams"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["codec_type"] == "video"))
        .ok_or_else(|| AppError::msg("This file does not contain an image."))?;
    let mut metadata = BTreeMap::new();
    if let Some(tags) = root["format"]["tags"].as_object() {
        for (k, v) in tags {
            if let Some(v) = v.as_str() {
                metadata.insert(k.clone(), v.to_string());
            }
        }
    }
    Ok(ImageInfo {
        path: path.to_string(),
        file_name: Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        width: stream["width"].as_u64().unwrap_or(0) as u32,
        height: stream["height"].as_u64().unwrap_or(0) as u32,
        size_bytes: std::fs::metadata(path).map(|m| m.len() as f64).unwrap_or(0.0),
        metadata,
    })
}

/// ffmpeg arguments that write `job`'s image at a quality of 1 – 100.
pub fn encode_args(job: &ImageJob, quality: u32, output: &str, avif_fallback: bool) -> Vec<String> {
    let quality = quality.clamp(1, 100);
    let mut a: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push(job.input.clone());

    // Outputs never carry metadata. `-map_metadata -1` drops container tags;
    // the side-data filter drops EXIF (camera, GPS), which ffmpeg would
    // otherwise copy into PNG files regardless.
    a.extend(["-map_metadata".into(), "-1".into(), "-vf".into(), "sidedata=mode=delete".into()]);
    a.extend(["-frames:v".into(), "1".into()]);
    match job.format {
        ImageFormat::Webp => a.extend(["-c:v".into(), "libwebp".into(), "-quality".into(), quality.to_string()]),
        ImageFormat::Avif => {
            // CRF: 0 is lossless, 63 is worst. Quality 100 → 0, quality 1 → 62.
            let crf = (63.0 - quality as f64 * 0.63).round() as u32;
            if avif_fallback {
                // libaom handles images SVT-AV1 refuses (smaller than 64 px).
                a.extend([
                    "-c:v".into(), "libaom-av1".into(), "-still-picture".into(), "1".into(),
                    "-crf".into(), crf.to_string(), "-b:v".into(), "0".into(), "-cpu-used".into(), "6".into(),
                    "-pix_fmt".into(), "yuv420p".into(),
                ]);
            } else {
                a.extend([
                    "-c:v".into(), "libsvtav1".into(), "-crf".into(), crf.to_string(),
                    "-preset".into(), "6".into(), "-pix_fmt".into(), "yuv420p".into(),
                ]);
            }
        }
        ImageFormat::Jpg => {
            // q:v 2 is best, 31 is worst.
            let q = (31.0 - quality as f64 * 0.29).round().clamp(2.0, 31.0) as u32;
            a.extend(["-q:v".into(), q.to_string(), "-pix_fmt".into(), "yuvj420p".into()]);
        }
        ImageFormat::Png => a.extend(["-c:v".into(), "png".into(), "-compression_level".into(), "9".into()]),
    }
    a.push(output.to_string());
    a
}

async fn encode_once(tools: &Tools, job: &ImageJob, quality: u32, output: &Path, control: &JobControl) -> Result<f64> {
    let out_str = output.to_string_lossy();
    let mut result = capture(&tools.ffmpeg, &encode_args(job, quality, &out_str, false), None, Some(control)).await?;
    if !result.ok && job.format == ImageFormat::Avif {
        result = capture(&tools.ffmpeg, &encode_args(job, quality, &out_str, true), None, Some(control)).await?;
    }
    let size = std::fs::metadata(output).map(|m| m.len() as f64).unwrap_or(0.0);
    if !result.ok || size <= 0.0 {
        let _ = std::fs::remove_file(output);
        return Err(AppError::msg(format!("Could not write the image: {}", last_line(&result.stderr))));
    }
    Ok(size)
}

/// What the size search found.
pub struct TargetResult {
    pub bytes: f64,
    pub quality: u32,
    /// Even the lowest quality is larger than the target.
    pub missed: bool,
}

/// Binary-search the quality scale for the best image that fits under
/// `target_kb`. Falls back to the closest result if nothing fits.
pub async fn fit_to_size(
    tools: &Tools,
    job: &ImageJob,
    target_kb: u32,
    temp_dir: &Path,
    control: &JobControl,
    mut on_step: impl FnMut(u32, u32),
) -> Result<TargetResult> {
    std::fs::create_dir_all(temp_dir)?;
    let target = target_kb as f64 * 1024.0;
    let uid = uuid::Uuid::new_v4().simple().to_string();
    let ext = job.format.ext();
    let (mut lo, mut hi) = (1u32, 100u32);
    // (path, bytes, quality)
    let mut best_under: Option<(PathBuf, f64, u32)> = None;
    let mut smallest: Option<(PathBuf, f64, u32)> = None;
    let mut step = 0u32;

    let outcome: Result<()> = async {
        while lo <= hi && step < 8 {
            step += 1;
            let q = (lo + hi) / 2;
            on_step(step, q);
            let path = temp_dir.join(format!("mvs_img_{uid}_{step}.{ext}"));
            let bytes = encode_once(tools, job, q, &path, control).await?;

            let mut keep = false;
            if bytes <= target {
                if best_under.as_ref().map(|b| q > b.2).unwrap_or(true) {
                    if let Some(old) = best_under.replace((path.clone(), bytes, q)) {
                        let _ = std::fs::remove_file(old.0);
                    }
                    keep = true;
                }
                // Within 3% under the target is good enough.
                if bytes >= target * 0.97 {
                    break;
                }
                lo = q + 1;
            } else {
                if smallest.as_ref().map(|s| bytes < s.1).unwrap_or(true) {
                    if let Some(old) = smallest.replace((path.clone(), bytes, q)) {
                        let _ = std::fs::remove_file(old.0);
                    }
                    keep = true;
                }
                if q == 1 {
                    break;
                }
                hi = q - 1;
            }
            if !keep {
                let _ = std::fs::remove_file(&path);
            }
        }
        Ok(())
    }
    .await;

    let missed = best_under.is_none();
    let winner = best_under.take().or_else(|| smallest.take());
    // Whatever was not chosen is temporary.
    for leftover in [best_under, smallest].into_iter().flatten() {
        let _ = std::fs::remove_file(leftover.0);
    }
    if let Err(e) = outcome {
        if let Some(w) = winner {
            let _ = std::fs::remove_file(w.0);
        }
        return Err(e);
    }
    let (path, bytes, quality) = winner.ok_or_else(|| AppError::msg("No image could be produced."))?;
    if let Some(dir) = Path::new(&job.output).parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::rename(&path, &job.output).is_err() {
        // Different drive: copy instead.
        std::fs::copy(&path, &job.output)?;
        let _ = std::fs::remove_file(&path);
    }
    Ok(TargetResult { bytes, quality, missed })
}

/// 4× upscale with Real-ESRGAN. Tries the GPU first, then the CPU.
pub async fn upscale(tools: &Tools, job: &ImageJob, control: &JobControl, mut on_stage: impl FnMut(f64, &str)) -> Result<()> {
    let upscaler = tools
        .upscaler
        .as_ref()
        .ok_or_else(|| AppError::msg("The AI upscaler (Real-ESRGAN) is not installed with this copy of the app."))?;
    let info = probe_image(tools, &job.input).await?;
    let pixels = info.width as u64 * info.height as u64;
    if pixels > UPSCALE_PIXEL_LIMIT {
        return Err(AppError::msg(format!(
            "This image is already {}×{} ({:.1} MP). Upscaling images of 4K or larger is not supported.",
            info.width,
            info.height,
            pixels as f64 / 1e6
        )));
    }
    let models = upscaler.parent().map(|d| d.join("models")).unwrap_or_default();
    let base: Vec<String> = vec![
        "-i".into(), job.input.clone(),
        "-o".into(), job.output.clone(),
        "-n".into(), "realesrgan-x4plus".into(),
        "-s".into(), "4".into(),
        "-m".into(), models.to_string_lossy().into_owned(),
    ];

    let mut last_error = String::new();
    for (gpu, progress, label) in [("0", 20.0, "Upscaling on the GPU"), ("-1", 30.0, "GPU failed; upscaling on the CPU (slower)")] {
        on_stage(progress, label);
        let mut args = base.clone();
        args.extend(["-g".into(), gpu.into()]);
        let out = capture(upscaler, &args, None, Some(control)).await?;
        let produced = std::fs::metadata(&job.output).map(|m| m.len() > 0).unwrap_or(false);
        if out.ok && produced {
            return Ok(());
        }
        last_error = last_line(&out.stderr);
        let _ = std::fs::remove_file(&job.output);
    }
    Err(AppError::msg(format!("AI upscaling failed on both the GPU and the CPU. {last_error}")))
}

/// Process one image job start to finish.
async fn process(tools: &Tools, job: &ImageJob, temp_dir: &Path, control: &JobControl, sink: &dyn EventSink) -> Result<(f64, Option<String>)> {
    if job.input == job.output {
        return Err(AppError::msg("The output file would overwrite the original image."));
    }
    if let Some(dir) = Path::new(&job.output).parent() {
        std::fs::create_dir_all(dir)?;
    }
    let original = std::fs::metadata(&job.input).map(|m| m.len() as f64).unwrap_or(0.0);
    let progress = |p: f64, message: &str| {
        emit(sink, "image:event", &ImageEvent {
            id: job.id.clone(),
            kind: "progress".into(),
            progress: p,
            message: message.to_string(),
            output: None,
            original_bytes: original,
            new_bytes: 0.0,
        });
    };

    match &job.action {
        ImageAction::Compress { quality } => {
            progress(40.0, "Compressing");
            let bytes = encode_once(tools, job, *quality, Path::new(&job.output), control).await?;
            Ok((bytes, None))
        }
        ImageAction::Target { kb } => {
            let result = fit_to_size(tools, job, *kb, temp_dir, control, |step, q| {
                progress(10.0 + step as f64 * 10.0, &format!("Searching for the best quality (step {step}, quality {q})"));
            })
            .await?;
            let warning = result.missed.then(|| {
                format!(
                    "Could not get under {kb} KB: the smallest possible result is {:.0} KB. Try a larger target or AVIF.",
                    result.bytes / 1024.0
                )
            });
            Ok((result.bytes, warning))
        }
        ImageAction::Upscale => {
            upscale(tools, job, control, |p, label| progress(p, label)).await?;
            let bytes = std::fs::metadata(&job.output).map(|m| m.len() as f64).unwrap_or(0.0);
            Ok((bytes, None))
        }
    }
}

/// Runs batches of image jobs in the background.
pub struct ImageRunner {
    tools: Option<Tools>,
    temp_dir: PathBuf,
    sink: Arc<dyn EventSink>,
    runtime: tokio::runtime::Handle,
    control: Mutex<Arc<JobControl>>,
}

impl ImageRunner {
    pub fn new(tools: Option<Tools>, temp_dir: PathBuf, sink: Arc<dyn EventSink>, runtime: tokio::runtime::Handle) -> Self {
        ImageRunner { tools, temp_dir, sink, runtime, control: Mutex::new(Arc::new(JobControl::new())) }
    }

    /// Start a batch. Returns straight away; progress arrives as
    /// `image:event` events and the batch ends with `image:batch-done`.
    pub fn start(&self, jobs: Vec<ImageJob>) -> Result<()> {
        let tools = self.tools.clone().ok_or(AppError::FfmpegMissing)?;
        let control = Arc::new(JobControl::new());
        *self.control.lock() = control.clone();
        let sink = self.sink.clone();
        let temp_dir = self.temp_dir.clone();
        let handle = self.runtime.clone();

        // Encoding images is quick, so several can run at once. The upscaler
        // needs the whole GPU, so those run one at a time.
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let light = Arc::new(Semaphore::new((cores / 2).clamp(1, 6)));
        let heavy = Arc::new(Semaphore::new(1));

        self.runtime.spawn(async move {
            let mut tasks = Vec::new();
            for job in jobs {
                let (tools, control, sink, temp_dir) = (tools.clone(), control.clone(), sink.clone(), temp_dir.clone());
                let gate = if matches!(job.action, ImageAction::Upscale) { heavy.clone() } else { light.clone() };
                tasks.push(handle.spawn(async move {
                    let _permit = gate.acquire().await;
                    let original = std::fs::metadata(&job.input).map(|m| m.len() as f64).unwrap_or(0.0);
                    let mut event = ImageEvent {
                        id: job.id.clone(),
                        kind: "error".into(),
                        progress: 100.0,
                        message: String::new(),
                        output: None,
                        original_bytes: original,
                        new_bytes: 0.0,
                    };
                    if control.is_cancelled() {
                        event.message = "Cancelled".into();
                        emit(&*sink, "image:event", &event);
                        return;
                    }
                    match process(&tools, &job, &temp_dir, &control, &*sink).await {
                        Ok((bytes, warning)) => {
                            event.kind = "done".into();
                            event.new_bytes = bytes;
                            event.output = Some(job.output.clone());
                            event.message = warning.unwrap_or_default();
                        }
                        Err(e) => event.message = e.to_string(),
                    }
                    emit(&*sink, "image:event", &event);
                }));
            }
            for task in tasks {
                let _ = task.await;
            }
            emit(&*sink, "image:batch-done", &control.is_cancelled());
        });
        Ok(())
    }

    pub fn cancel(&self) {
        self.control.lock().cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(format: ImageFormat) -> ImageJob {
        ImageJob {
            id: "1".into(),
            input: "C:/in/photo.png".into(),
            output: "C:/out/photo.webp".into(),
            action: ImageAction::Compress { quality: 80 },
            format,
        }
    }

    fn val<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    #[test]
    fn quality_mapping_per_format() {
        let webp = encode_args(&job(ImageFormat::Webp), 80, "o.webp", false);
        assert_eq!(val(&webp, "-c:v"), Some("libwebp"));
        assert_eq!(val(&webp, "-quality"), Some("80"));

        let avif = encode_args(&job(ImageFormat::Avif), 100, "o.avif", false);
        assert_eq!(val(&avif, "-c:v"), Some("libsvtav1"));
        assert_eq!(val(&avif, "-crf"), Some("0"));
        assert_eq!(val(&encode_args(&job(ImageFormat::Avif), 50, "o.avif", false), "-crf"), Some("32"));
        assert_eq!(val(&encode_args(&job(ImageFormat::Avif), 50, "o.avif", true), "-c:v"), Some("libaom-av1"));

        assert_eq!(val(&encode_args(&job(ImageFormat::Jpg), 100, "o.jpg", false), "-q:v"), Some("2"));
        assert_eq!(val(&encode_args(&job(ImageFormat::Jpg), 1, "o.jpg", false), "-q:v"), Some("31"));
        // Out-of-range quality is clamped.
        assert_eq!(val(&encode_args(&job(ImageFormat::Webp), 500, "o.webp", false), "-quality"), Some("100"));
    }

    #[test]
    fn metadata_is_always_stripped() {
        for format in [ImageFormat::Webp, ImageFormat::Avif, ImageFormat::Jpg, ImageFormat::Png] {
            let args = encode_args(&job(format), 80, "o.img", false);
            assert_eq!(val(&args, "-map_metadata"), Some("-1"), "{format:?}");
            assert_eq!(val(&args, "-vf"), Some("sidedata=mode=delete"), "{format:?}");
            assert_eq!(args.last().unwrap(), "o.img");
        }
    }
}
