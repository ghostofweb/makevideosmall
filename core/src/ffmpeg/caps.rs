//! Work out which encoders this machine can really use.
//!
//! ffmpeg lists every encoder it was built with, including GPU encoders the
//! hardware does not have. So hardware encoders are checked with a tiny real
//! encode instead of trusting the list.

use super::locate::Tools;
use super::runner::{capture, last_line};
use crate::error::Result;
use crate::model::{Capabilities, Codec, Container, EncoderInfo, Vendor, VideoEncoder};
use crate::util::join_all;
use std::collections::HashSet;
use std::time::Duration;

/// Encoder names from `ffmpeg -encoders` output.
pub fn parse_encoder_list(text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut in_list = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("------") {
            in_list = true;
            continue;
        }
        if !in_list {
            continue;
        }
        // " V....D libx264   libx264 H.264 ..."
        let mut parts = line.split_whitespace();
        if let (Some(flags), Some(name)) = (parts.next(), parts.next()) {
            if flags.len() == 6 {
                names.insert(name.to_string());
            }
        }
    }
    names
}

fn label(enc: VideoEncoder) -> &'static str {
    use VideoEncoder::*;
    match enc {
        X264 => "H.264 (x264)",
        X265 => "H.265 / HEVC (x265)",
        SvtAv1 => "AV1 (SVT-AV1)",
        H264Nvenc => "H.264 (NVIDIA NVENC)",
        HevcNvenc => "H.265 / HEVC (NVIDIA NVENC)",
        Av1Nvenc => "AV1 (NVIDIA NVENC)",
        H264Qsv => "H.264 (Intel Quick Sync)",
        HevcQsv => "H.265 / HEVC (Intel Quick Sync)",
        Av1Qsv => "AV1 (Intel Quick Sync)",
        H264Amf => "H.264 (AMD AMF)",
        HevcAmf => "H.265 / HEVC (AMD AMF)",
        Av1Amf => "AV1 (AMD AMF)",
        Copy => "Copy (no re-encode)",
    }
}

fn containers(enc: VideoEncoder) -> Vec<Container> {
    match enc.codec() {
        Codec::H264 | Codec::Hevc => vec![Container::Mp4, Container::Mkv, Container::Mov],
        Codec::Av1 => vec![Container::Mp4, Container::Mkv, Container::Webm],
        Codec::Copy => vec![Container::Mkv, Container::Mp4, Container::Mov, Container::Webm],
    }
}

/// Static description of an encoder; `available` is filled in by probing.
pub fn describe(enc: VideoEncoder, available: bool, reason: Option<String>) -> EncoderInfo {
    let (quality_min, quality_max, quality_default) = enc.quality_range();
    EncoderInfo {
        id: enc,
        label: label(enc).into(),
        codec: match enc.codec() {
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
            Codec::Av1 => "av1",
            Codec::Copy => "copy",
        }
        .into(),
        hardware: enc.is_hardware(),
        vendor: match enc.vendor() {
            Vendor::Software => None,
            Vendor::Nvidia => Some("NVIDIA".into()),
            Vendor::Intel => Some("Intel".into()),
            Vendor::Amd => Some("AMD".into()),
        },
        available,
        reason,
        quality_min,
        quality_max,
        quality_default,
        quality_label: match enc.vendor() {
            Vendor::Software => "CRF",
            Vendor::Nvidia => "CQ",
            Vendor::Intel => "ICQ",
            Vendor::Amd => "QP",
        }
        .into(),
        supports_ten_bit: enc.supports_ten_bit(),
        supports_two_pass: enc.supports_two_pass() || enc.vendor() == Vendor::Nvidia,
        supports_film_grain: enc == VideoEncoder::SvtAv1,
        containers: containers(enc),
    }
}

/// How long one hardware check may take. A working encoder answers in under a
/// second; a graphics driver that is busy can leave the check hanging.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const TIMED_OUT: &str = "The graphics driver did not answer in time.";

/// The check for this encoder gave no answer, as opposed to a clear yes or no.
pub fn timed_out(info: &EncoderInfo) -> bool {
    info.reason.as_deref() == Some(TIMED_OUT)
}

/// Where a fresh check gave no answer for an encoder, keep what an earlier
/// check found. A stalled driver says nothing about what the hardware can do.
pub fn keep_known_answers(fresh: &mut Capabilities, earlier: &Capabilities) {
    for info in fresh.encoders.iter_mut().filter(|e| timed_out(e)) {
        if let Some(known) = earlier.encoders.iter().find(|e| e.id == info.id && !timed_out(e)) {
            *info = known.clone();
        }
    }
}

/// Encode a few black frames to see whether a hardware encoder works here.
async fn test_encode(tools: &Tools, enc: VideoEncoder) -> std::result::Result<(), String> {
    let pix = match enc.vendor() {
        Vendor::Intel | Vendor::Amd => "nv12",
        _ => "yuv420p",
    };
    let args: Vec<String> = [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30",
        "-frames:v", "8", "-pix_fmt", pix,
        "-c:v", enc.ffmpeg_name(),
        "-f", "null", "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    match tokio::time::timeout(PROBE_TIMEOUT, capture(&tools.ffmpeg, &args, None, None)).await {
        Err(_) => Err(TIMED_OUT.into()),
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(out)) if out.ok => Ok(()),
        Ok(Ok(out)) => Err(friendly_reason(enc, &out.stderr)),
    }
}

/// Turn ffmpeg's error text into something a person can act on.
fn friendly_reason(enc: VideoEncoder, stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    let who = match enc.vendor() {
        Vendor::Nvidia => "NVIDIA",
        Vendor::Intel => "Intel",
        Vendor::Amd => "AMD",
        Vendor::Software => "",
    };
    if lower.contains("codec not supported") || lower.contains("no capable devices") || lower.contains("not supported by this") {
        format!("This {who} GPU cannot encode this format.")
    } else if lower.contains("cannot load") || lower.contains("dll") || lower.contains("no device") || lower.contains("not available")
        || lower.contains("failed to create") || lower.contains("error creating a mfx session") || lower.contains("unsupported")
    {
        format!("No {who} GPU (or driver) that supports this encoder was found.")
    } else if lower.contains("driver") {
        format!("The {who} graphics driver is too old for this encoder.")
    } else {
        let detail = last_line(stderr);
        if detail.is_empty() {
            format!("The {who} encoder failed a test encode.")
        } else {
            format!("The {who} encoder failed a test encode: {detail}")
        }
    }
}

async fn ffmpeg_version(tools: &Tools) -> String {
    match capture(&tools.ffmpeg, &["-version".to_string()], None, None).await {
        Ok(out) => out
            .stdout
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("ffmpeg version "))
            .and_then(|l| l.split_whitespace().next())
            .unwrap_or("unknown")
            .to_string(),
        Err(_) => "unknown".into(),
    }
}

/// Probe the machine. Takes a second or two; callers cache the result.
pub async fn detect(tools: &Tools) -> Result<Capabilities> {
    let list = capture(
        &tools.ffmpeg,
        &["-hide_banner".to_string(), "-encoders".to_string()],
        None,
        None,
    )
    .await?;
    let built = parse_encoder_list(&list.stdout);

    // Hardware checks run at the same time; each is a separate process.
    let checks = VideoEncoder::ALL.iter().copied().map(|enc| {
        let built = &built;
        async move {
            if enc == VideoEncoder::Copy {
                return describe(enc, true, None);
            }
            if !built.contains(enc.ffmpeg_name()) {
                return describe(enc, false, Some("This ffmpeg build does not include the encoder.".into()));
            }
            if !enc.is_hardware() {
                return describe(enc, true, None);
            }
            match test_encode(tools, enc).await {
                Ok(()) => describe(enc, true, None),
                Err(reason) => describe(enc, false, Some(reason)),
            }
        }
    });
    let mut encoders = join_all(checks.collect()).await;

    // A check that hung is tried once more, alone: hangs come from several
    // things asking the same graphics driver for a session at once.
    for info in encoders.iter_mut().filter(|e| timed_out(e)) {
        *info = match test_encode(tools, info.id).await {
            Ok(()) => describe(info.id, true, None),
            Err(reason) => describe(info.id, false, Some(reason)),
        };
    }

    Ok(Capabilities {
        ffmpeg_path: tools.ffmpeg.to_string_lossy().into_owned(),
        ffprobe_path: tools.ffprobe.to_string_lossy().into_owned(),
        ffmpeg_version: ffmpeg_version(tools).await,
        encoders,
        upscaler_available: tools.upscaler.is_some(),
        background_removal_available: tools.bg_model.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_encoder_list() {
        let text = "Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264              libx264 H.264 / AVC\n V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n A....D aac                  AAC (Advanced Audio Coding)\n";
        let names = parse_encoder_list(text);
        assert!(names.contains("libx264"));
        assert!(names.contains("hevc_nvenc"));
        assert!(names.contains("aac"));
        assert!(!names.contains("="));
        assert_eq!(names.len(), 3);
    }

    #[test]
    fn describes_encoders() {
        let svt = describe(VideoEncoder::SvtAv1, true, None);
        assert_eq!(svt.codec, "av1");
        assert!(!svt.hardware);
        assert!(svt.supports_film_grain);
        assert_eq!((svt.quality_min, svt.quality_max, svt.quality_default), (1, 63, 32));
        assert!(svt.containers.contains(&Container::Webm));

        let nv = describe(VideoEncoder::H264Nvenc, false, Some("nope".into()));
        assert!(nv.hardware);
        assert_eq!(nv.vendor.as_deref(), Some("NVIDIA"));
        assert_eq!(nv.quality_label, "CQ");
        assert!(!nv.supports_ten_bit);
        assert!(!nv.containers.contains(&Container::Webm));
    }

    #[test]
    fn a_stalled_check_does_not_erase_what_was_known() {
        let caps = |encoders: Vec<EncoderInfo>| Capabilities {
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            ffmpeg_version: String::new(),
            encoders,
            upscaler_available: false,
            background_removal_available: false,
        };
        let earlier = caps(vec![
            describe(VideoEncoder::HevcAmf, true, None),
            describe(VideoEncoder::Av1Amf, false, Some("This AMD GPU cannot encode this format.".into())),
            describe(VideoEncoder::HevcNvenc, true, None),
        ]);
        let mut fresh = caps(vec![
            describe(VideoEncoder::HevcAmf, false, Some(TIMED_OUT.into())),
            describe(VideoEncoder::Av1Amf, false, Some(TIMED_OUT.into())),
            // A clear "no" is believed, even if it used to be "yes".
            describe(VideoEncoder::HevcNvenc, false, Some("No NVIDIA GPU (or driver) that supports this encoder was found.".into())),
        ]);
        keep_known_answers(&mut fresh, &earlier);
        assert!(fresh.encoders[0].available, "the stalled check keeps the earlier yes");
        assert_eq!(fresh.encoders[1].reason.as_deref(), Some("This AMD GPU cannot encode this format."));
        assert!(!fresh.encoders[2].available);

        // With nothing known before, the stall is reported as it is.
        let mut alone = caps(vec![describe(VideoEncoder::HevcAmf, false, Some(TIMED_OUT.into()))]);
        keep_known_answers(&mut alone, &caps(vec![]));
        assert!(timed_out(&alone.encoders[0]));
    }

    #[test]
    fn friendly_reasons() {
        let r = friendly_reason(VideoEncoder::Av1Nvenc, "[av1_nvenc @ 0x1] Codec not supported\nError while opening encoder");
        assert_eq!(r, "This NVIDIA GPU cannot encode this format.");
        let r = friendly_reason(VideoEncoder::H264Qsv, "Error creating a MFX session: -9.");
        assert!(r.starts_with("No Intel GPU"));
    }
}
