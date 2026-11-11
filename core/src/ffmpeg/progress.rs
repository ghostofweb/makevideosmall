//! Parser for ffmpeg's `-progress pipe:1` output.
//!
//! ffmpeg writes blocks of `key=value` lines; each block ends with a
//! `progress=continue` or `progress=end` line.

/// One progress report from ffmpeg.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tick {
    /// Seconds of output written so far.
    pub out_time: f64,
    pub fps: f64,
    /// Encoding speed relative to real time.
    pub speed: f64,
    /// Bytes written so far.
    pub total_size: f64,
    pub frame: f64,
    pub done: bool,
}

#[derive(Default)]
pub struct ProgressParser {
    cur: Tick,
}

/// "00:01:02.500000" → 62.5
fn clock(s: &str) -> Option<f64> {
    let mut parts = s.trim().split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one line. Returns a `Tick` when a block is complete.
    pub fn feed(&mut self, line: &str) -> Option<Tick> {
        let (key, value) = line.trim().split_once('=')?;
        let value = value.trim();
        match key.trim() {
            "frame" => self.cur.frame = value.parse().unwrap_or(self.cur.frame),
            "fps" => self.cur.fps = value.parse().unwrap_or(self.cur.fps),
            "total_size" => self.cur.total_size = value.parse().unwrap_or(self.cur.total_size),
            // Despite the name, older ffmpeg builds report microseconds here too.
            "out_time_us" | "out_time_ms" => {
                if let Ok(us) = value.parse::<f64>() {
                    if us >= 0.0 {
                        self.cur.out_time = us / 1_000_000.0;
                    }
                }
            }
            "out_time" => {
                if let Some(t) = clock(value) {
                    if t >= 0.0 {
                        self.cur.out_time = t;
                    }
                }
            }
            "speed" => {
                if let Ok(x) = value.trim_end_matches('x').trim().parse::<f64>() {
                    self.cur.speed = x;
                }
            }
            "progress" => {
                self.cur.done = value == "end";
                return Some(self.cur);
            }
            _ => {}
        }
        None
    }
}

/// Overall percentage for a job that may have several passes.
pub fn percent(out_time: f64, duration: f64, pass: usize, passes: usize) -> f64 {
    let passes = passes.max(1) as f64;
    let within = if duration > 0.0 {
        (out_time / duration).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((pass as f64 + within) / passes * 100.0).clamp(0.0, 100.0)
}

/// Seconds left, or `None` while the speed is still unknown.
pub fn eta(out_time: f64, duration: f64, speed: f64, pass: usize, passes: usize) -> Option<f64> {
    if speed <= 0.0 || duration <= 0.0 {
        return None;
    }
    let remaining_passes = passes.max(1).saturating_sub(pass + 1) as f64;
    let left = (duration - out_time).max(0.0) + remaining_passes * duration;
    Some(left / speed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blocks() {
        let mut p = ProgressParser::new();
        let block = "frame=120\nfps=59.9\nstream_0_0_q=28.0\nbitrate= 512.3kbits/s\ntotal_size=320000\nout_time_us=5000000\nout_time_ms=5000000\nout_time=00:00:05.000000\ndup_frames=0\nspeed=2.5x\nprogress=continue\n";
        let mut ticks = Vec::new();
        for line in block.lines() {
            if let Some(t) = p.feed(line) {
                ticks.push(t);
            }
        }
        assert_eq!(ticks.len(), 1);
        let t = ticks[0];
        assert_eq!(t.frame, 120.0);
        assert_eq!(t.fps, 59.9);
        assert_eq!(t.total_size, 320000.0);
        assert_eq!(t.out_time, 5.0);
        assert_eq!(t.speed, 2.5);
        assert!(!t.done);

        assert!(p.feed("progress=end").unwrap().done);
    }

    #[test]
    fn tolerates_na_and_garbage() {
        let mut p = ProgressParser::new();
        for line in ["out_time_us=N/A", "speed=N/A", "total_size=N/A", "fps=0.00", "not a pair", ""] {
            assert!(p.feed(line).is_none());
        }
        let t = p.feed("progress=continue").unwrap();
        assert_eq!(t.out_time, 0.0);
        assert_eq!(t.speed, 0.0);
        // A negative clock (seen at the very start) is ignored.
        p.feed("out_time_us=-9223372036854775808");
        assert_eq!(p.feed("progress=continue").unwrap().out_time, 0.0);
    }

    #[test]
    fn falls_back_to_clock_string() {
        let mut p = ProgressParser::new();
        p.feed("out_time=01:02:03.500000");
        assert_eq!(p.feed("progress=continue").unwrap().out_time, 3723.5);
    }

    #[test]
    fn percent_and_eta() {
        assert_eq!(percent(30.0, 60.0, 0, 1), 50.0);
        assert_eq!(percent(30.0, 60.0, 0, 2), 25.0);
        assert_eq!(percent(30.0, 60.0, 1, 2), 75.0);
        assert_eq!(percent(90.0, 60.0, 0, 1), 100.0);
        assert_eq!(percent(10.0, 0.0, 0, 1), 0.0);

        assert_eq!(eta(30.0, 60.0, 2.0, 0, 1), Some(15.0));
        // First of two passes: the rest of this pass plus a whole second pass.
        assert_eq!(eta(30.0, 60.0, 2.0, 0, 2), Some(45.0));
        assert_eq!(eta(30.0, 60.0, 0.0, 0, 1), None);
    }
}
