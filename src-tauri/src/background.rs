//! Background removal: an AI model finds the subject, ffmpeg cuts it out.
//!
//! ffmpeg does all the image reading and writing; this module only prepares
//! the numbers for the model (U²-Net "silueta", 320×320 input) and turns its
//! answer into a transparency mask.

use crate::error::{AppError, Result};
use crate::ffmpeg::locate::Tools;
use crate::ffmpeg::runner::{capture, last_line, JobControl};
use crate::image::probe_image;
use crate::model::ImageJob;
use ort::session::Session;
use ort::value::Tensor;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Side length of the model's square input.
const SIDE: usize = 320;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// The loaded model. Loading takes a few hundred milliseconds, so it is kept.
struct Loaded {
    session: Mutex<Session>,
    // The environment must stay alive as long as the session does.
    _env: ort::environment::Environment,
}

static MODEL: OnceLock<std::result::Result<Loaded, String>> = OnceLock::new();

fn model(path: &Path) -> Result<&'static Loaded> {
    MODEL
        .get_or_init(|| {
            let env = ort::init().build().map_err(|e| e.to_string())?;
            let session = Session::builder(&env)
                .and_then(|mut b| b.commit_from_file(path))
                .map_err(|e| e.to_string())?;
            Ok(Loaded { session: Mutex::new(session), _env: env })
        })
        .as_ref()
        .map_err(|e| AppError::msg(format!("The background-removal model could not be loaded: {e}")))
}

/// RGB bytes (320×320, interleaved) → the model's input: planar floats,
/// scaled by the brightest value and normalised per channel.
pub fn to_model_input(rgb: &[u8]) -> Vec<f32> {
    let pixels = SIDE * SIDE;
    let max = rgb.iter().copied().max().unwrap_or(255).max(1) as f32;
    let mut data = vec![0f32; 3 * pixels];
    for p in 0..pixels {
        for c in 0..3 {
            data[c * pixels + p] = (rgb[p * 3 + c] as f32 / max - MEAN[c]) / STD[c];
        }
    }
    data
}

/// The model's raw answer → an 8-bit mask (255 = keep, 0 = background).
pub fn to_mask(output: &[f32]) -> Vec<u8> {
    let (lo, hi) = output
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    let range = (hi - lo).max(1e-6);
    output
        .iter()
        .map(|v| (((v - lo) / range) * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect()
}

fn infer(model_path: &Path, rgb: Vec<u8>) -> Result<Vec<u8>> {
    if rgb.len() != SIDE * SIDE * 3 {
        return Err(AppError::msg("The image could not be prepared for background removal."));
    }
    let loaded = model(model_path)?;
    let input = Tensor::from_array(([1usize, 3, SIDE, SIDE], to_model_input(&rgb)))
        .map_err(|e| AppError::msg(e.to_string()))?;
    let mut session = loaded.session.lock();
    let outputs = session
        .run(ort::inputs![input])
        .map_err(|e| AppError::msg(format!("Background removal failed: {e}")))?;
    let (_, values) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| AppError::msg(e.to_string()))?;
    if values.len() != SIDE * SIDE {
        return Err(AppError::msg("The background-removal model returned an unexpected result."));
    }
    Ok(to_mask(values))
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// Cut the subject out of `job.input` and save it as a PNG with a transparent background.
pub async fn remove_background(
    tools: &Tools,
    job: &ImageJob,
    temp_dir: &Path,
    control: &JobControl,
    mut on_stage: impl FnMut(f64, &str),
) -> Result<()> {
    let model_path: PathBuf = tools
        .bg_model
        .clone()
        .ok_or_else(|| AppError::msg("Background removal is not installed with this copy of the app."))?;
    let info = probe_image(tools, &job.input).await?;
    let (width, height) = match job.crop {
        Some(c) => (c.w.max(1), c.h.max(1)),
        None => (info.width, info.height),
    };
    std::fs::create_dir_all(temp_dir)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let small = temp_dir.join(format!("mvs_bg_{id}_in.raw"));
    let mask = temp_dir.join(format!("mvs_bg_{id}_mask.raw"));
    let crop = job.crop.map(|c| format!("crop={}:{}:{}:{},", c.w, c.h, c.x, c.y)).unwrap_or_default();

    let result: Result<()> = async {
        on_stage(15.0, "Looking at the picture");
        let mut args = strings(&["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i", &job.input]);
        args.extend(strings(&[
            "-vf",
            &format!("{crop}scale={SIDE}:{SIDE}:flags=lanczos"),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24",
            &small.to_string_lossy(),
        ]));
        let out = capture(&tools.ffmpeg, &args, None, Some(control)).await?;
        if !out.ok {
            return Err(AppError::msg(format!("Could not read the image: {}", last_line(&out.stderr))));
        }

        on_stage(45.0, "Finding the subject");
        let rgb = std::fs::read(&small)?;
        let path = model_path.clone();
        let mask_bytes = tokio::task::spawn_blocking(move || infer(&path, rgb))
            .await
            .map_err(|e| AppError::msg(e.to_string()))??;
        std::fs::write(&mask, mask_bytes)?;

        on_stage(80.0, "Cutting it out");
        let size = format!("{SIDE}x{SIDE}");
        let graph = format!(
            "[1:v]scale={width}:{height}:flags=bicubic,format=gray[m];[0:v]{crop}format=rgba[i];[i][m]alphamerge,sidedata=mode=delete"
        );
        let mut args = strings(&["-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-i", &job.input]);
        args.extend(strings(&[
            "-f", "rawvideo", "-pix_fmt", "gray", "-s", &size, "-i", &mask.to_string_lossy(),
            "-filter_complex", &graph,
            "-map_metadata", "-1", "-frames:v", "1", "-c:v", "png",
            &job.output,
        ]));
        let out = capture(&tools.ffmpeg, &args, None, Some(control)).await?;
        let produced = std::fs::metadata(&job.output).map(|m| m.len() > 0).unwrap_or(false);
        if !out.ok || !produced {
            let _ = std::fs::remove_file(&job.output);
            return Err(AppError::msg(format!("Could not save the cut-out: {}", last_line(&out.stderr))));
        }
        Ok(())
    }
    .await;

    let _ = std::fs::remove_file(&small);
    let _ = std::fs::remove_file(&mask);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_input_is_planar_and_normalised() {
        // One white pixel followed by black ones.
        let mut rgb = vec![0u8; SIDE * SIDE * 3];
        rgb[..3].copy_from_slice(&[255, 255, 255]);
        let data = to_model_input(&rgb);
        assert_eq!(data.len(), 3 * SIDE * SIDE);
        let pixels = SIDE * SIDE;
        for c in 0..3 {
            assert!((data[c * pixels] - (1.0 - MEAN[c]) / STD[c]).abs() < 1e-5, "white, channel {c}");
            assert!((data[c * pixels + 1] - (0.0 - MEAN[c]) / STD[c]).abs() < 1e-5, "black, channel {c}");
        }
        // A dark image is stretched to full range before normalising.
        let dim = vec![50u8; SIDE * SIDE * 3];
        assert!((to_model_input(&dim)[0] - (1.0 - MEAN[0]) / STD[0]).abs() < 1e-5);
    }

    #[test]
    fn mask_spans_the_full_range() {
        assert_eq!(to_mask(&[0.2, 0.6, 1.0]), vec![0, 128, 255]);
        // A flat answer must not divide by zero.
        assert_eq!(to_mask(&[0.5, 0.5]), vec![0, 0]);
    }
}
