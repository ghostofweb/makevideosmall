//! ffprobe → `MediaInfo`.

use crate::error::{AppError, Result};
use crate::model::{AudioStream, MediaInfo, SubtitleStream, VideoStream};
use crate::platform;
use serde_json::Value;
use std::path::Path;

/// Subtitle codecs that are text and can be converted between formats.
const TEXT_SUBS: &[&str] = &["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"];

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "unknown")
        .map(str::to_string)
}

/// "30000/1001" → 29.97
fn ratio(v: &Value) -> f64 {
    let Some(s) = v.as_str() else { return num(v) };
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(0.0));
            if b > 0.0 {
                a / b
            } else {
                0.0
            }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

fn tag(stream: &Value, key: &str) -> Option<String> {
    let tags = stream.get("tags")?.as_object()?;
    tags.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .and_then(|(_, v)| text(v))
}

fn disposition(stream: &Value, key: &str) -> bool {
    stream
        .get("disposition")
        .and_then(|d| d.get(key))
        .map(|v| num(v) == 1.0)
        .unwrap_or(false)
}

fn bit_depth(stream: &Value, pix_fmt: &str) -> u32 {
    let raw = num(&stream["bits_per_raw_sample"]) as u32;
    if raw >= 8 {
        return raw;
    }
    if pix_fmt.contains("p12") || pix_fmt.contains("12le") || pix_fmt.contains("12be") {
        12
    } else if pix_fmt.contains("p10") || pix_fmt.contains("10le") || pix_fmt.contains("10be") {
        10
    } else {
        8
    }
}

fn rotation(stream: &Value) -> i32 {
    if let Some(list) = stream.get("side_data_list").and_then(Value::as_array) {
        for item in list {
            if let Some(r) = item.get("rotation") {
                return num(r).round() as i32;
            }
        }
    }
    tag(stream, "rotate")
        .and_then(|r| r.parse::<f64>().ok())
        .map(|r| r.round() as i32)
        .unwrap_or(0)
}

/// Turn ffprobe's JSON into a `MediaInfo`. Pure, so it can be tested with fixtures.
pub fn parse_probe(json: &str, path: &str) -> Result<MediaInfo> {
    let root: Value = serde_json::from_str(json)?;
    let format = &root["format"];
    let streams = root["streams"].as_array().cloned().unwrap_or_default();

    let size_bytes = num(&format["size"]);
    let mut duration = num(&format["duration"]);

    let mut video: Option<VideoStream> = None;
    let mut audio = Vec::new();
    let mut subtitles = Vec::new();

    for s in &streams {
        let index = num(&s["index"]) as u32;
        let codec = s["codec_name"].as_str().unwrap_or("unknown").to_string();
        match s["codec_type"].as_str().unwrap_or("") {
            "video" => {
                // Cover art is a video stream too; skip it.
                if video.is_some() || disposition(s, "attached_pic") {
                    continue;
                }
                let pix_fmt = s["pix_fmt"].as_str().unwrap_or("unknown").to_string();
                let mut fps = ratio(&s["avg_frame_rate"]);
                if !(fps > 0.0 && fps < 1000.0) {
                    fps = ratio(&s["r_frame_rate"]);
                }
                if !(fps > 0.0 && fps < 1000.0) {
                    fps = 30.0;
                }
                let stream_duration = num(&s["duration"]);
                if duration <= 0.0 {
                    duration = stream_duration;
                }
                let color_transfer = text(&s["color_transfer"]);
                let is_hdr = matches!(
                    color_transfer.as_deref(),
                    Some("smpte2084") | Some("arib-std-b67")
                );
                let field_order = s["field_order"].as_str().unwrap_or("progressive");
                let mut frames = num(&s["nb_frames"]);
                if frames <= 0.0 {
                    frames = (duration * fps).round();
                }
                video = Some(VideoStream {
                    index,
                    codec,
                    width: num(&s["width"]) as u32,
                    height: num(&s["height"]) as u32,
                    fps,
                    bit_depth: bit_depth(s, &pix_fmt),
                    pix_fmt,
                    is_hdr,
                    color_transfer,
                    color_primaries: text(&s["color_primaries"]),
                    color_space: text(&s["color_space"]),
                    bitrate: num(&s["bit_rate"]),
                    frames,
                    rotation: rotation(s),
                    interlaced: !matches!(field_order, "progressive" | "unknown" | ""),
                });
            }
            "audio" => {
                let channels = num(&s["channels"]) as u32;
                audio.push(AudioStream {
                    index,
                    order: audio.len() as u32,
                    codec,
                    channels,
                    channel_layout: text(&s["channel_layout"]).unwrap_or_else(|| match channels {
                        1 => "mono".into(),
                        2 => "stereo".into(),
                        6 => "5.1".into(),
                        8 => "7.1".into(),
                        n => format!("{n} channels"),
                    }),
                    sample_rate: num(&s["sample_rate"]) as u32,
                    bitrate: num(&s["bit_rate"]),
                    language: tag(s, "language").filter(|l| l != "und"),
                    title: tag(s, "title"),
                    default: disposition(s, "default"),
                });
            }
            "subtitle" => {
                let is_text = TEXT_SUBS.contains(&codec.as_str());
                subtitles.push(SubtitleStream {
                    index,
                    order: subtitles.len() as u32,
                    codec,
                    language: tag(s, "language").filter(|l| l != "und"),
                    title: tag(s, "title"),
                    default: disposition(s, "default"),
                    forced: disposition(s, "forced"),
                    is_text,
                });
            }
            _ => {}
        }
    }

    let mut bitrate = num(&format["bit_rate"]);
    if bitrate <= 0.0 && duration > 0.0 {
        bitrate = size_bytes * 8.0 / duration;
    }
    // Many containers do not store a per-stream video bitrate; estimate it.
    if let Some(v) = video.as_mut() {
        if v.bitrate <= 0.0 {
            let audio_total: f64 = audio.iter().map(|a| a.bitrate).sum();
            v.bitrate = (bitrate - audio_total).max(0.0);
        }
    }

    let file_name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    Ok(MediaInfo {
        path: path.to_string(),
        file_name,
        size_bytes,
        duration,
        bitrate,
        format_name: format["format_name"].as_str().unwrap_or("").to_string(),
        video,
        audio,
        subtitles,
        chapters: root["chapters"].as_array().map(|c| c.len() as u32).unwrap_or(0),
    })
}

/// Run ffprobe on a file.
pub async fn probe(ffprobe: &Path, path: &str) -> Result<MediaInfo> {
    if !Path::new(path).is_file() {
        return Err(AppError::msg(format!("File not found: {path}")));
    }
    let out = platform::command(ffprobe, None)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-show_chapters",
        ])
        .arg(path)
        .output()
        .await?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::msg(format!(
            "This file could not be read as media. {}",
            err.lines().last().unwrap_or("").trim()
        )));
    }
    let mut info = parse_probe(&String::from_utf8_lossy(&out.stdout), path)?;
    if info.size_bytes <= 0.0 {
        info.size_bytes = std::fs::metadata(path).map(|m| m.len() as f64).unwrap_or(0.0);
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "streams": [
        {"index":0,"codec_name":"hevc","codec_type":"video","width":3840,"height":2160,
         "pix_fmt":"yuv420p10le","r_frame_rate":"24000/1001","avg_frame_rate":"24000/1001",
         "color_transfer":"smpte2084","color_primaries":"bt2020","color_space":"bt2020nc",
         "field_order":"progressive","disposition":{"default":1,"attached_pic":0}},
        {"index":1,"codec_name":"eac3","codec_type":"audio","channels":6,"channel_layout":"5.1(side)",
         "sample_rate":"48000","bit_rate":"640000","disposition":{"default":1},
         "tags":{"language":"eng","title":"Surround"}},
        {"index":2,"codec_name":"aac","codec_type":"audio","channels":2,"sample_rate":"48000",
         "bit_rate":"128000","disposition":{"default":0},"tags":{"LANGUAGE":"hin"}},
        {"index":3,"codec_name":"subrip","codec_type":"subtitle","disposition":{"default":1,"forced":0},
         "tags":{"language":"eng"}},
        {"index":4,"codec_name":"hdmv_pgs_subtitle","codec_type":"subtitle","disposition":{"default":0,"forced":1}},
        {"index":5,"codec_name":"mjpeg","codec_type":"video","width":600,"height":900,
         "disposition":{"attached_pic":1}}
      ],
      "chapters": [{"id":0},{"id":1},{"id":2}],
      "format": {"format_name":"matroska,webm","duration":"5400.5","size":"8000000000","bit_rate":"11850000"}
    }"#;

    #[test]
    fn parses_streams() {
        let m = parse_probe(FIXTURE, r"C:\videos\movie.mkv").unwrap();
        assert_eq!(m.file_name, "movie.mkv");
        assert_eq!(m.duration, 5400.5);
        assert_eq!(m.chapters, 3);

        let v = m.video.unwrap();
        assert_eq!((v.width, v.height), (3840, 2160));
        assert!((v.fps - 23.976).abs() < 0.001);
        assert_eq!(v.bit_depth, 10);
        assert!(v.is_hdr);
        assert!(!v.interlaced);
        // No per-stream bitrate in the fixture: total minus audio.
        assert_eq!(v.bitrate, 11_850_000.0 - 640_000.0 - 128_000.0);

        assert_eq!(m.audio.len(), 2);
        assert_eq!(m.audio[0].order, 0);
        assert_eq!(m.audio[0].channels, 6);
        assert_eq!(m.audio[0].language.as_deref(), Some("eng"));
        assert_eq!(m.audio[1].order, 1);
        assert_eq!(m.audio[1].channel_layout, "stereo");
        assert_eq!(m.audio[1].language.as_deref(), Some("hin"));

        assert_eq!(m.subtitles.len(), 2);
        assert!(m.subtitles[0].is_text);
        assert!(!m.subtitles[1].is_text);
        assert!(m.subtitles[1].forced);
    }

    #[test]
    fn handles_missing_fields() {
        let m = parse_probe(r#"{"streams":[{"index":0,"codec_type":"video","width":640,"height":360,"r_frame_rate":"0/0"}],"format":{}}"#, "a.mp4").unwrap();
        let v = m.video.unwrap();
        assert_eq!(v.fps, 30.0);
        assert_eq!(v.bit_depth, 8);
        assert_eq!(m.duration, 0.0);
        assert!(m.audio.is_empty());
    }

    #[test]
    fn reads_rotation_and_interlace() {
        let json = r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
          "avg_frame_rate":"25/1","field_order":"tt","side_data_list":[{"rotation":-90}]}],"format":{"duration":"10"}}"#;
        let v = parse_probe(json, "a.mp4").unwrap().video.unwrap();
        assert_eq!(v.rotation, -90);
        assert!(v.interlaced);
    }
}
