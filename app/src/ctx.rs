//! What every part of the app shares: the engine, the state, and the ways to
//! reach the interface from background work.

use crate::{pictures, queue_ui, video, App, A};
use mvs_core::model::*;
use mvs_core::service::Core;
use mvs_core::util::EventSink;
use parking_lot::Mutex;
use slint::{ComponentHandle, Image, ModelRc, SharedString, VecModel};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// What the button on the current message does.
#[derive(Clone, Copy, PartialEq, Default)]
pub enum ToastAction {
    #[default]
    None,
    CancelShutdown,
}

#[derive(Default)]
pub struct State {
    pub ready: bool,
    /// 0 videos, 1 pictures.
    pub mode: i32,
    pub caps: Option<Capabilities>,
    pub options: Vec<EasyOption>,
    pub presets: Vec<Preset>,
    pub settings: AppSettings,
    pub v: video::VideoState,
    pub q: queue_ui::QueueState,
    pub p: pictures::PicState,
    pub toast_action: ToastAction,
    pub toast_serial: u64,
}

impl State {
    pub fn encoder(&self, id: VideoEncoder) -> Option<&EncoderInfo> {
        self.caps.as_ref().and_then(|c| c.encoders.iter().find(|e| e.id == id))
    }

    pub fn usable(&self, id: VideoEncoder) -> bool {
        self.encoder(id).map(|e| e.available).unwrap_or(false)
    }

    pub fn has_gpu_encoder(&self) -> bool {
        [VideoEncoder::HevcNvenc, VideoEncoder::HevcAmf, VideoEncoder::HevcQsv].into_iter().any(|e| self.usable(e))
    }

    /// The preset new videos start with in the advanced view.
    pub fn default_preset(&self) -> Option<&Preset> {
        let ok = |p: &&Preset| self.usable(p.settings.video.encoder);
        self.presets
            .iter()
            .find(|p| p.id == self.settings.default_preset_id)
            .filter(ok)
            .or_else(|| self.presets.iter().find(|p| p.id == "balanced").filter(ok))
            .or_else(|| self.presets.iter().find(ok))
            .or(self.presets.first())
    }
}

pub struct Ctx {
    pub core: Core,
    pub runtime: tokio::runtime::Handle,
    pub state: Mutex<State>,
    pub ui: slint::Weak<App>,
    pub ids: AtomicU64,
    pub data_dir: PathBuf,
    /// Set to stop a pending "turn the PC off".
    pub shutdown_cancelled: AtomicBool,
}

impl Ctx {
    pub fn next_id(&self) -> u64 {
        self.ids.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }
}

/// Engine events arrive on background threads, some before the context exists.
pub struct UiSink(pub Arc<OnceLock<Arc<Ctx>>>);

impl EventSink for UiSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let Some(ctx) = self.0.get() else { return };
        if event.starts_with("image:") {
            pictures::on_event(ctx, event, payload);
        } else {
            queue_ui::on_event(ctx, event, payload);
        }
    }
}

/// Run `f` on the interface thread.
pub fn on_ui(ctx: &Arc<Ctx>, f: impl FnOnce(&App, &Arc<Ctx>) + Send + 'static) {
    let ctx = ctx.clone();
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = ctx.ui.upgrade() {
            f(&app, &ctx);
        }
    });
}

pub fn strs<S: Into<SharedString>>(items: impl IntoIterator<Item = S>) -> ModelRc<SharedString> {
    ModelRc::new(VecModel::from(items.into_iter().map(Into::into).collect::<Vec<SharedString>>()))
}

pub fn rows<T: Clone + 'static>(items: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(items))
}

thread_local! {
    /// Decoded pictures, so a list refresh does not decode every thumbnail again.
    static SMALL: RefCell<HashMap<PathBuf, Image>> = RefCell::new(HashMap::new());
    static BIG: RefCell<HashMap<PathBuf, Image>> = RefCell::new(HashMap::new());
    static TOAST_TIMER: slint::Timer = slint::Timer::default();
}

/// Load a picture for display (interface thread only). Missing files give an empty image.
pub fn img(path: Option<&Path>) -> Image {
    let Some(path) = path else { return Image::default() };
    let cached = |cache: &RefCell<HashMap<PathBuf, Image>>| cache.borrow().get(path).cloned();
    if let Some(found) = SMALL.with(cached).or_else(|| BIG.with(cached)) {
        return found;
    }
    let loaded = Image::load_from_path(path).unwrap_or_default();
    // Thumbnails are tiny, so many can be kept. Full-size frames are several
    // megabytes each once decoded: keep only the few that can be on screen.
    let (cache, limit) = if loaded.size().width <= 400 { (&SMALL, 600) } else { (&BIG, 6) };
    cache.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= limit {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), loaded.clone());
    });
    loaded
}

/// Show a message at the top of the window. `kind`: 0 plain, 1 good, 2 warning, 3 error.
pub fn toast(ctx: &Arc<Ctx>, kind: i32, title: impl Into<String>, detail: impl Into<String>) {
    toast_with(ctx, kind, title, detail, ToastAction::None, "");
}

pub fn toast_with(ctx: &Arc<Ctx>, kind: i32, title: impl Into<String>, detail: impl Into<String>, action: ToastAction, label: &str) {
    let (title, detail, label) = (title.into(), detail.into(), label.to_string());
    let serial = {
        let mut state = ctx.state.lock();
        state.toast_action = action;
        state.toast_serial += 1;
        state.toast_serial
    };
    on_ui(ctx, move |app, ctx| {
        let a = app.global::<A>();
        a.set_toast(title.into());
        a.set_toast_detail(detail.lines().next().unwrap_or("").into());
        a.set_toast_kind(kind);
        a.set_toast_action(label.into());
        // Messages with a button stay until they are answered or replaced.
        if action != ToastAction::None {
            return;
        }
        let ctx = ctx.clone();
        let wait = Duration::from_secs(if kind >= 2 { 9 } else { 5 });
        TOAST_TIMER.with(|timer| {
            timer.start(slint::TimerMode::SingleShot, wait, move || {
                if ctx.state.lock().toast_serial == serial {
                    clear_toast(&ctx);
                }
            });
        });
    });
}

pub fn clear_toast(ctx: &Arc<Ctx>) {
    ctx.state.lock().toast_action = ToastAction::None;
    on_ui(ctx, |app, _| {
        let a = app.global::<A>();
        a.set_toast("".into());
        a.set_toast_detail("".into());
        a.set_toast_action("".into());
    });
}

pub fn error_toast(ctx: &Arc<Ctx>, title: &str, error: impl std::fmt::Display) {
    toast(ctx, 3, title, error.to_string());
}

/// Put text on the clipboard.
pub fn copy_text(text: &str) -> bool {
    use std::io::Write;
    let mut cmd = std::process::Command::new("clip");
    cmd.stdin(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(mut child) = cmd.spawn() else { return false };
    // clip.exe reads UTF-16 when it sees a byte-order mark.
    let mut data: Vec<u8> = vec![0xFF, 0xFE];
    data.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
    let wrote = child.stdin.take().map(|mut stdin| stdin.write_all(&data).is_ok()).unwrap_or(false);
    child.wait().map(|s| s.success()).unwrap_or(false) && wrote
}

/// The system's "something finished" sound.
pub fn chime() {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBeep(kind: u32) -> i32;
        }
        // SAFETY: a plain Win32 call taking a constant.
        unsafe {
            MessageBeep(0x40);
        }
    }
}
