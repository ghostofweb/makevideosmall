//! Make Video Small — the engine.
//!
//! Plain Rust with no dependency on any interface toolkit: reading media,
//! building and running ffmpeg commands, the queue, presets, analysis and the
//! picture tools. `service::Core` is the front door.

pub mod analysis;
pub mod background;
pub mod error;
pub mod ffmpeg;
pub mod image;
pub mod model;
pub mod platform;
pub mod presets;
pub mod queue;
pub mod service;
pub mod system;
pub mod util;
