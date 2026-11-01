/// Process existence is a tri-state fact, independent of endpoint identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProcessState {
    Alive,
    Dead,
    Unknown,
}

/// Signal zero preserves EPERM as unknown; only ESRCH proves absence.
#[cfg(unix)]
pub(super) fn process_state(pid: u32) -> ProcessState {
    if pid == 0 || pid > i32::MAX as u32 {
        return ProcessState::Unknown;
    }
    // SAFETY: the positive PID fits pid_t; signal zero sends no signal.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return ProcessState::Alive;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => ProcessState::Dead,
        _ => ProcessState::Unknown,
    }
}

/// A waitable Windows process handle distinguishes exited from protected PIDs.
#[cfg(windows)]
pub(super) fn process_state(pid: u32) -> ProcessState {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    if pid == 0 {
        return ProcessState::Unknown;
    }
    // SAFETY: numeric PID only; every opened handle is closed after the wait.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return windows_open_failure(unsafe { GetLastError() }, ERROR_INVALID_PARAMETER);
    }
    let result = unsafe { WaitForSingleObject(handle, 0) };
    unsafe {
        CloseHandle(handle);
    }
    match result {
        WAIT_OBJECT_0 => ProcessState::Dead,
        WAIT_TIMEOUT => ProcessState::Alive,
        _ => ProcessState::Unknown,
    }
}

#[cfg(any(windows, test))]
fn windows_open_failure(error: u32, missing_pid: u32) -> ProcessState {
    if error == missing_pid {
        ProcessState::Dead
    } else {
        ProcessState::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_errors_only_prove_dead_for_missing_process() {
        assert_eq!(windows_open_failure(87, 87), ProcessState::Dead);
        assert_eq!(windows_open_failure(5, 87), ProcessState::Unknown);
        assert_eq!(windows_open_failure(6, 87), ProcessState::Unknown);
    }
    #[test]
    fn native_liveness_reports_this_process_and_invalid_pid() {
        assert_eq!(process_state(std::process::id()), ProcessState::Alive);
        assert_eq!(process_state(0), ProcessState::Unknown);
    }
    #[cfg(windows)]
    #[test]
    fn native_windows_liveness_reports_exited_child_without_unix_kill() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(process_state(pid), ProcessState::Dead);
    }
}
