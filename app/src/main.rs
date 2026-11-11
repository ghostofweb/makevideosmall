//! Make Video Small — the window. The engine lives in `mvs-core`; this crate
//! only shows what it reports and passes on what people ask for.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

slint::include_modules!();

mod ctx;
mod fmt;
mod pictures;
mod queue_ui;
mod settings_ui;
mod video;

use ctx::*;
use mvs_core::service::{expand_paths, Core, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS};
use mvs_core::util::EventSink;
use slint::ComponentHandle;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Where settings, presets and the queue are kept. The same folder earlier
/// versions used, so nothing is lost by updating.
fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MVS_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("com.ghostofweb.makevideosmall")
}

fn set_mode(ctx: &Arc<Ctx>, mode: i32) {
    ctx.state.lock().mode = mode;
    on_ui(ctx, move |app, _| app.global::<A>().set_mode(mode));
}

/// Files or folders arrived from outside (dropped on the window, or given
/// when the app was started): send each to the screen that handles its kind.
fn open_paths(ctx: &Arc<Ctx>, paths: Vec<String>) {
    if ctx.core.problem.is_some() {
        return;
    }
    let videos = !expand_paths(&paths, VIDEO_EXTENSIONS).is_empty();
    let pictures = !expand_paths(&paths, IMAGE_EXTENSIONS).is_empty();
    let mode = ctx.state.lock().mode;
    match (videos, pictures) {
        (false, false) => toast(ctx, 2, "Nothing to add", "Those are not videos or pictures this app can open."),
        (true, false) => set_mode(ctx, 0),
        (false, true) => set_mode(ctx, 1),
        (true, true) => set_mode(ctx, mode),
    }
    if videos {
        video::add_paths(ctx, paths.clone());
    }
    if pictures {
        pictures::add_paths(ctx, paths);
    }
}

/// Work that has to wait for the window: find out what this PC can do, then
/// bring back the list and the queue from last time.
async fn start_up(ctx: Arc<Ctx>) {
    let found = ctx.core.capabilities().await;
    let options = ctx.core.easy_options().await.unwrap_or_default();
    let snapshot = ctx.core.queue.snapshot();
    let problem = {
        let mut state = ctx.state.lock();
        state.options = options;
        state.q.jobs = snapshot.jobs;
        state.q.running = snapshot.running;
        state.q.paused = snapshot.paused;
        state.ready = true;
        match found {
            Ok(caps) => {
                state.caps = Some(caps);
                String::new()
            }
            Err(e) => format!("{e} Put ffmpeg.exe and ffprobe.exe in the \"engine\" folder next to this program, or install ffmpeg, then start the app again."),
        }
    };
    on_ui(&ctx, move |app, _| {
        let a = app.global::<A>();
        a.set_problem(problem.into());
        a.set_ready(true);
    });
    settings_ui::show(&ctx);
    video::show_videos(&ctx);
    video::show_editor(&ctx);
    queue_ui::show_queue(&ctx);
    pictures::show(&ctx);
    if ctx.core.problem.is_some() {
        return;
    }

    video::restore(&ctx).await;
    let given: Vec<String> = std::env::args().skip(1).filter(|a| std::path::Path::new(a).exists()).collect();
    if !given.is_empty() {
        open_paths(&ctx, given);
    }

    // The remembered answer keeps start-up instant; check it again once the
    // window is up, in case the graphics card or its driver changed.
    tokio::time::sleep(Duration::from_secs(6)).await;
    if let Some(fresh) = ctx.core.refresh_capabilities().await {
        let options = ctx.core.easy_options().await.unwrap_or_default();
        {
            let mut state = ctx.state.lock();
            state.caps = Some(fresh);
            state.options = options;
        }
        settings_ui::show(&ctx);
        pictures::show(&ctx);
        video::options_changed(&ctx);
    }
}

/// Hooks for automated checks of the finished program. They do nothing unless
/// the environment variables are set.
fn test_hooks(app: &App, ctx: &Arc<Ctx>) {
    // MVS_AUTO is a list of steps separated by ";". Each step presses the same
    // button a person would, so the real handlers run:
    //   sleep:<secs>  wait-check  wait-pics  wait-queue
    //   choose:<n>  queue  queue-all  start  advanced:<0|1>  settings  mode:<n>
    //   preset:<n>  tick:<n>  join  seek:<secs>  cut-start  cut-end  estimate  compare
    //   put:<name>:<value>  pic-tool:<n>  pic-go
    if let Ok(script) = std::env::var("MVS_AUTO") {
        let ctx = ctx.clone();
        ctx.runtime.clone().spawn(async move {
            while !ctx.state.lock().ready {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            for step in script.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                let mut parts = step.split(':');
                let name = parts.next().unwrap_or_default().to_string();
                let first = parts.next().unwrap_or_default().to_string();
                let second: f32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
                let number: f32 = first.parse().unwrap_or(0.0);
                match name.as_str() {
                    "sleep" => tokio::time::sleep(Duration::from_secs_f32(number)).await,
                    "wait-check" => loop {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        let state = ctx.state.lock();
                        let v = &state.v;
                        if !v.sources.is_empty() && v.loading == 0 && v.sources.iter().all(|s| s.easy.is_some() || s.check_error.is_some() || s.joined()) {
                            break;
                        }
                    },
                    "wait-pics" => loop {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let state = ctx.state.lock();
                        if !state.p.pics.is_empty() && state.p.loading == 0 && !state.p.busy && state.p.pics.iter().all(|x| x.thumb.is_some()) {
                            break;
                        }
                    },
                    "wait-queue" => loop {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        let state = ctx.state.lock();
                        if !state.q.jobs.is_empty() && !state.q.running {
                            break;
                        }
                    },
                    _ => {
                        on_ui(&ctx, move |app, _| {
                            let (v, q, i, a) = (app.global::<V>(), app.global::<Q>(), app.global::<I>(), app.global::<A>());
                            let n = number as i32;
                            match name.as_str() {
                                "choose" => v.invoke_choose(n),
                                "queue" => v.invoke_add_to_queue(),
                                "queue-all" => v.invoke_queue_all(),
                                "start" => q.invoke_start(),
                                "advanced" => a.invoke_set_advanced(n == 1),
                                "settings" => a.invoke_open_settings(true),
                                "mode" => a.invoke_set_mode(n),
                                "preset" => v.invoke_pick_preset(n),
                                "tick" => v.invoke_tick(n),
                                "join" => v.invoke_join(),
                                "seek" => v.invoke_seek(number),
                                "cut-start" => v.invoke_cut_start(),
                                "cut-end" => v.invoke_cut_end(),
                                "estimate" => v.invoke_estimate(),
                                "compare" => v.invoke_compare(),
                                "put" => v.invoke_put(first.into(), second),
                                "pic-tool" => i.invoke_put("mode".into(), number),
                                "pic-go" => i.invoke_go(),
                                other => eprintln!("MVS_AUTO: unknown step {other}"),
                            }
                        });
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            }
        });
    }
    // MVS_SNAPSHOT=<file>: save what the window shows, as raw RGBA plus a
    // "<width>x<height>" note, at each of the times (in seconds) listed in
    // MVS_SNAPSHOT_AFTER, e.g. "10,60". Later pictures get "-2", "-3" in the name.
    if let Ok(path) = std::env::var("MVS_SNAPSHOT") {
        let times: Vec<f64> = std::env::var("MVS_SNAPSHOT_AFTER").unwrap_or_else(|_| "5".into()).split(',').filter_map(|s| s.trim().parse().ok()).collect();
        let quit = std::env::var("MVS_SNAPSHOT_QUIT").is_ok();
        let last = times.len();
        for (n, after) in times.into_iter().enumerate() {
            let weak = app.as_weak();
            let file = if n == 0 { PathBuf::from(&path) } else { PathBuf::from(format!("{path}-{}", n + 1)) };
            slint::Timer::single_shot(Duration::from_secs_f64(after), move || {
                if let Some(app) = weak.upgrade() {
                    if let Ok(pixels) = app.window().take_snapshot() {
                        let _ = std::fs::write(file.with_extension("size"), format!("{}x{}", pixels.width(), pixels.height()));
                        let _ = std::fs::write(&file, pixels.as_bytes());
                    }
                }
                if quit && n + 1 == last {
                    let _ = slint::quit_event_loop();
                }
            });
        }
    }
}

fn main() -> Result<(), slint::PlatformError> {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("could not start the background workers");
    let app = App::new()?;

    // The engine reports on background threads; the context it reports to
    // can only be made once the engine exists.
    let late = Arc::new(OnceLock::new());
    let sink: Arc<dyn EventSink> = Arc::new(UiSink(late.clone()));
    let data_dir = data_dir();
    let core = Core::new(&data_dir, None, sink.clone(), runtime.handle().clone());
    let ctx = Arc::new(Ctx {
        runtime: runtime.handle().clone(),
        state: parking_lot::Mutex::new(State { settings: core.settings(), presets: core.presets.list(), ..State::default() }),
        ui: app.as_weak(),
        ids: AtomicU64::new(1),
        data_dir,
        shutdown_cancelled: AtomicBool::new(false),
        core,
    });
    let _ = late.set(ctx.clone());

    video::wire(&app, &ctx);
    queue_ui::wire(&app, &ctx);
    pictures::wire(&app, &ctx);
    settings_ui::wire(&app, &ctx);

    let a = app.global::<A>();
    a.set_advanced(ctx.state.lock().settings.advanced_mode);
    let c = ctx.clone();
    a.on_set_mode(move |mode| set_mode(&c, mode));
    let c = ctx.clone();
    a.on_set_advanced(move |on| settings_ui::set_advanced(&c, on));
    let c = ctx.clone();
    a.on_open_settings(move |open| {
        settings_ui::show(&c);
        on_ui(&c, move |app, _| app.global::<A>().set_settings_open(open));
    });
    let c = ctx.clone();
    a.on_toast_clicked(move || {
        if c.state.lock().toast_action == ToastAction::CancelShutdown {
            c.shutdown_cancelled.store(true, Ordering::SeqCst);
            toast(&c, 0, "The PC will stay on", "");
        } else {
            clear_toast(&c);
        }
    });
    let c = ctx.clone();
    a.on_toast_dismissed(move || {
        // Closing the countdown must not leave the PC turning itself off unseen.
        if c.state.lock().toast_action == ToastAction::CancelShutdown {
            c.shutdown_cancelled.store(true, Ordering::SeqCst);
        }
        clear_toast(&c);
    });
    let c = ctx.clone();
    a.on_close_log(move || {
        c.state.lock().q.log_job = None;
        on_ui(&c, |app, _| app.global::<A>().set_log_open(false));
    });
    let c = ctx.clone();
    a.on_copy_log(move || {
        let text = c.ui.upgrade().map(|app| app.global::<A>().get_log_text().to_string()).unwrap_or_default();
        if copy_text(&text) {
            toast(&c, 1, "Log copied", "");
        } else {
            toast(&c, 3, "Could not copy the log", "");
        }
    });
    let c = ctx.clone();
    a.on_name_done(move |save| {
        let name = c.ui.upgrade().map(|app| app.global::<A>().get_name_text().to_string()).unwrap_or_default();
        video::name_done(&c, save, &name);
    });
    let c = ctx.clone();
    a.on_quit_answer(move |quit| {
        if quit {
            c.core.shutdown();
            let _ = slint::quit_event_loop();
        } else if let Some(app) = c.ui.upgrade() {
            app.global::<A>().set_confirm_quit(false);
        }
    });

    // Closing the window while a video is being compressed asks first.
    let c = ctx.clone();
    app.window().on_close_requested(move || {
        if c.core.queue.is_busy() {
            if let Some(app) = c.ui.upgrade() {
                app.global::<A>().set_confirm_quit(true);
            }
            slint::CloseRequestResponse::KeepWindowShown
        } else {
            slint::CloseRequestResponse::HideWindow
        }
    });

    // Files dropped on the window arrive one at a time; gather them so that
    // a handful of files is added as one batch.
    {
        use slint::winit_030::{winit, EventResult, WinitWindowAccessor};
        let dropped: Rc<RefCell<Vec<String>>> = Rc::default();
        let timer = Rc::new(slint::Timer::default());
        let c = ctx.clone();
        app.window().on_winit_window_event(move |_, event| {
            if let winit::event::WindowEvent::DroppedFile(path) = event {
                dropped.borrow_mut().push(path.to_string_lossy().into_owned());
                let (dropped, c) = (dropped.clone(), c.clone());
                timer.start(slint::TimerMode::SingleShot, Duration::from_millis(120), move || {
                    let paths = std::mem::take(&mut *dropped.borrow_mut());
                    if !paths.is_empty() {
                        open_paths(&c, paths);
                    }
                });
            }
            EventResult::Propagate
        });
    }

    mvs_core::system::spawn_monitor(sink);
    runtime.spawn(start_up(ctx.clone()));
    test_hooks(&app, &ctx);

    app.show()?;
    let result = slint::run_event_loop();
    ctx.core.shutdown();
    runtime.shutdown_background();
    result
}
