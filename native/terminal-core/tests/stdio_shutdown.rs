//! Linux relies on a subreaper and pidfds; `windows_job.rs` covers the same
//! shutdown guarantees on Windows through its job object.
#![cfg(target_os = "linux")]

use std::fs;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static NEXT_HOST: AtomicU64 = AtomicU64::new(1);

struct Host {
    child: Child,
    directory: PathBuf,
}

impl Host {
    fn start() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "patterm-stdio-test-{}-{}",
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
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(
                Instant::now() < deadline,
                "host stopped within its deadline"
            );
            thread::sleep(Duration::from_millis(5));
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

struct ManagedChild {
    pid: u32,
    descriptor: OwnedFd,
}

impl ManagedChild {
    fn from_file(path: &Path) -> Self {
        let deadline = Instant::now() + Duration::from_secs(3);
        let pid = loop {
            if let Ok(text) = fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "test child wrote its PID");
            thread::sleep(Duration::from_millis(5));
        };
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        assert!(descriptor >= 0);
        Self {
            pid,
            descriptor: unsafe { OwnedFd::from_raw_fd(descriptor as i32) },
        }
    }

    fn assert_reaped(&self) {
        assert!(
            !Path::new(&format!("/proc/{}", self.pid)).exists(),
            "managed descendant was stopped and reaped"
        );
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        // Keep a failed assertion from leaving its deliberately stubborn child.
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.descriptor.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
        }
    }
}

#[test]
fn explicit_shutdown_stops_stubborn_and_fully_daemonised_commands() {
    let mut host = Host::start();
    let direct_file = host.directory.join("direct.pid");
    host.request("terminal.process.spawn", json!({
        "command": "/bin/sh", "args": ["-c", "trap '' HUP TERM; echo $$ > \"$1\"; exec sleep 30", "child", direct_file],
    }));
    let direct = ManagedChild::from_file(&direct_file);
    let daemon_file = host.directory.join("daemon.pid");
    let daemon_parent = host.request("terminal.process.spawn", json!({
        "command": "/bin/sh",
        "args": ["-c", "trap '' HUP TERM; setsid /bin/sh -c 'trap \"\" HUP TERM; echo $$ > \"$1\"; exec sleep 30' child \"$1\" </dev/null >/dev/null 2>&1 & exit 0", "parent", daemon_file],
    }))["process_id"].clone();
    let daemon = ManagedChild::from_file(&daemon_file);
    let deadline = Instant::now() + Duration::from_secs(3);
    while host.request(
        "terminal.process.status",
        json!({ "process_id": daemon_parent }),
    )["status"]
        != "exited"
    {
        assert!(
            Instant::now() < deadline,
            "the daemon's PTY parent exited before Quit"
        );
    }
    let stat = fs::read_to_string(format!("/proc/{}/stat", daemon.pid)).unwrap();
    let fields = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    assert_eq!(
        fields[1].parse::<u32>().unwrap(),
        host.child.id(),
        "the host adopted its daemonised descendant"
    );
    assert_eq!(
        fields[3].parse::<u32>().unwrap(),
        daemon.pid,
        "the daemon owns an independent session"
    );

    // An unrelated command belongs to this test process, outside the host tree.
    let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
    let unrelated_pid = unrelated.id();
    let result = host.request("terminal.host.shutdown", json!({}));
    let unrelated_alive = unrelated.try_wait().unwrap().is_none();
    let _ = unrelated.kill();
    let _ = unrelated.wait();
    assert_eq!(result["ok"], true);
    host.wait_for_exit();
    direct.assert_reaped();
    daemon.assert_reaped();
    assert!(
        unrelated_alive,
        "shutdown did not signal unrelated PID {unrelated_pid}"
    );
}

#[test]
fn stdin_eof_also_cleans_up_stubborn_commands() {
    let mut host = Host::start();
    let filename = host.directory.join("child.pid");
    host.request("terminal.process.spawn", json!({
        "command": "/bin/sh", "args": ["-c", "trap '' HUP TERM; echo $$ > \"$1\"; exec sleep 30", "child", filename],
    }));
    let child = ManagedChild::from_file(&filename);
    drop(host.child.stdin.take());
    host.wait_for_exit();
    child.assert_reaped();
}

#[test]
fn reaps_adopted_children_without_consuming_pty_exit_status() {
    let mut host = Host::start();
    let filename = host.directory.join("adopted.pid");
    let parent = host.request("terminal.process.spawn", json!({
        "command": "/bin/sh",
        "args": ["-c", "trap '' HUP; setsid /bin/sh -c 'echo $$ > \"$1\"; sleep 0.1; exit 7' child \"$1\" </dev/null >/dev/null 2>&1 & exit 13", "parent", filename],
    }))["process_id"].clone();
    let adopted = ManagedChild::from_file(&filename);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let stat = fs::read_to_string(format!("/proc/{}/stat", adopted.pid)).unwrap();
        if stat.rsplit_once(')').unwrap().1.split_whitespace().next() == Some("Z") {
            break;
        }
        assert!(Instant::now() < deadline, "adopted child exited");
        thread::sleep(Duration::from_millis(5));
    }
    let next = host.request(
        "terminal.process.spawn",
        json!({
            "command": "/bin/sh", "args": ["-c", "exit 9"],
        }),
    )["process_id"]
        .clone();
    adopted.assert_reaped();
    for (id, code) in [(parent, 13), (next, 9)] {
        loop {
            let status = host.request("terminal.process.status", json!({ "process_id": id }));
            if status["status"] == "exited" {
                assert_eq!(status["exit_code"], code);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Alacritty retained its child's exit status"
            );
        }
    }
    host.request("terminal.host.shutdown", json!({}));
    host.wait_for_exit();
}
