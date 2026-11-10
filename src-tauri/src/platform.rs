//! OS-specific process control: hidden console windows, priority classes,
//! suspend/resume, and a job object that kills child processes if the app dies.

use crate::model::SystemImpact;
use std::io;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;

    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(handle: *mut c_void) -> i32;
        fn NtResumeProcess(handle: *mut c_void) -> i32;
    }

    pub fn creation_flags(impact: Option<SystemImpact>) -> u32 {
        CREATE_NO_WINDOW
            | match impact {
                Some(SystemImpact::Stealth) => IDLE_PRIORITY_CLASS,
                Some(SystemImpact::Balanced) => BELOW_NORMAL_PRIORITY_CLASS,
                Some(SystemImpact::Beast) => ABOVE_NORMAL_PRIORITY_CLASS,
                None => 0,
            }
    }

    fn with_process<T>(
        pid: u32,
        access: u32,
        f: impl FnOnce(HANDLE) -> io::Result<T>,
    ) -> io::Result<T> {
        // SAFETY: OpenProcess returns null on failure, which is checked; the
        // handle is closed before returning.
        unsafe {
            let h = OpenProcess(access, 0, pid);
            if h.is_null() {
                return Err(io::Error::last_os_error());
            }
            let r = f(h);
            CloseHandle(h);
            r
        }
    }

    pub fn suspend(pid: u32) -> io::Result<()> {
        with_process(pid, PROCESS_SUSPEND_RESUME, |h| {
            // SAFETY: `h` is a valid process handle with suspend/resume access.
            let status = unsafe { NtSuspendProcess(h) };
            if status < 0 {
                Err(io::Error::other(format!("NtSuspendProcess failed: {status:#x}")))
            } else {
                Ok(())
            }
        })
    }

    pub fn resume(pid: u32) -> io::Result<()> {
        with_process(pid, PROCESS_SUSPEND_RESUME, |h| {
            // SAFETY: `h` is a valid process handle with suspend/resume access.
            let status = unsafe { NtResumeProcess(h) };
            if status < 0 {
                Err(io::Error::other(format!("NtResumeProcess failed: {status:#x}")))
            } else {
                Ok(())
            }
        })
    }

    /// Handle of the kill-on-close job, stored as an integer so it is `Sync`.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> usize {
        *JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls with valid, zero-initialised arguments.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return 0;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                job as usize
            }
        })
    }

    /// Tie a child process to the app's lifetime: when the app exits (even by
    /// crashing), Windows closes the job handle and kills the child.
    pub fn adopt(pid: u32) {
        let job = job();
        if job == 0 {
            return;
        }
        let _ = with_process(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, |h| {
            // SAFETY: both handles are valid for the duration of the call.
            unsafe { AssignProcessToJobObject(job as HANDLE, h) };
            Ok(())
        });
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn suspend(_pid: u32) -> io::Result<()> {
        Err(io::Error::other("Pausing is only supported on Windows"))
    }
    pub fn resume(_pid: u32) -> io::Result<()> {
        Err(io::Error::other("Pausing is only supported on Windows"))
    }
    pub fn adopt(_pid: u32) {}
}

pub use imp::{adopt, resume, suspend};

/// Build an async command that never flashes a console window and runs at the
/// priority that matches the chosen system impact.
pub fn command(
    program: impl AsRef<std::ffi::OsStr>,
    impact: Option<SystemImpact>,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(imp::creation_flags(impact));
    #[cfg(not(windows))]
    let _ = impact;
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    cmd
}
