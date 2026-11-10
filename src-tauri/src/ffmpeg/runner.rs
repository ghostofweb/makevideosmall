//! Run ffmpeg (and friends) as child processes with live progress, pause,
//! resume and cancel.

use super::progress::{ProgressParser, Tick};
use crate::error::{AppError, Result};
use crate::model::SystemImpact;
use crate::platform;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::{mpsc, watch};

/// Shared handle used to pause, resume or cancel a running process.
pub struct JobControl {
    pid: AtomicU32,
    paused: AtomicBool,
    cancel: watch::Sender<bool>,
}

impl Default for JobControl {
    fn default() -> Self {
        Self::new()
    }
}

impl JobControl {
    pub fn new() -> Self {
        JobControl {
            pid: AtomicU32::new(0),
            paused: AtomicBool::new(false),
            cancel: watch::channel(false).0,
        }
    }

    pub fn cancel(&self) {
        self.cancel.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    /// Resolves once `cancel` has been called (immediately if it already was).
    pub async fn cancelled(&self) {
        let mut rx = self.cancel.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Suspend the running process. Remembered even if nothing runs yet, so a
    /// process started later begins suspended.
    pub fn pause(&self) -> std::io::Result<()> {
        self.paused.store(true, Ordering::SeqCst);
        match self.pid.load(Ordering::SeqCst) {
            0 => Ok(()),
            pid => platform::suspend(pid),
        }
    }

    pub fn resume(&self) -> std::io::Result<()> {
        self.paused.store(false, Ordering::SeqCst);
        match self.pid.load(Ordering::SeqCst) {
            0 => Ok(()),
            pid => platform::resume(pid),
        }
    }

    fn attach(&self, pid: u32) {
        self.pid.store(pid, Ordering::SeqCst);
        platform::adopt(pid);
        if self.is_paused() {
            let _ = platform::suspend(pid);
        }
    }

    fn detach(&self) {
        self.pid.store(0, Ordering::SeqCst);
    }
}

enum Line {
    Out(String),
    Err(String),
}

/// Read lines from a pipe without assuming valid UTF-8, splitting on both
/// `\n` and `\r` (ffmpeg uses carriage returns for in-place updates).
fn pump<R>(reader: R, tx: mpsc::UnboundedSender<Line>, wrap: fn(String) -> Line)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    for piece in String::from_utf8_lossy(&buf).split(['\r', '\n']) {
                        let piece = piece.trim_end();
                        if !piece.is_empty() && tx.send(wrap(piece.to_string())).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
}

/// Boil ffmpeg's stderr down to the lines that explain a failure.
fn failure_message(tail: &VecDeque<String>, code: Option<i32>) -> String {
    let useful: Vec<&str> = tail
        .iter()
        .map(String::as_str)
        .filter(|l| {
            let l = l.to_ascii_lowercase();
            !l.starts_with("frame=") && !l.contains("press [q]") && !l.trim().is_empty()
        })
        .collect();
    let start = useful.len().saturating_sub(4);
    let detail = useful[start..].join("\n");
    if detail.is_empty() {
        format!("ffmpeg exited with code {}.", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
    } else {
        detail
    }
}

/// Run one ffmpeg invocation to completion.
///
/// `on_tick` receives progress, `on_log` receives every stderr line.
pub async fn run_ffmpeg(
    ffmpeg: &Path,
    args: &[String],
    cwd: Option<&Path>,
    impact: Option<SystemImpact>,
    control: &JobControl,
    mut on_tick: impl FnMut(Tick),
    mut on_log: impl FnMut(&str),
) -> Result<()> {
    if control.is_cancelled() {
        return Err(AppError::Cancelled);
    }
    let mut cmd = platform::command(ffmpeg, impact);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start ffmpeg: {e}")))?;
    control.attach(child.id().unwrap_or(0));

    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Some(out) = child.stdout.take() {
        pump(out, tx.clone(), Line::Out);
    }
    if let Some(err) = child.stderr.take() {
        pump(err, tx.clone(), Line::Err);
    }
    drop(tx);

    let mut parser = ProgressParser::new();
    let mut tail: VecDeque<String> = VecDeque::with_capacity(40);

    let status = loop {
        tokio::select! {
            line = rx.recv() => match line {
                Some(Line::Out(l)) => {
                    if let Some(tick) = parser.feed(&l) {
                        on_tick(tick);
                    }
                }
                Some(Line::Err(l)) => {
                    on_log(&l);
                    if tail.len() == 40 {
                        tail.pop_front();
                    }
                    tail.push_back(l);
                }
                // Both pipes closed: the process is finishing.
                None => break child.wait().await,
            },
            _ = control.cancelled() => {
                let _ = child.kill().await;
                control.detach();
                return Err(AppError::Cancelled);
            }
        }
    };
    control.detach();

    let status = status?;
    if control.is_cancelled() {
        return Err(AppError::Cancelled);
    }
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Msg(failure_message(&tail, status.code())))
    }
}

/// Output of a short helper process.
pub struct Captured {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Run a process and collect its output. Cancelling drops (and so kills) it.
pub async fn capture(
    program: &Path,
    args: &[String],
    impact: Option<SystemImpact>,
    control: Option<&JobControl>,
) -> Result<Captured> {
    let mut cmd = platform::command(program, impact);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start {}: {e}", program.display())))?;
    if let Some(pid) = child.id() {
        platform::adopt(pid);
    }
    let output = match control {
        Some(c) => {
            tokio::select! {
                out = child.wait_with_output() => out?,
                _ = c.cancelled() => return Err(AppError::Cancelled),
            }
        }
        None => child.wait_with_output().await?,
    };
    Ok(Captured {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Last non-empty line of a process's stderr, for error messages.
pub fn last_line(text: &str) -> String {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_message_keeps_the_useful_tail() {
        let mut tail = VecDeque::new();
        for l in ["Press [q] to stop", "frame=  10 fps=0", "[libx264] bad thing", "Error opening output", "", "Conversion failed!"] {
            tail.push_back(l.to_string());
        }
        assert_eq!(
            failure_message(&tail, Some(1)),
            "[libx264] bad thing\nError opening output\nConversion failed!"
        );
        assert_eq!(failure_message(&VecDeque::new(), Some(-22)), "ffmpeg exited with code -22.");
    }

    #[test]
    fn control_remembers_cancel() {
        let c = JobControl::new();
        assert!(!c.is_cancelled());
        c.cancel();
        assert!(c.is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_resolves_even_if_cancel_came_first() {
        let c = JobControl::new();
        c.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), c.cancelled())
            .await
            .expect("cancelled() must not hang");
    }
}
