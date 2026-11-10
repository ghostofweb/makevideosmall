//! Make Video Small — Rust core.
//!
//! The modules below are plain Rust with no dependency on the UI framework,
//! so they can be unit- and integration-tested on their own. `app` is the thin
//! layer that exposes them to the Tauri window.

pub mod analysis;
pub mod background;
pub mod error;
pub mod ffmpeg;
pub mod image;
pub mod model;
pub mod platform;
pub mod presets;
pub mod queue;
pub mod system;
pub mod util;

mod app;

pub use app::run;
