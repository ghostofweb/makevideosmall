//! Find the ffmpeg, ffprobe and Real-ESRGAN binaries.

use crate::error::{AppError, Result};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Real-ESRGAN executable, when bundled.
    pub upscaler: Option<PathBuf>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn in_path(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(&file))
            .find(|candidate| candidate.is_file())
    })
}

fn in_dirs(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let file = exe(name);
    dirs.iter().map(|d| d.join(&file)).find(|c| c.is_file())
}

/// Folders that may hold bundled binaries, most specific first.
pub fn default_engine_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(res) = resource_dir {
        dirs.push(res.join("engine"));
        dirs.push(res.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("engine"));
            dirs.push(dir.to_path_buf());
        }
    }
    // Development and test builds: the repo's engine folder.
    if cfg!(debug_assertions) {
        dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine"));
    }
    dirs
}

/// Bundled binaries win over whatever is on PATH, so a release behaves the
/// same on every machine.
pub fn locate(engine_dirs: &[PathBuf]) -> Result<Tools> {
    let ffmpeg = in_dirs("ffmpeg", engine_dirs)
        .or_else(|| in_path("ffmpeg"))
        .ok_or(AppError::FfmpegMissing)?;
    let ffprobe = in_dirs("ffprobe", engine_dirs)
        .or_else(|| {
            ffmpeg
                .parent()
                .map(|d| d.join(exe("ffprobe")))
                .filter(|p| p.is_file())
        })
        .or_else(|| in_path("ffprobe"))
        .ok_or(AppError::FfmpegMissing)?;
    let upscaler = in_dirs("realesrgan-ncnn-vulkan", engine_dirs);
    Ok(Tools {
        ffmpeg,
        ffprobe,
        upscaler,
    })
}
