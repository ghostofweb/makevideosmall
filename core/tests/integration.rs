//! End-to-end tests of the Rust core against the real ffmpeg.
//!
//! Every test generates its own inputs with ffmpeg's built-in test sources,
//! runs the same code paths the app uses, and checks the result with ffprobe.

use mvs_core::analysis;
use mvs_core::error::AppError;
use mvs_core::ffmpeg::caps;
use mvs_core::ffmpeg::command::{plan, PlanOptions};
use mvs_core::ffmpeg::locate::{default_engine_dirs, locate, Tools};
use mvs_core::ffmpeg::probe::probe;
use mvs_core::ffmpeg::runner::{capture, run_ffmpeg, JobControl};
use mvs_core::image::{fit_to_size, probe_image, ImageRunner};
use mvs_core::model::*;
use mvs_core::presets::{builtin_presets, spec_for};
use mvs_core::queue::{ProbeCache, QueueManager};
use mvs_core::util::EventSink;
use parking_lot::{Mutex, RwLock};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

// ───────────────────────────── Fixtures ─────────────────────────────

fn tools() -> Tools {
    locate(&default_engine_dirs(None)).expect("ffmpeg and ffprobe must be installed to run these tests")
}

struct Fixtures {
    dir: tempfile::TempDir,
    /// 6 s, 1280x720, 30 fps, two audio tracks (stereo AAC, 5.1 AC-3), one SRT subtitle.
    main: String,
    /// Same content, in a folder whose name has a space and an apostrophe.
    awkward: String,
    /// 640x360 picture inside a 640x480 frame with black bars.
    letterbox: String,
    interlaced: String,
    /// 20 s of noisy 1080p: slow enough to pause and cancel mid-encode.
    long: String,
    photo: String,
    small_photo: String,
}

fn ffmpeg_blocking(args: &[&str]) {
    let out = std::process::Command::new(&tools().ffmpeg)
        .args(["-hide_banner", "-y", "-nostdin", "-loglevel", "error"])
        .args(args)
        .output()
        .expect("ffmpeg should start");
    assert!(out.status.success(), "fixture ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
}

fn fixtures() -> &'static Fixtures {
    static FIXTURES: OnceLock<Fixtures> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let dir = tempfile::Builder::new().prefix("mvs test ").tempdir().unwrap();
        let p = |name: &str| dir.path().join(name).to_string_lossy().into_owned();

        let srt = p("subs.srt");
        std::fs::write(
            &srt,
            "1\n00:00:00,500 --> 00:00:02,500\nFirst subtitle line\n\n2\n00:00:03,000 --> 00:00:05,500\nSecond subtitle line\n",
        )
        .unwrap();

        let main = p("main.mkv");
        ffmpeg_blocking(&[
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
            "-i", &srt,
            "-t", "6",
            "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-c:a:0", "aac", "-b:a:0", "128k", "-ac:a:0", "2",
            "-c:a:1", "ac3", "-b:a:1", "384k", "-ac:a:1", "6",
            "-c:s", "srt",
            "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=hin",
            "-metadata:s:s:0", "language=eng",
            &main,
        ]);

        let awkward_dir = dir.path().join("It's a folder");
        std::fs::create_dir_all(&awkward_dir).unwrap();
        let awkward = awkward_dir.join("my clip.mkv").to_string_lossy().into_owned();
        std::fs::copy(&main, &awkward).unwrap();

        let letterbox = p("letterbox.mp4");
        ffmpeg_blocking(&[
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
            "-t", "8", "-vf", "pad=640:480:0:60:black",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            &letterbox,
        ]);

        let interlaced = p("interlaced.mkv");
        ffmpeg_blocking(&[
            "-f", "lavfi", "-i", "testsrc2=size=720x576:rate=25",
            "-t", "4", "-vf", "interlace",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-flags", "+ilme+ildct", "-pix_fmt", "yuv420p",
            &interlaced,
        ]);

        let long = p("long.mp4");
        ffmpeg_blocking(&[
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30,noise=alls=10:allf=t",
            "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
            "-t", "20",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            &long,
        ]);

        let photo = p("photo.png");
        ffmpeg_blocking(&["-f", "lavfi", "-i", "testsrc2=size=1281x721:rate=1,noise=alls=8", "-frames:v", "1", &photo]);
        let small_photo = p("small.png");
        ffmpeg_blocking(&["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=1", "-frames:v", "1", &small_photo]);

        Fixtures { dir, main, awkward, letterbox, interlaced, long, photo, small_photo }
    })
}

/// A fresh output path inside the fixture folder.
fn out(name: &str) -> String {
    let dir = fixtures().dir.path().join("out");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(format!("{}_{name}", uuid::Uuid::new_v4().simple())).to_string_lossy().into_owned()
}

fn temp() -> PathBuf {
    let dir = fixtures().dir.path().join("tmp");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn media(path: &str) -> MediaInfo {
    probe(&tools().ffprobe, path).await.unwrap()
}

fn base_settings(encoder: VideoEncoder, container: Container) -> EncodeSettings {
    EncodeSettings {
        container,
        video: VideoSettings {
            encoder,
            rate: RateControl::Quality { value: encoder.quality_range().2 },
            two_pass: false,
            speed: Speed::Fastest,
            bit_depth: BitDepth::Auto,
            fps: Fps::Source,
            resolution: Resolution::Source,
            crop: CropMode::None,
            hdr: HdrMode::Keep,
            film_grain: 0,
        },
        audio: AudioDefaults { codec: AudioCodec::Aac, bitrate_kbps: 128, mixdown: Mixdown::Stereo },
        subtitles: SubtitleDefault::None,
        filters: Filters::default(),
        keep_chapters: true,
        keep_metadata: true,
    }
}

/// A job for `input` that keeps only the first audio track.
async fn job(input: &str, encoder: VideoEncoder, container: Container) -> JobSpec {
    let m = media(input).await;
    let mut spec = spec_for(&m, &base_settings(encoder, container), out(&format!("o.{}", container.ext())));
    spec.audio_tracks.truncate(1);
    spec
}

/// Run a job exactly the way the queue does, minus the queue.
async fn encode(spec: &JobSpec) -> MediaInfo {
    try_encode(spec, false).await.unwrap_or_else(|e| panic!("encode failed: {e}"))
}

async fn try_encode(spec: &JobSpec, hw_decode: bool) -> Result<MediaInfo, AppError> {
    let t = tools();
    let m = media(&spec.input).await;
    let p = plan(spec, &m, &PlanOptions { hw_decode, pass_log: format!("pass_{}", uuid::Uuid::new_v4().simple()), joined: Vec::new() })?;
    let control = JobControl::new();
    for args in &p.passes {
        run_ffmpeg(&t.ffmpeg, args, Some(&temp()), None, &control, |_| {}, |_| {}).await?;
    }
    Ok(media(&spec.output).await)
}

fn close(actual: f64, expected: f64, tolerance: f64) -> bool {
    (actual - expected).abs() <= tolerance
}

// ───────────────────────────── Capabilities ─────────────────────────────

async fn capabilities() -> Capabilities {
    static CAPS: tokio::sync::OnceCell<Capabilities> = tokio::sync::OnceCell::const_new();
    CAPS.get_or_init(|| async { caps::detect(&tools()).await.unwrap() }).await.clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detects_encoders() {
    let caps = capabilities().await;
    assert!(!caps.ffmpeg_version.is_empty() && caps.ffmpeg_version != "unknown");
    assert_eq!(caps.encoders.len(), VideoEncoder::ALL.len());
    for enc in [VideoEncoder::X264, VideoEncoder::X265, VideoEncoder::SvtAv1, VideoEncoder::Copy] {
        let info = caps.encoders.iter().find(|e| e.id == enc).unwrap();
        assert!(info.available, "{enc:?} should be available: {:?}", info.reason);
    }
    for e in &caps.encoders {
        // An unavailable encoder always says why.
        assert_eq!(e.available, e.reason.is_none(), "{:?}", e.id);
        println!("  {:<34} {}", e.label, if e.available { "available".to_string() } else { format!("unavailable: {}", e.reason.clone().unwrap()) });
    }
}

// ───────────────────────────── Encoding ─────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_available_encoder_produces_a_valid_file() {
    let caps = capabilities().await;
    let mut tested = 0;
    for info in caps.encoders.iter().filter(|e| e.available) {
        let container = if info.id == VideoEncoder::Copy { Container::Mkv } else { Container::Mp4 };
        let spec = job(&fixtures().main, info.id, container).await;
        let result = encode(&spec).await;
        let v = result.video.as_ref().unwrap_or_else(|| panic!("{:?}: no video stream", info.id));
        let expected = match info.codec.as_str() {
            "hevc" => "hevc",
            "av1" => "av1",
            _ => "h264",
        };
        assert_eq!(v.codec, expected, "{:?}", info.id);
        assert_eq!((v.width, v.height), (1280, 720), "{:?}", info.id);
        assert!(close(result.duration, 6.0, 0.35), "{:?}: duration {}", info.id, result.duration);
        assert!(close(v.fps, 30.0, 0.1), "{:?}: fps {}", info.id, v.fps);
        assert_eq!(result.audio.len(), 1, "{:?}", info.id);
        assert!(result.size_bytes > 10_000.0, "{:?}", info.id);
        println!("  {:<34} ok  {:>7.0} KB  {} {}", info.label, result.size_bytes / 1024.0, v.codec, v.pix_fmt);
        tested += 1;
    }
    assert!(tested >= 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn svt_av1_is_ten_bit_and_webm_works() {
    let mut spec = job(&fixtures().main, VideoEncoder::SvtAv1, Container::Webm).await;
    spec.settings.video.film_grain = 6;
    spec.audio_tracks[0].codec = AudioCodec::Aac; // WebM must turn this into Opus.
    let result = encode(&spec).await;
    let v = result.video.unwrap();
    assert_eq!(v.codec, "av1");
    assert_eq!(v.bit_depth, 10);
    assert_eq!(result.audio[0].codec, "opus");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn trim_cuts_the_right_length() {
    let mut spec = job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await;
    spec.trim = Some(Trim { start: 1.0, end: 3.5 });
    let result = encode(&spec).await;
    assert!(close(result.duration, 2.5, 0.25), "duration {}", result.duration);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn geometry_and_filters_apply() {
    let mut spec = job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await;
    spec.settings.video.crop = CropMode::Manual { w: 1000, h: 600, x: 100, y: 50 };
    spec.settings.video.resolution = Resolution::Height { value: 300 };
    spec.settings.video.fps = Fps::Fixed { value: 15.0 };
    spec.settings.filters = Filters {
        denoise: Strength::Medium,
        deinterlace: Deinterlace::Off,
        rotate: Rotate::Cw90,
        flip_h: true,
        flip_v: false,
        sharpen: Strength::Light,
    };
    let m = media(&spec.input).await;
    let p = plan(&spec, &m, &PlanOptions::default()).unwrap();
    assert_eq!((p.width, p.height), (300, 500));
    let result = encode(&spec).await;
    let v = result.video.unwrap();
    assert_eq!((v.width, v.height), (300, 500));
    assert!(close(v.fps, 15.0, 0.1), "fps {}", v.fps);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn audio_tracks_codecs_and_mixdown() {
    let m = media(&fixtures().main).await;
    assert_eq!(m.audio.len(), 2);
    assert_eq!(m.audio[1].channels, 6);

    let mut spec = job(&fixtures().main, VideoEncoder::X264, Container::Mkv).await;
    spec.audio_tracks = vec![
        AudioTrack { order: 1, codec: AudioCodec::Opus, bitrate_kbps: 192, mixdown: Mixdown::Source },
        AudioTrack { order: 0, codec: AudioCodec::Copy, bitrate_kbps: 0, mixdown: Mixdown::Source },
        AudioTrack { order: 1, codec: AudioCodec::Aac, bitrate_kbps: 96, mixdown: Mixdown::Stereo },
        AudioTrack { order: 1, codec: AudioCodec::Flac, bitrate_kbps: 0, mixdown: Mixdown::Mono },
    ];
    let result = encode(&spec).await;
    let got: Vec<(String, u32)> = result.audio.iter().map(|a| (a.codec.clone(), a.channels)).collect();
    assert_eq!(
        got,
        vec![("opus".to_string(), 6), ("aac".to_string(), 2), ("aac".to_string(), 2), ("flac".to_string(), 1)]
    );

    // No audio at all is allowed.
    spec.audio_tracks.clear();
    spec.output = out("silent.mkv");
    assert!(encode(&spec).await.audio.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subtitles_copy_convert_and_burn() {
    let keep = vec![SubtitleTrack { order: 0, mode: SubtitleMode::Copy, default: true }];

    let mut mkv = job(&fixtures().main, VideoEncoder::X264, Container::Mkv).await;
    mkv.subtitle_tracks = keep.clone();
    let result = encode(&mkv).await;
    assert_eq!(result.subtitles.len(), 1);
    assert_eq!(result.subtitles[0].codec, "subrip");
    assert!(result.subtitles[0].default);

    let mut mp4 = job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await;
    mp4.subtitle_tracks = keep.clone();
    let result = encode(&mp4).await;
    assert_eq!(result.subtitles[0].codec, "mov_text");

    // Burn-in, from a path with a space and an apostrophe in it, with a trim.
    let mut burn = job(&fixtures().awkward, VideoEncoder::X264, Container::Mp4).await;
    burn.subtitle_tracks = vec![SubtitleTrack { order: 0, mode: SubtitleMode::Burn, default: false }];
    burn.trim = Some(Trim { start: 0.5, end: 2.5 });
    let burned = encode(&burn).await;
    assert!(burned.subtitles.is_empty(), "a burned subtitle is part of the picture, not a track");
    assert!(close(burned.duration, 2.0, 0.25));

    // The same clip without the subtitle must differ: proof the text was drawn.
    let mut plain = burn.clone();
    plain.subtitle_tracks.clear();
    plain.output = out("plain.mp4");
    encode(&plain).await;
    let psnr = capture(
        &tools().ffmpeg,
        &["-hide_banner", "-i", &burn.output, "-i", &plain.output, "-lavfi", "psnr", "-f", "null", "-"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
        None,
        None,
    )
    .await
    .unwrap();
    let average = psnr
        .stderr
        .split("average:")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or("inf")
        .to_string();
    assert_ne!(average, "inf", "burned and plain clips are identical — the subtitle was not rendered");
    println!("  burned vs plain PSNR: {average} dB (finite = text is visible)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_pass_and_target_size() {
    for encoder in [VideoEncoder::X264, VideoEncoder::X265] {
        let mut spec = job(&fixtures().main, encoder, Container::Mp4).await;
        spec.settings.video.rate = RateControl::TargetSize { mb: 1.5 };
        spec.settings.video.two_pass = true;
        spec.settings.video.speed = Speed::Fast;
        let m = media(&spec.input).await;
        assert_eq!(plan(&spec, &m, &PlanOptions::default()).unwrap().passes.len(), 2);
        let result = encode(&spec).await;
        let target = 1.5 * 1024.0 * 1024.0;
        let ratio = result.size_bytes / target;
        println!("  {encoder:?} target 1.5 MB → {:.2} MB ({:.0}% of target)", result.size_bytes / 1048576.0, ratio * 100.0);
        assert!(ratio <= 1.03, "{encoder:?} overshot the target: {ratio:.3}");
        assert!(ratio >= 0.70, "{encoder:?} is far under the target: {ratio:.3}");
    }
    // The two-pass statistics files are named, not left as ffmpeg defaults.
    assert!(!temp().join("ffmpeg2pass-0.log").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deinterlaces() {
    let m = media(&fixtures().interlaced).await;
    assert!(m.video.as_ref().unwrap().interlaced, "fixture should be flagged interlaced");
    let mut spec = job(&fixtures().interlaced, VideoEncoder::X264, Container::Mp4).await;
    spec.settings.filters.deinterlace = Deinterlace::Bwdif;
    let result = encode(&spec).await;
    assert!(!result.video.unwrap().interlaced);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gpu_decode_pipeline_when_nvenc_exists() {
    let caps = capabilities().await;
    if !caps.encoders.iter().any(|e| e.id == VideoEncoder::HevcNvenc && e.available) {
        println!("  skipped: no NVENC on this machine");
        return;
    }
    let spec = job(&fixtures().main, VideoEncoder::HevcNvenc, Container::Mp4).await;
    let m = media(&spec.input).await;
    assert!(plan(&spec, &m, &PlanOptions { hw_decode: true, pass_log: "x".into(), joined: Vec::new() }).unwrap().hwaccel);
    let result = try_encode(&spec, true).await.expect("full-GPU pipeline should encode");
    assert_eq!(result.video.unwrap().codec, "hevc");
}

// ───────────────────────────── Analysis ─────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn finds_black_bars_and_noise() {
    let t = tools();
    let boxed = media(&fixtures().letterbox).await;
    let found = analysis::analyze_source(&t, &boxed, None).await.unwrap();
    let crop = found.crop.expect("black bars should be detected");
    assert_eq!((crop.w, crop.x), (640, 0));
    assert!(close(crop.h as f64, 360.0, 4.0) && close(crop.y as f64, 60.0, 4.0), "{crop:?}");

    let clean = media(&fixtures().main).await;
    let a = analysis::analyze_source(&t, &clean, None).await.unwrap();
    assert_eq!(a.crop, None, "a full-frame picture must not be cropped");

    let noisy = media(&fixtures().long).await;
    let n = analysis::analyze_source(&t, &noisy, None).await.unwrap();
    println!("  clean: {} (grain {}) | noisy: {} (grain {})", a.noise_profile, a.grain_level, n.noise_profile, n.grain_level);
    assert!(n.grain_level > a.grain_level, "the noisy clip should score higher than the clean one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn estimate_is_in_the_right_ballpark() {
    let t = tools();
    let spec = job(&fixtures().long, VideoEncoder::X264, Container::Mp4).await;
    let m = media(&spec.input).await;
    let mut stages = Vec::new();
    let est = analysis::estimate(&t, &spec, &m, &temp(), false, None, |p, s| stages.push((p, s.to_string()))).await.unwrap();
    assert!(est.sampled);
    assert!(est.encode_secs > 0.0);
    assert!(stages.len() >= 3);

    let started = Instant::now();
    let actual = encode(&spec).await;
    let took = started.elapsed().as_secs_f64();
    let ratio = est.size_bytes / actual.size_bytes;
    println!(
        "  estimate {:.1} MB vs actual {:.1} MB (ratio {ratio:.2}); time estimate {:.1}s vs actual {took:.1}s",
        est.size_bytes / 1048576.0,
        actual.size_bytes / 1048576.0,
        est.encode_secs
    );
    assert!((0.6..=1.6).contains(&ratio), "size estimate off by more than 60%: {ratio:.2}");

    // Bitrate-driven jobs are arithmetic, so the estimate is exact by design.
    let mut sized = spec.clone();
    sized.settings.video.rate = RateControl::TargetSize { mb: 5.0 };
    let est = analysis::estimate(&t, &sized, &m, &temp(), false, None, |_, _| {}).await.unwrap();
    assert!(!est.sampled);
    assert!(close(est.size_bytes / 1048576.0, 5.0, 0.2), "{}", est.size_bytes / 1048576.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn preview_clips_and_frames_are_playable() {
    let t = tools();
    let mut spec = job(&fixtures().main, VideoEncoder::SvtAv1, Container::Mkv).await;
    spec.settings.video.resolution = Resolution::Height { value: 360 };
    let m = media(&spec.input).await;

    let pair = analysis::render_preview(&t, &spec, &m, 2.0, 2.0, &temp(), false, None, |_, _| {}).await.unwrap();
    for path in [&pair.original, &pair.encoded] {
        let clip = media(path).await;
        let v = clip.video.unwrap();
        // WebView2 always plays 8-bit H.264 in MP4.
        assert_eq!((v.codec.as_str(), v.pix_fmt.as_str()), ("h264", "yuv420p"), "{path}");
        assert_eq!((v.width, v.height), (640, 360), "both clips share the job's geometry");
        assert!(close(clip.duration, 2.0, 0.3));
    }
    assert!(pair.encoded_bytes > 0.0 && pair.estimate.size_bytes > 0.0);

    let frame = temp().join("frame.jpg");
    analysis::render_frame(&t, &spec, &m, 3.0, 320, &frame).await.unwrap();
    let info = probe_image(&t, &frame.to_string_lossy()).await.unwrap();
    assert_eq!((info.width, info.height), (320, 180));
}

// ───────────────────────────── Queue ─────────────────────────────

#[derive(Default)]
struct Collector {
    events: Mutex<Vec<(String, serde_json::Value)>>,
}

impl EventSink for Collector {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.events.lock().push((event.to_string(), payload));
    }
}

impl Collector {
    fn count(&self, name: &str) -> usize {
        self.events.lock().iter().filter(|(n, _)| n == name).count()
    }
    fn last(&self, name: &str) -> Option<serde_json::Value> {
        self.events.lock().iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }
}

/// The queue tests pause, cancel and restart encodes against the clock. Run
/// together they starve each other of processor time and miss their
/// deadlines, so they take turns.
static QUEUE_TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Rig {
    queue: QueueManager,
    events: Arc<Collector>,
    settings: Arc<RwLock<AppSettings>>,
    store: PathBuf,
    /// Last, so the queue (and its encoders) is gone before the next test starts.
    _turn: std::sync::MutexGuard<'static, ()>,
}

fn rig() -> Rig {
    // A test that failed while it held the turn must not block the rest.
    let turn = QUEUE_TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let events = Arc::new(Collector::default());
    let settings = Arc::new(RwLock::new(AppSettings::default()));
    let store = temp().join(format!("queue_{}.json", uuid::Uuid::new_v4().simple()));
    let queue = QueueManager::new(
        Some(tools()),
        temp(),
        Some(store.clone()),
        settings.clone(),
        Arc::new(ProbeCache::default()),
        events.clone(),
        tokio::runtime::Handle::current(),
    );
    Rig { queue, events, settings, store, _turn: turn }
}

async fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < timeout, "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn status(rig: &Rig, id: &str) -> JobStatus {
    rig.queue.snapshot().jobs.iter().find(|j| j.id == id).map(|j| j.status).expect("job exists")
}

fn job_of(rig: &Rig, id: &str) -> Job {
    rig.queue.snapshot().jobs.into_iter().find(|j| j.id == id).expect("job exists")
}

/// A job slow enough to interact with while it runs.
async fn slow_job() -> JobSpec {
    let mut spec = job(&fixtures().long, VideoEncoder::X265, Container::Mkv).await;
    spec.settings.video.speed = Speed::Slow;
    spec
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_runs_jobs_in_order_and_persists() {
    let r = rig();
    let mut specs = Vec::new();
    for _ in 0..3 {
        specs.push(job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await);
    }
    let ids = r.queue.add(specs).await.unwrap();
    assert_eq!(ids.len(), 3);
    assert!(r.queue.snapshot().jobs.iter().all(|j| j.status == JobStatus::Queued));
    assert!(!r.queue.snapshot().running, "adding jobs must not start the queue");

    // Move the last job to the front, then run one at a time.
    r.queue.move_job(&ids[2], 0);
    let order: Vec<String> = r.queue.snapshot().jobs.iter().map(|j| j.id.clone()).collect();
    assert_eq!(order, vec![ids[2].clone(), ids[0].clone(), ids[1].clone()]);

    r.queue.start();
    wait_for("queue to finish", Duration::from_secs(120), || r.events.count("queue:finished") == 1).await;

    let snap = r.queue.snapshot();
    assert!(!snap.running);
    for j in &snap.jobs {
        assert_eq!(j.status, JobStatus::Done, "{:?}", j.error);
        assert_eq!(j.progress, 100.0);
        assert!(j.final_bytes.unwrap() > 0.0);
        assert!(Path::new(&j.spec.output).is_file());
        assert!(j.command.as_deref().unwrap().starts_with("ffmpeg "));
    }
    // Ran in list order: each started after the previous one finished.
    let started: Vec<f64> = order.iter().map(|id| job_of(&r, id).started_at.unwrap()).collect();
    assert!(started[0] <= started[1] && started[1] <= started[2], "{started:?}");
    let first_done = job_of(&r, &order[0]).finished_at.unwrap();
    assert!(job_of(&r, &order[1]).started_at.unwrap() >= first_done - 5.0, "parallel limit of 1 was not respected");

    let tally: QueueFinished = serde_json::from_value(r.events.last("queue:finished").unwrap()).unwrap();
    assert_eq!((tally.done, tally.failed, tally.cancelled), (3, 0, 0));
    assert!(tally.output_bytes > 0.0 && tally.source_bytes > 0.0);
    assert!(r.events.count("job:progress") >= 3);
    assert!(!r.queue.job_log(&ids[0]).is_empty());

    // A new manager reading the same file sees the finished jobs.
    let restored = QueueManager::new(
        Some(tools()), temp(), Some(r.store.clone()), r.settings.clone(),
        Arc::new(ProbeCache::default()), Arc::new(Collector::default()), tokio::runtime::Handle::current(),
    );
    assert_eq!(restored.snapshot().jobs.len(), 3);
    assert!(restored.snapshot().jobs.iter().all(|j| j.status == JobStatus::Done));

    restored.clear_finished();
    assert!(restored.snapshot().jobs.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queue_runs_jobs_in_parallel_when_allowed() {
    let r = rig();
    r.settings.write().parallel_jobs = 2;
    let ids = r.queue.add(vec![slow_job().await, slow_job().await, slow_job().await]).await.unwrap();
    r.queue.start();
    wait_for("two jobs to run together", Duration::from_secs(30), || {
        r.queue.snapshot().jobs.iter().filter(|j| j.status == JobStatus::Running).count() == 2
    })
    .await;
    assert_eq!(status(&r, &ids[2]), JobStatus::Queued, "the third job waits for a free slot");
    r.queue.stop();
    wait_for("jobs to stop", Duration::from_secs(20), || !r.queue.is_busy()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_removes_the_partial_file() {
    let r = rig();
    let spec = slow_job().await;
    let output = spec.output.clone();
    let id = r.queue.add(vec![spec]).await.unwrap().remove(0);
    r.queue.start();
    wait_for("encode to produce output", Duration::from_secs(120), || {
        job_of(&r, &id).progress > 1.0 && Path::new(&output).exists()
    })
    .await;

    r.queue.cancel(&id);
    wait_for("job to be cancelled", Duration::from_secs(20), || status(&r, &id) == JobStatus::Cancelled).await;
    wait_for("partial file to be deleted", Duration::from_secs(10), || !Path::new(&output).exists()).await;
    wait_for("queue to report finished", Duration::from_secs(10), || r.events.count("queue:finished") == 1).await;
    let tally: QueueFinished = serde_json::from_value(r.events.last("queue:finished").unwrap()).unwrap();
    assert_eq!((tally.done, tally.cancelled), (0, 1));

    // Retry puts it back in line; it does not start by itself once the queue has drained.
    r.queue.retry(&id);
    assert_eq!(status(&r, &id), JobStatus::Queued);
    assert_eq!(job_of(&r, &id).progress, 0.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_freezes_and_resume_finishes() {
    let r = rig();
    let mut spec = job(&fixtures().long, VideoEncoder::X264, Container::Mp4).await;
    spec.settings.video.speed = Speed::Medium;
    let id = r.queue.add(vec![spec]).await.unwrap().remove(0);
    r.queue.start();
    wait_for("encode to get going", Duration::from_secs(120), || job_of(&r, &id).progress > 2.0).await;

    r.queue.pause();
    assert!(r.queue.snapshot().paused);
    assert_eq!(status(&r, &id), JobStatus::Paused);
    // Let anything already in the pipe drain, then the numbers must stand still.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let frozen = (job_of(&r, &id).progress, r.events.count("job:progress"));
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let later = (job_of(&r, &id).progress, r.events.count("job:progress"));
    assert_eq!(frozen, later, "a paused encode must make no progress");
    assert!(frozen.0 < 100.0);

    r.queue.resume();
    assert_eq!(status(&r, &id), JobStatus::Running);
    wait_for("paused job to finish after resume", Duration::from_secs(120), || status(&r, &id) == JobStatus::Done).await;
    let done = job_of(&r, &id);
    let result = media(&done.spec.output).await;
    assert!(close(result.duration, 20.0, 0.4), "a paused-and-resumed encode must be complete: {}", result.duration);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_returns_jobs_to_the_queue() {
    let r = rig();
    let spec = slow_job().await;
    let output = spec.output.clone();
    let id = r.queue.add(vec![spec]).await.unwrap().remove(0);
    r.queue.start();
    wait_for("encode to start", Duration::from_secs(120), || job_of(&r, &id).progress > 1.0).await;
    r.queue.stop();
    wait_for("job to return to queued", Duration::from_secs(20), || status(&r, &id) == JobStatus::Queued).await;
    assert!(!r.queue.snapshot().running);
    assert!(!Path::new(&output).exists());
    assert_eq!(r.events.count("queue:finished"), 0, "stopping is not finishing");

    // Removing a queued job just drops it.
    r.queue.remove(&[id]);
    assert!(r.queue.snapshot().jobs.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_running_job_cleans_up() {
    let r = rig();
    let spec = slow_job().await;
    let output = spec.output.clone();
    let id = r.queue.add(vec![spec]).await.unwrap().remove(0);
    r.queue.start();
    wait_for("output to appear", Duration::from_secs(120), || Path::new(&output).exists() && job_of(&r, &id).progress > 1.0).await;
    r.queue.remove(&[id]);
    assert!(r.queue.snapshot().jobs.is_empty());
    wait_for("encoder to exit and file to be deleted", Duration::from_secs(20), || !r.queue.is_busy() && !Path::new(&output).exists()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failures_are_reported_and_the_queue_moves_on() {
    let r = rig();
    // A bad job is rejected before it is queued.
    let mut bad = job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await;
    bad.output = bad.input.clone();
    assert!(r.queue.add(vec![bad]).await.is_err());
    let mut missing = job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await;
    missing.input = out("does-not-exist.mp4");
    assert!(r.queue.add(vec![missing]).await.is_err());
    assert!(r.queue.snapshot().jobs.is_empty());

    // A job that breaks while running: the source disappears after queueing.
    let doomed_input = out("doomed.mkv");
    std::fs::copy(&fixtures().main, &doomed_input).unwrap();
    let doomed = job(&doomed_input, VideoEncoder::X264, Container::Mp4).await;
    let good = job(&fixtures().main, VideoEncoder::X264, Container::Mp4).await;
    let ids = r.queue.add(vec![doomed, good]).await.unwrap();
    std::fs::remove_file(&doomed_input).unwrap();

    r.queue.start();
    wait_for("queue to finish", Duration::from_secs(90), || r.events.count("queue:finished") == 1).await;
    let failed = job_of(&r, &ids[0]);
    assert_eq!(failed.status, JobStatus::Failed);
    let message = failed.error.unwrap();
    assert!(!message.trim().is_empty());
    println!("  failure message shown to the user: {}", message.replace('\n', " | "));
    assert!(!Path::new(&failed.spec.output).exists());
    assert_eq!(status(&r, &ids[1]), JobStatus::Done, "one failure must not block the next job");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auto_crop_is_detected_when_the_job_runs() {
    let r = rig();
    let mut spec = job(&fixtures().letterbox, VideoEncoder::X264, Container::Mp4).await;
    spec.settings.video.crop = CropMode::Auto;
    spec.audio_tracks.clear();
    let id = r.queue.add(vec![spec]).await.unwrap().remove(0);
    r.queue.start();
    wait_for("job to finish", Duration::from_secs(90), || status(&r, &id) == JobStatus::Done).await;
    let done = job_of(&r, &id);
    assert!(done.spec.auto_crop.is_some(), "the detected crop is stored on the job");
    let v = media(&done.spec.output).await.video.unwrap();
    assert_eq!(v.width, 640);
    assert!(close(v.height as f64, 360.0, 4.0), "height {}", v.height);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_jobs_restart_from_the_queue_after_relaunch() {
    let r = rig();
    let id = r.queue.add(vec![slow_job().await]).await.unwrap().remove(0);
    r.queue.start();
    wait_for("encode to start", Duration::from_secs(120), || job_of(&r, &id).progress > 1.0).await;

    // "Relaunch": a second manager reads what the first one saved mid-encode.
    let saved: Vec<Job> = serde_json::from_str(&std::fs::read_to_string(&r.store).unwrap()).unwrap();
    assert_eq!(saved[0].status, JobStatus::Running);
    let relaunched = QueueManager::new(
        Some(tools()), temp(), Some(r.store.clone()), r.settings.clone(),
        Arc::new(ProbeCache::default()), Arc::new(Collector::default()), tokio::runtime::Handle::current(),
    );
    let restored = &relaunched.snapshot().jobs[0];
    assert_eq!(restored.status, JobStatus::Queued);
    assert_eq!(restored.progress, 0.0);
    assert!(!relaunched.snapshot().running);

    r.queue.shutdown();
    wait_for("encoder to exit", Duration::from_secs(20), || !r.queue.is_busy()).await;
}

// ───────────────────────────── Presets ─────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_builtin_preset_encodes() {
    let caps = capabilities().await;
    let m = media(&fixtures().main).await;
    for preset in builtin_presets() {
        let enc = preset.settings.video.encoder;
        if !caps.encoders.iter().any(|e| e.id == enc && e.available) {
            println!("  {:<32} skipped ({enc:?} unavailable here)", preset.name);
            continue;
        }
        let mut settings = preset.settings.clone();
        // Keep the test quick; the preset's quality settings are untouched.
        settings.video.speed = Speed::Fastest;
        let spec = spec_for(&m, &settings, out(&format!("{}.{}", preset.id, settings.container.ext())));
        let result = encode(&spec).await;
        assert!(result.video.is_some(), "{}", preset.id);
        println!(
            "  {:<32} {:>6.0} KB → {:>6.0} KB",
            preset.name,
            m.size_bytes / 1024.0,
            result.size_bytes / 1024.0
        );
    }
}

// ───────────────────────────── Images ─────────────────────────────

fn image_job(input: &str, action: ImageAction, format: ImageFormat) -> ImageJob {
    ImageJob {
        id: uuid::Uuid::new_v4().simple().to_string(),
        input: input.to_string(),
        output: out(&format!("img.{}", format.ext())),
        action,
        format,
        crop: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_compress_in_a_batch() {
    let events = Arc::new(Collector::default());
    let runner = ImageRunner::new(Some(tools()), temp(), events.clone(), tokio::runtime::Handle::current());
    let mut jobs = Vec::new();
    for format in [ImageFormat::Webp, ImageFormat::Avif, ImageFormat::Jpg, ImageFormat::Png] {
        jobs.push(image_job(&fixtures().photo, ImageAction::Compress { quality: 75 }, format));
    }
    // A 160x120 image: fine for every format, including AVIF's fallback path.
    jobs.push(image_job(&fixtures().small_photo, ImageAction::Compress { quality: 60 }, ImageFormat::Avif));
    runner.start(jobs.clone()).unwrap();
    wait_for("image batch to finish", Duration::from_secs(120), || events.count("image:batch-done") == 1).await;

    let results: Vec<ImageEvent> = events
        .events
        .lock()
        .iter()
        .filter(|(n, _)| n == "image:event")
        .map(|(_, v)| serde_json::from_value::<ImageEvent>(v.clone()).unwrap())
        .filter(|e| e.kind != "progress")
        .collect();
    assert_eq!(results.len(), jobs.len());
    for e in &results {
        assert_eq!(e.kind, "done", "{}", e.message);
        assert!(e.new_bytes > 0.0);
    }
    for j in &jobs {
        let info = probe_image(&tools(), &j.output).await.unwrap();
        assert!(info.width >= 160 && info.height >= 120, "{}", j.output);
    }
    let lossy = results.iter().find(|e| e.id == jobs[0].id).unwrap();
    assert!(lossy.new_bytes < lossy.original_bytes, "WebP at quality 75 should be smaller than the PNG");
}

/// Camera details and GPS location must never survive into an output file.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_never_keep_exif_or_gps() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("exif.jpg");
    let marker = b"TestModel";
    let contains = |path: &Path| std::fs::read(path).unwrap().windows(marker.len()).any(|w| w == marker);
    assert!(contains(&source), "the fixture must carry EXIF for this test to mean anything");

    let t = tools();
    let control = JobControl::new();
    for format in [ImageFormat::Webp, ImageFormat::Avif, ImageFormat::Jpg, ImageFormat::Png] {
        let j = image_job(&source.to_string_lossy(), ImageAction::Target { kb: 400 }, format);
        fit_to_size(&t, &j, 400, &temp(), &control, |_, _| {}).await.unwrap();
        assert!(!contains(Path::new(&j.output)), "{format:?} output still contains EXIF from the source");
        let info = probe_image(&t, &j.output).await.unwrap();
        assert_eq!((info.width, info.height), (640, 480));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_fit_a_target_size() {
    let t = tools();
    let control = JobControl::new();
    // Its own folder: other picture tests work in the shared one at the same time.
    let work = temp().join("fit");
    std::fs::create_dir_all(&work).unwrap();
    for (format, kb) in [(ImageFormat::Webp, 60u32), (ImageFormat::Jpg, 90), (ImageFormat::Avif, 40)] {
        let j = image_job(&fixtures().photo, ImageAction::Target { kb }, format);
        let mut steps = 0;
        let result = fit_to_size(&t, &j, kb, &work, &control, |_, _| steps += 1).await.unwrap();
        let size = std::fs::metadata(&j.output).unwrap().len() as f64;
        println!("  {format:?} target {kb} KB → {:.1} KB at quality {} in {steps} steps", size / 1024.0, result.quality);
        assert!(!result.missed);
        assert!(size <= kb as f64 * 1024.0, "{format:?} is over the target");
        assert!(size >= kb as f64 * 1024.0 * 0.5, "{format:?} wasted more than half the budget");
        assert!(steps <= 8);
    }
    // An impossible target reports that it was missed and still writes the smallest file.
    let j = image_job(&fixtures().photo, ImageAction::Target { kb: 1 }, ImageFormat::Jpg);
    let result = fit_to_size(&t, &j, 1, &work, &control, |_, _| {}).await.unwrap();
    assert!(result.missed);
    assert!(Path::new(&j.output).is_file());
    // No search leftovers.
    let leftovers = std::fs::read_dir(&work).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("mvs_img_")).count();
    assert_eq!(leftovers, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_upscale_four_times() {
    let t = tools();
    if t.upscaler.is_none() {
        println!("  skipped: Real-ESRGAN is not in the engine folder");
        return;
    }
    let j = image_job(&fixtures().small_photo, ImageAction::Upscale, ImageFormat::Png);
    let control = JobControl::new();
    let mut stages = Vec::new();
    mvs_core::image::upscale(&t, &j, &temp(), &control, |_, s| stages.push(s.to_string())).await.unwrap();
    let info = probe_image(&t, &j.output).await.unwrap();
    println!("  upscaled 160x120 → {}x{} via: {}", info.width, info.height, stages.last().unwrap());
    assert_eq!((info.width, info.height), (640, 480));

    // The app is handed its folders in Windows' long-path form; the upscaler
    // must still find its model files (this is what broke "Enlarge" once).
    let engine = t.upscaler.as_ref().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
    let long_form = std::path::PathBuf::from(format!(r"\\?\{}", engine.canonicalize().unwrap().display()).replace(r"\\?\\\?\", r"\\?\"));
    let located = locate(&default_engine_dirs(Some(&long_form))).unwrap();
    let found = located.upscaler.as_ref().unwrap().to_string_lossy().into_owned();
    assert!(!found.starts_with(r"\\?\"), "{found}");
    // And an AVIF source, which the upscaler cannot read by itself.
    let avif = image_job(&fixtures().small_photo, ImageAction::Compress { quality: 90 }, ImageFormat::Avif);
    fit_to_size(&located, &avif, 500, &temp(), &control, |_, _| {}).await.unwrap();
    let from_avif = image_job(&avif.output, ImageAction::Upscale, ImageFormat::Png);
    mvs_core::image::upscale(&located, &from_avif, &temp(), &control, |_, _| {}).await.unwrap();
    let info = probe_image(&located, &from_avif.output).await.unwrap();
    assert_eq!((info.width, info.height), (640, 480));
}

// ───────────────────────────── Join, simple choices, crop, cut-outs ─────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn joins_videos_of_different_shapes_through_the_queue() {
    let r = rig();
    // 6 s 1280x720 with sound + 8 s 640x480 without sound + 4 s 720x576 interlaced without sound.
    let first = media(&fixtures().main).await;
    let mut spec = spec_for(&first, &base_settings(VideoEncoder::X264, Container::Mp4), out("joined.mp4"));
    spec.audio_tracks.truncate(1);
    spec.extra_inputs = vec![fixtures().letterbox.clone(), fixtures().interlaced.clone()];

    let id = r.queue.add(vec![spec]).await.unwrap().remove(0);
    let queued = job_of(&r, &id);
    assert!(close(queued.source.duration, 18.0, 0.3), "the queue shows the total length: {}", queued.source.duration);
    assert!(queued.source.file_name.ends_with("+ 2 more"), "{}", queued.source.file_name);

    r.queue.start();
    wait_for("the join to finish", Duration::from_secs(120), || {
        matches!(status(&r, &id), JobStatus::Done | JobStatus::Failed)
    })
    .await;
    let done = job_of(&r, &id);
    assert_eq!(done.status, JobStatus::Done, "{:?}", done.error);

    let result = media(&done.spec.output).await;
    let v = result.video.as_ref().unwrap();
    assert_eq!((v.width, v.height), (1280, 720), "every clip is fitted into the first clip's frame");
    assert!(close(result.duration, 18.0, 0.5), "6 + 8 + 4 seconds: {}", result.duration);
    assert_eq!(result.audio.len(), 1, "silent clips are padded with silence");
    assert!(close(v.fps, 30.0, 0.1));
    // The originals are untouched.
    assert!(Path::new(&fixtures().letterbox).is_file() && Path::new(&fixtures().interlaced).is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simple_choices_are_measured_and_one_is_suggested() {
    let t = tools();
    let caps = capabilities().await;
    let m = media(&fixtures().long).await;
    for prefer_gpu in [true, false] {
        let options = mvs_core::presets::easy_options(&caps, prefer_gpu);
        assert_eq!(options.len(), 3);
        let specs: Vec<JobSpec> = options
            .iter()
            .map(|o| {
                let mut s = spec_for(&m, &o.settings, out("easy.mp4"));
                // Keep the processor path quick; quality settings are untouched.
                s.settings.video.speed = Speed::Fastest;
                s
            })
            .collect();
        let mut stages = Vec::new();
        let started = Instant::now();
        let (original, tried) = analysis::compare_choices(&t, &specs, &m, &temp(), true, None, |p, s| stages.push((p, s.to_string())))
            .await
            .unwrap();
        let took = started.elapsed().as_secs_f64();
        assert_eq!(tried.len(), 3);
        assert!(stages.len() >= 4 && stages.last().unwrap().0 == 100.0);

        let reference = media(&original).await;
        for (option, t3) in options.iter().zip(&tried) {
            let clip = media(&t3.preview).await;
            let v = clip.video.as_ref().unwrap();
            assert_eq!((v.codec.as_str(), v.pix_fmt.as_str()), ("h264", "yuv420p"), "previews must play in the app");
            assert_eq!((v.width, v.height), (1920, 1080));
            assert!(close(clip.duration, reference.duration, 0.2));
            assert!(t3.similarity > 0.2 && t3.similarity <= 1.0, "{}: quality score {}", option.id, t3.similarity);
            assert!(t3.estimate.sampled && t3.estimate.size_bytes > 0.0 && t3.estimate.encode_secs > 0.0);
        }
        // Lower quality must never be estimated larger, or look closer to the original.
        assert!(tried[0].estimate.size_bytes > tried[1].estimate.size_bytes && tried[1].estimate.size_bytes > tried[2].estimate.size_bytes);
        assert!(tried[0].similarity >= tried[2].similarity);

        let scores: Vec<(f64, f64)> = tried.iter().map(|x| (x.estimate.savings_percent, x.similarity)).collect();
        let (pick, why) = analysis::recommend(&scores);
        println!(
            "  {} ({:?}): {} | suggested: {} — {why} [{took:.1}s]",
            if prefer_gpu { "graphics card" } else { "processor" },
            options[0].settings.video.encoder,
            tried
                .iter()
                .zip(&options)
                .map(|(x, o)| format!("{} {:.1} MB, {:.0}% smaller, {:.3} \"{}\"", o.id, x.estimate.size_bytes / 1048576.0, x.estimate.savings_percent, x.similarity, analysis::describe_look(x.similarity)))
                .collect::<Vec<_>>()
                .join(" | "),
            options[pick].id
        );
        assert!(!why.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_crop_keeps_the_chosen_part() {
    let t = tools();
    let control = JobControl::new();
    for format in [ImageFormat::Jpg, ImageFormat::Png, ImageFormat::Webp] {
        let mut j = image_job(&fixtures().photo, ImageAction::Compress { quality: 92 }, format);
        j.crop = Some(Crop { w: 400, h: 300, x: 100, y: 50 });
        fit_to_size(&t, &j, 100_000, &temp(), &control, |_, _| {}).await.unwrap();
        let info = probe_image(&t, &j.output).await.unwrap();
        assert_eq!((info.width, info.height), (400, 300), "{format:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn images_background_is_made_transparent() {
    let t = tools();
    if t.bg_model.is_none() {
        println!("  skipped: the background-removal model is not in the engine folder");
        return;
    }
    // A bright disc on a flat grey background: an unmistakable subject.
    let subject = out("subject.png");
    ffmpeg_blocking(&[
        "-f", "lavfi", "-i", "color=c=0x808080:s=640x480",
        "-vf", "geq=r='if(lte(hypot(X-320,Y-240),130),230,128)':g='if(lte(hypot(X-320,Y-240),130),60,128)':b='if(lte(hypot(X-320,Y-240),130),40,128)'",
        "-frames:v", "1", &subject,
    ]);
    let j = image_job(&subject, ImageAction::RemoveBackground, ImageFormat::Png);
    let control = JobControl::new();
    let mut stages = Vec::new();
    let started = Instant::now();
    mvs_core::background::remove_background(&t, &j, &temp(), &control, |_, s| stages.push(s.to_string())).await.unwrap();
    println!("  background removed in {:.2}s ({})", started.elapsed().as_secs_f64(), stages.join(" → "));

    let info = probe_image(&t, &j.output).await.unwrap();
    assert_eq!((info.width, info.height), (640, 480));
    // Read the transparency back: opaque in the middle of the disc, clear in the corners.
    let alpha = out("alpha.raw");
    ffmpeg_blocking(&["-i", &j.output, "-vf", "alphaextract", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", &alpha]);
    let a = std::fs::read(&alpha).unwrap();
    assert_eq!(a.len(), 640 * 480, "the result must have a transparency channel");
    let at = |x: usize, y: usize| a[y * 640 + x];
    assert!(at(320, 240) > 200, "the subject must stay solid (alpha {})", at(320, 240));
    for (x, y) in [(8, 8), (630, 8), (8, 470), (630, 470)] {
        assert!(at(x, y) < 40, "the background at ({x},{y}) must be see-through (alpha {})", at(x, y));
    }
    // Nothing temporary is left behind.
    let leftovers = std::fs::read_dir(temp()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("mvs_bg_")).count();
    assert_eq!(leftovers, 0);

    // It also runs as part of a batch, next to other work.
    let events = Arc::new(Collector::default());
    let runner = ImageRunner::new(Some(tools()), temp(), events.clone(), tokio::runtime::Handle::current());
    let batch = vec![
        image_job(&subject, ImageAction::RemoveBackground, ImageFormat::Png),
        image_job(&fixtures().small_photo, ImageAction::RemoveBackground, ImageFormat::Png),
    ];
    runner.start(batch.clone()).unwrap();
    wait_for("cut-out batch to finish", Duration::from_secs(60), || events.count("image:batch-done") == 1).await;
    for j in &batch {
        assert!(Path::new(&j.output).is_file());
    }
}

/// Diagnostic: run encoder detection many times and report anything slow.
/// `cargo test --test integration detection_is_consistently_fast -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn detection_is_consistently_fast() {
    let t = tools();
    let mut slowest = 0.0f64;
    for round in 1..=15 {
        let started = Instant::now();
        let caps = caps::detect(&t).await.unwrap();
        let took = started.elapsed().as_secs_f64();
        slowest = slowest.max(took);
        let odd: Vec<String> = caps
            .encoders
            .iter()
            .filter(|e| e.reason.as_deref().map(|r| r.contains("timed out")).unwrap_or(false))
            .map(|e| format!("{:?}", e.id))
            .collect();
        println!("  round {round:>2}: {took:>5.1}s  timed out: {odd:?}");
    }
    assert!(slowest < 8.0, "encoder detection took {slowest:.1}s in the worst round");
}
