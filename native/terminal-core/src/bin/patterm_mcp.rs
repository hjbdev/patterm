//! Native Patterm MCP stdio shim, header helper, exec wrapper, and URL opener.
//!
//! Speaks protocol v2 over Patterm's local MCP socket (Unix domain socket on
//! POSIX, user-private named pipe on Windows) with a persistent connection in
//! stdio MCP server mode and zero-overhead `execvp` replacement in `--mcp-exec`
//! mode on Unix.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::env;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{self, Command};
#[cfg(windows)]
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};

const DISCONNECTED_MESSAGE: &str =
    "Patterm disconnected before responding. The command may have run and was not retried.";

#[derive(Clone)]
struct EnvConfig {
    socket_path: String,
    identity: Option<String>,
    opencode_bridge: Option<String>,
    gateway: bool,
    catalogue_refresh_ms: u64,
    relist_grace_ms: u64,
    js_shim: Option<String>,
    node_path: String,
}

impl EnvConfig {
    fn from_env() -> Self {
        let socket_path = env::var("PATTERM_MCP_SOCKET")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_socket_path);
        let identity = env::var("PATTERM_MCP_IDENTITY")
            .ok()
            .filter(|s| !s.is_empty());
        let opencode_bridge = env::var("PATTERM_OPENCODE_BRIDGE")
            .ok()
            .filter(|s| !s.is_empty());
        let gateway = env::var("PATTERM_MCP_GATEWAY").ok().as_deref() == Some("1");
        let catalogue_refresh_ms = env::var("PATTERM_MCP_CATALOGUE_REFRESH_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(60_000);
        let relist_grace_ms = catalogue_refresh_ms.min(10_000);
        let js_shim = env::var("PATTERM_MCP_JS_SHIM")
            .ok()
            .filter(|s| !s.is_empty());
        let node_path = env::var("PATTERM_NODE")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "node".to_string());
        Self {
            socket_path,
            identity,
            opencode_bridge,
            gateway,
            catalogue_refresh_ms,
            relist_grace_ms,
            js_shim,
            node_path,
        }
    }
}

fn default_socket_path() -> String {
    #[cfg(windows)]
    {
        let base = env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            let home = env::var("USERPROFILE").unwrap_or_default();
            Path::new(&home)
                .join("AppData")
                .join("Local")
                .to_string_lossy()
                .into_owned()
        });
        Path::new(&base)
            .join("patterm-desktop")
            .join("mcp.sock")
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var("HOME").unwrap_or_default();
        Path::new(&home)
            .join("Library")
            .join("Application Support")
            .join("patterm-desktop")
            .join("mcp.sock")
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let config_home = env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                let home = env::var("HOME").unwrap_or_default();
                Path::new(&home)
                    .join(".config")
                    .to_string_lossy()
                    .into_owned()
            });
        Path::new(&config_home)
            .join("patterm-desktop")
            .join("mcp.sock")
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(unix)]
mod ipc {
    use std::io::{self, Read, Write};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    pub struct IpcReader(UnixStream);

    pub struct IpcWriter(UnixStream);

    impl IpcReader {
        pub fn connect(
            socket_path: &str,
        ) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
            let stream = UnixStream::connect(Path::new(socket_path))?;
            let reader = stream.try_clone()?;
            Ok((Box::new(IpcReader(reader)), Box::new(IpcWriter(stream))))
        }
    }

    impl Read for IpcReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for IpcWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    impl Drop for IpcWriter {
        fn drop(&mut self) {
            let _ = self.0.shutdown(Shutdown::Both);
        }
    }
}

#[cfg(windows)]
mod ipc {
    use std::fs::{self, OpenOptions};
    use std::io::{self, Read, Write};
    use std::mem;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::IntoRawHandle;
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED,
        FALSE, HANDLE, TRUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED};
    use windows_sys::Win32::System::Threading::CreateEventW;
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    const PIPE_PREFIX: &str = r"\\.\pipe\";

    fn resolve_ipc_path(socket_path: &str) -> io::Result<String> {
        if socket_path.starts_with(PIPE_PREFIX) {
            return Ok(socket_path.to_string());
        }
        let abs = if Path::new(socket_path).is_absolute() {
            PathBuf::from(socket_path)
        } else {
            std::env::current_dir()?.join(socket_path)
        };
        let normalized = normalize_path(&abs);
        let lower = normalized.to_string_lossy().to_lowercase();
        let dir = Path::new(&lower)
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "socket path needs a parent"))?;
        let key_path = dir.join(".ipc-key");
        let key = fs::read_to_string(&key_path)?.trim().to_string();
        let mut input = Vec::with_capacity(key.len() + lower.len());
        input.extend_from_slice(key.as_bytes());
        input.extend_from_slice(lower.as_bytes());
        let digest = sha256_hex(&input);
        let basename = Path::new(&lower)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(format!("{PIPE_PREFIX}patterm-{}-{basename}", &digest[..32]))
    }

    fn normalize_path(path: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for comp in path.components() {
            match comp {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    }

    fn sha256_hex(data: &[u8]) -> String {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];
        let bit_len = (data.len() as u64) * 8;
        let mut msg = data.to_vec();
        msg.push(0x80);
        while (msg.len() % 64) != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());
        for chunk in msg.chunks_exact(64) {
            let mut w = [0u32; 64];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([
                    chunk[4 * i],
                    chunk[4 * i + 1],
                    chunk[4 * i + 2],
                    chunk[4 * i + 3],
                ]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }
            let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ ((!e) & g);
                let temp1 = hh
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0.wrapping_add(maj);
                hh = g;
                g = f;
                f = e;
                e = d.wrapping_add(temp1);
                d = c;
                c = b;
                b = a;
                a = temp1.wrapping_add(temp2);
            }
            let next = [a, b, c, d, e, f, g, hh];
            for i in 0..8 {
                h[i] = h[i].wrapping_add(next[i]);
            }
        }
        let mut out = String::with_capacity(64);
        for word in h {
            use std::fmt::Write;
            let _ = write!(&mut out, "{word:08x}");
        }
        out
    }

    struct OwnedPipeHandle {
        handle: HANDLE,
        closed: AtomicBool,
    }

    // SAFETY: Win32 overlapped HANDLEs may be used concurrently from separate
    // reader and writer threads as long as each thread uses its own OVERLAPPED
    // struct and event, and CloseHandle runs only after both drop.
    unsafe impl Send for OwnedPipeHandle {}
    unsafe impl Sync for OwnedPipeHandle {}

    impl OwnedPipeHandle {
        fn new(handle: HANDLE) -> Self {
            Self {
                handle,
                closed: AtomicBool::new(false),
            }
        }

        fn is_closed(&self) -> bool {
            self.closed.load(Ordering::Acquire)
        }

        fn close(&self) {
            if !self.closed.swap(true, Ordering::AcqRel) {
                unsafe {
                    CancelIoEx(self.handle, ptr::null());
                }
            }
        }
    }

    impl Drop for OwnedPipeHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }

    struct OwnedEvent(HANDLE);

    unsafe impl Send for OwnedEvent {}

    impl OwnedEvent {
        fn new() -> io::Result<Self> {
            let event = unsafe { CreateEventW(ptr::null(), TRUE, FALSE, ptr::null()) };
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(event))
        }
    }

    impl Drop for OwnedEvent {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn is_pipe_eof(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error().map(|code| code as u32),
            Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA)
        )
    }

    struct OverlappedPipeReader {
        handle: Arc<OwnedPipeHandle>,
        event: OwnedEvent,
    }

    impl Read for OverlappedPipeReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if buf.is_empty() || self.handle.is_closed() {
                return Ok(0);
            }
            let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
            overlapped.hEvent = self.event.0;
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ok = unsafe {
                ReadFile(
                    self.handle.handle,
                    buf.as_mut_ptr(),
                    len,
                    ptr::null_mut(),
                    &mut overlapped,
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    return if is_pipe_eof(&err) || self.handle.is_closed() {
                        Ok(0)
                    } else {
                        Err(err)
                    };
                }
                if self.handle.is_closed() {
                    unsafe {
                        CancelIoEx(self.handle.handle, &overlapped);
                    }
                }
            }
            let mut transferred: u32 = 0;
            if unsafe { GetOverlappedResult(self.handle.handle, &overlapped, &mut transferred, TRUE) }
                == 0
            {
                let err = io::Error::last_os_error();
                return if is_pipe_eof(&err) || self.handle.is_closed() {
                    Ok(0)
                } else {
                    Err(err)
                };
            }
            Ok(transferred as usize)
        }
    }

    struct OverlappedPipeWriter {
        handle: Arc<OwnedPipeHandle>,
        event: OwnedEvent,
    }

    impl Write for OverlappedPipeWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
            overlapped.hEvent = self.event.0;
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ok = unsafe {
                WriteFile(
                    self.handle.handle,
                    buf.as_ptr(),
                    len,
                    ptr::null_mut(),
                    &mut overlapped,
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    return Err(err);
                }
            }
            let mut transferred: u32 = 0;
            if unsafe { GetOverlappedResult(self.handle.handle, &overlapped, &mut transferred, TRUE) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(transferred as usize)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for OverlappedPipeWriter {
        fn drop(&mut self) {
            self.handle.close();
        }
    }

    pub fn connect(socket_path: &str) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let pipe = resolve_ipc_path(socket_path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED)
            .open(&pipe)?;
        let handle = Arc::new(OwnedPipeHandle::new(file.into_raw_handle() as HANDLE));
        let read_event = OwnedEvent::new()?;
        let write_event = OwnedEvent::new()?;
        Ok((
            Box::new(OverlappedPipeReader {
                handle: Arc::clone(&handle),
                event: read_event,
            }),
            Box::new(OverlappedPipeWriter {
                handle,
                event: write_event,
            }),
        ))
    }
}

struct SocketResponse {
    result: Value,
    push: bool,
}

struct SocketState {
    next_id: u64,
    generation: u64,
    writer: Option<Box<dyn Write + Send>>,
    pending: HashMap<u64, mpsc::Sender<Result<SocketResponse, String>>>,
    fifo_order: VecDeque<u64>,
    subscribed: bool,
}

struct PersistentSocket {
    socket_path: String,
    state: Arc<Mutex<SocketState>>,
    on_catalog_changed: Option<mpsc::Sender<()>>,
}

impl PersistentSocket {
    fn new(socket_path: String, on_catalog_changed: Option<mpsc::Sender<()>>) -> Self {
        Self {
            socket_path,
            state: Arc::new(Mutex::new(SocketState {
                next_id: 1,
                generation: 0,
                writer: None,
                pending: HashMap::new(),
                fifo_order: VecDeque::new(),
                subscribed: false,
            })),
            on_catalog_changed,
        }
    }

    fn request(&self, mut payload: Map<String, Value>) -> Result<SocketResponse> {
        let (rx, id) = {
            let mut guard = self.state.lock().unwrap();
            if guard.writer.is_none() {
                let (reader, writer) = connect_ipc(&self.socket_path)
                    .with_context(|| format!("failed to connect to {}", self.socket_path))?;
                guard.generation += 1;
                let generation = guard.generation;
                guard.writer = Some(writer);
                guard.subscribed = false;
                let state = Arc::clone(&self.state);
                let notify = self.on_catalog_changed.clone();
                thread::spawn(move || {
                    let mut buf_reader = BufReader::new(reader);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match buf_reader.read_line(&mut line) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                let trimmed = line.trim();
                                if trimmed.is_empty() {
                                    continue;
                                }
                                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                                    continue;
                                };
                                if value.get("event").and_then(Value::as_str)
                                    == Some("catalog_changed")
                                {
                                    if state.lock().unwrap().generation != generation {
                                        break;
                                    }
                                    if let Some(ref tx) = notify {
                                        let _ = tx.send(());
                                    }
                                    continue;
                                }
                                let mut s = state.lock().unwrap();
                                if s.generation != generation {
                                    break;
                                }
                                let matched_id = value
                                    .get("id")
                                    .and_then(Value::as_u64)
                                    .filter(|id| s.pending.contains_key(id))
                                    .or_else(|| s.fifo_order.front().copied());
                                if let Some(req_id) = matched_id {
                                    s.fifo_order.retain(|&x| x != req_id);
                                    if let Some(tx) = s.pending.remove(&req_id) {
                                        if let Some(err) =
                                            value.get("error").and_then(Value::as_str)
                                        {
                                            let _ = tx.send(Err(err.to_string()));
                                        } else {
                                            let push = value
                                                .get("push")
                                                .and_then(Value::as_bool)
                                                .unwrap_or(false);
                                            let result = value
                                                .get("result")
                                                .cloned()
                                                .unwrap_or(Value::Null);
                                            let _ = tx.send(Ok(SocketResponse { result, push }));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let mut s = state.lock().unwrap();
                    if s.generation == generation {
                        s.writer = None;
                        s.subscribed = false;
                        s.fifo_order.clear();
                        for (_, tx) in s.pending.drain() {
                            let _ = tx.send(Err(DISCONNECTED_MESSAGE.to_string()));
                        }
                    }
                });
            }
            let id = guard.next_id;
            guard.next_id += 1;
            payload.insert("id".to_string(), json!(id));
            payload.insert("version".to_string(), json!(2));
            let serialized = serde_json::to_string(&Value::Object(payload))?;
            let (tx, rx) = mpsc::channel();
            guard.pending.insert(id, tx);
            guard.fifo_order.push_back(id);
            let write_res = if let Some(ref mut writer) = guard.writer {
                writer
                    .write_all(serialized.as_bytes())
                    .and_then(|_| writer.write_all(b"\n"))
                    .and_then(|_| writer.flush())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    DISCONNECTED_MESSAGE,
                ))
            };
            if write_res.is_err() {
                guard.generation += 1;
                guard.writer = None;
                guard.subscribed = false;
                guard.pending.remove(&id);
                guard.fifo_order.clear();
                for (_, tx) in guard.pending.drain() {
                    let _ = tx.send(Err(DISCONNECTED_MESSAGE.to_string()));
                }
                return Err(anyhow!(DISCONNECTED_MESSAGE));
            }
            (rx, id)
        };

        match rx.recv() {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(msg)) => Err(anyhow!(msg)),
            Err(_) => {
                let mut guard = self.state.lock().unwrap();
                guard.pending.remove(&id);
                guard.fifo_order.retain(|&x| x != id);
                Err(anyhow!(DISCONNECTED_MESSAGE))
            }
        }
    }

    fn subscribe_catalog_if_needed(&self, cfg: &EnvConfig) {
        let should_subscribe = {
            let mut guard = self.state.lock().unwrap();
            if guard.writer.is_some() && !guard.subscribed {
                guard.subscribed = true;
                true
            } else {
                false
            }
        };
        if !should_subscribe {
            return;
        }
        let mut req = Map::new();
        req.insert("op".to_string(), json!("catalog-subscribe"));
        req.insert(
            "identity".to_string(),
            cfg.identity
                .as_ref()
                .map(|s| json!(s))
                .unwrap_or(Value::Null),
        );
        let _ = self.request(req);
    }
}

#[cfg(unix)]
fn connect_ipc(
    socket_path: &str,
) -> io::Result<(Box<dyn io::Read + Send>, Box<dyn Write + Send>)> {
    ipc::IpcReader::connect(socket_path)
}

#[cfg(windows)]
fn connect_ipc(
    socket_path: &str,
) -> io::Result<(Box<dyn io::Read + Send>, Box<dyn Write + Send>)> {
    ipc::connect(socket_path)
}

fn attach_auth(
    req: &mut Map<String, Value>,
    cfg: &EnvConfig,
    is_tool: bool,
    is_server: bool,
    meta: Option<&Map<String, Value>>,
) -> Result<()> {
    if let Some(ref bridge) = cfg.opencode_bridge {
        if is_tool {
            let session_id = meta
                .and_then(|m| {
                    m.get("ai.opencode/sessionID")
                        .or_else(|| m.get("sessionID"))
                })
                .and_then(Value::as_str);
            let Some(sid) = session_id else {
                bail!("OpenCode MCP call is missing session metadata");
            };
            req.insert("opencodeBridge".to_string(), json!(bridge));
            req.insert("opencodeSessionId".to_string(), json!(sid));
            return Ok(());
        }
        if is_server {
            req.insert("opencodeBridge".to_string(), json!(bridge));
            return Ok(());
        }
    }
    req.insert(
        "identity".to_string(),
        cfg.identity
            .as_ref()
            .map(|s| json!(s))
            .unwrap_or(Value::Null),
    );
    Ok(())
}

// --- One-shot modes ---

fn run_print_headers(cfg: &EnvConfig, op: &str, args: &[String]) -> Result<()> {
    let server_id = args.first().ok_or_else(|| anyhow!("missing MCP server ID"))?;
    let sock = PersistentSocket::new(cfg.socket_path.clone(), None);
    let mut req = Map::new();
    req.insert("op".to_string(), json!(op));
    req.insert("server".to_string(), json!(server_id));
    attach_auth(&mut req, cfg, false, true, None)?;
    let resp = sock.request(req)?;
    let headers = resp
        .result
        .get("headers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, &headers)?;
    handle.flush()?;
    Ok(())
}

#[cfg(windows)]
fn enable_kill_on_exit_job() {
    use std::ffi::c_void;
    use std::mem;
    use std::ptr;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            CloseHandle(job);
            return;
        }
        // Keep the job handle open for the process lifetime so the OS ends
        // every spawned child if this shim is killed.
    }
}

fn run_mcp_exec(cfg: &EnvConfig, args: &[String]) -> Result<()> {
    let server_id = args.first().ok_or_else(|| anyhow!("missing MCP server ID"))?;
    let sock = PersistentSocket::new(cfg.socket_path.clone(), None);
    let mut req = Map::new();
    req.insert("op".to_string(), json!("mcp-exec"));
    req.insert("server".to_string(), json!(server_id));
    attach_auth(&mut req, cfg, false, true, None)?;
    let resp = sock.request(req)?;
    let command = resp
        .result
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing exec command"))?
        .to_string();
    let target_args: Vec<String> = resp
        .result
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let target_env: BTreeMap<String, String> = resp
        .result
        .get("env")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = Command::new(&command)
            .args(&target_args)
            .envs(&target_env)
            .exec();
        eprintln!("patterm-mcp: could not start {command}: {err}");
        process::exit(127);
    }

    #[cfg(windows)]
    {
        enable_kill_on_exit_job();
        let mut child = match Command::new(&command)
            .args(&target_args)
            .envs(&target_env)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(c) => c,
            Err(err) => {
                eprintln!("patterm-mcp: could not start {command}: {err}");
                process::exit(127);
            }
        };
        let status = child.wait()?;
        process::exit(status.code().unwrap_or(1));
    }
}

fn run_mcp_bridge(cfg: &EnvConfig, args: &[String]) -> Result<()> {
    let server_id = args.first().ok_or_else(|| anyhow!("missing MCP server ID"))?;
    let js_shim = cfg.js_shim.clone().or_else(|| {
        let exe = env::current_exe().ok()?;
        let dir = exe.parent()?;
        for candidate in [
            dir.join("patterm-mcp.js"),
            dir.join("..").join("mcp").join("patterm-mcp.js"),
            dir.join("..").join("..").join("..").join("..").join("dist").join("mcp").join("patterm-mcp.js"),
        ] {
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    });
    let Some(shim_path) = js_shim else {
        bail!("--mcp-bridge requires PATTERM_MCP_JS_SHIM");
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = Command::new(&cfg.node_path)
            .arg(&shim_path)
            .arg("--mcp-bridge")
            .arg(server_id)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .exec();
        bail!("failed to exec JS MCP bridge {}: {err}", cfg.node_path);
    }
    #[cfg(windows)]
    {
        enable_kill_on_exit_job();
        let status = Command::new(&cfg.node_path)
            .arg(&shim_path)
            .arg("--mcp-bridge")
            .arg(server_id)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        process::exit(status.code().unwrap_or(1));
    }
}

// --- Stdio MCP server mode ---

#[derive(Clone)]
struct ToolDescriptor {
    name: String,
    namespace: String,
    description: String,
    usage_notes: Vec<String>,
    input_schema: Value,
    annotations: Option<Value>,
}

fn parse_catalogue(value: Value) -> Result<Vec<ToolDescriptor>> {
    let arr = value
        .as_array()
        .ok_or_else(|| anyhow!("Patterm returned an invalid MCP tool catalogue"))?;
    let mut tools = Vec::with_capacity(arr.len());
    for entry in arr {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let Some(name) = obj.get("name").and_then(Value::as_str) else {
            continue;
        };
        let namespace = obj
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let description = obj
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let usage_notes = obj
            .get("usageNotes")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let input_schema = obj
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object" }));
        let annotations = obj.get("annotations").cloned().filter(|v| !v.is_null());
        tools.push(ToolDescriptor {
            name: name.to_string(),
            namespace,
            description,
            usage_notes,
            input_schema,
            annotations,
        });
    }
    Ok(tools)
}

// Antigravity declares MCP tools only up to a shared size budget, about
// 60 KB across every server, then drops the largest, with no way to call
// them. Patterm's full catalogue alone nearly fills it. Its sessions get a
// gateway instead: the tools agents call most, declared in full, plus help
// to list and explain the rest and call to run them. Keep in step with
// mcp/shim.ts.
const GATEWAY_TOOLS: &[&str] = &[
    "help",
    "whoami",
    "get_project_status",
    "session_context",
    "list_processes",
    "spawn_agent",
    "spawn_process",
    "send_message",
    "report_to_parent",
    "notify_user",
    "request_close",
    "close_process",
    "get_conversation_output",
    "get_process_output",
    "timer_fire_when_reported_any",
    "timer_fire_when_reported_all",
    "status_set",
    "reference_attach",
    "worktree_create",
    "assistant_memory_search",
];
const GATEWAY_CALL: &str = "call";

fn gateway_call() -> ToolDescriptor {
    ToolDescriptor {
        name: GATEWAY_CALL.to_string(),
        namespace: "meta".to_string(),
        description: "Run any Patterm tool by name, including those this session does not declare directly. Call help first for the tool's schema and usage notes, then pass its arguments unchanged.".to_string(),
        usage_notes: Vec::new(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "tool": { "type": "string", "minLength": 1, "description": "The Patterm tool name, such as todo_list." },
                "arguments": { "type": "object", "description": "The tool's arguments, as its help schema describes." }
            },
            "required": ["tool"],
            "additionalProperties": false
        }),
        annotations: None,
    }
}

// The tools this session declares to its client.
fn advertised(tools: Vec<ToolDescriptor>, gateway: bool) -> Vec<ToolDescriptor> {
    if !gateway {
        return tools;
    }
    let mut core: Vec<ToolDescriptor> = tools
        .into_iter()
        .filter(|tool| GATEWAY_TOOLS.contains(&tool.name.as_str()))
        .collect();
    core.push(gateway_call());
    core
}

fn describe_tool(tool: &ToolDescriptor, gateway: bool) -> String {
    let mut parts = vec![tool.description.as_str()];
    if tool.namespace.starts_with("cli.") {
        parts.extend(tool.usage_notes.iter().map(String::as_str));
    }
    if gateway && tool.name == "help" {
        parts.push("This session declares only Patterm's most used tools: list the rest with help, then run them with call.");
    }
    parts.join(" ")
}

fn advertised_schema(schema: &Value) -> Value {
    let Some(obj) = schema.as_object() else {
        return schema.clone();
    };
    let mut result = Map::new();
    for (key, value) in obj {
        if key == "$schema" {
            continue;
        }
        if key == "required" && value.as_array().is_some_and(|a| a.is_empty()) {
            continue;
        }
        if key == "properties" && value.as_object().is_some_and(|o| o.is_empty()) {
            continue;
        }
        if matches!(
            key.as_str(),
            "properties" | "patternProperties" | "$defs" | "definitions"
        ) {
            if let Some(map) = value.as_object() {
                let mut inner = Map::new();
                for (name, entry) in map {
                    inner.insert(name.clone(), advertised_schema(entry));
                }
                result.insert(key.clone(), Value::Object(inner));
                continue;
            }
        }
        if matches!(key.as_str(), "anyOf" | "oneOf" | "allOf" | "prefixItems") {
            if let Some(list) = value.as_array() {
                result.insert(
                    key.clone(),
                    Value::Array(list.iter().map(advertised_schema).collect()),
                );
                continue;
            }
        }
        if matches!(
            key.as_str(),
            "items" | "additionalProperties" | "not" | "if" | "then" | "else" | "contains"
        ) {
            result.insert(key.clone(), advertised_schema(value));
            continue;
        }
        result.insert(key.clone(), value.clone());
    }
    Value::Object(result)
}

type Signatures = BTreeMap<String, String>;

fn signatures_of(tools: &[ToolDescriptor], gateway: bool) -> Signatures {
    let mut map = BTreeMap::new();
    for tool in tools {
        let sig = json!([
            describe_tool(tool, gateway),
            advertised_schema(&tool.input_schema),
            tool.annotations.clone().unwrap_or(Value::Null),
        ]);
        map.insert(tool.name.clone(), sig.to_string());
    }
    map
}

fn stale_notice(listed: &Signatures, current: &Signatures) -> String {
    let added: Vec<&str> = current
        .keys()
        .filter(|name| !listed.contains_key(*name))
        .map(String::as_str)
        .collect();
    let changed: Vec<&str> = current
        .iter()
        .filter(|(name, sig)| listed.get(*name).is_some_and(|prev| prev != *sig))
        .map(|(name, _)| name.as_str())
        .collect();
    let removed: Vec<&str> = listed
        .keys()
        .filter(|name| !current.contains_key(*name))
        .map(String::as_str)
        .collect();
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(format!("new: {}", added.join(", ")));
    }
    if !changed.is_empty() {
        parts.push(format!("changed: {}", changed.join(", ")));
    }
    if !removed.is_empty() {
        parts.push(format!("removed: {}", removed.join(", ")));
    }
    format!(
        "[Patterm] Patterm's MCP tools changed after this session listed them ({}). This session cannot see the changes. Tell the user that restarting this agent will load them.",
        parts.join("; ")
    )
}

fn validate_arguments(schema: &Value, args: &Value) -> std::result::Result<(), String> {
    let Some(schema_obj) = schema.as_object() else {
        return Ok(());
    };
    if schema_obj.get("type").and_then(Value::as_str) == Some("object") {
        let Some(args_obj) = args.as_object() else {
            return Err("expected an object".to_string());
        };
        if let Some(required) = schema_obj.get("required").and_then(Value::as_array) {
            for field in required {
                if let Some(name) = field.as_str() {
                    if !args_obj.contains_key(name) {
                        return Err(format!("missing required property '{name}'"));
                    }
                }
            }
        }
        let props = schema_obj.get("properties").and_then(Value::as_object);
        if schema_obj.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
            for key in args_obj.keys() {
                if !props.is_some_and(|p| p.contains_key(key)) {
                    return Err(format!("unexpected property '{key}'"));
                }
            }
        }
        if let Some(props) = props {
            for (key, value) in args_obj {
                if let Some(prop_schema) = props.get(key).and_then(Value::as_object) {
                    validate_value(key, prop_schema, value)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_value(
    key: &str,
    prop_schema: &Map<String, Value>,
    value: &Value,
) -> std::result::Result<(), String> {
    if let Some(expected_type) = prop_schema.get("type").and_then(Value::as_str) {
        let ok = match expected_type {
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.is_i64() || value.is_u64(),
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            "null" => value.is_null(),
            _ => true,
        };
        if !ok {
            return Err(format!("property '{key}' must be {expected_type}"));
        }
    }
    if let (Some(min_len), Some(s)) = (
        prop_schema.get("minLength").and_then(Value::as_u64),
        value.as_str(),
    ) {
        if (s.chars().count() as u64) < min_len {
            return Err(format!(
                "property '{key}' must have length >= {min_len}"
            ));
        }
    }
    Ok(())
}

struct CatalogueState {
    tools: Vec<ToolDescriptor>,
    by_name: HashMap<String, ToolDescriptor>,
    signatures: Signatures,
    changed_at: Option<Instant>,
    listed: Option<Signatures>,
    noticed: Option<Signatures>,
}

impl CatalogueState {
    fn new(tools: Vec<ToolDescriptor>, gateway: bool) -> Self {
        let tools = advertised(tools, gateway);
        let signatures = signatures_of(&tools, gateway);
        let by_name = tools.iter().map(|t| (t.name.clone(), t.clone())).collect();
        Self {
            tools,
            by_name,
            signatures,
            changed_at: None,
            listed: None,
            noticed: None,
        }
    }

    fn update(&mut self, next: Vec<ToolDescriptor>, gateway: bool) -> bool {
        let next = advertised(next, gateway);
        let next_sigs = signatures_of(&next, gateway);
        if next_sigs == self.signatures {
            return false;
        }
        self.by_name = next.iter().map(|t| (t.name.clone(), t.clone())).collect();
        self.tools = next;
        self.signatures = next_sigs;
        self.changed_at = Some(Instant::now());
        true
    }

    fn pending_notice(&mut self, grace_ms: u64) -> Option<String> {
        let listed = self.listed.as_ref()?;
        if self.noticed.as_ref() == Some(&self.signatures) {
            return None;
        }
        if let Some(changed_at) = self.changed_at {
            if changed_at.elapsed() < Duration::from_millis(grace_ms) {
                return None;
            }
        }
        if listed == &self.signatures {
            return None;
        }
        self.noticed = Some(self.signatures.clone());
        Some(stale_notice(listed, &self.signatures))
    }
}

fn fetch_catalogue(sock: &PersistentSocket, cfg: &EnvConfig) -> Result<Vec<ToolDescriptor>> {
    let mut req = Map::new();
    req.insert("op".to_string(), json!("catalog"));
    attach_auth(&mut req, cfg, false, false, None)?;
    let resp = sock.request(req)?;
    if resp.push {
        sock.subscribe_catalog_if_needed(cfg);
    }
    parse_catalogue(resp.result)
}

fn write_json_line(out: &Arc<Mutex<io::Stdout>>, value: &Value) {
    if let Ok(line) = serde_json::to_string(value) {
        let mut guard = out.lock().unwrap();
        let _ = guard.write_all(line.as_bytes());
        let _ = guard.write_all(b"\n");
        let _ = guard.flush();
    }
}

fn run_stdio_server(cfg: EnvConfig) -> Result<()> {
    let (catalog_tx, catalog_rx) = mpsc::channel::<()>();
    let sock = Arc::new(PersistentSocket::new(
        cfg.socket_path.clone(),
        Some(catalog_tx),
    ));
    let initial_tools = fetch_catalogue(&sock, &cfg)?;
    let catalogue = Arc::new(Mutex::new(CatalogueState::new(initial_tools, cfg.gateway)));
    let stdout = Arc::new(Mutex::new(io::stdout()));

    // Background catalogue refresh thread (handles both push events and periodic polling).
    {
        let sock = Arc::clone(&sock);
        let catalogue = Arc::clone(&catalogue);
        let stdout = Arc::clone(&stdout);
        let cfg = cfg.clone();
        thread::spawn(move || {
            let interval = Duration::from_millis(cfg.catalogue_refresh_ms);
            loop {
                match catalog_rx.recv_timeout(interval) {
                    Ok(()) => {
                        // Coalesce rapid push events.
                        while catalog_rx.try_recv().is_ok() {}
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                if let Ok(next) = fetch_catalogue(&sock, &cfg) {
                    let changed = catalogue.lock().unwrap().update(next, cfg.gateway);
                    if changed {
                        write_json_line(
                            &stdout,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "notifications/tools/list_changed"
                            }),
                        );
                    }
                }
            }
        });
    }

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            continue;
        };
        let id = msg.get("id").cloned();
        let Some(req_id) = id else {
            // Notification (e.g. notifications/initialized, notifications/cancelled): no reply.
            continue;
        };
        match method {
            "initialize" => {
                let version = msg
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18");
                write_json_line(
                    &stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "protocolVersion": version,
                            "capabilities": {
                                "tools": { "listChanged": true }
                            },
                            "serverInfo": {
                                "name": "patterm",
                                "version": "0.1.0"
                            }
                        }
                    }),
                );
            }
            "ping" => {
                write_json_line(
                    &stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {}
                    }),
                );
            }
            "tools/list" => {
                let tools_json: Vec<Value> = {
                    let mut guard = catalogue.lock().unwrap();
                    guard.listed = Some(guard.signatures.clone());
                    guard
                        .tools
                        .iter()
                        .map(|tool| {
                            let mut entry = Map::new();
                            entry.insert("name".to_string(), json!(tool.name));
                            entry.insert(
                                "description".to_string(),
                                json!(describe_tool(tool, cfg.gateway)),
                            );
                            entry.insert(
                                "inputSchema".to_string(),
                                advertised_schema(&tool.input_schema),
                            );
                            if let Some(ref annotations) = tool.annotations {
                                entry.insert("annotations".to_string(), annotations.clone());
                            }
                            Value::Object(entry)
                        })
                        .collect()
                };
                write_json_line(
                    &stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": { "tools": tools_json }
                    }),
                );
            }
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let sock = Arc::clone(&sock);
                let catalogue = Arc::clone(&catalogue);
                let stdout = Arc::clone(&stdout);
                let cfg = cfg.clone();
                thread::spawn(move || {
                    handle_tool_call(req_id, params, &sock, &catalogue, &stdout, &cfg);
                });
            }
            _ => {
                write_json_line(
                    &stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32601,
                            "message": format!("Method not found: {method}")
                        }
                    }),
                );
            }
        }
    }
    Ok(())
}

fn handle_tool_call(
    req_id: Value,
    params: Value,
    sock: &PersistentSocket,
    catalogue: &Mutex<CatalogueState>,
    stdout: &Arc<Mutex<io::Stdout>>,
    cfg: &EnvConfig,
) {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let arguments = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(value) => value.clone(),
    };
    let meta = params.get("_meta").and_then(Value::as_object);

    let tool = {
        let guard = catalogue.lock().unwrap();
        guard.by_name.get(&name).cloned()
    };

    let Some(tool) = tool else {
        let notice = catalogue.lock().unwrap().pending_notice(cfg.relist_grace_ms);
        let mut message = format!("Tool {name} not found");
        if let Some(n) = notice {
            message.push_str("\n\n");
            message.push_str(&n);
        }
        write_json_line(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32602,
                    "message": message
                }
            }),
        );
        return;
    };

    let schema = advertised_schema(&tool.input_schema);
    if let Err(reason) = validate_arguments(&schema, &arguments) {
        let mut content = vec![json!({
            "type": "text",
            "text": format!("Invalid arguments for tool {name}: {reason}")
        })];
        if let Some(notice) = catalogue.lock().unwrap().pending_notice(cfg.relist_grace_ms) {
            content.push(json!({ "type": "text", "text": notice }));
        }
        write_json_line(
            stdout,
            &json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": content,
                    "isError": true
                }
            }),
        );
        return;
    }

    // call forwards the named tool; its handler validates the arguments.
    let (name, arguments) = if cfg.gateway && name == GATEWAY_CALL {
        let inner = arguments
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let inner_args = match arguments.get("arguments") {
            None | Some(Value::Null) => json!({}),
            Some(value) => value.clone(),
        };
        (inner, inner_args)
    } else {
        (name, arguments)
    };

    let mut req = Map::new();
    req.insert("tool".to_string(), json!(name));
    req.insert("args".to_string(), arguments);
    if let Err(err) = attach_auth(&mut req, cfg, true, false, meta) {
        send_tool_error(req_id, &err.to_string(), catalogue, stdout, cfg);
        return;
    }

    match sock.request(req) {
        Ok(resp) => {
            let mut content = format_tool_content(resp.result);
            if let Some(notice) = catalogue.lock().unwrap().pending_notice(cfg.relist_grace_ms) {
                content.push(json!({ "type": "text", "text": notice }));
            }
            write_json_line(
                stdout,
                &json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": { "content": content }
                }),
            );
        }
        Err(err) => {
            send_tool_error(req_id, &err.to_string(), catalogue, stdout, cfg);
        }
    }
}

fn send_tool_error(
    req_id: Value,
    message: &str,
    catalogue: &Mutex<CatalogueState>,
    stdout: &Arc<Mutex<io::Stdout>>,
    cfg: &EnvConfig,
) {
    let mut content = vec![json!({ "type": "text", "text": message })];
    if let Some(notice) = catalogue.lock().unwrap().pending_notice(cfg.relist_grace_ms) {
        content.push(json!({ "type": "text", "text": notice }));
    }
    write_json_line(
        stdout,
        &json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": content,
                "isError": true
            }
        }),
    );
}

fn format_tool_content(result: Value) -> Vec<Value> {
    if let Value::Object(mut obj) = result {
        if let Some(Value::Array(images)) = obj.get("mcp_images").cloned() {
            obj.remove("mcp_images");
            let text = serde_json::to_string_pretty(&Value::Object(obj))
                .unwrap_or_else(|_| "{}".to_string());
            let mut content = vec![json!({ "type": "text", "text": text })];
            for image in images {
                if let Some(img) = image.as_object() {
                    if let (Some(data), Some(mime)) = (
                        img.get("data").and_then(Value::as_str),
                        img.get("mimeType").and_then(Value::as_str),
                    ) {
                        content.push(json!({
                            "type": "image",
                            "data": data,
                            "mimeType": mime
                        }));
                    }
                }
            }
            return content;
        }
        let text = serde_json::to_string_pretty(&Value::Object(obj))
            .unwrap_or_else(|_| "{}".to_string());
        return vec![json!({ "type": "text", "text": text })];
    }
    let text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| "null".to_string());
    vec![json!({ "type": "text", "text": text })]
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let cfg = EnvConfig::from_env();
    let mode = args.first().map(String::as_str).unwrap_or("");
    let rest = if args.len() > 1 { &args[1..] } else { &[] };

    let res = match mode {
        "--mcp-headers" => run_print_headers(&cfg, "mcp-headers", rest),
        "--mcp-proxy-headers" => run_print_headers(&cfg, "mcp-proxy-headers", rest),
        "--mcp-exec" => run_mcp_exec(&cfg, rest),
        "--mcp-bridge" => run_mcp_bridge(&cfg, rest),
        _ => run_stdio_server(cfg),
    };

    if let Err(err) = res {
        let label = match mode {
            "--mcp-headers" | "--mcp-proxy-headers" | "--mcp-exec" | "--mcp-bridge" => &mode[2..],
            _ => "shim",
        };
        eprintln!("patterm-mcp {label} failed: {err}");
        process::exit(1);
    }
}
