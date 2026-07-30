use std::process::{Child, Command};
use std::time::{Duration, Instant};

const PROCESS_TREE_WAIT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
pub(crate) enum ChildWindow {
    Hidden,
    Visible,
}

#[derive(Clone, Copy)]
pub(crate) enum JobLifetime {
    /// Probe와 수집처럼 앱 밖에 남아서는 안 되는 tree입니다.
    KillOnDrop,
    /// 사용자 설치·OAuth처럼 앱 crash 뒤에도 provider 작업을 강제로 죽이지 않는 tree입니다.
    DetachOnDrop,
}

#[cfg(windows)]
pub(crate) struct ProcessTree {
    handle: Option<windows::Win32::Foundation::HANDLE>,
}

#[cfg(not(windows))]
pub(crate) struct ProcessTree;

#[cfg(windows)]
impl ProcessTree {
    fn new(lifetime: JobLifetime) -> std::io::Result<Self> {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        use windows::core::PCWSTR;

        // SAFETY: no security attributes or shared name are supplied. This guard owns the handle.
        let handle =
            unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(std::io::Error::other)?;
        if matches!(lifetime, JobLifetime::KillOnDrop) {
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `limits` has the structure and byte length required by this information
            // class, and `handle` remains live for the call.
            if let Err(error) = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } {
                // SAFETY: this branch still owns the valid handle.
                let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
                return Err(std::io::Error::other(error));
            }
        }
        Ok(Self {
            handle: Some(handle),
        })
    }

    fn handle(&self) -> windows::Win32::Foundation::HANDLE {
        self.handle.expect("live process tree has a job handle")
    }

    fn active_processes_zero(&self, deadline: Instant) -> bool {
        use windows::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject,
        };

        let Some(handle) = self.handle else {
            return true;
        };
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: `accounting` has the exact structure and byte length required by the
            // accounting information class, and `handle` remains open.
            let queried = unsafe {
                QueryInformationJobObject(
                    Some(handle),
                    JobObjectBasicAccountingInformation,
                    std::ptr::addr_of_mut!(accounting).cast(),
                    std::mem::size_of_val(&accounting) as u32,
                    None,
                )
            };
            if queried.is_err() {
                return false;
            }
            if accounting.ActiveProcesses == 0 {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(crate) fn terminate_and_wait(&self, child: &mut Child) -> bool {
        use windows::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: this guard owns a live job handle. Termination is intentionally scoped to only
        // the processes assigned to this operation's job.
        let terminated = unsafe { TerminateJobObject(self.handle(), 1) }.is_ok();
        let empty = terminated && self.active_processes_zero(Instant::now() + PROCESS_TREE_WAIT);
        let _ = child.kill();
        let waited = child.wait().is_ok();
        empty && waited
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            // SAFETY: this guard owns the handle. Kill-on-close, when configured, is the fail-safe.
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
        }
    }
}

#[cfg(not(windows))]
impl ProcessTree {
    pub(crate) fn terminate_and_wait(&self, child: &mut Child) -> bool {
        let _ = child.kill();
        child.wait().is_ok()
    }
}

#[cfg(windows)]
pub(crate) fn spawn_in_process_tree(
    mut command: Command,
    window: ChildWindow,
    lifetime: JobLifetime,
) -> std::io::Result<(Child, ProcessTree)> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::AssignProcessToJobObject;

    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let process_tree = ProcessTree::new(lifetime)?;
    let window_flag = match window {
        ChildWindow::Hidden => CREATE_NO_WINDOW,
        ChildWindow::Visible => CREATE_NEW_CONSOLE,
    };
    command.creation_flags(CREATE_SUSPENDED | window_flag);
    let mut child = command.spawn()?;
    // SAFETY: the process and job handles are valid. CREATE_SUSPENDED prevents target code from
    // creating a descendant before assignment completes.
    let assigned =
        unsafe { AssignProcessToJobObject(process_tree.handle(), HANDLE(child.as_raw_handle())) };
    if let Err(error) = assigned {
        let _ = process_tree.terminate_and_wait(&mut child);
        return Err(std::io::Error::other(error));
    }
    if let Err(error) = resume_only_suspended_thread(child.id()) {
        let _ = process_tree.terminate_and_wait(&mut child);
        return Err(error);
    }
    Ok((child, process_tree))
}

#[cfg(windows)]
fn resume_only_suspended_thread(process_id: u32) -> std::io::Result<()> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    // SAFETY: the generated Result rejects an invalid snapshot handle.
    let snapshot =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(std::io::Error::other)?;
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` points to writable storage of the required size.
    let mut current = unsafe { Thread32First(snapshot, std::ptr::addr_of_mut!(entry)) };
    let mut thread_ids = Vec::new();
    while current.is_ok() {
        if entry.th32OwnerProcessID == process_id {
            thread_ids.push(entry.th32ThreadID);
        }
        // SAFETY: the snapshot is still open and `entry` remains valid.
        current = unsafe { Thread32Next(snapshot, std::ptr::addr_of_mut!(entry)) };
    }
    // SAFETY: this function owns the snapshot handle.
    let _ = unsafe { CloseHandle(snapshot) };

    // CREATE_SUSPENDED creates one primary thread and prevents it from starting target code.
    // Anything else is ambiguous, so fail before resuming any thread.
    let [thread_id] = thread_ids.as_slice() else {
        return Err(std::io::Error::other(format!(
            "suspended process exposed {} threads instead of one",
            thread_ids.len()
        )));
    };
    // SAFETY: the sole thread ID came from the live process snapshot.
    let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, *thread_id) }
        .map_err(std::io::Error::other)?;
    // SAFETY: OpenThread granted suspend/resume access for this live handle.
    let previous_count = unsafe { ResumeThread(thread_handle) };
    // SAFETY: this scope owns the thread handle.
    let _ = unsafe { CloseHandle(thread_handle) };
    if previous_count == u32::MAX {
        Err(std::io::Error::last_os_error())
    } else if previous_count != 1 {
        Err(std::io::Error::other(
            "suspended process primary thread had an unexpected suspend count",
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn spawn_in_process_tree(
    mut command: Command,
    _window: ChildWindow,
    _lifetime: JobLifetime,
) -> std::io::Result<(Child, ProcessTree)> {
    command.spawn().map(|child| (child, ProcessTree))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::thread;

    #[test]
    fn nested_job_assignment_is_supported_or_fails_before_target_code_runs() {
        const CHILD_SCENARIO: &str = "AI_USAGE_MONITOR_NESTED_JOB_TEST";
        const TEST_NAME: &str = "codex_cli::process_tree::tests::nested_job_assignment_is_supported_or_fails_before_target_code_runs";

        if std::env::var_os(CHILD_SCENARIO).is_some() {
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoLogo", "-NoProfile", "-Command", "exit 0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let (mut child, process_tree) =
                spawn_in_process_tree(command, ChildWindow::Hidden, JobLifetime::KillOnDrop)
                    .expect("inner job is assigned before its target runs");
            while child.try_wait().expect("inner child status").is_none() {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(process_tree.terminate_and_wait(&mut child));
            return;
        }

        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD_SCENARIO, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, outer_job) =
            spawn_in_process_tree(command, ChildWindow::Hidden, JobLifetime::DetachOnDrop)
                .expect("outer job child starts");
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            match child.try_wait().expect("outer child status") {
                Some(status) => break status,
                None if Instant::now() >= deadline => {
                    let _ = outer_job.terminate_and_wait(&mut child);
                    panic!("nested job child timed out");
                }
                None => thread::sleep(Duration::from_millis(10)),
            }
        };
        drop(outer_job);
        assert!(status.success(), "nested job child failed");
    }

    #[test]
    fn detach_on_drop_keeps_an_interactive_child_running() {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, process_tree) =
            spawn_in_process_tree(command, ChildWindow::Hidden, JobLifetime::DetachOnDrop)
                .expect("detached job child starts");

        drop(process_tree);
        thread::sleep(Duration::from_millis(100));
        assert!(
            child.try_wait().expect("child status").is_none(),
            "closing a detached interactive job must not cancel its child"
        );
        let _ = child.kill();
        child.wait().expect("fixture child is reaped");
    }
}
