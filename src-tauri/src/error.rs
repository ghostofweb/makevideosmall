//! One error type for the whole core. It serialises to a plain string so the
//! UI can show it directly.

use serde::{Serialize, Serializer};

#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("ffmpeg was not found. Put ffmpeg.exe and ffprobe.exe in the engine folder next to the app, or install ffmpeg on your PATH.")]
    FfmpegMissing,
    #[error("Cancelled")]
    Cancelled,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid data: {0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Msg(s.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
