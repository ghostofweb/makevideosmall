//! Words and numbers for the interface, plus the small bits of maths behind
//! the crop box and the quality slider. Pure functions, all unit-tested.

use mvs_core::model::*;

pub fn bytes(n: f64) -> String {
    if !n.is_finite() || n < 0.0 {
        return "—".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut value, mut unit) = (n, 0);
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let digits = if unit == 0 || value >= 100.0 { 0 } else if value >= 10.0 { 1 } else { 2 };
    format!("{value:.digits$} {}", units[unit])
}

/// 3723.4 → "1:02:03", 62 → "1:02"
pub fn clock(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "—".into();
    }
    let total = seconds as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// Like `clock`, with tenths — for cut points.
pub fn precise_clock(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "0:00.0".into();
    }
    let tenths = (seconds * 10.0).round() as u64;
    format!("{}.{}", clock((tenths / 10) as f64), tenths % 10)
}

/// "1:02:03.5", "62.5" or "1:02" → seconds.
pub fn parse_clock(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for part in parts {
        let value: f64 = part.trim().parse().ok()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        total = total * 60.0 + value;
    }
    Some(total)
}

/// 192 → "3 min", 45 → "45 s", 4000 → "1 h 7 min"
pub fn span(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "—".into();
    }
    if seconds < 60.0 {
        return format!("{} s", seconds.round().max(1.0));
    }
    let minutes = (seconds / 60.0).round() as u64;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let (h, m) = (minutes / 60, minutes % 60);
    if m == 0 { format!("{h} h") } else { format!("{h} h {m} min") }
}

/// Percent smaller than the original; negative means the file grew.
pub fn savings(source: f64, output: f64) -> i64 {
    if source > 0.0 { ((1.0 - output / source) * 100.0).round() as i64 } else { 0 }
}

pub fn savings_label(source: f64, output: f64) -> String {
    match savings(source, output) {
        p if p > 0 => format!("{p}% smaller"),
        p if p < 0 => format!("{}% bigger", -p),
        _ => "same size".into(),
    }
}

pub fn bitrate(bits_per_second: f64) -> String {
    if !(bits_per_second > 0.0) {
        return "—".into();
    }
    let kbps = bits_per_second / 1000.0;
    if kbps >= 10_000.0 {
        format!("{:.0} Mbps", kbps / 1000.0)
    } else if kbps >= 1000.0 {
        format!("{:.1} Mbps", kbps / 1000.0)
    } else {
        format!("{} kbps", kbps.round())
    }
}

pub fn fps(value: f64) -> String {
    if !(value > 0.0) {
        return "—".into();
    }
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 {
        format!("{rounded}")
    } else if (rounded * 100.0).fract().abs() < 1e-6 {
        format!("{rounded:.2}")
    } else {
        format!("{rounded:.3}")
    }
}

pub fn base_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

pub fn dir_name(path: &str) -> String {
    match path.rfind(['\\', '/']) {
        Some(i) if i > 0 => path[..i].to_string(),
        _ => String::new(),
    }
}

pub fn language(code: Option<&str>) -> String {
    let Some(code) = code else { return "Unknown language".into() };
    let name = match code.to_lowercase().as_str() {
        "eng" | "en" => "English",
        "hin" | "hi" => "Hindi",
        "spa" | "es" => "Spanish",
        "fre" | "fra" | "fr" => "French",
        "ger" | "deu" | "de" => "German",
        "ita" | "it" => "Italian",
        "jpn" | "ja" => "Japanese",
        "kor" | "ko" => "Korean",
        "chi" | "zho" | "zh" => "Chinese",
        "por" | "pt" => "Portuguese",
        "rus" | "ru" => "Russian",
        "ara" | "ar" => "Arabic",
        "pan" | "pa" => "Punjabi",
        "tam" | "ta" => "Tamil",
        "tel" | "te" => "Telugu",
        "ben" | "bn" => "Bengali",
        "urd" | "ur" => "Urdu",
        _ => return code.to_uppercase(),
    };
    name.to_string()
}

pub fn channels(count: u32) -> String {
    match count {
        1 => "Mono".into(),
        2 => "Stereo".into(),
        6 => "5.1".into(),
        8 => "7.1".into(),
        n => format!("{n} ch"),
    }
}

// ───────────────────────────── Encoder settings ─────────────────────────────

pub const HEIGHTS: [u32; 6] = [2160, 1440, 1080, 720, 480, 360];
pub const FRAME_RATES: [f64; 8] = [60.0, 50.0, 30.0, 29.97, 25.0, 24.0, 23.976, 15.0];
pub const AUDIO_KBPS: [u32; 9] = [64, 96, 128, 160, 192, 256, 320, 448, 640];

pub fn container_label(c: Container) -> &'static str {
    match c {
        Container::Mp4 => "MP4",
        Container::Mkv => "MKV",
        Container::Webm => "WebM",
        Container::Mov => "MOV",
    }
}

/// Quality sliders run 0–100 with "better" on the right, whatever the
/// encoder's own scale is (where lower numbers mean better quality).
pub fn slider_from_quality(info: &EncoderInfo, value: u32) -> f32 {
    let range = info.quality_max.saturating_sub(info.quality_min);
    if range == 0 {
        return 50.0;
    }
    let clamped = value.clamp(info.quality_min, info.quality_max);
    ((info.quality_max - clamped) as f32 / range as f32 * 100.0).round()
}

pub fn quality_from_slider(info: &EncoderInfo, slider: f32) -> u32 {
    let range = info.quality_max.saturating_sub(info.quality_min) as f32;
    (info.quality_max as f32 - slider.clamp(0.0, 100.0) / 100.0 * range).round() as u32
}

/// Carry a quality value across encoders by its distance from each default.
pub fn translate_quality(from: Option<&EncoderInfo>, to: &EncoderInfo, value: u32) -> u32 {
    let Some(from) = from.filter(|f| f.id != to.id) else {
        return value.clamp(to.quality_min, to.quality_max);
    };
    let from_range = (from.quality_max - from.quality_min).max(1) as f64;
    let to_range = (to.quality_max - to.quality_min).max(1) as f64;
    let moved = to.quality_default as f64 + (value as f64 - from.quality_default as f64) * to_range / from_range;
    (moved.round().max(0.0) as u32).clamp(to.quality_min, to.quality_max)
}

/// Switch encoder and repair every setting the new encoder cannot honour.
pub fn switch_encoder(settings: &EncodeSettings, from: Option<&EncoderInfo>, to: &EncoderInfo) -> EncodeSettings {
    let mut next = settings.clone();
    next.video.encoder = to.id;
    if let RateControl::Quality { value } = next.video.rate {
        next.video.rate = RateControl::Quality { value: translate_quality(from, to, value) };
    }
    if !to.supports_two_pass {
        next.video.two_pass = false;
    }
    if !to.supports_film_grain {
        next.video.film_grain = 0;
    }
    if !to.supports_ten_bit && next.video.bit_depth == BitDepth::Ten {
        next.video.bit_depth = BitDepth::Auto;
    }
    if !to.containers.contains(&next.container) {
        if let Some(first) = to.containers.first() {
            next.container = *first;
        }
    }
    next
}

pub fn rate_summary(rate: RateControl, info: Option<&EncoderInfo>) -> String {
    match rate {
        RateControl::Quality { value } => format!("{} {value}", info.map(|i| i.quality_label.as_str()).unwrap_or("Quality")),
        RateControl::Bitrate { kbps } if kbps >= 1000 => format!("{:.1} Mbps", kbps as f64 / 1000.0),
        RateControl::Bitrate { kbps } => format!("{kbps} kbps"),
        RateControl::TargetSize { mb } if mb >= 1024.0 => format!("fit in {:.1} GB", mb / 1024.0),
        RateControl::TargetSize { mb } => format!("fit in {mb} MB"),
    }
}

/// One-line description of settings, e.g. "AV1, CRF 40, 720p, MP4".
pub fn describe_settings(settings: &EncodeSettings, caps: Option<&Capabilities>) -> String {
    let info = caps.and_then(|c| c.encoders.iter().find(|e| e.id == settings.video.encoder));
    let codec = match info.map(|i| i.codec.as_str()) {
        Some("h264") => "H.264".to_string(),
        Some("hevc") => "HEVC".to_string(),
        Some("av1") => "AV1".to_string(),
        Some("copy") => "Copy".to_string(),
        _ => format!("{:?}", settings.video.encoder),
    };
    let mut parts = vec![if info.map(|i| i.hardware).unwrap_or(false) { format!("{codec} on GPU") } else { codec }];
    if settings.video.encoder != VideoEncoder::Copy {
        parts.push(rate_summary(settings.video.rate, info));
    }
    match settings.video.resolution {
        Resolution::Height { value } => parts.push(format!("{value}p")),
        Resolution::Custom { w, h } => parts.push(format!("{w}×{h}")),
        Resolution::Source => {}
    }
    parts.push(container_label(settings.container).to_string());
    parts.join(", ")
}

/// Length of the output after cutting.
pub fn job_duration(spec: &JobSpec, media: &MediaInfo) -> f64 {
    let Some(trim) = spec.trim else { return media.duration };
    let start = trim.start.clamp(0.0, media.duration.max(0.0));
    let end = if trim.end <= 0.0 { media.duration } else { trim.end.clamp(start, media.duration.max(start)) };
    if end - start >= 0.1 { end - start } else { media.duration }
}

/// An estimate for a different length of the same video.
pub fn scale_estimate(estimate: &Estimate, factor: f64) -> Estimate {
    if !factor.is_finite() || factor <= 0.0 || factor == 1.0 {
        return estimate.clone();
    }
    Estimate { size_bytes: estimate.size_bytes * factor, encode_secs: estimate.encode_secs * factor, ..estimate.clone() }
}

// ───────────────────────────── Crop box ─────────────────────────────

/// Smallest crop box, in pixels.
pub const MIN_CROP: f64 = 16.0;

/// The shapes offered in the crop tool: width ÷ height, or `None` for any.
pub const CROP_SHAPES: [Option<f64>; 5] = [None, Some(1.0), Some(16.0 / 9.0), Some(4.0 / 3.0), Some(9.0 / 16.0)];

/// The largest centred box of the given shape, covering 80% of the picture.
pub fn default_crop(width: u32, height: u32, aspect: Option<f64>) -> Crop {
    let (mut w, mut h) = (width as f64 * 0.8, height as f64 * 0.8);
    if let Some(a) = aspect {
        if w / h > a { w = h * a } else { h = w / a }
    }
    let (w, h) = (w.round() as u32, h.round() as u32);
    Crop { w, h, x: (width - w) / 2, y: (height - h) / 2 }
}

/// Apply a drag to a crop box, keeping it inside the picture and on shape.
/// `handle`: 0 move, 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right.
pub fn drag_crop(start: Crop, handle: i32, dx: f64, dy: f64, width: u32, height: u32, aspect: Option<f64>) -> Crop {
    let (width, height) = (width as f64, height as f64);
    let (sx, sy, sw, sh) = (start.x as f64, start.y as f64, start.w as f64, start.h as f64);
    if handle == 0 {
        return Crop {
            x: (sx + dx).clamp(0.0, (width - sw).max(0.0)).round() as u32,
            y: (sy + dy).clamp(0.0, (height - sh).max(0.0)).round() as u32,
            ..start
        };
    }
    // The corner opposite the one being dragged stays where it is.
    let left = handle == 1 || handle == 3;
    let top = handle == 1 || handle == 2;
    let anchor_x = if left { sx + sw } else { sx };
    let anchor_y = if top { sy + sh } else { sy };
    let room_x = if left { anchor_x } else { width - anchor_x };
    let room_y = if top { anchor_y } else { height - anchor_y };
    let mut w = (sw + if left { -dx } else { dx }).max(MIN_CROP).min(room_x);
    let mut h = (sh + if top { -dy } else { dy }).max(MIN_CROP).min(room_y);
    if let Some(a) = aspect {
        // Follow the width, then shrink to whatever room there is.
        h = w / a;
        let fit = (room_x / w).min(room_y / h).min(1.0);
        w *= fit;
        h *= fit;
    }
    let (w, h) = (w.round(), h.round());
    Crop {
        w: w as u32,
        h: h as u32,
        x: (if left { anchor_x - w } else { anchor_x }).round().max(0.0) as u32,
        y: (if top { anchor_y - h } else { anchor_y }).round().max(0.0) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mvs_core::ffmpeg::caps::describe;

    #[test]
    fn sizes_and_times() {
        assert_eq!(bytes(0.0), "0 B");
        assert_eq!(bytes(1536.0), "1.50 KB");
        assert_eq!(bytes(15.0 * 1024.0), "15.0 KB");
        assert_eq!(bytes(230.0 * 1024.0 * 1024.0), "230 MB");
        assert_eq!(bytes(f64::NAN), "—");
        assert_eq!(clock(62.0), "1:02");
        assert_eq!(clock(3723.9), "1:02:03");
        assert_eq!(precise_clock(83.46), "1:23.5");
        // Rounding up must carry into the seconds, not print ".10".
        assert_eq!(precise_clock(59.97), "1:00.0");
        assert_eq!(span(0.2), "1 s");
        assert_eq!(span(192.0), "3 min");
        assert_eq!(span(4000.0), "1 h 7 min");
        assert_eq!(span(3600.0), "1 h");
    }

    #[test]
    fn reads_typed_times() {
        assert_eq!(parse_clock("12"), Some(12.0));
        assert_eq!(parse_clock("1:23.5"), Some(83.5));
        assert_eq!(parse_clock(" 1:02:03 "), Some(3723.0));
        for bad in ["", "abc", "1::2", "-5", "1:2:3:4"] {
            assert_eq!(parse_clock(bad), None, "{bad}");
        }
        for t in [0.0, 0.5, 59.9, 60.0, 3599.9, 7325.3] {
            assert!((parse_clock(&precise_clock(t)).unwrap() - t).abs() < 1e-6);
        }
    }

    #[test]
    fn labels() {
        assert_eq!(savings_label(1000.0, 250.0), "75% smaller");
        assert_eq!(savings_label(1000.0, 1200.0), "20% bigger");
        assert_eq!(savings_label(1000.0, 1000.0), "same size");
        assert_eq!(savings(0.0, 5.0), 0);
        assert_eq!(bitrate(128_000.0), "128 kbps");
        assert_eq!(bitrate(2_500_000.0), "2.5 Mbps");
        assert_eq!(bitrate(12_000_000.0), "12 Mbps");
        assert_eq!(fps(30.0), "30");
        assert_eq!(fps(23.976023976), "23.976");
        assert_eq!(fps(29.97), "29.97");
        assert_eq!(base_name(r"C:\Videos\My clip.mkv"), "My clip.mkv");
        assert_eq!(dir_name(r"C:\Videos\My clip.mkv"), r"C:\Videos");
        assert_eq!(dir_name("clip.mkv"), "");
        assert_eq!(language(Some("HIN")), "Hindi");
        assert_eq!(language(Some("xyz")), "XYZ");
        assert_eq!(language(None), "Unknown language");
        assert_eq!(channels(6), "5.1");
    }

    #[test]
    fn quality_slider_round_trips_and_puts_better_on_the_right() {
        for enc in [VideoEncoder::X264, VideoEncoder::SvtAv1, VideoEncoder::HevcNvenc] {
            let info = describe(enc, true, None);
            assert_eq!(slider_from_quality(&info, info.quality_min), 100.0);
            assert_eq!(slider_from_quality(&info, info.quality_max), 0.0);
            for q in info.quality_min..=info.quality_max {
                assert_eq!(quality_from_slider(&info, slider_from_quality(&info, q)), q);
            }
        }
    }

    #[test]
    fn switching_encoder_repairs_settings() {
        let x264 = describe(VideoEncoder::X264, true, None);
        let svt = describe(VideoEncoder::SvtAv1, true, None);
        let nvenc = describe(VideoEncoder::H264Nvenc, true, None);
        assert_eq!(translate_quality(Some(&x264), &svt, 23), 32);
        assert_eq!(translate_quality(Some(&x264), &svt, 18), 26);
        assert_eq!(translate_quality(None, &x264, 99), 51);

        let mut settings = mvs_core::presets::builtin_presets().remove(0).settings;
        settings.container = Container::Webm;
        settings.video.encoder = VideoEncoder::SvtAv1;
        settings.video.rate = RateControl::Quality { value: 40 };
        settings.video.film_grain = 8;
        settings.video.bit_depth = BitDepth::Ten;
        let next = switch_encoder(&settings, Some(&svt), &nvenc);
        assert_eq!(next.video.encoder, VideoEncoder::H264Nvenc);
        assert_eq!(next.video.film_grain, 0);
        assert_eq!(next.video.bit_depth, BitDepth::Auto);
        assert_eq!(next.container, Container::Mp4, "H.264 cannot go in WebM");
        assert_eq!(next.video.rate, RateControl::Quality { value: 31 });
        assert_eq!(describe_settings(&next, None), "H264Nvenc, Quality 31, MP4");
    }

    #[test]
    fn crop_box_stays_inside_and_on_shape() {
        let (w, h) = (1000, 600);
        assert_eq!(default_crop(w, h, None), Crop { w: 800, h: 480, x: 100, y: 60 });
        for shape in CROP_SHAPES {
            let c = default_crop(w, h, shape);
            assert!(c.x + c.w <= w && c.y + c.h <= h);
            if let Some(a) = shape {
                assert!((c.w as f64 / c.h as f64 - a).abs() < 0.02);
            }
        }
        let start = Crop { w: 400, h: 300, x: 300, y: 150 };
        assert_eq!(drag_crop(start, 0, 50.0, -20.0, w, h, None), Crop { w: 400, h: 300, x: 350, y: 130 });
        assert_eq!(drag_crop(start, 0, 9999.0, 9999.0, w, h, None), Crop { w: 400, h: 300, x: 600, y: 300 });
        assert_eq!(drag_crop(start, 4, 100.0, 50.0, w, h, None), Crop { w: 500, h: 350, x: 300, y: 150 });
        let nw = drag_crop(start, 1, -100.0, -50.0, w, h, None);
        assert_eq!(nw, Crop { w: 500, h: 350, x: 200, y: 100 });
        assert_eq!((nw.x + nw.w, nw.y + nw.h), (700, 450), "the opposite corner stays put");
        for handle in 1..=4 {
            for (dx, dy) in [(9999.0, 9999.0), (-9999.0, -9999.0), (9999.0, -9999.0), (-9999.0, 9999.0)] {
                let c = drag_crop(start, handle, dx, dy, w, h, None);
                assert!(c.x + c.w <= w && c.y + c.h <= h && c.w >= 16 && c.h >= 16, "{handle} {dx} {dy}: {c:?}");
            }
        }
        let square = Crop { w: 300, h: 300, x: 300, y: 150 };
        assert_eq!(drag_crop(square, 4, 9999.0, 9999.0, w, h, Some(1.0)), Crop { w: 450, h: 450, x: 300, y: 150 });
    }

    #[test]
    fn estimates_follow_the_cut() {
        let e = Estimate { size_bytes: 100.0, savings_percent: 50.0, encode_secs: 10.0, video_kbps: 1.0, sampled: true };
        let half = scale_estimate(&e, 0.5);
        assert_eq!((half.size_bytes, half.encode_secs, half.savings_percent), (50.0, 5.0, 50.0));
        assert_eq!(scale_estimate(&e, f64::NAN), e);
    }
}
