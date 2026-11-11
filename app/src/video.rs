//! The video screen: the list of videos being set up and the editor for the
//! selected one (three simple choices, or every control in the advanced view).

use crate::ctx::*;
use crate::fmt::*;
use crate::{App, AudioRow, Choice, SubRow, VideoRow, A, V};
use mvs_core::ffmpeg::command::display_size;
use mvs_core::ffmpeg::runner::JobControl;
use mvs_core::model::*;
use mvs_core::presets::spec_for;
use mvs_core::service::{CommandPreview, VIDEO_EXTENSIONS};
use mvs_core::util::{load_json, save_json};
use serde::{Deserialize, Serialize};
use slint::ComponentHandle;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The three choices after they were tried on a video.
pub struct Easy {
    pub analysis: EasyAnalysis,
    /// A frame of the original, and the same frame encoded with each choice.
    pub original_frame: Option<PathBuf>,
    pub frames: Vec<Option<PathBuf>>,
}

pub struct Source {
    pub id: u64,
    /// For joined videos this describes the whole result.
    pub media: MediaInfo,
    pub spec: JobSpec,
    pub preset_id: Option<String>,
    /// Simple choice in use ("best" | "balanced" | "smallest").
    pub choice: Option<String>,
    /// The person chose for themselves, so a suggestion must not replace it.
    pub picked_by_user: bool,
    pub custom_output: bool,
    pub thumb: Option<PathBuf>,
    pub position: f64,
    pub frame: Option<PathBuf>,
    frame_serial: u64,
    pub easy: Option<Easy>,
    pub checking: Option<Arc<JobControl>>,
    pub check_progress: f64,
    pub check_stage: String,
    pub check_error: Option<String>,
    pub analysis: Option<SourceAnalysis>,
    pub analyzing: bool,
    pub estimate: Option<Estimate>,
    pub estimating: Option<Arc<JobControl>>,
    /// Stills of a short clip before and after, with a caption for the result.
    pub compare: Option<(PathBuf, PathBuf, String)>,
    pub comparing: Option<Arc<JobControl>>,
    pub compare_progress: f64,
    pub compare_stage: String,
    pub plan: Option<CommandPreview>,
    pub plan_error: Option<String>,
    plan_serial: u64,
}

impl Source {
    fn new(id: u64, media: MediaInfo, spec: JobSpec, preset_id: Option<String>, choice: Option<String>) -> Self {
        let position = spec.trim.map(|t| t.start).unwrap_or((media.duration * 0.15).min(20.0));
        Source {
            id, media, spec, preset_id, choice,
            picked_by_user: false, custom_output: false, thumb: None, position, frame: None, frame_serial: 0,
            easy: None, checking: None, check_progress: 0.0, check_stage: String::new(), check_error: None,
            analysis: None, analyzing: false, estimate: None, estimating: None,
            compare: None, comparing: None, compare_progress: 0.0, compare_stage: String::new(),
            plan: None, plan_error: None, plan_serial: 0,
        }
    }

    pub fn joined(&self) -> bool {
        !self.spec.extra_inputs.is_empty()
    }

    fn name(&self) -> String {
        if self.joined() { format!("{} videos joined", self.spec.extra_inputs.len() + 1) } else { self.media.file_name.clone() }
    }

    /// The size estimate that matches the current settings and cut.
    fn current_estimate(&self) -> Option<Estimate> {
        let tried = self.choice.as_ref().and_then(|c| self.easy.as_ref()?.analysis.choices.iter().find(|x| &x.id == c));
        match tried {
            Some(t) => Some(scale_estimate(&t.estimate, job_duration(&self.spec, &self.media) / job_duration(&t.spec, &self.media))),
            None => self.estimate.clone(),
        }
    }

    fn stop_work(&mut self) {
        for control in [self.checking.take(), self.estimating.take(), self.comparing.take()].into_iter().flatten() {
            control.cancel();
        }
    }
}

#[derive(Default)]
pub struct VideoState {
    pub sources: Vec<Source>,
    pub selected: Option<u64>,
    /// Ticked videos, in the order they were ticked (that is the join order).
    pub ticked: Vec<u64>,
    pub loading: usize,
    /// The video whose settings are being saved as a preset.
    pub naming: Option<u64>,
}

impl VideoState {
    pub fn get(&mut self, id: u64) -> Option<&mut Source> {
        self.sources.iter_mut().find(|s| s.id == id)
    }
    fn current(&mut self) -> Option<&mut Source> {
        let id = self.selected?;
        self.get(id)
    }
    fn outputs_except(&self, id: Option<u64>) -> Vec<String> {
        self.sources.iter().filter(|s| Some(s.id) != id).map(|s| s.spec.output.clone()).collect()
    }
    /// What batch actions apply to: the ticked videos, or all of them.
    fn targets(&self) -> Vec<u64> {
        if self.ticked.is_empty() { self.sources.iter().map(|s| s.id).collect() } else { self.ticked.clone() }
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    spec: JobSpec,
    preset_id: Option<String>,
    choice: Option<String>,
    custom_output: bool,
    picked_by_user: bool,
}

fn save_list(ctx: &Arc<Ctx>) {
    let saved: Vec<Saved> = ctx
        .state
        .lock()
        .v
        .sources
        .iter()
        .map(|s| Saved { spec: s.spec.clone(), preset_id: s.preset_id.clone(), choice: s.choice.clone(), custom_output: s.custom_output, picked_by_user: s.picked_by_user })
        .collect();
    let _ = save_json(&ctx.data_dir.join("videos.json"), &saved);
}

fn with_ext(path: &str, container: Container) -> String {
    Path::new(path).with_extension(container.ext()).to_string_lossy().into_owned()
}

// ───────────────────────────── Showing ─────────────────────────────

pub fn show_videos(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let v = app.global::<V>();
        let vs = &state.v;
        let rows_: Vec<VideoRow> = vs
            .sources
            .iter()
            .map(|s| {
                let label = s
                    .choice
                    .as_ref()
                    .and_then(|c| state.options.iter().find(|o| &o.id == c).map(|o| o.title.clone()))
                    .or_else(|| s.preset_id.as_ref().and_then(|p| state.presets.iter().find(|x| &x.id == p).map(|x| x.name.clone())))
                    .unwrap_or_else(|| "Your own settings".into());
                let size = s.media.video.as_ref().map(|v| format!("{}×{}", v.width, v.height)).unwrap_or_default();
                VideoRow {
                    name: s.name().into(),
                    detail: format!("{size} / {} / {label}", bytes(s.media.size_bytes)).into(),
                    has_thumb: s.thumb.is_some(),
                    thumb: img(s.thumb.as_deref()),
                    ticked: vs.ticked.contains(&s.id),
                    order: if vs.ticked.len() >= 2 { vs.ticked.iter().position(|t| *t == s.id).map(|i| i as i32 + 1).unwrap_or(0) } else { 0 },
                    ratio: s.current_estimate().filter(|_| s.media.size_bytes > 0.0).map(|e| (e.size_bytes / s.media.size_bytes) as f32).unwrap_or(-1.0),
                }
            })
            .collect();
        let n = rows_.len();
        v.set_videos(rows(rows_));
        v.set_selected(vs.selected.and_then(|id| vs.sources.iter().position(|s| s.id == id)).map(|i| i as i32).unwrap_or(-1));
        v.set_ticked_count(vs.ticked.len() as i32);
        v.set_loading(vs.loading > 0);
        v.set_count_text(if vs.loading > 0 { "reading…".to_string() } else if n > 0 { n.to_string() } else { String::new() }.into());
        v.set_can_add(ctx.core.problem.is_none());
        v.set_option_titles(strs(state.options.iter().map(|o| o.title.clone())));
        let targets = vs.targets();
        let mut shared = vs.sources.iter().filter(|s| targets.contains(&s.id)).map(|s| s.choice.clone());
        let first = shared.next().flatten();
        let same = first.is_some() && shared.all(|c| c == first);
        v.set_shared_choice(if same { state.options.iter().position(|o| Some(&o.id) == first.as_ref()).map(|i| i as i32).unwrap_or(-1) } else { -1 });
        v.set_advanced(state.settings.advanced_mode);
        let ticked = vs.ticked.len();
        v.set_queue_all_text(
            if ticked > 0 { format!("Add {ticked} video{} to queue", if ticked == 1 { "" } else { "s" }) } else if n == 1 { "Add to queue".into() } else { format!("Add all {n} to queue") }
                .into(),
        );
        v.set_presets(strs(preset_labels(&state)));
    });
}

fn preset_labels(state: &State) -> Vec<String> {
    state
        .presets
        .iter()
        .map(|p| if state.usable(p.settings.video.encoder) { p.name.clone() } else { format!("{} (not available on this PC)", p.name) })
        .collect()
}

fn resolution_choices(s: &Source) -> Vec<(String, Resolution)> {
    let (w, h) = s.media.video.as_ref().map(display_size).unwrap_or((0, 0));
    let mut list = vec![(format!("Same as source ({w}×{h})"), Resolution::Source)];
    for height in HEIGHTS.into_iter().filter(|x| *x < h) {
        list.push((format!("{height}p"), Resolution::Height { value: height }));
    }
    match s.spec.settings.video.resolution {
        Resolution::Height { value } if !list.iter().any(|(_, r)| *r == Resolution::Height { value }) => {
            list.push((format!("{value}p (no change for this video)"), Resolution::Height { value }));
        }
        _ => {}
    }
    let custom = match s.spec.settings.video.resolution {
        Resolution::Custom { w, h } => Resolution::Custom { w, h },
        _ => Resolution::Custom { w: w.max(16), h: h.max(16) },
    };
    list.push(("Custom size".into(), custom));
    list
}

fn rate_choices(s: &Source) -> Vec<(String, Fps)> {
    let source = s.media.video.as_ref().map(|v| v.fps).unwrap_or(0.0);
    let mut list = vec![(format!("Same as source ({} fps)", fps(source)), Fps::Source)];
    list.extend(FRAME_RATES.iter().map(|f| (format!("{f} fps"), Fps::Fixed { value: *f })));
    list
}

fn nearest_kbps(kbps: u32) -> i32 {
    AUDIO_KBPS.iter().enumerate().min_by_key(|(_, k)| k.abs_diff(kbps)).map(|(i, _)| i as i32).unwrap_or(2)
}

pub fn show_editor(ctx: &Arc<Ctx>) {
    on_ui(ctx, |app, ctx| {
        let state = ctx.state.lock();
        let v = app.global::<V>();
        let Some(s) = state.v.selected.and_then(|id| state.v.sources.iter().find(|s| s.id == id)) else {
            v.set_has_source(false);
            return;
        };
        let advanced = state.settings.advanced_mode;
        let vs = &s.spec.settings.video;
        let info = state.encoder(vs.encoder);
        let joined = s.joined();
        let duration = s.media.duration;
        v.set_has_source(true);
        v.set_joined(joined);
        v.set_joined_list(
            std::iter::once(&s.spec.input).chain(&s.spec.extra_inputs).enumerate().map(|(i, p)| format!("{}. {}", i + 1, base_name(p))).collect::<Vec<_>>().join("    ").into(),
        );

        // ── The three choices
        let checking = s.checking.is_some();
        let cards: Vec<Choice> = state
            .options
            .iter()
            .map(|option| {
                let mut card = Choice { title: option.title.clone().into(), hint: option.hint.clone().into(), ..Default::default() };
                if let Some((easy, tried)) = s.easy.as_ref().and_then(|e| e.analysis.choices.iter().find(|c| c.id == option.id).map(|c| (e, c))) {
                    let e = scale_estimate(&tried.estimate, job_duration(&s.spec, &s.media) / job_duration(&tried.spec, &s.media));
                    let saved = tried.estimate.savings_percent.round();
                    card.measured = true;
                    card.suggested = easy.analysis.recommended == option.id;
                    card.size = bytes(e.size_bytes).into();
                    card.bigger = saved < 0.0;
                    card.saving = if saved > 0.0 { format!("{saved}% smaller") } else if saved < 0.0 { format!("{}% bigger", -saved) } else { "same size".into() }.into();
                    card.look = tried.look.clone().into();
                    card.time = format!("Takes about {}", span(e.encode_secs)).into();
                }
                card
            })
            .collect();
        v.set_choices(rows(cards));
        let chosen = s.choice.as_ref().and_then(|c| state.options.iter().position(|o| &o.id == c));
        v.set_chosen(chosen.map(|i| i as i32).unwrap_or(-1));
        v.set_checking(checking);
        v.set_check_progress((s.check_progress / 100.0) as f32);
        v.set_check_stage(s.check_stage.clone().into());
        v.set_heading(
            if joined { format!("{} videos will be joined into one", s.spec.extra_inputs.len() + 1) } else if checking { "Checking your video…".into() } else { "How small should it be?".to_string() }
                .into(),
        );
        v.set_advice(if joined { String::new() } else { s.easy.as_ref().map(|e| e.analysis.advice.clone()).unwrap_or_default() }.into());
        v.set_error(s.check_error.as_ref().map(|e| format!("This video could not be checked. You can still compress it. {e}")).unwrap_or_default().into());
        let dims = s.media.video.as_ref().map(|x| format!("{}×{}, ", x.width, x.height)).unwrap_or_default();
        v.set_info(format!("{dims}{}, {}", clock(duration), bytes(s.media.size_bytes)).into());
        v.set_save_as(if advanced { s.spec.output.clone() } else { format!("Saves as {} in {}", base_name(&s.spec.output), dir_name(&s.spec.output)) }.into());

        // ── Picture area
        let simple_pair = if advanced { None } else { chosen.and_then(|i| s.easy.as_ref().and_then(|e| Some((e.original_frame.clone()?, e.frames.get(i)?.clone()?)))) };
        let frame = s.frame.as_deref().or(s.thumb.as_deref());
        v.set_has_frame(frame.is_some());
        v.set_frame(img(frame));
        match (&simple_pair, &s.compare) {
            (Some((left, right)), _) => {
                v.set_left(img(Some(left)));
                v.set_right(img(Some(right)));
                let est = s.current_estimate();
                v.set_right_caption(format!("{}{}", chosen.map(|i| state.options[i].title.clone()).unwrap_or_default(), est.map(|e| format!(", about {}", bytes(e.size_bytes))).unwrap_or_default()).into());
                v.set_has_compare(true);
            }
            (None, Some((left, right, caption))) if advanced => {
                v.set_left(img(Some(left)));
                v.set_right(img(Some(right)));
                v.set_right_caption(caption.clone().into());
                v.set_has_compare(true);
            }
            _ => v.set_has_compare(false),
        }

        // ── Cutting
        let trim = s.spec.trim;
        let (from, to) = trim.map(|t| (t.start, if t.end > 0.0 { t.end } else { duration })).unwrap_or((0.0, duration));
        v.set_length_secs(duration as f32);
        v.set_position(s.position as f32);
        v.set_trim_from(from as f32);
        v.set_trim_to(to as f32);
        v.set_has_trim(trim.is_some());
        v.set_position_text(precise_clock(s.position).into());
        v.set_start_text(precise_clock(from).into());
        v.set_end_text(precise_clock(to).into());
        v.set_keeping_text(
            if trim.is_some() { format!("Keeping {} of {}", precise_clock(job_duration(&s.spec, &s.media)), precise_clock(duration)) } else { precise_clock(duration) }.into(),
        );

        if !advanced {
            return;
        }

        // ── Advanced controls
        let caps = state.caps.as_ref();
        let encoders = caps.map(|c| c.encoders.as_slice()).unwrap_or(&[]);
        v.set_encoders(strs(encoders.iter().map(|e| if e.available { e.label.clone() } else { format!("{} (not available on this PC)", e.label) })));
        v.set_encoder(encoders.iter().position(|e| e.id == vs.encoder).map(|i| i as i32).unwrap_or(-1));
        let copy = vs.encoder == VideoEncoder::Copy;
        v.set_is_copy(copy);
        v.set_encoder_hint(
            if copy {
                "The picture is copied untouched: instant, no quality loss, and no size change. Use it to cut a clip or swap the sound.".to_string()
            } else if info.map(|i| i.hardware).unwrap_or(false) {
                format!("Runs on your {} graphics card. Much faster than a processor encoder; files are bigger at the same quality.", info.and_then(|i| i.vendor.clone()).unwrap_or_default())
            } else {
                "Runs on the processor. Slower than a graphics-card encoder, but smaller files at the same quality.".to_string()
            }
            .into(),
        );
        v.set_rate_mode(match vs.rate { RateControl::Quality { .. } => 0, RateControl::Bitrate { .. } => 1, RateControl::TargetSize { .. } => 2 });
        if let (RateControl::Quality { value }, Some(i)) = (vs.rate, info) {
            v.set_quality(slider_from_quality(i, value));
            v.set_quality_hint(format!("{} {value} on this encoder's own scale ({} is best, {} is smallest). The default is {}.", i.quality_label, i.quality_min, i.quality_max, i.quality_default).into());
        }
        if let RateControl::Bitrate { kbps } = vs.rate {
            v.set_kbps_text(kbps.to_string().into());
        }
        v.set_kbps_hint(s.media.video.as_ref().map(|x| format!("The source video is about {}.", bitrate(x.bitrate))).unwrap_or_default().into());
        if let RateControl::TargetSize { mb } = vs.rate {
            v.set_size_text(format!("{mb}").into());
        }
        v.set_two_pass(vs.two_pass);
        v.set_two_pass_allowed(info.map(|i| i.supports_two_pass).unwrap_or(false));
        v.set_speed(match vs.speed { Speed::Slowest => 0, Speed::Slow => 1, Speed::Medium => 2, Speed::Fast => 3, Speed::Fastest => 4 });
        let res = resolution_choices(s);
        v.set_resolutions(strs(res.iter().map(|(l, _)| l.clone())));
        let custom = matches!(vs.resolution, Resolution::Custom { .. });
        v.set_resolution(if custom { res.len() as i32 - 1 } else { res.iter().position(|(_, r)| *r == vs.resolution).map(|i| i as i32).unwrap_or(0) });
        v.set_custom_size(custom);
        if let Resolution::Custom { w, h } = vs.resolution {
            v.set_width_text(w.to_string().into());
            v.set_height_text(h.to_string().into());
        }
        let rates = rate_choices(s);
        v.set_rates(strs(rates.iter().map(|(l, _)| l.clone())));
        v.set_rate(rates.iter().position(|(_, r)| *r == vs.fps).map(|i| i as i32).unwrap_or(0));
        v.set_crop_mode(match vs.crop { CropMode::None => 0, CropMode::Auto => 1, CropMode::Manual { .. } => 2 });
        v.set_crop_hint(
            match (vs.crop, s.spec.auto_crop, &s.analysis) {
                (CropMode::Auto, Some(c), _) => format!("Black bars found. The picture will be cropped to {}×{}.", c.w, c.h),
                (CropMode::Auto, None, Some(_)) => "No black bars were found in this video, so nothing will be cropped.".into(),
                (CropMode::Auto, None, None) => "Black bars are looked for when the video is compressed. Use \"Check for black bars\" on the Summary tab to see the result now.".into(),
                _ => String::new(),
            }
            .into(),
        );
        if let CropMode::Manual { w, h, x, y } = vs.crop {
            v.set_crop_w(w.to_string().into());
            v.set_crop_h(h.to_string().into());
            v.set_crop_x(x.to_string().into());
            v.set_crop_y(y.to_string().into());
        }
        v.set_depth(match vs.bit_depth { BitDepth::Auto => 0, BitDepth::Eight => 1, BitDepth::Ten => 2 });
        v.set_ten_allowed(info.map(|i| i.supports_ten_bit).unwrap_or(false));
        v.set_is_hdr(s.media.video.as_ref().map(|x| x.is_hdr).unwrap_or(false));
        v.set_hdr(if vs.hdr == HdrMode::Keep { 0 } else { 1 });
        v.set_grain_allowed(info.map(|i| i.supports_film_grain).unwrap_or(false));
        v.set_grain(vs.film_grain as f32);
        let containers: Vec<Container> = info.map(|i| i.containers.clone()).unwrap_or_else(|| vec![Container::Mp4, Container::Mkv]);
        v.set_containers(strs(containers.iter().map(|c| container_label(*c))));
        v.set_container(containers.iter().position(|c| *c == s.spec.settings.container).map(|i| i as i32).unwrap_or(-1));
        v.set_keep_chapters(s.spec.settings.keep_chapters);
        v.set_keep_metadata(s.spec.settings.keep_metadata);
        v.set_chapters_hint(if s.media.chapters > 0 { format!("This video has {} chapter markers.", s.media.chapters) } else { "This video has no chapter markers.".to_string() }.into());
        let f = &s.spec.settings.filters;
        let interlaced = s.media.video.as_ref().map(|x| x.interlaced).unwrap_or(false);
        v.set_deinterlace(match f.deinterlace { Deinterlace::Off => 0, Deinterlace::Yadif => 1, Deinterlace::Bwdif => 2 });
        v.set_deinterlace_hint(
            if interlaced { "This video is interlaced; deinterlacing removes the comb-like lines on motion." } else { "Only needed for interlaced video such as old TV recordings. This video is not interlaced." }.into(),
        );
        let strength = |x: Strength| match x { Strength::Off => 0, Strength::Light => 1, Strength::Medium => 2, Strength::Strong => 3 };
        v.set_denoise(strength(f.denoise));
        v.set_sharpen(strength(f.sharpen));
        v.set_rotate(match f.rotate { Rotate::None => 0, Rotate::Cw90 => 1, Rotate::Cw180 => 2, Rotate::Cw270 => 3 });
        v.set_flip_h(f.flip_h);
        v.set_flip_v(f.flip_v);

        // ── Tracks
        let audio: Vec<AudioRow> = if joined {
            Vec::new()
        } else {
            s.media
                .audio
                .iter()
                .map(|a| {
                    let track = s.spec.audio_tracks.iter().find(|t| t.order == a.order);
                    let d = s.spec.settings.audio;
                    AudioRow {
                        title: format!("Track {}: {}{}", a.order + 1, language(a.language.as_deref()), a.title.as_ref().map(|t| format!(", {t}")).unwrap_or_default()).into(),
                        detail: format!("{}, {}, {} kHz{}{}", a.codec.to_uppercase(), channels(a.channels), a.sample_rate as f64 / 1000.0, if a.bitrate > 0.0 { format!(", {}", bitrate(a.bitrate)) } else { String::new() }, if a.default { ", default track" } else { "" }).into(),
                        keep: track.is_some(),
                        codec: match track.map(|t| t.codec).unwrap_or(d.codec) { AudioCodec::Copy => 0, AudioCodec::Aac => 1, AudioCodec::Opus => 2, AudioCodec::Ac3 => 3, AudioCodec::Flac => 4 },
                        kbps: nearest_kbps(track.map(|t| t.bitrate_kbps).unwrap_or(d.bitrate_kbps)),
                        mix: match track.map(|t| t.mixdown).unwrap_or(d.mixdown) { Mixdown::Source => 0, Mixdown::Mono => 1, Mixdown::Stereo => 2, Mixdown::Surround51 => 3 },
                    }
                })
                .collect()
        };
        v.set_audio_tab(if joined { "Audio".to_string() } else { format!("Audio {}/{}", s.spec.audio_tracks.len(), s.media.audio.len()) }.into());
        v.set_audio(rows(audio));
        let subs: Vec<SubRow> = if joined {
            Vec::new()
        } else {
            s.media
                .subtitles
                .iter()
                .map(|sub| {
                    let track = s.spec.subtitle_tracks.iter().find(|t| t.order == sub.order);
                    SubRow {
                        title: format!("Track {}: {}{}{}", sub.order + 1, language(sub.language.as_deref()), sub.title.as_ref().map(|t| format!(", {t}")).unwrap_or_default(), if sub.forced { " (forced)" } else { "" }).into(),
                        detail: format!("{}, {}", sub.codec.to_uppercase(), if sub.is_text { "text" } else { "picture-based" }).into(),
                        mode: match track.map(|t| t.mode) { None => 0, Some(SubtitleMode::Copy) => 1, Some(SubtitleMode::Burn) => 2 },
                        shown_by_default: track.map(|t| t.default).unwrap_or(false),
                    }
                })
                .collect()
        };
        v.set_subs_tab(if joined { "Subtitles".to_string() } else { format!("Subtitles {}/{}", s.spec.subtitle_tracks.len(), s.media.subtitles.len()) }.into());
        v.set_subs(rows(subs));

        // ── Presets
        v.set_preset(s.preset_id.as_ref().and_then(|p| state.presets.iter().position(|x| &x.id == p)).map(|i| i as i32).unwrap_or(-1));
        v.set_preset_is_mine(s.preset_id.as_ref().and_then(|p| state.presets.iter().find(|x| &x.id == p)).map(|p| !p.builtin).unwrap_or(false));

        // ── Summary
        let kept = if duration > 0.0 { job_duration(&s.spec, &s.media) / duration } else { 1.0 };
        let est = s.current_estimate();
        let source_bytes = s.media.size_bytes * kept;
        v.set_estimate_ratio(est.as_ref().filter(|_| source_bytes > 0.0).map(|e| (e.size_bytes / source_bytes) as f32).unwrap_or(-1.0));
        v.set_estimate_text(
            est.map(|e| {
                format!(
                    "{} to about {}, {}.{} {}",
                    bytes(source_bytes),
                    bytes(e.size_bytes),
                    savings_label(source_bytes, e.size_bytes),
                    if e.encode_secs > 0.0 { format!(" About {} to encode.", span(e.encode_secs)) } else { String::new() },
                    if e.sampled { "Measured from three short samples; the real file can differ by 10 to 20%." } else { "Worked out from the bitrate, so it is close to exact." }
                )
            })
            .unwrap_or_else(|| format!("{} now. Not estimated yet.", bytes(source_bytes)))
            .into(),
        );
        v.set_estimating(s.estimating.is_some());
        v.set_warnings(s.plan.as_ref().map(|p| p.warnings.join("\n")).unwrap_or_default().into());
        v.set_plan_error(s.plan_error.clone().unwrap_or_default().into());
        v.set_command(s.plan.as_ref().map(|p| p.command.clone()).unwrap_or_default().into());
        v.set_source_text(
            format!(
                "{}\n{}, {}, {}\n{}",
                s.media.video.as_ref().map(|x| format!("{}, {}×{}, {} fps, {}-bit{}{}", x.codec.to_uppercase(), x.width, x.height, fps(x.fps), x.bit_depth, if x.is_hdr { " HDR" } else { "" }, if x.interlaced { ", interlaced" } else { "" })).unwrap_or_default(),
                clock(duration),
                bytes(s.media.size_bytes),
                bitrate(s.media.bitrate),
                dir_name(&s.media.path)
            )
            .into(),
        );
        v.set_analyzing(s.analyzing);
        let a = s.analysis.as_ref();
        v.set_finding_bars(a.map(|a| a.crop.map(|c| format!("Black bars found: the picture itself is {}×{}.", c.w, c.h)).unwrap_or_else(|| "No black bars.".into())).unwrap_or_default().into());
        v.set_can_crop_bars(a.map(|a| a.crop.is_some()).unwrap_or(false) && !(vs.crop == CropMode::Auto && s.spec.auto_crop.is_some()));
        v.set_finding_noise(a.map(|a| format!("{}.", a.noise_profile)).unwrap_or_default().into());
        let grain_ok = info.map(|i| i.supports_film_grain).unwrap_or(false);
        v.set_noise_action(
            match a {
                Some(a) if a.grain_level > 0 && grain_ok && vs.film_grain != a.grain_level => format!("Use film grain {}", a.grain_level),
                Some(a) if a.grain_level > 0 && !grain_ok && f.denoise == Strength::Off => "Reduce noise lightly".into(),
                _ => String::new(),
            }
            .into(),
        );
        v.set_finding_interlaced(a.map(|a| a.interlaced).unwrap_or(false));
        v.set_comparing(s.comparing.is_some());
        v.set_compare_progress((s.compare_progress / 100.0) as f32);
        v.set_compare_stage(s.compare_stage.clone().into());
    });
}

// ───────────────────────────── Adding and removing ─────────────────────────────

/// Settings a newly added video starts with, and how they are labelled.
fn starting_point(state: &State) -> Option<(EncodeSettings, Option<String>, Option<String>)> {
    let balanced = state.options.iter().find(|o| o.id == "balanced");
    match (state.settings.advanced_mode, balanced, state.default_preset()) {
        (false, Some(b), _) => Some((b.settings.clone(), None, Some("balanced".into()))),
        (_, _, Some(p)) => Some((p.settings.clone(), Some(p.id.clone()), None)),
        (_, Some(b), None) => Some((b.settings.clone(), None, Some("balanced".into()))),
        _ => None,
    }
}

pub fn add_paths(ctx: &Arc<Ctx>, paths: Vec<String>) {
    let files = mvs_core::service::expand_paths(&paths, VIDEO_EXTENSIONS);
    let (incoming, start) = {
        let mut state = ctx.state.lock();
        let known: Vec<String> = state.v.sources.iter().filter(|s| !s.joined()).map(|s| s.media.path.to_lowercase()).collect();
        let incoming: Vec<String> = files.iter().filter(|f| !known.contains(&f.to_lowercase())).cloned().collect();
        state.v.loading += incoming.len();
        (incoming, starting_point(&state))
    };
    if incoming.is_empty() {
        toast(ctx, 0, if files.is_empty() { "No videos were found there." } else { "Those videos are already in the list." }, "");
        return;
    }
    let Some((settings, preset_id, choice)) = start else {
        ctx.state.lock().v.loading -= incoming.len();
        toast(ctx, 3, "This PC has no video encoder the app can use.", "");
        return;
    };
    show_videos(ctx);
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let mut failed = Vec::new();
        for path in incoming {
            let made = async {
                let media = ctx.core.probe(&path).await?;
                if media.video.is_none() {
                    return Err(mvs_core::error::AppError::msg("This file has no video in it."));
                }
                let taken = ctx.state.lock().v.outputs_except(None);
                let spec = ctx.core.make_spec(&path, &settings, &taken).await?;
                Ok((media, spec))
            }
            .await;
            let added = {
                let mut state = ctx.state.lock();
                state.v.loading -= 1;
                match made {
                    Ok((media, spec)) => {
                        let id = ctx.next_id();
                        state.v.sources.push(Source::new(id, media, spec, preset_id.clone(), choice.clone()));
                        Some((id, state.v.selected.is_none()))
                    }
                    Err(e) => {
                        failed.push(format!("{}: {e}", base_name(&path)));
                        None
                    }
                }
            };
            show_videos(&ctx);
            if let Some((id, first)) = added {
                if first {
                    select(&ctx, id);
                }
                load_thumb(&ctx, id);
            }
        }
        save_list(&ctx);
        if !failed.is_empty() {
            toast(&ctx, 3, format!("{} file{} could not be added", failed.len(), if failed.len() == 1 { "" } else { "s" }), failed.join("; "));
        }
    });
}

fn load_thumb(ctx: &Arc<Ctx>, id: u64) {
    let Some((mut spec, at)) = ctx.state.lock().v.get(id).map(|s| (s.spec.clone(), (s.media.duration * 0.15).min(20.0))) else { return };
    spec.extra_inputs.clear();
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        if let Ok(path) = ctx.core.render_frame(&spec, at, 320).await {
            if let Some(s) = ctx.state.lock().v.get(id) {
                s.thumb = Some(path);
            }
            show_videos(&ctx);
            show_editor(&ctx);
        }
    });
}

/// Bring back the list from last time.
pub async fn restore(ctx: &Arc<Ctx>) {
    let saved: Vec<Saved> = load_json(&ctx.data_dir.join("videos.json"));
    for item in saved {
        let media = if item.spec.extra_inputs.is_empty() { ctx.core.probe(&item.spec.input).await } else { ctx.core.join_info(&item.spec).await };
        // A video that was moved or deleted since last time is quietly forgotten.
        let Ok(media) = media else { continue };
        let id = ctx.next_id();
        let mut source = Source::new(id, media, item.spec, item.preset_id, item.choice);
        source.custom_output = item.custom_output;
        source.picked_by_user = item.picked_by_user;
        let first = {
            let mut state = ctx.state.lock();
            state.v.sources.push(source);
            state.v.selected.is_none()
        };
        show_videos(ctx);
        if first {
            select(ctx, id);
        }
        load_thumb(ctx, id);
    }
}

/// "Change" on a waiting job: bring it back with every setting intact.
pub fn add_from_job(ctx: &Arc<Ctx>, job: Job) {
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let media = if job.spec.extra_inputs.is_empty() { ctx.core.probe(&job.spec.input).await } else { ctx.core.join_info(&job.spec).await };
        match media {
            Ok(media) => {
                let id = ctx.next_id();
                let mut source = Source::new(id, media, job.spec, None, None);
                source.custom_output = true;
                source.picked_by_user = true;
                ctx.state.lock().v.sources.push(source);
                select(&ctx, id);
                load_thumb(&ctx, id);
                save_list(&ctx);
            }
            Err(e) => error_toast(&ctx, "That video can no longer be read.", e),
        }
    });
}

fn remove(ctx: &Arc<Ctx>, ids: &[u64]) {
    let next = {
        let mut state = ctx.state.lock();
        for s in state.v.sources.iter_mut().filter(|s| ids.contains(&s.id)) {
            s.stop_work();
        }
        state.v.sources.retain(|s| !ids.contains(&s.id));
        state.v.ticked.retain(|t| !ids.contains(t));
        if state.v.selected.map(|id| ids.contains(&id)).unwrap_or(false) {
            state.v.selected = state.v.sources.first().map(|s| s.id);
            state.v.selected
        } else {
            None
        }
    };
    save_list(ctx);
    match next {
        Some(id) => select(ctx, id),
        None => {
            show_videos(ctx);
            show_editor(ctx);
        }
    }
}

pub fn select(ctx: &Arc<Ctx>, id: u64) {
    let (needs_check, advanced) = {
        let mut state = ctx.state.lock();
        state.v.selected = Some(id);
        let advanced = state.settings.advanced_mode;
        let needs = state.v.get(id).map(|s| !advanced && s.easy.is_none() && s.checking.is_none() && s.check_error.is_none() && !s.joined()).unwrap_or(false);
        (needs, advanced)
    };
    show_videos(ctx);
    show_editor(ctx);
    request_frame(ctx, id, 0);
    if needs_check {
        start_check(ctx, id);
    }
    if advanced {
        request_plan(ctx, id);
    }
}

/// The simple view was switched on or off: bring the selected video up to date.
pub fn mode_changed(ctx: &Arc<Ctx>) {
    let selected = ctx.state.lock().v.selected;
    match selected {
        Some(id) => select(ctx, id),
        None => {
            show_videos(ctx);
            show_editor(ctx);
        }
    }
}

/// Where finished files go, or what is added to their name, was changed.
pub fn renamed(ctx: &Arc<Ctx>) {
    {
        let mut state = ctx.state.lock();
        let ids: Vec<u64> = state.v.sources.iter().filter(|s| !s.custom_output && !s.joined()).map(|s| s.id).collect();
        for id in ids {
            let others = state.v.outputs_except(Some(id));
            if let Some(s) = state.v.get(id) {
                s.spec.output = ctx.core.output_for(&s.spec.input, s.spec.settings.container, &others);
            }
        }
    }
    show_editor(ctx);
    save_list(ctx);
}

// ───────────────────────────── Preview frames and the plan ─────────────────────────────

/// Redraw the still for the current position, after a short pause so that
/// dragging the slider does not start a render for every pixel.
fn request_frame(ctx: &Arc<Ctx>, id: u64, wait_ms: u64) {
    let Some((mut spec, at, serial)) = ctx.state.lock().v.get(id).map(|s| {
        s.frame_serial += 1;
        (s.spec.clone(), s.position.min(s.media.duration), s.frame_serial)
    }) else {
        return;
    };
    spec.extra_inputs.clear();
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
        if ctx.state.lock().v.get(id).map(|s| s.frame_serial) != Some(serial) {
            return;
        }
        if let Ok(path) = ctx.core.render_frame(&spec, at, 1280).await {
            let current = {
                let mut state = ctx.state.lock();
                match state.v.get(id) {
                    Some(s) if s.frame_serial == serial => {
                        s.frame = Some(path);
                        true
                    }
                    _ => false,
                }
            };
            if current {
                show_editor(&ctx);
            }
        }
    });
}

/// Ask the engine what this job would run: it reports problems before queueing.
fn request_plan(ctx: &Arc<Ctx>, id: u64) {
    let Some((spec, serial)) = ctx.state.lock().v.get(id).map(|s| {
        s.plan_serial += 1;
        (s.spec.clone(), s.plan_serial)
    }) else {
        return;
    };
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let result = ctx.core.command_preview(&spec).await;
        {
            let mut state = ctx.state.lock();
            let Some(s) = state.v.get(id).filter(|s| s.plan_serial == serial) else { return };
            match result {
                Ok(plan) => {
                    s.plan = Some(plan);
                    s.plan_error = None;
                }
                Err(e) => s.plan_error = Some(e.to_string()),
            }
        }
        show_editor(&ctx);
    });
}

// ───────────────────────────── Changing settings ─────────────────────────────

/// Change a video's settings by hand (the advanced controls).
fn edit(ctx: &Arc<Ctx>, change: impl FnOnce(&mut Source, &State2)) {
    let id = {
        let mut state = ctx.state.lock();
        let view = State2 { caps: state.caps.clone(), others: state.v.outputs_except(state.v.selected) };
        let Some(s) = state.v.current() else { return };
        let container = s.spec.settings.container;
        change(s, &view);
        s.preset_id = None;
        s.choice = None;
        s.picked_by_user = true;
        // Any change makes the old estimate and comparison stale.
        s.estimate = None;
        s.compare = None;
        if s.spec.settings.container != container {
            s.spec.output = if s.custom_output {
                with_ext(&s.spec.output, s.spec.settings.container)
            } else {
                let (input, c) = (s.spec.input.clone(), s.spec.settings.container);
                ctx.core.output_for(&input, c, &view.others)
            };
        }
        s.id
    };
    show_videos(ctx);
    show_editor(ctx);
    request_plan(ctx, id);
    request_frame(ctx, id, 150);
    save_list(ctx);
}

/// What `edit` closures may look at besides the video itself.
pub struct State2 {
    caps: Option<Capabilities>,
    others: Vec<String>,
}

impl State2 {
    fn encoder(&self, id: VideoEncoder) -> Option<&EncoderInfo> {
        self.caps.as_ref().and_then(|c| c.encoders.iter().find(|e| e.id == id))
    }
}

fn set_trim(ctx: &Arc<Ctx>, start: f64, end: f64) {
    let id = {
        let mut state = ctx.state.lock();
        let Some(s) = state.v.current() else { return };
        let duration = s.media.duration;
        let a = start.clamp(0.0, duration);
        let b = end.clamp(a, duration);
        let whole = a < 0.05 && duration - b < 0.05;
        s.spec.trim = if whole || b - a < 0.1 { None } else { Some(Trim { start: a, end: b }) };
        s.compare = None;
        s.id
    };
    show_videos(ctx);
    show_editor(ctx);
    request_plan(ctx, id);
    save_list(ctx);
}

fn put(ctx: &Arc<Ctx>, name: &str, value: f32) {
    let index = value.round().max(0.0) as usize;
    let on = value > 0.5;
    if name == "encoder" {
        let target = ctx.state.lock().caps.as_ref().and_then(|c| c.encoders.get(index).cloned());
        match target {
            Some(to) if to.available => edit(ctx, move |s, view| {
                let from = view.encoder(s.spec.settings.video.encoder).cloned();
                s.spec.settings = switch_encoder(&s.spec.settings, from.as_ref(), &to);
            }),
            Some(to) => {
                toast(ctx, 2, format!("{} cannot be used on this PC", to.label), to.reason.unwrap_or_default());
                show_editor(ctx);
            }
            None => {}
        }
        return;
    }
    let name = name.to_string();
    edit(ctx, move |s, view| {
        let info = view.encoder(s.spec.settings.video.encoder).cloned();
        let source_bitrate = s.media.video.as_ref().map(|v| v.bitrate).unwrap_or(8e6);
        let size_mb = s.media.size_bytes / 1_048_576.0;
        let res = resolution_choices(s);
        let rates = rate_choices(s);
        let auto_crop = s.spec.auto_crop;
        let (dw, dh) = s.media.video.as_ref().map(display_size).unwrap_or((0, 0));
        let settings = &mut s.spec.settings;
        let v = &mut settings.video;
        let strength = |i: usize| [Strength::Off, Strength::Light, Strength::Medium, Strength::Strong][i.min(3)];
        match name.as_str() {
            "rate-mode" => {
                v.rate = match index {
                    0 => RateControl::Quality { value: info.as_ref().map(|i| i.quality_default).unwrap_or(28) },
                    1 => RateControl::Bitrate { kbps: ((source_bitrate / 1000.0 / 4.0).round() as u32).max(300) },
                    _ => RateControl::TargetSize { mb: (size_mb / 4.0).round().max(1.0) },
                };
                if index == 2 {
                    v.two_pass = info.as_ref().map(|i| i.supports_two_pass).unwrap_or(false);
                }
            }
            "quality" => {
                if let Some(i) = &info {
                    v.rate = RateControl::Quality { value: quality_from_slider(i, value) };
                }
            }
            "size" => v.rate = RateControl::TargetSize { mb: (value as f64).max(1.0) },
            "two-pass" => v.two_pass = on,
            "speed" => v.speed = [Speed::Slowest, Speed::Slow, Speed::Medium, Speed::Fast, Speed::Fastest][index.min(4)],
            "resolution" => {
                if let Some((_, r)) = res.get(index) {
                    v.resolution = *r;
                }
            }
            "rate" => {
                if let Some((_, r)) = rates.get(index) {
                    v.fps = *r;
                }
            }
            "crop-mode" => {
                v.crop = match index {
                    0 => CropMode::None,
                    1 => CropMode::Auto,
                    _ => {
                        let c = auto_crop.unwrap_or(Crop { w: dw, h: dh, x: 0, y: 0 });
                        CropMode::Manual { w: c.w, h: c.h, x: c.x, y: c.y }
                    }
                }
            }
            "depth" => v.bit_depth = [BitDepth::Auto, BitDepth::Eight, BitDepth::Ten][index.min(2)],
            "hdr" => v.hdr = if index == 0 { HdrMode::Keep } else { HdrMode::Tonemap },
            "grain" => v.film_grain = (value.round().max(0.0) as u32).min(50),
            "container" => {
                if let Some(c) = info.as_ref().and_then(|i| i.containers.get(index)) {
                    settings.container = *c;
                }
            }
            "keep-chapters" => settings.keep_chapters = on,
            "keep-metadata" => settings.keep_metadata = on,
            "deinterlace" => settings.filters.deinterlace = [Deinterlace::Off, Deinterlace::Yadif, Deinterlace::Bwdif][index.min(2)],
            "denoise" => settings.filters.denoise = strength(index),
            "sharpen" => settings.filters.sharpen = strength(index),
            "rotate" => settings.filters.rotate = [Rotate::None, Rotate::Cw90, Rotate::Cw180, Rotate::Cw270][index.min(3)],
            "flip-h" => settings.filters.flip_h = on,
            "flip-v" => settings.filters.flip_v = on,
            _ => {}
        }
    });
}

fn put_text(ctx: &Arc<Ctx>, name: &str, text: &str) {
    let Ok(number) = text.trim().parse::<f64>() else {
        // Not a number: put back what was there.
        show_editor(ctx);
        return;
    };
    let name = name.to_string();
    edit(ctx, move |s, _| {
        let v = &mut s.spec.settings.video;
        let whole = number.round().max(0.0) as u32;
        match (name.as_str(), &mut v.rate, &mut v.resolution, &mut v.crop) {
            ("kbps", rate, _, _) => *rate = RateControl::Bitrate { kbps: whole.clamp(50, 500_000) },
            ("size", rate, _, _) => *rate = RateControl::TargetSize { mb: number.clamp(1.0, 1_000_000.0) },
            ("width", _, Resolution::Custom { w, .. }, _) => *w = whole.clamp(16, 16384),
            ("height", _, Resolution::Custom { h, .. }, _) => *h = whole.clamp(16, 16384),
            ("crop-w", _, _, CropMode::Manual { w, .. }) => *w = whole,
            ("crop-h", _, _, CropMode::Manual { h, .. }) => *h = whole,
            ("crop-x", _, _, CropMode::Manual { x, .. }) => *x = whole,
            ("crop-y", _, _, CropMode::Manual { y, .. }) => *y = whole,
            _ => {}
        }
    });
}

fn audio_put(ctx: &Arc<Ctx>, row: usize, key: &str, value: f32) {
    let index = value.round().max(0.0) as usize;
    let key = key.to_string();
    edit(ctx, move |s, _| {
        let order = row as u32;
        let defaults = s.spec.settings.audio;
        let tracks = &mut s.spec.audio_tracks;
        if key == "keep" {
            if value > 0.5 && !tracks.iter().any(|t| t.order == order) {
                tracks.push(AudioTrack { order, codec: defaults.codec, bitrate_kbps: defaults.bitrate_kbps, mixdown: defaults.mixdown });
                tracks.sort_by_key(|t| t.order);
            } else if value <= 0.5 {
                tracks.retain(|t| t.order != order);
            }
            return;
        }
        let Some(track) = tracks.iter_mut().find(|t| t.order == order) else { return };
        match key.as_str() {
            "codec" => track.codec = [AudioCodec::Copy, AudioCodec::Aac, AudioCodec::Opus, AudioCodec::Ac3, AudioCodec::Flac][index.min(4)],
            "kbps" => track.bitrate_kbps = AUDIO_KBPS[index.min(AUDIO_KBPS.len() - 1)],
            "mix" => track.mixdown = [Mixdown::Source, Mixdown::Mono, Mixdown::Stereo, Mixdown::Surround51][index.min(3)],
            _ => {}
        }
    });
}

fn sub_put(ctx: &Arc<Ctx>, row: usize, key: &str, value: f32) {
    let key = key.to_string();
    edit(ctx, move |s, _| {
        let order = row as u32;
        let tracks = &mut s.spec.subtitle_tracks;
        if key == "mode" {
            let mode = value.round() as i32;
            tracks.retain(|t| t.order != order);
            // Only one subtitle can be burned into the picture.
            if mode == 2 {
                tracks.retain(|t| t.mode != SubtitleMode::Burn);
            }
            if mode > 0 {
                tracks.push(SubtitleTrack { order, mode: if mode == 2 { SubtitleMode::Burn } else { SubtitleMode::Copy }, default: false });
                tracks.sort_by_key(|t| t.order);
            }
        } else if key == "default" {
            let on = value > 0.5;
            for t in tracks.iter_mut() {
                if t.order == order {
                    t.default = on;
                } else if on {
                    t.default = false;
                }
            }
        }
    });
}

// ───────────────────────────── The simple choices ─────────────────────────────

fn start_check(ctx: &Arc<Ctx>, id: u64) {
    let (spec, control) = {
        let mut state = ctx.state.lock();
        // One at a time: two checks running together slow each other down and
        // make every "takes about" figure too high.
        for other in state.v.sources.iter_mut().filter(|s| s.id != id) {
            if let Some(c) = other.checking.take() {
                c.cancel();
            }
        }
        let Some(s) = state.v.get(id).filter(|s| s.checking.is_none() && !s.joined()) else { return };
        let control = Arc::new(JobControl::new());
        s.checking = Some(control.clone());
        s.check_progress = 0.0;
        s.check_stage = "Starting".into();
        s.check_error = None;
        (s.spec.clone(), control)
    };
    show_editor(ctx);
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let mine = |s: &Source| s.checking.as_ref().map(|c| Arc::ptr_eq(c, &control)).unwrap_or(false);
        let progress_ctx = ctx.clone();
        let progress_control = control.clone();
        let result = ctx
            .core
            .easy_analyze(&spec, &control, move |p, stage| {
                if let Some(s) = progress_ctx.state.lock().v.get(id).filter(|s| s.checking.as_ref().map(|c| Arc::ptr_eq(c, &progress_control)).unwrap_or(false)) {
                    s.check_progress = p * 0.94;
                    s.check_stage = stage.to_string();
                }
                show_editor(&progress_ctx);
            })
            .await;
        let result = match result {
            Ok(analysis) => {
                // Stills are enough to judge quality, and far lighter than playing clips.
                let still = |clip: String| {
                    let ctx = ctx.clone();
                    async move {
                        let frame = match ctx.core.clip_frame(&clip, 1.0).await {
                            Ok(f) => Some(f),
                            Err(_) => ctx.core.clip_frame(&clip, 0.0).await.ok(),
                        };
                        let _ = std::fs::remove_file(&clip);
                        frame
                    }
                };
                let original_frame = still(analysis.original.clone()).await;
                let mut frames = Vec::new();
                for choice in &analysis.choices {
                    frames.push(still(choice.preview.clone()).await);
                }
                Ok(Easy { analysis, original_frame, frames })
            }
            Err(e) => Err(e),
        };
        let apply = {
            let mut state = ctx.state.lock();
            let Some(s) = state.v.get(id).filter(|s| mine(s)) else { return };
            s.checking = None;
            match result {
                Ok(easy) => {
                    let pick = if s.picked_by_user { s.choice.clone() } else { Some(easy.analysis.recommended.clone()) };
                    s.analysis = Some(easy.analysis.analysis.clone());
                    s.easy = Some(easy);
                    // Still on a simple choice: switch to the measured version of it.
                    s.choice.as_ref().and(pick)
                }
                Err(mvs_core::error::AppError::Cancelled) => None,
                Err(e) => {
                    s.check_error = Some(e.to_string());
                    None
                }
            }
        };
        match apply {
            Some(choice) => pick_choice(&ctx, id, &choice, false),
            None => {
                show_videos(&ctx);
                show_editor(&ctx);
            }
        }
    });
}

/// Use one of the three simple choices for a video.
fn pick_choice(ctx: &Arc<Ctx>, id: u64, choice: &str, by_user: bool) {
    {
        let mut state = ctx.state.lock();
        let Some(option) = state.options.iter().find(|o| o.id == choice).cloned() else { return };
        let others = state.v.outputs_except(Some(id));
        let Some(s) = state.v.get(id) else { return };
        let tried = s.easy.as_ref().and_then(|e| e.analysis.choices.iter().find(|c| c.id == choice)).map(|c| c.spec.clone());
        let mut spec = match tried {
            // Already tried on this video: the settings include the black-bar crop.
            Some(spec) => spec,
            None => spec_for(&s.media, &option.settings, String::new()),
        };
        spec.trim = s.spec.trim;
        spec.extra_inputs = s.spec.extra_inputs.clone();
        if s.joined() {
            spec.audio_tracks.truncate(1);
            spec.subtitle_tracks.clear();
        }
        spec.output = if s.custom_output || s.joined() {
            with_ext(&s.spec.output, spec.settings.container)
        } else {
            ctx.core.output_for(&s.spec.input, spec.settings.container, &others)
        };
        s.spec = spec;
        s.choice = Some(choice.to_string());
        s.preset_id = None;
        s.estimate = None;
        s.picked_by_user |= by_user;
    }
    show_videos(ctx);
    show_editor(ctx);
    save_list(ctx);
}

/// The simple choices changed (speed or size was switched): earlier
/// measurements no longer apply.
pub fn options_changed(ctx: &Arc<Ctx>) {
    let (repick, selected) = {
        let mut state = ctx.state.lock();
        let mut repick = Vec::new();
        for s in state.v.sources.iter_mut() {
            if let Some(c) = s.checking.take() {
                c.cancel();
            }
            s.easy = None;
            s.check_error = None;
            if let Some(choice) = &s.choice {
                repick.push((s.id, choice.clone()));
            }
        }
        (repick, state.v.selected)
    };
    for (id, choice) in repick {
        pick_choice(ctx, id, &choice, false);
    }
    if let Some(id) = selected {
        select(ctx, id);
    }
}

fn apply_preset(ctx: &Arc<Ctx>, ids: &[u64], index: usize) {
    let preset = {
        let state = ctx.state.lock();
        match state.presets.get(index) {
            Some(p) if state.usable(p.settings.video.encoder) => p.clone(),
            Some(p) => {
                let name = p.name.clone();
                drop(state);
                toast(ctx, 2, format!("\"{name}\" cannot be used on this PC"), "Its encoder is not available here.");
                show_editor(ctx);
                return;
            }
            None => return,
        }
    };
    {
        let mut state = ctx.state.lock();
        for id in ids {
            let others = state.v.outputs_except(Some(*id));
            let Some(s) = state.v.get(*id) else { continue };
            let mut spec = spec_for(&s.media, &preset.settings, String::new());
            // The cut and a chosen file name belong to the video, not the preset.
            spec.trim = s.spec.trim;
            spec.auto_crop = s.spec.auto_crop;
            spec.extra_inputs = s.spec.extra_inputs.clone();
            if s.joined() {
                spec.audio_tracks.truncate(1);
                spec.subtitle_tracks.clear();
            }
            spec.output = if s.custom_output || s.joined() { with_ext(&s.spec.output, spec.settings.container) } else { ctx.core.output_for(&s.spec.input, spec.settings.container, &others) };
            s.spec = spec;
            s.preset_id = Some(preset.id.clone());
            s.choice = None;
            s.picked_by_user = true;
            s.estimate = None;
            s.compare = None;
        }
    }
    show_videos(ctx);
    show_editor(ctx);
    // Read first, then act: the functions below take the same lock.
    let selected = ctx.state.lock().v.selected;
    if let Some(id) = selected {
        request_plan(ctx, id);
        request_frame(ctx, id, 0);
    }
    save_list(ctx);
}

// ───────────────────────────── Queueing and joining ─────────────────────────────

fn queue(ctx: &Arc<Ctx>, ids: Vec<u64>) {
    let specs: Vec<JobSpec> = ctx.state.lock().v.sources.iter().filter(|s| ids.contains(&s.id)).map(|s| s.spec.clone()).collect();
    if specs.is_empty() {
        return;
    }
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        match ctx.core.queue.add(specs).await {
            Ok(_) => remove(&ctx, &ids),
            Err(e) => error_toast(&ctx, "Could not add to the queue", e),
        }
    });
}

fn join(ctx: &Arc<Ctx>) {
    let (paths, settings, others, ids, thumb, advanced) = {
        let state = ctx.state.lock();
        let chosen: Vec<&Source> = state.v.ticked.iter().filter_map(|id| state.v.sources.iter().find(|s| s.id == *id)).collect();
        if chosen.len() < 2 {
            return;
        }
        if chosen.iter().any(|s| s.joined()) {
            drop(state);
            toast(ctx, 2, "One of these is already a joined video", "Untick it and try again.");
            return;
        }
        let advanced = state.settings.advanced_mode;
        let balanced = state.options.iter().find(|o| o.id == "balanced").map(|o| o.settings.clone());
        let settings = match (advanced, balanced) {
            (false, Some(b)) => b,
            _ => chosen[0].spec.settings.clone(),
        };
        let ids: Vec<u64> = chosen.iter().map(|s| s.id).collect();
        let others = state.v.sources.iter().filter(|s| !ids.contains(&s.id)).map(|s| s.spec.output.clone()).collect::<Vec<_>>();
        (chosen.iter().map(|s| s.media.path.clone()).collect::<Vec<_>>(), settings, others, ids, chosen[0].thumb.clone(), advanced)
    };
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        match ctx.core.join_spec(&paths, &settings, &others).await {
            Ok(made) => {
                let id = ctx.next_id();
                let mut source = Source::new(id, made.media, made.spec, None, if advanced { None } else { Some("balanced".into()) });
                source.custom_output = true;
                source.thumb = thumb;
                {
                    let mut state = ctx.state.lock();
                    for s in state.v.sources.iter_mut().filter(|s| ids.contains(&s.id)) {
                        s.stop_work();
                    }
                    let at = state.v.sources.iter().position(|s| s.id == ids[0]).unwrap_or(0);
                    state.v.sources.retain(|s| !ids.contains(&s.id));
                    let at = at.min(state.v.sources.len());
                    state.v.sources.insert(at, source);
                    state.v.ticked.clear();
                }
                toast(&ctx, 1, format!("{} videos will be joined into one", paths.len()), "");
                select(&ctx, id);
                save_list(&ctx);
            }
            Err(e) => error_toast(&ctx, "Those videos cannot be joined", e),
        }
    });
}

// ───────────────────────────── Advanced: estimate, check, compare ─────────────────────────────

fn estimate(ctx: &Arc<Ctx>) {
    let Some((id, spec, control)) = ({
        let mut state = ctx.state.lock();
        state.v.current().filter(|s| s.estimating.is_none()).map(|s| {
            let control = Arc::new(JobControl::new());
            s.estimating = Some(control.clone());
            (s.id, s.spec.clone(), control)
        })
    }) else {
        return;
    };
    show_editor(ctx);
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let result = ctx.core.estimate(&spec, &control, |_, _| {}).await;
        {
            let mut state = ctx.state.lock();
            let Some(s) = state.v.get(id).filter(|s| s.estimating.as_ref().map(|c| Arc::ptr_eq(c, &control)).unwrap_or(false)) else { return };
            s.estimating = None;
            match result {
                // Drop the answer if the settings changed while it was worked out.
                Ok(e) if s.spec == spec => s.estimate = Some(e),
                Ok(_) | Err(mvs_core::error::AppError::Cancelled) => {}
                Err(e) => {
                    drop(state);
                    error_toast(&ctx, "Could not estimate the size", e);
                }
            }
        }
        show_videos(&ctx);
        show_editor(&ctx);
    });
}

fn analyze(ctx: &Arc<Ctx>) {
    let Some((id, path)) = ({
        let mut state = ctx.state.lock();
        state.v.current().filter(|s| !s.analyzing && !s.joined()).map(|s| {
            s.analyzing = true;
            (s.id, s.spec.input.clone())
        })
    }) else {
        return;
    };
    show_editor(ctx);
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let result = ctx.core.analyze_source(&path, &JobControl::new()).await;
        let failed = {
            let mut state = ctx.state.lock();
            let Some(s) = state.v.get(id) else { return };
            s.analyzing = false;
            match result {
                Ok(found) => {
                    s.analysis = Some(found);
                    None
                }
                Err(e) => Some(e),
            }
        };
        if let Some(e) = failed {
            error_toast(&ctx, "Could not check the video", e);
        }
        show_editor(&ctx);
    });
}

fn compare(ctx: &Arc<Ctx>) {
    let Some((id, spec, at, control)) = ({
        let mut state = ctx.state.lock();
        state.v.current().filter(|s| s.comparing.is_none() && !s.joined()).map(|s| {
            let control = Arc::new(JobControl::new());
            s.comparing = Some(control.clone());
            s.compare = None;
            s.compare_progress = 0.0;
            s.compare_stage = "Starting".into();
            (s.id, s.spec.clone(), s.position, control)
        })
    }) else {
        return;
    };
    show_editor(ctx);
    let ctx = ctx.clone();
    ctx.runtime.clone().spawn(async move {
        let mine = |s: &Source| s.comparing.as_ref().map(|c| Arc::ptr_eq(c, &control)).unwrap_or(false);
        let (pc, pcontrol) = (ctx.clone(), control.clone());
        let result = ctx
            .core
            .render_preview(&spec, at, 4.0, &control, move |p, stage| {
                if let Some(s) = pc.state.lock().v.get(id).filter(|s| s.comparing.as_ref().map(|c| Arc::ptr_eq(c, &pcontrol)).unwrap_or(false)) {
                    s.compare_progress = p * 0.9;
                    s.compare_stage = stage.to_string();
                }
                show_editor(&pc);
            })
            .await;
        let stills = match result {
            Ok(pair) => {
                let at = (pair.duration / 2.0).min(1.5);
                let left = ctx.core.clip_frame(&pair.original, at).await;
                let right = ctx.core.clip_frame(&pair.encoded, at).await;
                let _ = std::fs::remove_file(&pair.original);
                let _ = std::fs::remove_file(&pair.encoded);
                let caption = format!("Compressed, about {} for the whole video", bytes(pair.estimate.size_bytes));
                left.and_then(|l| right.map(|r| (l, r, caption)))
            }
            Err(e) => Err(e),
        };
        let failed = {
            let mut state = ctx.state.lock();
            let Some(s) = state.v.get(id).filter(|s| mine(s)) else { return };
            s.comparing = None;
            match stills {
                Ok(done) => {
                    s.compare = Some(done);
                    None
                }
                Err(mvs_core::error::AppError::Cancelled) => None,
                Err(e) => Some(e),
            }
        };
        if let Some(e) = failed {
            error_toast(&ctx, "Could not make the comparison", e);
        }
        show_editor(&ctx);
    });
}

// ───────────────────────────── Presets ─────────────────────────────

pub fn reload_presets(ctx: &Arc<Ctx>) {
    ctx.state.lock().presets = ctx.core.presets.list();
    show_videos(ctx);
    show_editor(ctx);
    crate::settings_ui::show(ctx);
}

/// The name sheet was answered.
pub fn name_done(ctx: &Arc<Ctx>, save: bool, name: &str) {
    let target = {
        let mut state = ctx.state.lock();
        let id = state.v.naming.take();
        let caps = state.caps.clone();
        id.and_then(|id| state.v.get(id).map(|s| (id, s.spec.settings.clone(), describe_settings(&s.spec.settings, caps.as_ref()))))
    };
    on_ui(ctx, |app, _| app.global::<A>().set_naming(false));
    let (Some((id, settings, description)), true) = (target, save && !name.trim().is_empty()) else { return };
    match ctx.core.presets.save(Preset { id: String::new(), name: name.trim().to_string(), description, builtin: false, settings }) {
        Ok(saved) => {
            if let Some(s) = ctx.state.lock().v.get(id) {
                s.preset_id = Some(saved.id.clone());
            }
            toast(ctx, 1, format!("Saved preset \"{}\"", saved.name), "");
            reload_presets(ctx);
        }
        Err(e) => error_toast(ctx, "Could not save the preset", e),
    }
}

// ───────────────────────────── Wiring ─────────────────────────────

pub fn wire(app: &App, ctx: &Arc<Ctx>) {
    let v = app.global::<V>();
    macro_rules! on {
        ($setter:ident, |$c:ident $(, $arg:ident)*| $body:expr) => {{
            let $c = ctx.clone();
            v.$setter(move |$($arg),*| $body);
        }};
    }

    on!(on_add_files, |c| {
        if let Some(files) = rfd::FileDialog::new().set_title("Add videos").add_filter("Videos", VIDEO_EXTENSIONS).pick_files() {
            add_paths(&c, files.iter().map(|f| f.to_string_lossy().into_owned()).collect());
        }
    });
    on!(on_add_folder, |c| {
        if let Some(dir) = rfd::FileDialog::new().set_title("Add every video in a folder").pick_folder() {
            add_paths(&c, vec![dir.to_string_lossy().into_owned()]);
        }
    });
    on!(on_select, |c, i| {
        let id = c.state.lock().v.sources.get(i as usize).map(|s| s.id);
        if let Some(id) = id {
            select(&c, id);
        }
    });
    on!(on_tick, |c, i| {
        {
            let mut state = c.state.lock();
            let Some(id) = state.v.sources.get(i as usize).map(|s| s.id) else { return };
            if state.v.ticked.contains(&id) { state.v.ticked.retain(|t| *t != id) } else { state.v.ticked.push(id) }
        }
        show_videos(&c);
    });
    on!(on_remove, |c, i| {
        let id = c.state.lock().v.sources.get(i as usize).map(|s| s.id);
        if let Some(id) = id {
            remove(&c, &[id]);
        }
    });
    on!(on_join, |c| join(&c));
    on!(on_bulk_choice, |c, i| {
        let (targets, choice) = {
            let state = c.state.lock();
            (state.v.targets(), state.options.get(i as usize).map(|o| o.id.clone()))
        };
        if let Some(choice) = choice {
            for id in targets {
                pick_choice(&c, id, &choice, true);
            }
        }
    });
    on!(on_bulk_preset, |c, i| {
        let targets = c.state.lock().v.targets();
        apply_preset(&c, &targets, i.max(0) as usize);
    });
    on!(on_queue_all, |c| {
        let targets = c.state.lock().v.targets();
        queue(&c, targets);
    });

    on!(on_choose, |c, i| {
        let picked = {
            let state = c.state.lock();
            state.v.selected.zip(state.options.get(i as usize).map(|o| o.id.clone()))
        };
        if let Some((id, choice)) = picked {
            pick_choice(&c, id, &choice, true);
        }
    });
    on!(on_add_to_queue, |c| {
        let selected = c.state.lock().v.selected;
        if let Some(id) = selected {
            queue(&c, vec![id]);
        }
    });
    on!(on_change_output, |c| {
        let Some((output, inputs, container)) = c.state.lock().v.current().map(|s| (s.spec.output.clone(), std::iter::once(s.spec.input.clone()).chain(s.spec.extra_inputs.clone()).collect::<Vec<_>>(), s.spec.settings.container)) else { return };
        let dialog = rfd::FileDialog::new().set_title("Save as").set_directory(dir_name(&output)).set_file_name(base_name(&output)).add_filter(container_label(container), &[container.ext()]);
        let Some(picked) = dialog.save_file() else { return };
        let picked = with_ext(&picked.to_string_lossy(), container);
        if inputs.iter().any(|p| p.eq_ignore_ascii_case(&picked)) {
            toast(&c, 3, "That would replace one of your original videos", "Choose a different name.");
            return;
        }
        if let Some(s) = c.state.lock().v.current() {
            s.spec.output = picked;
            s.custom_output = true;
        }
        show_editor(&c);
        save_list(&c);
    });
    on!(on_recheck, |c| {
        let id = {
            let mut state = c.state.lock();
            state.v.current().map(|s| {
                s.check_error = None;
                s.id
            })
        };
        if let Some(id) = id {
            start_check(&c, id);
        }
    });

    on!(on_seek, |c, at| {
        let id = c.state.lock().v.current().map(|s| {
            s.position = (at as f64).clamp(0.0, s.media.duration);
            s.id
        });
        if let Some(id) = id {
            show_editor(&c);
            request_frame(&c, id, 140);
        }
    });
    let trim_now = |c: &Arc<Ctx>| c.state.lock().v.current().map(|s| (s.position, s.spec.trim.map(|t| t.start).unwrap_or(0.0), s.spec.trim.map(|t| if t.end > 0.0 { t.end } else { s.media.duration }).unwrap_or(s.media.duration)));
    on!(on_cut_start, |c| {
        if let Some((at, _, end)) = trim_now(&c) {
            set_trim(&c, at, end.max(at + 0.1));
        }
    });
    on!(on_cut_end, |c| {
        if let Some((at, start, _)) = trim_now(&c) {
            set_trim(&c, start.min((at - 0.1).max(0.0)), at);
        }
    });
    on!(on_cut_clear, |c| set_trim(&c, 0.0, f64::MAX));
    on!(on_cut_type, |c, which, text| {
        let Some((_, start, end)) = trim_now(&c) else { return };
        match (which.as_str(), parse_clock(&text)) {
            ("start", Some(t)) => set_trim(&c, t, end),
            ("end", Some(t)) => set_trim(&c, start, t),
            _ => show_editor(&c),
        }
    });

    on!(on_put, |c, name, value| put(&c, &name, value));
    on!(on_put_text, |c, name, text| put_text(&c, &name, &text));
    on!(on_audio_put, |c, row, key, value| audio_put(&c, row.max(0) as usize, &key, value));
    on!(on_sub_put, |c, row, key, value| sub_put(&c, row.max(0) as usize, &key, value));

    on!(on_pick_preset, |c, i| {
        let selected = c.state.lock().v.selected;
        if let Some(id) = selected {
            apply_preset(&c, &[id], i.max(0) as usize);
        }
    });
    on!(on_save_preset, |c| {
        {
            let mut state = c.state.lock();
            state.v.naming = state.v.selected;
        }
        on_ui(&c, |app, _| {
            let a = app.global::<A>();
            a.set_name_text("".into());
            a.set_naming(true);
        });
    });
    on!(on_delete_preset, |c| {
        let Some(preset) = ({
            let state = c.state.lock();
            state.v.selected.and_then(|id| state.v.sources.iter().find(|s| s.id == id)).and_then(|s| s.preset_id.clone())
        }) else {
            return;
        };
        match c.core.presets.delete(&preset) {
            Ok(()) => {
                for s in c.state.lock().v.sources.iter_mut().filter(|s| s.preset_id.as_ref() == Some(&preset)) {
                    s.preset_id = None;
                }
                toast(&c, 1, "Preset deleted", "");
                reload_presets(&c);
            }
            Err(e) => error_toast(&c, "Could not delete the preset", e),
        }
    });
    on!(on_import_presets, |c| {
        let Some(file) = rfd::FileDialog::new().set_title("Import presets").add_filter("Presets", &["json"]).pick_file() else { return };
        match c.core.presets.import(&file) {
            Ok(added) => {
                toast(&c, 1, format!("Imported {} preset{}", added.len(), if added.len() == 1 { "" } else { "s" }), "");
                reload_presets(&c);
            }
            Err(e) => error_toast(&c, "Could not import presets", e),
        }
    });
    on!(on_export_presets, |c| {
        let mine: Vec<String> = c.state.lock().presets.iter().filter(|p| !p.builtin).map(|p| p.id.clone()).collect();
        if mine.is_empty() {
            toast(&c, 0, "You have not saved any presets yet", "");
            return;
        }
        let Some(file) = rfd::FileDialog::new().set_title("Export my presets").set_file_name("make-video-small-presets.json").add_filter("Presets", &["json"]).save_file() else { return };
        match c.core.presets.export(&mine, &file) {
            Ok(n) => toast(&c, 1, format!("Exported {n} preset{}", if n == 1 { "" } else { "s" }), ""),
            Err(e) => error_toast(&c, "Could not export presets", e),
        }
    });

    on!(on_estimate, |c| estimate(&c));
    on!(on_cancel_estimate, |c| {
        if let Some(control) = c.state.lock().v.current().and_then(|s| s.estimating.take()) {
            control.cancel();
        }
        show_editor(&c);
    });
    on!(on_analyze, |c| analyze(&c));
    on!(on_apply_crop, |c| edit(&c, |s, _| {
        if let Some(found) = s.analysis.as_ref().and_then(|a| a.crop) {
            s.spec.auto_crop = Some(found);
            s.spec.settings.video.crop = CropMode::Auto;
        }
    }));
    on!(on_apply_noise, |c| edit(&c, |s, view| {
        let Some(level) = s.analysis.as_ref().map(|a| a.grain_level) else { return };
        if view.encoder(s.spec.settings.video.encoder).map(|i| i.supports_film_grain).unwrap_or(false) {
            s.spec.settings.video.film_grain = level;
        } else {
            s.spec.settings.filters.denoise = Strength::Light;
        }
    }));
    on!(on_apply_deinterlace, |c| edit(&c, |s, _| s.spec.settings.filters.deinterlace = Deinterlace::Bwdif));
    on!(on_compare, |c| compare(&c));
    on!(on_close_compare, |c| {
        if let Some(s) = c.state.lock().v.current() {
            if let Some(control) = s.comparing.take() {
                control.cancel();
            }
            s.compare = None;
        }
        show_editor(&c);
    });
    on!(on_copy_command, |c| {
        let command = c.state.lock().v.current().and_then(|s| s.plan.as_ref().map(|p| p.command.clone()));
        match command {
            Some(text) if copy_text(&text) => toast(&c, 1, "Command copied", ""),
            _ => toast(&c, 3, "Could not copy the command", ""),
        }
    });
}
