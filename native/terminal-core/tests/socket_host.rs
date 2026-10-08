#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static NEXT_HOST: AtomicU64 = AtomicU64::new(1);

struct Host {
    child: Child,
    directory: PathBuf,
    socket: PathBuf,
}

impl Host {
    fn start() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "patterm-host-test-{}-{}",
            std::process::id(),
            NEXT_HOST.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = directory.join("control.sock");
        let child = Self::command(&socket).spawn().unwrap();
        let host = Self {
            child,
            directory,
            socket,
        };
        let deadline = Instant::now() + Duration::from_secs(3);
        while !host.socket.exists() {
            assert!(Instant::now() < deadline, "host created its socket");
            thread::sleep(Duration::from_millis(5));
        }
        host
    }

    fn command(socket: &PathBuf) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_patterm-terminal-core"));
        command.args(["--socket", socket.to_str().unwrap(), "--host-id", "test"]);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        command
    }

    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
    }

    fn wait_for_exit(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.child.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "host shut down within its deadline"
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

fn request(stream: &mut UnixStream, method: &str, params: Value) -> Value {
    writeln!(
        stream,
        "{}",
        json!({ "id": 1, "method": method, "params": params })
    )
    .unwrap();
    loop {
        let mut length = [0_u8; 4];
        stream.read_exact(&mut length).unwrap();
        let length = u32::from_le_bytes(length) as usize;
        assert!((1..=16 * 1024 * 1024).contains(&length));
        let mut frame = vec![0_u8; length];
        stream.read_exact(&mut frame).unwrap();
        if frame[0] == 1 {
            let response: Value = serde_json::from_slice(&frame[1..]).unwrap();
            assert!(response.get("error").is_none(), "{response}");
            return response["result"].clone();
        }
    }
}

#[test]
fn reconnect_preserves_sleep_output_and_exit_status() {
    let mut host = Host::start();
    let mut controller = host.connect();
    let handshake = request(&mut controller, "terminal.host.handshake", json!({}));
    assert_eq!(handshake["protocol_version"], 1);
    assert_eq!(handshake["host_id"], "test");
    let id = request(
        &mut controller,
        "terminal.process.spawn",
        json!({
            "command": "/bin/sh",
            "args": ["-c", "printf 'before\\n'; sleep 0.2; printf 'after\\n'; exit 7"],
            "name": "surviving command",
        }),
    )["process_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(id.contains(handshake["incarnation"].as_str().unwrap()));
    drop(controller);
    thread::sleep(Duration::from_millis(350));

    let mut controller = host.connect();
    assert_eq!(
        request(&mut controller, "terminal.host.handshake", json!({})),
        handshake
    );
    let inventory = request(&mut controller, "terminal.process.list", json!({}));
    assert_eq!(inventory["processes"].as_array().unwrap().len(), 1);
    assert_eq!(inventory["processes"][0]["process_id"], id);
    assert_eq!(inventory["processes"][0]["status"], "exited");
    assert_eq!(inventory["processes"][0]["exit_code"], 7);
    assert_eq!(inventory["processes"][0]["activity"], "idle");
    let output = request(
        &mut controller,
        "terminal.process.output",
        json!({ "process_id": id }),
    );
    assert!(output["screen"].as_str().unwrap().contains("before\nafter"));
    request(
        &mut controller,
        "terminal.process.close",
        json!({ "process_id": id }),
    );
    request(&mut controller, "terminal.host.shutdown", json!({}));
    host.wait_for_exit();
    assert!(!host.socket.exists());
}

#[test]
fn rejects_competing_hosts_and_controllers_without_losing_ownership() {
    let mut host = Host::start();
    let mut controller = host.connect();
    request(&mut controller, "terminal.host.handshake", json!({}));
    let mut second_controller = host.connect();
    let mut byte = [0_u8];
    assert_eq!(second_controller.read(&mut byte).unwrap(), 0);
    assert_eq!(
        request(&mut controller, "terminal.ping", json!({}))["ok"],
        true
    );
    assert!(!Host::command(&host.socket).status().unwrap().success());
    assert_eq!(
        request(&mut controller, "terminal.ping", json!({}))["ok"],
        true
    );

    // Closing a live terminal after reconnect exercises ownership, not only
    // retained scrollback from processes that have already exited.
    let id = request(&mut controller, "terminal.process.spawn", json!({
        "command": "/bin/sh", "args": ["-c", "read input; printf 'received:%s' \"$input\"; sleep 30"],
    }))["process_id"].clone();
    drop(controller);
    thread::sleep(Duration::from_millis(25));
    let mut controller = host.connect();
    request(
        &mut controller,
        "terminal.process.input",
        json!({
            "process_id": id, "text": "hello\n",
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let output = request(
            &mut controller,
            "terminal.process.output",
            json!({ "process_id": id }),
        );
        if output["screen"]
            .as_str()
            .unwrap()
            .contains("received:hello")
        {
            break;
        }
        assert!(Instant::now() < deadline);
    }
    request(&mut controller, "terminal.host.shutdown", json!({}));
    host.wait_for_exit();
}

#[test]
fn crashed_host_reclaims_stale_socket_with_a_new_incarnation() {
    let mut host = Host::start();
    let mut controller = host.connect();
    let old = request(&mut controller, "terminal.host.handshake", json!({}));
    host.child.kill().unwrap();
    host.child.wait().unwrap();
    drop(controller);
    assert!(host.socket.exists(), "crash leaves a stale socket");
    host.child = Host::command(&host.socket).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut controller = loop {
        match UnixStream::connect(&host.socket) {
            Ok(stream) => break stream,
            Err(_) => {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(5));
            }
        }
    };
    controller
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let new = request(&mut controller, "terminal.host.handshake", json!({}));
    assert_ne!(new["incarnation"], old["incarnation"]);
    request(&mut controller, "terminal.host.shutdown", json!({}));
    host.wait_for_exit();
}
