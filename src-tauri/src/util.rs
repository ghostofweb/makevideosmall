//! Small shared helpers: events, JSON persistence, time, futures.

use crate::error::Result;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Where the core sends notifications. The app forwards them to the UI; tests
/// collect them.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// Discards every event.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

pub fn emit<T: Serialize>(sink: &dyn EventSink, event: &str, payload: &T) {
    if let Ok(value) = serde_json::to_value(payload) {
        sink.emit(event, value);
    }
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Read a JSON file, falling back to `T::default()` when it is missing or broken.
pub fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write JSON via a temp file and rename, so a crash never leaves half a file.
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Poll every future concurrently on the current task; results keep their order.
pub async fn join_all<F: std::future::Future>(futures: Vec<F>) -> Vec<F::Output> {
    use std::pin::Pin;
    use std::task::Poll;

    let mut futures: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut results: Vec<Option<F::Output>> = futures.iter().map(|_| None).collect();
    std::future::poll_fn(move |cx| {
        let mut pending = false;
        for (i, fut) in futures.iter_mut().enumerate() {
            if results[i].is_none() {
                match fut.as_mut().poll(cx) {
                    Poll::Ready(v) => results[i] = Some(v),
                    Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(results.iter_mut().map(|r| r.take().unwrap()).collect())
        }
    })
    .await
}

/// "1.5 GB"-style size for log lines.
pub fn format_bytes(bytes: f64) -> String {
    let mut size = bytes.max(0.0);
    for unit in ["B", "KB", "MB", "GB"] {
        if size < 1024.0 {
            return format!("{size:.1} {unit}");
        }
        size /= 1024.0;
    }
    format!("{size:.1} TB")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn join_all_keeps_order() {
        let futs: Vec<_> = (0..5u64)
            .map(|i| async move {
                tokio::time::sleep(Duration::from_millis(20 - i * 4)).await;
                i
            })
            .collect();
        assert_eq!(join_all(futs).await, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn json_round_trip_and_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("data.json");
        assert_eq!(load_json::<Vec<u32>>(&path), Vec::<u32>::new());
        save_json(&path, &vec![1u32, 2, 3]).unwrap();
        assert_eq!(load_json::<Vec<u32>>(&path), vec![1, 2, 3]);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_json::<Vec<u32>>(&path), Vec::<u32>::new());
    }

    #[test]
    fn formats_bytes() {
        assert_eq!(format_bytes(512.0), "512.0 B");
        assert_eq!(format_bytes(1536.0), "1.5 KB");
        assert_eq!(format_bytes(5.0 * 1024.0 * 1024.0 * 1024.0), "5.0 GB");
    }
}
