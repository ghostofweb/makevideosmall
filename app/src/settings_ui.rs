//! The Settings sheet.

use crate::ctx::*;
use crate::{queue_ui, video, App, A, S};
use mvs_core::model::*;
use slint::ComponentHandle;
use std::sync::Arc;

/// Change the settings, save them, and bring the window up to date.
pub fn change(ctx: &Arc<Ctx>, edit: impl FnOnce(&mut AppSettings)) -> bool {
    let mut settings = ctx.core.settings();
    edit(&mut settings);
    let saved = match ctx.core.set_settings(settings) {
        Ok(saved) => {
            ctx.state.lock().settings = saved;
            true
        }
        Err(e) => {
            error_toast(ctx, "Could not save the settings", e);
            false
        }
    };
    show(ctx);
    queue_ui::show_queue(ctx);
    saved
}

pub fn show(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let s = app.global::<S>();
        let settings = &state.settings;
        s.set_beside(settings.output_dir.is_none());
        s.set_folder(settings.output_dir.clone().unwrap_or_default().into());
        s.set_suffix(settings.output_suffix.clone().into());
        s.set_suffix_example(
            if settings.output_suffix.is_empty() && settings.output_dir.is_none() {
                "With nothing added, \"Holiday.mp4\" becomes \"Holiday (2).mp4\" so the original is never replaced.".to_string()
            } else {
                format!("\"Holiday.mp4\" becomes \"Holiday{}.mp4\".", settings.output_suffix)
            }
            .into(),
        );
        s.set_has_gpu(state.has_gpu_encoder());
        s.set_prefer_gpu(settings.prefer_gpu);
        s.set_impact(match settings.system_impact {
            SystemImpact::Stealth => 0,
            SystemImpact::Balanced => 1,
            SystemImpact::Beast => 2,
        });
        s.set_delete_original(settings.delete_original);
        s.set_sound(settings.play_sound_on_finish);
        s.set_shutdown(settings.shutdown_on_finish);
        s.set_advanced(settings.advanced_mode);
        s.set_presets(strs(state.presets.iter().map(|p| p.name.clone())));
        s.set_default_preset(state.default_preset().and_then(|d| state.presets.iter().position(|p| p.id == d.id)).map(|i| i as i32).unwrap_or(-1));
        s.set_parallel(settings.parallel_jobs as i32);
        s.set_hardware_decode(settings.hardware_decode);
        let tools = match &state.caps {
            Some(caps) => format!("ffmpeg {}\n{}", caps.ffmpeg_version, caps.ffmpeg_path),
            None => "ffmpeg was not found.".to_string(),
        };
        s.set_about(format!("Make Video Small {}\nEverything runs on this PC. Nothing is uploaded.\n\n{tools}\n\nSettings are kept in {}", env!("CARGO_PKG_VERSION"), ctx.data_dir.display()).into());
        app.global::<A>().set_advanced(settings.advanced_mode);
    });
}

/// Speed or size was chosen: the three simple choices are different now.
fn refresh_choices(ctx: &Arc<Ctx>) {
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        if let Ok(options) = ctx.core.easy_options().await {
            ctx.state.lock().options = options;
            video::options_changed(&ctx);
        }
    });
}

pub fn set_advanced(ctx: &Arc<Ctx>, on: bool) {
    if change(ctx, |s| s.advanced_mode = on) {
        video::mode_changed(ctx);
    }
}

pub fn wire(app: &App, ctx: &Arc<Ctx>) {
    let s = app.global::<S>();
    let c = ctx.clone();
    s.on_put(move |name, value| {
        let on = value > 0.5;
        let index = value.round().max(0.0) as usize;
        match name.as_str() {
            "beside" => {
                change(&c, |s| s.output_dir = None);
                video::renamed(&c);
            }
            "prefer-gpu" => {
                if change(&c, |s| s.prefer_gpu = on) {
                    refresh_choices(&c);
                }
            }
            "impact" => {
                change(&c, |s| s.system_impact = [SystemImpact::Stealth, SystemImpact::Balanced, SystemImpact::Beast][index.min(2)]);
            }
            "delete-original" => {
                change(&c, |s| s.delete_original = on);
            }
            "sound" => {
                change(&c, |s| s.play_sound_on_finish = on);
            }
            "shutdown" => {
                change(&c, |s| s.shutdown_on_finish = on);
            }
            "advanced" => set_advanced(&c, on),
            "default-preset" => {
                let id = c.state.lock().presets.get(index).map(|p| p.id.clone());
                if let Some(id) = id {
                    change(&c, |s| s.default_preset_id = id);
                }
            }
            "parallel" => {
                change(&c, |s| s.parallel_jobs = (index as u32).clamp(1, 4));
            }
            "hardware-decode" => {
                change(&c, |s| s.hardware_decode = on);
            }
            _ => {}
        }
    });
    let c = ctx.clone();
    s.on_put_text(move |name, text| {
        if name == "suffix" && text.as_str() != c.state.lock().settings.output_suffix {
            change(&c, |s| s.output_suffix = text.trim().to_string());
            video::renamed(&c);
        }
    });
    let c = ctx.clone();
    s.on_choose_folder(move || {
        if let Some(dir) = rfd::FileDialog::new().set_title("Save finished videos in").pick_folder() {
            change(&c, |s| s.output_dir = Some(dir.to_string_lossy().into_owned()));
            video::renamed(&c);
        }
    });
}
