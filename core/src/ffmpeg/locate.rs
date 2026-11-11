//! Find the ffmpeg, ffprobe and Real-ESRGAN binaries.

use crate::error::{AppError, Result};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Real-ESRGAN executable, when bundled.
    pub upscaler: Option<PathBuf>,
    /// Background-removal model, when bundled.
    pub bg_model: Option<PathBuf>,
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

/// Drop Windows' `\\?\` long-path prefix. Windows itself accepts it, but
/// many command-line tools (the upscaler among them) build file names from the
/// folders they are given and cannot open paths in that form.
pub fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        // Only for ordinary drive paths; `\\?\UNC\…` must stay as it is.
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Folders that may hold bundled binaries, most specific first.
pub fn default_engine_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(res) = resource_dir {
        let res = &plain_path(res);
        dirs.push(res.join("engine"));
        dirs.push(res.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = plain_path(&exe).parent() {
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
    let bg_model = engine_dirs
        .iter()
        .map(|d| d.join("models").join("silueta.onnx"))
        .find(|p| p.is_file());
    Ok(Tools {
        ffmpeg,
        ffprobe,
        upscaler,
        bg_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_long_path_prefix_from_drive_paths_only() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Program Files\App\engine")), PathBuf::from(r"C:\Program Files\App\engine"));
        assert_eq!(plain_path(Path::new(r"C:\App\engine")), PathBuf::from(r"C:\App\engine"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share")), PathBuf::from(r"\\?\UNC\server\share"));
        // Every folder the app searches is free of the prefix.
        let dirs = default_engine_dirs(Some(Path::new(r"\\?\C:\App")));
        assert!(dirs.iter().all(|d| !d.to_string_lossy().starts_with(r"\\?\")), "{dirs:?}");
    }
}
