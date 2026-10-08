//! Reconnectable terminal host. Socket I/O never blocks terminal scheduling.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::protocol::{write_frame, CoreRequest, CoreResponse, FRAME_CONTROL_RESPONSE};
use crate::terminal::{SidecarMessage, TerminalManager};

const PROTOCOL_VERSION: u32 = 1;
const POLL_INTERVAL: Duration = Duration::from_millis(4);
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const IO_BUDGET: usize = 64 * 1024;
const REQUEST_BUDGET: usize = 64;

pub fn run(path: &Path, host_id: &str) -> Result<()> {
    if host_id.is_empty()
        || host_id.len() > 64
        || !host_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        bail!("host ID must contain 1–64 ASCII letters, digits, hyphens, or underscores");
    }
    let mut transport = SocketTransport::bind(path)?;
    let mut random = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let incarnation = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let (tx, rx) = mpsc::channel();
    let mut terminals =
        TerminalManager::with_id_prefix(tx, format!("proc_{host_id}_{incarnation}"));

    loop {
        let requests = transport.poll()?;
        if transport.take_disconnected() {
            terminals.unsubscribe_all();
        }
        for request in requests {
            let mut shutdown = false;
            let response = match request {
                Ok(request) if request.method == "terminal.host.handshake" => CoreResponse::result(
                    request.id,
                    serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "host_id": host_id,
                        "incarnation": incarnation,
                        "pid": std::process::id(),
                    }),
                ),
                Ok(request) => {
                    shutdown = request.method == "terminal.host.shutdown";
                    super::dispatch(&mut terminals, request)
                }
                Err(error) => CoreResponse::error(None, error),
            };
            write_frame(
                &mut transport,
                FRAME_CONTROL_RESPONSE,
                &serde_json::to_vec(&response)?,
            )?;
            if shutdown && response.error.is_none() {
                transport.flush()?;
                return Ok(());
            }
            if !transport.connected() {
                break;
            }
        }
        terminals.write_due_events(&mut transport)?;
        let timeout = terminals
            .next_deadline()
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(POLL_INTERVAL)
            .min(POLL_INTERVAL);
        match rx.recv_timeout(timeout) {
            Ok(SidecarMessage::TerminalEvent(event)) => {
                terminals.write_event_frame(&mut transport, event)?;
            }
            Ok(SidecarMessage::Notification {
                process_id,
                notification,
            }) => {
                terminals.write_notification_frame(&mut transport, process_id, notification)?;
            }
            Err(RecvTimeoutError::Disconnected) => break,
            _ => {}
        }
    }
    terminals.shutdown()
}

struct SocketTransport {
    listener: UnixListener,
    // Hold the lock until the listening socket has been removed.
    _lock: File,
    path: PathBuf,
    controller: Option<UnixStream>,
    input: Vec<u8>,
    input_scan_offset: usize,
    output: VecDeque<u8>,
    disconnected: bool,
}

impl SocketTransport {
    fn bind(path: &Path) -> Result<Self> {
        let parent = path
            .parent()
            .context("socket path needs a parent directory")?;
        let metadata = fs::symlink_metadata(parent)
            .context("create a private terminal host directory before starting the host")?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            bail!("terminal host socket directory must be a real directory with mode 0700");
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(Path::new(&lock_path))?;
        lock.try_lock()
            .context("another terminal host owns this socket")?;

        // The lock excludes another host starting while a crashed host's socket
        // is removed. Never unlink a live socket or an unrelated file.
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => match UnixStream::connect(path) {
                Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
                    fs::remove_file(path)?;
                }
                _ => bail!("terminal host socket is already in use"),
            },
            Ok(_) => bail!("terminal host socket path already contains a non-socket file"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let listener = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            _lock: lock,
            path: path.to_path_buf(),
            controller: None,
            input: Vec::new(),
            input_scan_offset: 0,
            output: VecDeque::new(),
            disconnected: false,
        })
    }

    fn connected(&self) -> bool {
        self.controller.is_some()
    }

    fn disconnect(&mut self) {
        if let Some(controller) = self.controller.take() {
            let _ = controller.shutdown(std::net::Shutdown::Both);
            self.disconnected = true;
        }
        self.input.clear();
        self.input_scan_offset = 0;
        self.output.clear();
    }

    fn take_disconnected(&mut self) -> bool {
        std::mem::take(&mut self.disconnected)
    }

    fn poll(&mut self) -> Result<Vec<std::result::Result<CoreRequest, String>>> {
        self.flush()?;
        if let Some(controller) = self.controller.as_mut() {
            let mut bytes = [0_u8; IO_BUDGET];
            match controller.read(&mut bytes) {
                Ok(0) => self.disconnect(),
                Ok(length) => {
                    if self.input.len() + length > MAX_REQUEST_BYTES {
                        self.disconnect();
                    } else {
                        self.input.extend_from_slice(&bytes[..length]);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => self.disconnect(),
            }
        }
        // Limit accepts as well as requests so a competing client cannot prevent
        // terminal input deadlines and lifecycle events from being processed.
        for _ in 0..REQUEST_BUDGET {
            match self.listener.accept() {
                Ok((controller, _)) => {
                    if self.connected() {
                        let _ = controller.shutdown(std::net::Shutdown::Both);
                    } else {
                        controller.set_nonblocking(true)?;
                        self.controller = Some(controller);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let mut consumed = 0;
        let mut requests = Vec::new();
        for _ in 0..REQUEST_BUDGET {
            let Some(length) = self.input[self.input_scan_offset..]
                .iter()
                .position(|byte| *byte == b'\n')
            else {
                self.input_scan_offset = self.input.len();
                break;
            };
            let end = self.input_scan_offset + length;
            let line = &self.input[consumed..end];
            if !line.iter().all(u8::is_ascii_whitespace) {
                requests.push(
                    serde_json::from_slice(line)
                        .map_err(|error| format!("invalid request: {error}")),
                );
            }
            consumed = end + 1;
            self.input_scan_offset = consumed;
        }
        self.input.drain(..consumed);
        self.input_scan_offset -= consumed;
        Ok(requests)
    }
}

impl Write for SocketTransport {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.connected() {
            return Ok(bytes.len());
        }
        if self.output.len() + bytes.len() > MAX_OUTPUT_BYTES {
            // Reconnection obtains fresh snapshots and inventory. Retaining an
            // unbounded backlog would let a paused browser exhaust host memory.
            self.disconnect();
            return Ok(bytes.len());
        }
        self.output.extend(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let Some(controller) = self.controller.as_mut() else {
            return Ok(());
        };
        let mut budget = IO_BUDGET;
        while !self.output.is_empty() && budget > 0 {
            let bytes = self.output.as_slices().0;
            match controller.write(&bytes[..bytes.len().min(budget)]) {
                Ok(0) => {
                    self.disconnect();
                    break;
                }
                Ok(length) => {
                    self.output.drain(..length);
                    budget -= length;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.disconnect();
                    break;
                }
            }
        }
        Ok(())
    }
}

impl Drop for SocketTransport {
    fn drop(&mut self) {
        self.disconnect();
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflowing_output_disconnects_controller_and_releases_backlog() {
        let directory =
            std::env::temp_dir().join(format!("patterm-host-backpressure-{}", std::process::id(),));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("control.sock");
        {
            let mut transport = SocketTransport::bind(&path).unwrap();
            let mut controller = UnixStream::connect(&path).unwrap();
            controller
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            transport.poll().unwrap();
            transport.write_all(&vec![0; MAX_OUTPUT_BYTES]).unwrap();
            assert!(transport.connected());
            transport.write_all(&[1]).unwrap();
            assert!(!transport.connected());
            assert!(transport.output.is_empty());
            assert!(transport.take_disconnected());
            assert_eq!(controller.read(&mut [0]).unwrap(), 0);

            let _next = UnixStream::connect(&path).unwrap();
            transport.poll().unwrap();
            assert!(
                transport.connected(),
                "host accepts a fresh controller after overflow"
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
