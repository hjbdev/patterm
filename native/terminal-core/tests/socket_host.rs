#![cfg(any(unix, windows))]

use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

static NEXT_HOST: AtomicU64 = AtomicU64::new(1);

// A Windows host serves a named pipe; a client opens it like a file.
#[cfg(unix)]
type Stream = UnixStream;
#[cfg(windows)]
type Stream = fs::File;

struct Host {
    child: Child,
    directory: PathBuf,
    socket: PathBuf,
}

impl Host {
    fn start() -> Self {
        let name = format!(
            "patterm-host-test-{}-{}",
            std::process::id(),
            NEXT_HOST.fetch_add(1, Ordering::Relaxed),
        );
        let directory = std::env::temp_dir().join(&name);
        fs::create_dir(&directory).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        #[cfg(unix)]
        let socket = directory.join("control.sock");
        #[cfg(windows)]
        let socket = PathBuf::from(format!(r"\\.\pipe\{name}"));
        let child = Self::command(&socket).spawn().unwrap();
        let host = Self {
            child,
            directory,
            socket,
        };
        // Probing a pipe would connect to it, so Windows waits in connect().
        #[cfg(unix)]
        {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !host.socket.exists() {
                assert!(Instant::now() < deadline, "host created its socket");
                thread::sleep(Duration::from_millis(5));
            }
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

    #[cfg(unix)]
    fn connect(&self) -> Stream {
        let stream = UnixStream::connect(&self.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
    }

    #[cfg(windows)]
    fn connect(&self) -> Stream {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match open_pipe(&self.socket) {
                Ok(stream) => return stream,
                Err(error) => {
                    assert!(Instant::now() < deadline, "host serves its pipe: {error}");
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    // The endpoint is gone once the host has released it.
    fn endpoint_exists(&self) -> bool {
        #[cfg(unix)]
        return self.socket.exists();
        #[cfg(windows)]
        return open_pipe(&self.socket).is_ok();
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

#[cfg(windows)]
fn open_pipe(path: &PathBuf) -> std::io::Result<Stream> {
    fs::OpenOptions::new().read(true).write(true).open(path)
}

// A command that prints `before`, pauses, prints `after`, and exits 7, with how
// long it takes to finish.
fn surviving_command() -> (Value, Duration) {
    #[cfg(unix)]
    return (
        json!({
            "command": "/bin/sh",
            "args": ["-c", "printf 'before\\n'; sleep 0.2; printf 'after\\n'; exit 7"],
        }),
        Duration::from_millis(350),
    );
    #[cfg(windows)]
    return (
        json!({
            "command": "cmd.exe",
            "args": ["/d", "/c", "echo before& ping -n 2 127.0.0.1 >nul& echo after& exit 7"],
        }),
        Duration::from_millis(2500),
    );
}

// A command that reads a line, prints it back, and keeps running, with the
// input that ends a line.
fn reading_command() -> (Value, &'static str) {
    #[cfg(unix)]
    return (
        json!({
            "command": "/bin/sh",
            "args": ["-c", "read input; printf 'received:%s' \"$input\"; sleep 30"],
        }),
        "hello\n",
    );
    #[cfg(windows)]
    return (
        json!({
            "command": "cmd.exe",
            "args": ["/d", "/v:on", "/c", "set /p input=& echo received:!input!& ping -n 30 127.0.0.1 >nul"],
        }),
        "hello\r",
    );
}

fn request(stream: &mut Stream, method: &str, params: Value) -> Value {
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
    let (mut params, duration) = surviving_command();
    params["name"] = json!("surviving command");
    let id = request(&mut controller, "terminal.process.spawn", params)["process_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(id.contains(handshake["incarnation"].as_str().unwrap()));
    drop(controller);
    thread::sleep(duration);

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
    assert!(!host.endpoint_exists());
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
    let (params, line) = reading_command();
    let id = request(&mut controller, "terminal.process.spawn", params)["process_id"].clone();
    drop(controller);
    thread::sleep(Duration::from_millis(25));
    let mut controller = host.connect();
    request(
        &mut controller,
        "terminal.process.input",
        json!({
            "process_id": id, "text": line,
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
    // A pipe vanishes with its server, so only a Unix socket file goes stale.
    #[cfg(unix)]
    assert!(host.socket.exists(), "crash leaves a stale socket");
    host.child = Host::command(&host.socket).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    #[cfg(unix)]
    let mut controller = loop {
        match UnixStream::connect(&host.socket) {
            Ok(stream) => break stream,
            Err(_) => {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(5));
            }
        }
    };
    #[cfg(unix)]
    controller
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    #[cfg(windows)]
    let mut controller = {
        assert!(Instant::now() < deadline);
        host.connect()
    };
    let new = request(&mut controller, "terminal.host.handshake", json!({}));
    assert_ne!(new["incarnation"], old["incarnation"]);
    request(&mut controller, "terminal.host.shutdown", json!({}));
    host.wait_for_exit();
}
