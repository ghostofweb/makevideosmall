//! The picture tools: make smaller, fit a size, crop, remove the background,
//! make bigger.

use crate::ctx::*;
use crate::fmt::*;
use crate::{App, PicRow, Tool, I};
use mvs_core::model::*;
use mvs_core::service::{image_output_for, IMAGE_EXTENSIONS};
use slint::ComponentHandle;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SMALLER: i32 = 0;
const FIT: i32 = 1;
const CROP: i32 = 2;
const CUT_OUT: i32 = 3;
const BIGGER: i32 = 4;

const FORMATS: [(ImageFormat, &str, &str); 4] = [
    (ImageFormat::Webp, "WebP", "Small, and works in every current browser and most apps. A good default."),
    (ImageFormat::Jpg, "JPEG", "Opens everywhere, even on old devices. Bigger than WebP."),
    (ImageFormat::Avif, "AVIF", "The smallest of all. Some older apps cannot open it."),
    (ImageFormat::Png, "PNG", "No quality loss at all, but often not much smaller."),
];

pub struct Pic {
    pub id: u64,
    pub info: ImageInfo,
    /// Size as it is shown: photos taken sideways are turned upright.
    pub w: u32,
    pub h: u32,
    pub thumb: Option<PathBuf>,
    pub preview: Option<PathBuf>,
    /// 0 ready, 1 working, 2 done, 3 failed
    pub state: i32,
    pub message: String,
    pub warning: String,
    pub output: Option<String>,
    pub result: Option<PathBuf>,
    pub new_bytes: f64,
    /// The tool that made the result.
    pub done_mode: Option<i32>,
    pub crop: Option<Crop>,
}

impl Pic {
    fn temp_files(&self) -> impl Iterator<Item = &PathBuf> {
        [&self.thumb, &self.preview, &self.result].into_iter().flatten()
    }
    fn reset(&mut self) {
        self.state = 0;
        self.message.clear();
        self.warning.clear();
        self.output = None;
        self.result = None;
        self.done_mode = None;
    }
}

pub struct PicState {
    pub pics: Vec<Pic>,
    pub selected: Option<u64>,
    pub mode: i32,
    pub format: ImageFormat,
    pub quality: u32,
    pub target_kb: u32,
    /// Index into `CROP_SHAPES`.
    pub shape: usize,
    pub dir: Option<String>,
    pub busy: bool,
    pub loading: usize,
}

impl Default for PicState {
    fn default() -> Self {
        PicState { pics: Vec::new(), selected: None, mode: SMALLER, format: ImageFormat::Webp, quality: 80, target_kb: 500, shape: 0, dir: None, busy: false, loading: 0 }
    }
}

impl PicState {
    fn get(&mut self, id: u64) -> Option<&mut Pic> {
        self.pics.iter_mut().find(|p| p.id == id)
    }
    fn current(&mut self) -> Option<&mut Pic> {
        let id = self.selected?;
        self.get(id)
    }
    fn formats(&self) -> &'static [(ImageFormat, &'static str, &'static str)] {
        // A PNG has no quality to turn down, so it cannot be made to fit a size.
        if self.mode == FIT { &FORMATS[..3] } else { &FORMATS }
    }
    fn format(&self) -> ImageFormat {
        if self.mode == FIT && self.format == ImageFormat::Png { ImageFormat::Webp } else { self.format }
    }
    /// The pictures the big button would work on.
    fn targets(&self) -> Vec<u64> {
        if self.mode == CROP {
            return self.pics.iter().filter(|p| Some(p.id) == self.selected && p.crop.is_some() && p.state != 1).map(|p| p.id).collect();
        }
        let waiting: Vec<u64> = self.pics.iter().filter(|p| p.state == 0 || p.state == 3).map(|p| p.id).collect();
        if waiting.is_empty() { self.pics.iter().filter(|p| p.state == 2).map(|p| p.id).collect() } else { waiting }
    }
    /// In the crop tool the selected picture needs a box to drag.
    fn ensure_crop(&mut self, fresh: bool) {
        let shape = CROP_SHAPES[self.shape.min(CROP_SHAPES.len() - 1)];
        if self.mode != CROP {
            return;
        }
        if let Some(pic) = self.current() {
            if (fresh || pic.crop.is_none()) && pic.w >= 2 && pic.h >= 2 {
                pic.crop = Some(default_crop(pic.w, pic.h, shape));
            }
        }
    }
}

fn shrinks(mode: Option<i32>) -> bool {
    matches!(mode, Some(SMALLER) | Some(FIT))
}

fn plural(n: usize) -> String {
    if n == 1 { "1 picture".into() } else { format!("{n} pictures") }
}

fn set_crop(i: &I, crop: Option<Crop>, w: u32, h: u32) {
    let c = crop.unwrap_or(Crop { w, h, x: 0, y: 0 });
    i.set_img_w(w.max(1) as f32);
    i.set_img_h(h.max(1) as f32);
    i.set_crop_x(c.x as f32);
    i.set_crop_y(c.y as f32);
    i.set_crop_w(c.w as f32);
    i.set_crop_h(c.h as f32);
    i.set_crop_text(format!("Keeping {}×{} of {w}×{h}", c.w, c.h).into());
}

pub fn show(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let p = &state.p;
        let i = app.global::<I>();
        let list: Vec<PicRow> = p
            .pics
            .iter()
            .map(|pic| PicRow {
                name: pic.info.file_name.clone().into(),
                detail: format!("{}×{}, {}", pic.w, pic.h, bytes(pic.info.size_bytes)).into(),
                has_thumb: pic.thumb.is_some(),
                thumb: img(pic.thumb.as_deref()),
                state: pic.state,
                message: pic.message.clone().into(),
                ratio: if pic.state == 2 && shrinks(pic.done_mode) && pic.info.size_bytes > 0.0 { (pic.new_bytes / pic.info.size_bytes) as f32 } else { -1.0 },
            })
            .collect();
        let n = list.len();
        i.set_pics(rows(list));
        i.set_selected(p.selected.and_then(|id| p.pics.iter().position(|x| x.id == id)).map(|x| x as i32).unwrap_or(-1));
        i.set_count_text(if p.loading > 0 { "reading…".to_string() } else if n > 0 { n.to_string() } else { String::new() }.into());
        i.set_can_add(ctx.core.problem.is_none() && !p.busy);

        let caps = state.caps.as_ref();
        let (cut_out, bigger) = (caps.map(|c| c.background_removal_available).unwrap_or(false), caps.map(|c| c.upscaler_available).unwrap_or(false));
        let tool = |title: &str, detail: &str, available: bool| Tool { title: title.into(), detail: if available { detail } else { "Not included in this copy" }.into(), available };
        i.set_tools(rows(vec![
            tool("Make smaller", "Shrink the file", true),
            tool("Fit a size", "Stay under a limit", true),
            tool("Crop", "Keep only a part", true),
            tool("Remove background", "Cut out the subject", cut_out),
            tool("Make bigger", "Four times larger, with AI", bigger),
        ]));
        i.set_mode(p.mode);
        let formats = p.formats();
        let format = formats.iter().position(|f| f.0 == p.format()).unwrap_or(0);
        i.set_formats(strs(formats.iter().map(|f| f.1)));
        i.set_format(format as i32);
        i.set_format_note(formats[format].2.into());
        i.set_show_quality(p.mode == SMALLER && p.format != ImageFormat::Png);
        i.set_quality(p.quality as f32);
        i.set_target_text(p.target_kb.to_string().into());
        i.set_shape(p.shape as i32);
        i.set_save_in(p.dir.clone().unwrap_or_else(|| "Next to each original".into()).into());
        i.set_has_dir(p.dir.is_some());
        i.set_busy(p.busy);

        let targets = p.targets();
        let again = if targets.iter().any(|id| p.pics.iter().any(|x| x.id == *id && x.state == 2)) { " again" } else { "" };
        let count = plural(targets.len().max(1));
        let limit = if p.target_kb >= 1024 { format!("{} MB", p.target_kb as f64 / 1024.0) } else { format!("{} KB", p.target_kb) };
        i.set_go_text(
            match p.mode {
                SMALLER => format!("Make {count} smaller{again}"),
                FIT => format!("Fit {count} under {limit}{again}"),
                CROP => "Crop this picture".to_string(),
                CUT_OUT => format!("Remove the background from {count}{again}"),
                _ => format!("Make {count} bigger{again}"),
            }
            .into(),
        );
        let available = match p.mode {
            CUT_OUT => cut_out,
            BIGGER => bigger,
            _ => true,
        };
        i.set_can_go(!targets.is_empty() && !p.busy && available && ctx.core.problem.is_none());

        let shrunk: Vec<&Pic> = p.pics.iter().filter(|x| x.state == 2 && shrinks(x.done_mode)).collect();
        let (before, after) = shrunk.iter().fold((0.0, 0.0), |(b, a), x| (b + x.info.size_bytes, a + x.new_bytes));
        i.set_total_ratio(if before > 0.0 { (after / before) as f32 } else { -1.0 });
        i.set_total_text(format!("{}: {} to {}, {}", plural(shrunk.len()), bytes(before), bytes(after), savings_label(before, after)).into());

        // ── The selected picture
        let Some(pic) = p.selected.and_then(|id| p.pics.iter().find(|x| x.id == id)) else {
            i.set_has_preview(false);
            i.set_has_result(false);
            i.set_cropping(false);
            i.set_note("".into());
            return;
        };
        let shown = pic.preview.as_deref().or(pic.thumb.as_deref());
        i.set_has_preview(shown.is_some());
        i.set_preview(img(shown));
        let done = pic.state == 2 && pic.result.is_some();
        i.set_has_result(done);
        i.set_result(img(if done { pic.result.as_deref() } else { None }));
        i.set_comparable(done && pic.done_mode != Some(CROP));
        i.set_left_caption(format!("Original, {}", bytes(pic.info.size_bytes)).into());
        i.set_right_caption(
            format!(
                "{}, {}",
                match pic.done_mode {
                    Some(CROP) => "Cropped",
                    Some(CUT_OUT) => "Background removed",
                    Some(BIGGER) => "Four times bigger",
                    _ => "Smaller copy",
                },
                bytes(pic.new_bytes)
            )
            .into(),
        );
        i.set_note(if pic.state == 2 { pic.warning.clone() } else { String::new() }.into());
        i.set_can_redo(pic.state == 2 && pic.done_mode == Some(CROP) && !p.busy);
        i.set_cropping(p.mode == CROP && pic.state != 1 && !(pic.state == 2 && pic.done_mode == Some(CROP)) && pic.crop.is_some());
        set_crop(&i, pic.crop, pic.w, pic.h);
    });
}

// ───────────────────────────── Adding and removing ─────────────────────────────

pub fn add_paths(ctx: &Arc<Ctx>, paths: Vec<String>) {
    let files = mvs_core::service::expand_paths(&paths, IMAGE_EXTENSIONS);
    let incoming: Vec<String> = {
        let mut state = ctx.state.lock();
        let known: Vec<String> = state.p.pics.iter().map(|p| p.info.path.to_lowercase()).collect();
        let incoming: Vec<String> = files.iter().filter(|f| !known.contains(&f.to_lowercase())).cloned().collect();
        state.p.loading += incoming.len();
        incoming
    };
    if incoming.is_empty() {
        toast(ctx, 0, if files.is_empty() { "No pictures were found there." } else { "Those pictures are already in the list." }, "");
        return;
    }
    show(ctx);
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let mut failed = Vec::new();
        for path in incoming {
            let probed = ctx.core.image_probe(&path).await;
            let added = {
                let mut state = ctx.state.lock();
                state.p.loading -= 1;
                match probed {
                    Ok(info) => {
                        let id = ctx.next_id();
                        let (w, h) = (info.width, info.height);
                        state.p.pics.push(Pic { id, info, w, h, thumb: None, preview: None, state: 0, message: String::new(), warning: String::new(), output: None, result: None, new_bytes: 0.0, done_mode: None, crop: None });
                        Some((id, state.p.selected.is_none()))
                    }
                    Err(e) => {
                        failed.push(format!("{}: {e}", base_name(&path)));
                        None
                    }
                }
            };
            match added {
                Some((id, true)) => select(&ctx, id),
                _ => show(&ctx),
            }
            if let Some((id, _)) = added {
                load_thumb(&ctx, id, path).await;
            }
        }
        if !failed.is_empty() {
            toast(&ctx, 3, format!("{} file{} could not be added", failed.len(), if failed.len() == 1 { "" } else { "s" }), failed.join("; "));
        }
    });
}

async fn load_thumb(ctx: &Arc<Ctx>, id: u64, path: String) {
    let Ok(thumb) = ctx.core.image_preview(&path, 160).await else { return };
    // A photo taken with the camera turned is stored sideways; the small copy
    // is upright, which tells us the size people actually see.
    let upright = ctx.core.image_probe(&thumb.to_string_lossy()).await.ok();
    {
        let mut state = ctx.state.lock();
        let Some(pic) = state.p.get(id) else {
            let _ = std::fs::remove_file(thumb);
            return;
        };
        pic.thumb = Some(thumb);
        if let Some(seen) = upright {
            if pic.w != pic.h && (seen.width > seen.height) != (pic.w > pic.h) {
                std::mem::swap(&mut pic.w, &mut pic.h);
                pic.crop = None;
            }
        }
        state.p.ensure_crop(false);
    }
    show(ctx);
}

/// Make the larger copies shown in the middle of the window.
fn load_views(ctx: &Arc<Ctx>, id: u64) {
    let Some((path, output, need_preview, need_result)) = ctx.state.lock().p.get(id).map(|p| (p.info.path.clone(), p.output.clone(), p.preview.is_none(), p.state == 2 && p.result.is_none())) else { return };
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        if need_preview {
            if let Ok(made) = ctx.core.image_preview(&path, 1600).await {
                match ctx.state.lock().p.get(id) {
                    Some(pic) if pic.preview.is_none() => pic.preview = Some(made),
                    _ => drop(std::fs::remove_file(made)),
                }
                show(&ctx);
            }
        }
        if let (true, Some(output)) = (need_result, output) {
            if let Ok(made) = ctx.core.image_preview(&output, 1600).await {
                match ctx.state.lock().p.get(id) {
                    Some(pic) if pic.result.is_none() && pic.output.as_deref() == Some(&output) => pic.result = Some(made),
                    _ => drop(std::fs::remove_file(made)),
                }
                show(&ctx);
            }
        }
    });
}

fn select(ctx: &Arc<Ctx>, id: u64) {
    {
        let mut state = ctx.state.lock();
        state.p.selected = Some(id);
        state.p.ensure_crop(false);
    }
    show(ctx);
    load_views(ctx, id);
}

fn remove(ctx: &Arc<Ctx>, ids: &[u64]) {
    let next = {
        let mut state = ctx.state.lock();
        for pic in state.p.pics.iter().filter(|p| ids.contains(&p.id)) {
            for file in pic.temp_files() {
                let _ = std::fs::remove_file(file);
            }
        }
        state.p.pics.retain(|p| !ids.contains(&p.id));
        if state.p.selected.map(|id| ids.contains(&id)).unwrap_or(false) {
            state.p.selected = state.p.pics.first().map(|p| p.id);
            state.p.selected
        } else {
            None
        }
    };
    match next {
        Some(id) => select(ctx, id),
        None => show(ctx),
    }
}

// ───────────────────────────── Doing the work ─────────────────────────────

fn same_format(path: &str) -> ImageFormat {
    match Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => ImageFormat::Jpg,
        Some("webp") => ImageFormat::Webp,
        Some("avif") => ImageFormat::Avif,
        _ => ImageFormat::Png,
    }
}

fn go(ctx: &Arc<Ctx>) {
    let jobs = {
        let mut state = ctx.state.lock();
        let p = &mut state.p;
        if p.busy {
            return;
        }
        let mode = p.mode;
        let action = match mode {
            SMALLER => ImageAction::Compress { quality: p.quality },
            FIT => ImageAction::Target { kb: p.target_kb },
            // A crop should not cost quality anyone can see.
            CROP => ImageAction::Compress { quality: 92 },
            CUT_OUT => ImageAction::RemoveBackground,
            _ => ImageAction::Upscale,
        };
        let suffix = ["_small", "_small", "_cropped", "_no_background", "_4x"][mode.clamp(0, 4) as usize];
        let (format, dir, targets) = (p.format(), p.dir.clone(), p.targets());
        let mut taken = Vec::new();
        let mut jobs = Vec::new();
        for pic in p.pics.iter_mut().filter(|pic| targets.contains(&pic.id)) {
            // Cut-outs and enlargements are always PNG; a crop keeps the original's format.
            let format = match mode {
                CUT_OUT | BIGGER => ImageFormat::Png,
                CROP => same_format(&pic.info.path),
                _ => format,
            };
            let output = image_output_for(&pic.info.path, format, suffix, dir.as_deref(), &taken);
            taken.push(output.clone());
            jobs.push(ImageJob { id: pic.id.to_string(), input: pic.info.path.clone(), output, action: action.clone(), format, crop: if mode == CROP { pic.crop } else { None } });
            if let Some(old) = pic.result.take() {
                let _ = std::fs::remove_file(old);
            }
            pic.reset();
            pic.state = 1;
            pic.message = "Waiting".into();
            pic.done_mode = Some(mode);
        }
        p.busy = !jobs.is_empty();
        jobs
    };
    if jobs.is_empty() {
        return;
    }
    if let Err(e) = ctx.core.images.start(jobs) {
        {
            let mut state = ctx.state.lock();
            state.p.busy = false;
            for pic in state.p.pics.iter_mut().filter(|p| p.state == 1) {
                pic.reset();
            }
        }
        error_toast(ctx, "Could not start", e);
    }
    show(ctx);
}

pub fn on_event(ctx: &Arc<Ctx>, event: &str, payload: serde_json::Value) {
    if event == "image:batch-done" {
        let cancelled = payload.as_bool().unwrap_or(false);
        let (done, failed) = {
            let mut state = ctx.state.lock();
            state.p.busy = false;
            // Anything still marked as working was skipped when the batch stopped.
            for pic in state.p.pics.iter_mut().filter(|p| p.state == 1) {
                pic.reset();
            }
            (state.p.pics.iter().filter(|p| p.state == 2).count(), state.p.pics.iter().filter(|p| p.state == 3).count())
        };
        if cancelled {
            toast(ctx, 0, "Stopped", "");
        } else if failed > 0 {
            toast(ctx, 2, format!("{} could not be done", plural(failed)), "The reason is shown under each one in the list.");
        } else if done > 0 {
            toast(ctx, 1, "Done", "Your originals were not changed.");
        }
        show(ctx);
        return;
    }
    let Ok(e) = serde_json::from_value::<ImageEvent>(payload) else { return };
    let Ok(id) = e.id.parse::<u64>() else { return };
    let finished = {
        let mut state = ctx.state.lock();
        let Some(pic) = state.p.get(id) else { return };
        match e.kind.as_str() {
            "done" => {
                pic.state = 2;
                pic.new_bytes = e.new_bytes;
                pic.message = e.output.as_deref().map(|o| format!("Saved as {}", base_name(o))).unwrap_or_default();
                pic.output = e.output;
                pic.warning = e.message;
                true
            }
            "error" if e.message == "Cancelled" => {
                pic.reset();
                false
            }
            "error" => {
                pic.state = 3;
                pic.message = e.message;
                pic.done_mode = None;
                false
            }
            _ => {
                pic.state = 1;
                pic.message = if e.message.is_empty() { "Working".into() } else { e.message };
                false
            }
        }
    };
    show(ctx);
    if finished && ctx.state.lock().p.selected == Some(id) {
        load_views(ctx, id);
    }
}

// ───────────────────────────── Wiring ─────────────────────────────

pub fn wire(app: &App, ctx: &Arc<Ctx>) {
    let i = app.global::<I>();
    macro_rules! on {
        ($setter:ident, |$c:ident $(, $arg:ident)*| $body:expr) => {{
            let $c = ctx.clone();
            i.$setter(move |$($arg),*| $body);
        }};
    }

    on!(on_add, |c| {
        if let Some(files) = rfd::FileDialog::new().set_title("Add pictures").add_filter("Pictures", IMAGE_EXTENSIONS).pick_files() {
            add_paths(&c, files.iter().map(|f| f.to_string_lossy().into_owned()).collect());
        }
    });
    on!(on_clear, |c| {
        let ids: Vec<u64> = c.state.lock().p.pics.iter().map(|p| p.id).collect();
        c.core.images.cancel();
        remove(&c, &ids);
    });
    on!(on_select, |c, index| {
        let id = c.state.lock().p.pics.get(index.max(0) as usize).map(|p| p.id);
        if let Some(id) = id {
            select(&c, id);
        }
    });
    on!(on_remove, |c, index| {
        let id = c.state.lock().p.pics.get(index.max(0) as usize).map(|p| p.id);
        if let Some(id) = id {
            remove(&c, &[id]);
        }
    });
    on!(on_put, |c, name, value| {
        let index = value.round().max(0.0) as usize;
        {
            let mut state = c.state.lock();
            let p = &mut state.p;
            match name.as_str() {
                "mode" => {
                    p.mode = (index as i32).min(BIGGER);
                    p.ensure_crop(false);
                }
                "format" => {
                    if let Some(f) = p.formats().get(index) {
                        p.format = f.0;
                    }
                }
                "quality" => {
                    p.quality = (index as u32).clamp(1, 100);
                    // The slider is being dragged: only the number needs to follow.
                    let quality = p.quality as f32;
                    drop(state);
                    if let Some(app) = c.ui.upgrade() {
                        app.global::<I>().set_quality(quality);
                    }
                    return;
                }
                "target" => p.target_kb = (index as u32).clamp(5, 102_400),
                "shape" => {
                    p.shape = index.min(CROP_SHAPES.len() - 1);
                    p.ensure_crop(true);
                }
                _ => {}
            }
        }
        show(&c);
        let selected = c.state.lock().p.selected;
        if let Some(id) = selected {
            load_views(&c, id);
        }
    });
    on!(on_put_text, |c, name, text| {
        if name == "target" {
            if let Ok(kb) = text.trim().parse::<f64>() {
                c.state.lock().p.target_kb = (kb.round().max(0.0) as u32).clamp(5, 102_400);
            }
        }
        show(&c);
    });
    on!(on_choose_dir, |c| {
        if let Some(dir) = rfd::FileDialog::new().set_title("Save pictures in").pick_folder() {
            c.state.lock().p.dir = Some(dir.to_string_lossy().into_owned());
            show(&c);
        }
    });
    on!(on_reset_dir, |c| {
        c.state.lock().p.dir = None;
        show(&c);
    });
    on!(on_go, |c| go(&c));
    on!(on_cancel, |c| c.core.images.cancel());
    on!(on_reveal, |c| {
        let output = c.state.lock().p.current().and_then(|p| p.output.clone());
        if let Some(Err(e)) = output.map(|o| mvs_core::platform::reveal(&o)) {
            error_toast(&c, "Could not show the file", e);
        }
    });
    on!(on_redo, |c| {
        {
            let mut state = c.state.lock();
            if let Some(pic) = state.p.current() {
                if let Some(old) = pic.result.take() {
                    let _ = std::fs::remove_file(old);
                }
                pic.reset();
            }
            state.p.ensure_crop(false);
        }
        show(&c);
    });
    on!(on_crop_drag, |c, handle, sx, sy, sw, sh, dx, dy| {
        let moved = {
            let mut state = c.state.lock();
            let shape = CROP_SHAPES[state.p.shape.min(CROP_SHAPES.len() - 1)];
            let Some(pic) = state.p.current() else { return };
            let start = Crop { x: sx.max(0.0).round() as u32, y: sy.max(0.0).round() as u32, w: sw.max(1.0).round() as u32, h: sh.max(1.0).round() as u32 };
            let crop = drag_crop(start, handle, dx as f64, dy as f64, pic.w, pic.h, shape);
            pic.crop = Some(crop);
            (crop, pic.w, pic.h)
        };
        // Straight to the screen: a full refresh for every pixel of a drag would lag.
        if let Some(app) = c.ui.upgrade() {
            set_crop(&app.global::<I>(), Some(moved.0), moved.1, moved.2);
        }
    });
}
