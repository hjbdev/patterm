//! Windows host ownership of PTY descendants, and how arguments reach them.
//!
//! The Linux counterpart is `stdio_shutdown.rs`. Windows has no subreaper and
//! no signals, so the host joins a kill-on-close job object instead: every
//! descendant, detached or not, ends when the host does, however it ends.
#![cfg(windows)]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

static NEXT_HOST: AtomicU64 = AtomicU64::new(1);

/// Variable that turns `arg_echo_child` from a no-op into the recorder.
const ARG_ECHO_OUT: &str = "PATTERM_ARG_ECHO_OUT";

struct Host {
    child: Child,
    directory: PathBuf,
}

impl Host {
    fn start() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "patterm-job-test-{}-{}",
            std::process::id(),
            NEXT_HOST.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&directory).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_patterm-terminal-core"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self { child, directory }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        writeln!(
            self.child.stdin.as_mut().unwrap(),
            "{}",
            json!({ "id": 1, "method": method, "params": params })
        )
        .unwrap();
        let output = self.child.stdout.as_mut().unwrap();
        loop {
            let mut length = [0_u8; 4];
            output.read_exact(&mut length).unwrap();
            let mut frame = vec![0_u8; u32::from_le_bytes(length) as usize];
            output.read_exact(&mut frame).unwrap();
            if frame[0] == 1 {
                let response: Value = serde_json::from_slice(&frame[1..]).unwrap();
                assert!(response.get("error").is_none(), "{response}");
                return response["result"].clone();
            }
        }
    }

    fn wait_for_exit(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "host stopped within its deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Waits for the PTY child to finish and returns its exit code.
    fn wait_for_process_exit(&mut self, process_id: &Value) -> i64 {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let status = self.request(
                "terminal.process.status",
                json!({ "process_id": process_id }),
            );
            if status["status"] == "exited" {
                return status["exit_code"].as_i64().expect("exit code");
            }
            assert!(Instant::now() < deadline, "PTY child exited");
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

/// A process the test watches by PID. Holding the handle keeps the PID from
/// being reused, so "not running" can only mean this process ended.
struct Watched {
    handle: HANDLE,
    pid: u32,
}

impl Watched {
    fn open(pid: u32) -> Self {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        assert!(!handle.is_null(), "open process {pid}");
        Self { handle, pid }
    }

    /// Reads the PID a PowerShell child wrote to `path`.
    fn from_file(path: &Path) -> Self {
        let deadline = Instant::now() + Duration::from_secs(20);
        let pid = loop {
            if let Ok(text) = fs::read_to_string(path) {
                if let Ok(pid) = text.trim().trim_start_matches('\u{feff}').parse::<u32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "test child wrote its PID");
            thread::sleep(Duration::from_millis(20));
        };
        Self::open(pid)
    }

    fn running(&self) -> bool {
        let mut code = 0;
        unsafe { GetExitCodeProcess(self.handle, &mut code) != 0 && code == STILL_ACTIVE as u32 }
    }

    fn assert_gone_soon(&self, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.running() {
            assert!(
                Instant::now() < deadline,
                "{what} (pid {}) was ended with the host",
                self.pid
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        // Keep a failed assertion from leaving its deliberately long-lived child.
        unsafe {
            TerminateProcess(self.handle, 1);
            CloseHandle(self.handle);
        }
    }
}

fn powershell_quote(text: &Path) -> String {
    format!("'{}'", text.display().to_string().replace('\'', "''"))
}

/// PTY child that starts a grandchild outside its pseudoconsole (Start-Process
/// gives it a console of its own) and records the grandchild's PID. With
/// `linger` the child stays alive afterwards; without it the child exits and
/// the grandchild is orphaned.
fn spawn_with_detached_grandchild(host: &mut Host, pid_file: &Path, linger: bool) -> Value {
    let script = format!(
        "$p = Start-Process -PassThru -WindowStyle Hidden ping.exe -ArgumentList '-n','120','127.0.0.1'; \
         Set-Content -Encoding ascii -Path {} -Value $p.Id; {}",
        powershell_quote(pid_file),
        if linger { "Start-Sleep 120" } else { "exit 0" },
    );
    host.request(
        "terminal.process.spawn",
        json!({
            "command": "powershell.exe",
            "args": ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        }),
    )["process_id"]
        .clone()
}

fn unrelated_process() -> Watched {
    let child = Command::new("ping.exe")
        .args(["-n", "120", "127.0.0.1"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    // The Child handle closes when dropped; Watched keeps its own.
    Watched::open(child.id())
}

#[test]
fn explicit_shutdown_ends_orphaned_detached_descendants() {
    let mut host = Host::start();
    let pid_file = host.directory.join("grandchild.pid");
    let parent = spawn_with_detached_grandchild(&mut host, &pid_file, false);
    let grandchild = Watched::from_file(&pid_file);
    assert!(grandchild.running(), "the detached grandchild started");
    host.wait_for_process_exit(&parent);
    assert!(
        grandchild.running(),
        "the grandchild outlives its exited PTY parent until the host ends"
    );

    // An unrelated process belongs to this test, outside the host's job.
    let unrelated = unrelated_process();
    let result = host.request("terminal.host.shutdown", json!({}));
    assert_eq!(result["ok"], true);
    host.wait_for_exit();
    grandchild.assert_gone_soon("detached grandchild");
    assert!(
        unrelated.running(),
        "shutdown did not end unrelated pid {}",
        unrelated.pid
    );
}

#[test]
fn stdin_eof_ends_detached_descendants_of_a_live_child() {
    let mut host = Host::start();
    let pid_file = host.directory.join("grandchild.pid");
    spawn_with_detached_grandchild(&mut host, &pid_file, true);
    let grandchild = Watched::from_file(&pid_file);
    assert!(grandchild.running());
    drop(host.child.stdin.take());
    host.wait_for_exit();
    grandchild.assert_gone_soon("detached grandchild");
}

#[test]
fn killing_the_host_ends_its_descendants() {
    let mut host = Host::start();
    let pid_file = host.directory.join("grandchild.pid");
    spawn_with_detached_grandchild(&mut host, &pid_file, true);
    let grandchild = Watched::from_file(&pid_file);
    assert!(grandchild.running());
    let unrelated = unrelated_process();
    // TerminateProcess gives the host no chance to clean up after itself; only
    // the job object can end the grandchild now.
    host.child.kill().unwrap();
    host.wait_for_exit();
    grandchild.assert_gone_soon("detached grandchild");
    assert!(
        unrelated.running(),
        "unrelated pid {} survives",
        unrelated.pid
    );
}

/// Control for the tests above: with no job object around it, a grandchild
/// started the same way does outlive its terminated parent. This is what shows
/// those tests can fail, rather than passing because Windows tidies up anyway.
#[test]
fn control_detached_grandchild_outlives_an_unowned_parent() {
    let directory = std::env::temp_dir().join(format!(
        "patterm-job-control-{}-{}",
        std::process::id(),
        NEXT_HOST.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&directory).unwrap();
    let pid_file = directory.join("grandchild.pid");
    let mut parent = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!(
            "$p = Start-Process -PassThru -WindowStyle Hidden ping.exe -ArgumentList '-n','120','127.0.0.1'; \
             Set-Content -Encoding ascii -Path {} -Value $p.Id; Start-Sleep 120",
            powershell_quote(&pid_file),
        ))
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let grandchild = Watched::from_file(&pid_file);
    parent.kill().unwrap();
    parent.wait().unwrap();
    thread::sleep(Duration::from_millis(500));
    let survived = grandchild.running();
    drop(grandchild);
    let _ = fs::remove_dir_all(&directory);
    assert!(survived, "without a job the grandchild is left running");
}

/// Child program for the argument tests: this test executable, started with
/// `--ignored --exact`, records the arguments after `--` the way Rust's runtime
/// (the same parser as the C runtime) split them.
#[test]
#[ignore = "child program for the argument tests"]
fn arg_echo_child() {
    let Some(out) = std::env::var_os(ARG_ECHO_OUT) else {
        return;
    };
    let args = std::env::args()
        .skip_while(|arg| arg != "--")
        .skip(1)
        .collect::<Vec<_>>();
    fs::write(out, serde_json::to_vec(&args).unwrap()).unwrap();
}

/// Runs `program` as `arg_echo_child` with `args` after the `--` and returns
/// what it received.
fn received_args(program: &Path, args: &[&str]) -> Vec<String> {
    let mut host = Host::start();
    let out = host.directory.join("args.json");
    let mut command_args = vec![
        "arg_echo_child",
        "--ignored",
        "--exact",
        "--nocapture",
        "--",
    ];
    command_args.extend_from_slice(args);
    let process = host.request(
        "terminal.process.spawn",
        json!({
            "command": program,
            "args": command_args,
            "env": { ARG_ECHO_OUT: out },
        }),
    )["process_id"]
        .clone();
    assert_eq!(host.wait_for_process_exit(&process), 0, "the child ran");
    serde_json::from_slice(&fs::read(&out).expect("the child recorded its arguments")).unwrap()
}

const AWKWARD_ARGS: &[&str] = &[
    "plain",
    "two words",
    "say \"hi\"",
    "trailing\\",
    "dir with space\\",
    "back\\\\slash \\\"quoted\\\"",
    "",
    "tab\there",
    "ends with quote\"",
    "100%PATH% ^&|<>",
    "unicode \u{4e2d}\u{e9}",
];

#[test]
fn arguments_reach_the_child_exactly() {
    let program = std::env::current_exe().unwrap();
    let received = received_args(&program, AWKWARD_ARGS);
    assert_eq!(received, AWKWARD_ARGS);
}

#[test]
fn program_path_with_spaces_is_not_split() {
    let directory = std::env::temp_dir().join(format!(
        "patterm path test {}-{}",
        std::process::id(),
        NEXT_HOST.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&directory).unwrap();
    let program = directory.join("arg echo child.exe");
    fs::copy(std::env::current_exe().unwrap(), &program).unwrap();
    let received = received_args(&program, &["two words", "x"]);
    let _ = fs::remove_dir_all(&directory);
    assert_eq!(received, ["two words", "x"]);
}

#[test]
fn installed_program_files_path_runs() {
    // `C:\Program Files\PowerShell\7\pwsh.exe` is the common real-world case
    // of a spaced path; skip quietly where PowerShell 7 is not installed.
    let Some(program) = std::env::var_os("ProgramFiles")
        .map(|root| PathBuf::from(root).join(r"PowerShell\7\pwsh.exe"))
        .filter(|path| path.exists())
    else {
        return;
    };
    let mut host = Host::start();
    let out = host.directory.join("pwsh.txt");
    let process = host.request(
        "terminal.process.spawn",
        json!({
            "command": program,
            "args": [
                "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                format!("Set-Content -Path {} -Value 'ran in pwsh'; exit 5", powershell_quote(&out)),
            ],
        }),
    )["process_id"]
        .clone();
    assert_eq!(host.wait_for_process_exit(&process), 5);
    assert!(fs::read_to_string(&out).unwrap().contains("ran in pwsh"));
}
