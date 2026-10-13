//! Reconnectable terminal host. Socket I/O never blocks terminal scheduling.
//!
//! Unix hosts listen on a socket file in a private directory. Windows hosts
//! serve a named pipe that only the current user can open; the caller passes
//! the pipe name in place of the socket path.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};

use crate::protocol::{write_frame, CoreRequest, CoreResponse, FRAME_CONTROL_RESPONSE};
use crate::terminal::{SidecarMessage, TerminalManager};

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

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
    platform::fill_random(&mut random)?;
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
    // Owns the endpoint (and on Unix the lock) until the transport drops.
    listener: platform::Listener,
    controller: Option<platform::Stream>,
    input: Vec<u8>,
    input_scan_offset: usize,
    output: VecDeque<u8>,
    disconnected: bool,
}

impl SocketTransport {
    fn bind(path: &Path) -> Result<Self> {
        Ok(Self {
            listener: platform::Listener::bind(path)?,
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
    }
}

#[cfg(unix)]
mod unix {
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read};
    use std::os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt};
    use std::os::unix::net::{SocketAddr, UnixListener};
    use std::path::{Path, PathBuf};

    use anyhow::{bail, Context, Result};

    pub use std::os::unix::net::UnixStream as Stream;

    pub fn fill_random(bytes: &mut [u8]) -> Result<()> {
        File::open("/dev/urandom")?.read_exact(bytes)?;
        Ok(())
    }

    pub struct Listener {
        listener: UnixListener,
        path: PathBuf,
        // Hold the lock until the listening socket has been removed.
        _lock: File,
    }

    impl Listener {
        pub fn bind(path: &Path) -> Result<Self> {
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
                Ok(metadata) if metadata.file_type().is_socket() => match Stream::connect(path) {
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
                path: path.to_path_buf(),
                _lock: lock,
            })
        }

        pub fn accept(&mut self) -> io::Result<(Stream, SocketAddr)> {
            self.listener.accept()
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

// Named pipe transport. Every read, write, and connect is overlapped and polled
// without waiting, so like the nonblocking Unix socket, the pipe never blocks
// terminal scheduling.
#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io::{self, Read, Write};
    use std::mem;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;

    use anyhow::{bail, Context, Result};
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_BROKEN_PIPE, ERROR_INSUFFICIENT_BUFFER, ERROR_IO_INCOMPLETE,
        ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, FALSE,
        HANDLE, INVALID_HANDLE_VALUE, TRUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, OpenProcessToken,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    const PIPE_PREFIX: &str = r"\\.\pipe\";
    const BUFFER_BYTES: usize = super::IO_BUDGET;

    pub fn fill_random(bytes: &mut [u8]) -> Result<()> {
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            bail!("failed to generate a terminal host incarnation (NTSTATUS {status:#x})");
        }
        Ok(())
    }

    pub struct Listener {
        name: Vec<u16>,
        security: Security,
        // The instance waiting for the next client. The pipe exists while any
        // instance is open, so it vanishes with this process.
        next: Instance,
    }

    impl Listener {
        pub fn bind(path: &Path) -> Result<Self> {
            if !path.to_string_lossy().starts_with(PIPE_PREFIX) {
                bail!(
                    "terminal host endpoint must be a named pipe such as \\\\.\\pipe\\patterm-host"
                );
            }
            let name = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let security = Security::current_user()?;
            // The first-instance flag fails when any process already serves this
            // name, which excludes a second host and a pipe planted in advance.
            let next = Instance::create(&name, &security, true)
                .context("terminal host pipe is already in use")?;
            Ok(Self {
                name,
                security,
                next,
            })
        }

        pub fn accept(&mut self) -> io::Result<(Stream, ())> {
            if self.next.connect.pending {
                match self.next.connect.poll(self.next.handle) {
                    Ok(None) => return Err(io::ErrorKind::WouldBlock.into()),
                    Ok(Some(_)) => {}
                    // The client left before the connection completed; listen
                    // again on a fresh instance.
                    Err(_) => {
                        let stale = mem::replace(
                            &mut self.next,
                            Instance::create(&self.name, &self.security, false)?,
                        );
                        drop(stale);
                        return Err(io::ErrorKind::Interrupted.into());
                    }
                }
            }
            let connected = mem::replace(
                &mut self.next,
                Instance::create(&self.name, &self.security, false)?,
            );
            Ok((connected.into_stream()?, ()))
        }
    }

    struct Instance {
        handle: HANDLE,
        connect: Box<Operation>,
    }

    impl Instance {
        fn create(name: &[u16], security: &Security, first: bool) -> io::Result<Self> {
            let attributes = SECURITY_ATTRIBUTES {
                nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: security.descriptor,
                bInheritHandle: FALSE,
            };
            let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
            if first {
                open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
            }
            let handle = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    open_mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    BUFFER_BYTES as u32,
                    BUFFER_BYTES as u32,
                    0,
                    &attributes,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            let mut instance = Self {
                handle,
                connect: match Operation::new(0) {
                    Ok(operation) => operation,
                    Err(error) => {
                        unsafe { CloseHandle(handle) };
                        return Err(error);
                    }
                },
            };
            instance.connect.reset();
            if unsafe { ConnectNamedPipe(handle, &mut instance.connect.overlapped) } == 0 {
                let error = io::Error::last_os_error();
                match error.raw_os_error().map(|code| code as u32) {
                    Some(ERROR_IO_PENDING) => instance.connect.pending = true,
                    // A client connected, and perhaps already left, between
                    // creating the instance and waiting for it. Reads report
                    // a departed client as end of stream.
                    Some(ERROR_PIPE_CONNECTED) | Some(ERROR_NO_DATA) => {}
                    _ => return Err(error),
                }
            }
            Ok(instance)
        }

        fn into_stream(self) -> io::Result<Stream> {
            let instance = mem::ManuallyDrop::new(self);
            // The connect operation has completed, so only its event remains.
            let connect = unsafe { ptr::read(&instance.connect) };
            drop(connect);
            Stream::new(instance.handle)
        }
    }

    impl Drop for Instance {
        fn drop(&mut self) {
            self.connect.cancel(self.handle);
            unsafe { CloseHandle(self.handle) };
        }
    }

    pub struct Stream {
        handle: HANDLE,
        read: Box<Operation>,
        write: Box<Operation>,
        // Bytes received by the last read and not yet returned.
        unread: std::ops::Range<usize>,
    }

    impl Stream {
        fn new(handle: HANDLE) -> io::Result<Self> {
            let operations = Operation::new(BUFFER_BYTES)
                .and_then(|read| Ok((read, Operation::new(BUFFER_BYTES)?)));
            let (read, write) = match operations {
                Ok(operations) => operations,
                Err(error) => {
                    unsafe { CloseHandle(handle) };
                    return Err(error);
                }
            };
            Ok(Self {
                handle,
                read,
                write,
                unread: 0..0,
            })
        }

        // Unix sockets are switched to nonblocking mode after accept. Pipe
        // operations here are always overlapped and never wait.
        pub fn set_nonblocking(&self, _nonblocking: bool) -> io::Result<()> {
            Ok(())
        }

        // Dropping the stream closes the pipe instance. A client reads the data
        // already written, then end of stream, as after a Unix socket shutdown.
        pub fn shutdown(&self, _how: std::net::Shutdown) -> io::Result<()> {
            Ok(())
        }
    }

    impl Read for Stream {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.unread.is_empty() {
                let completed = if self.read.pending {
                    self.read.poll(self.handle)
                } else {
                    self.read.start_read(self.handle)
                };
                match completed {
                    // A zero-byte write from the client is not end of stream.
                    Ok(None) | Ok(Some(0)) => return Err(io::ErrorKind::WouldBlock.into()),
                    Ok(Some(length)) => self.unread = 0..length,
                    Err(error) if is_disconnect(&error) => return Ok(0),
                    Err(error) => return Err(error),
                }
            }
            let length = self.unread.len().min(bytes.len());
            let start = self.unread.start;
            bytes[..length].copy_from_slice(&self.read.buffer[start..start + length]);
            self.unread.start += length;
            Ok(length)
        }
    }

    impl Write for Stream {
        // Accepts up to one buffer while no earlier write is in flight. A failed
        // write surfaces on the next call, which disconnects the controller.
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.write.pending && self.write.poll(self.handle)?.is_none() {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            let length = bytes.len().min(BUFFER_BYTES);
            self.write.buffer[..length].copy_from_slice(&bytes[..length]);
            self.write.reset();
            let written = unsafe {
                WriteFile(
                    self.handle,
                    self.write.buffer.as_ptr(),
                    length as u32,
                    ptr::null_mut(),
                    &mut self.write.overlapped,
                )
            };
            if written == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    return Err(error);
                }
                self.write.pending = true;
            }
            Ok(length)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            self.read.cancel(self.handle);
            self.write.cancel(self.handle);
            unsafe { CloseHandle(self.handle) };
        }
    }

    fn is_disconnect(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error().map(|code| code as u32),
            Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA)
        )
    }

    // One overlapped operation. It is boxed so the OVERLAPPED and its buffer
    // keep their addresses while the kernel may still write to them.
    struct Operation {
        overlapped: OVERLAPPED,
        buffer: Vec<u8>,
        pending: bool,
    }

    impl Operation {
        fn new(length: usize) -> io::Result<Box<Self>> {
            // A manual-reset event per operation lets cancellation wait for this
            // operation alone while another is in flight on the same handle.
            let event = unsafe { CreateEventW(ptr::null(), TRUE, FALSE, ptr::null()) };
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
            overlapped.hEvent = event;
            Ok(Box::new(Self {
                overlapped,
                buffer: vec![0; length],
                pending: false,
            }))
        }

        fn reset(&mut self) {
            let event = self.overlapped.hEvent;
            self.overlapped = unsafe { mem::zeroed() };
            self.overlapped.hEvent = event;
        }

        fn start_read(&mut self, handle: HANDLE) -> io::Result<Option<usize>> {
            self.reset();
            let read = unsafe {
                ReadFile(
                    handle,
                    self.buffer.as_mut_ptr(),
                    self.buffer.len() as u32,
                    ptr::null_mut(),
                    &mut self.overlapped,
                )
            };
            if read == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    return Err(error);
                }
            }
            // Completed or queued: either way the result is read from the
            // OVERLAPPED.
            self.pending = true;
            self.poll(handle)
        }

        // Ok(None) while the operation is still in flight.
        fn poll(&mut self, handle: HANDLE) -> io::Result<Option<usize>> {
            let mut transferred = 0;
            if unsafe { GetOverlappedResult(handle, &self.overlapped, &mut transferred, FALSE) }
                != 0
            {
                self.pending = false;
                return Ok(Some(transferred as usize));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
                return Ok(None);
            }
            self.pending = false;
            Err(error)
        }

        // Waits for a cancelled operation so the kernel no longer references
        // its buffer when the box is freed.
        fn cancel(&mut self, handle: HANDLE) {
            if !self.pending {
                return;
            }
            let mut transferred = 0;
            unsafe {
                CancelIoEx(handle, &self.overlapped);
                GetOverlappedResult(handle, &self.overlapped, &mut transferred, TRUE);
            }
            self.pending = false;
        }
    }

    impl Drop for Operation {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.overlapped.hEvent) };
        }
    }

    // A DACL granting the current user alone full access to the pipe. The
    // default pipe DACL lets Everyone read, which would expose terminal output.
    struct Security {
        descriptor: PSECURITY_DESCRIPTOR,
    }

    impl Security {
        fn current_user() -> Result<Self> {
            let sid = current_user_sid().context("failed to read the terminal host user")?;
            let sddl = format!("D:P(A;;GA;;;{sid})")
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error())
                    .context("failed to build the terminal host pipe security descriptor");
            }
            Ok(Self { descriptor })
        }
    }

    impl Drop for Security {
        fn drop(&mut self) {
            unsafe { LocalFree(self.descriptor) };
        }
    }

    fn current_user_sid() -> io::Result<String> {
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut length = 0_u32;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
                CloseHandle(token);
                return Err(error);
            }
            // u64 storage keeps TOKEN_USER's pointer fields aligned.
            let mut buffer = vec![0_u64; (length as usize).div_ceil(8)];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                length,
                &mut length,
            );
            let error = io::Error::last_os_error();
            CloseHandle(token);
            if ok == 0 {
                return Err(error);
            }
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut text = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return Err(io::Error::last_os_error());
            }
            let length = (0..).take_while(|&index| *text.add(index) != 0).count();
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text as *mut c_void);
            Ok(sid)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn overflowing_output_disconnects_controller_and_releases_backlog() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixStream;

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

    #[cfg(windows)]
    #[test]
    fn overflowing_output_disconnects_controller_and_releases_backlog() {
        use std::fs::OpenOptions;

        let path = std::path::PathBuf::from(format!(
            r"\\.\pipe\patterm-host-backpressure-{}",
            std::process::id()
        ));
        let open = || {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap()
        };
        let mut transport = SocketTransport::bind(&path).unwrap();
        assert!(
            SocketTransport::bind(&path).is_err(),
            "a second host cannot serve the same pipe"
        );
        let mut controller = open();
        transport.poll().unwrap();
        assert!(transport.connected());
        transport.write_all(&vec![0; MAX_OUTPUT_BYTES]).unwrap();
        assert!(transport.connected());
        transport.write_all(&[1]).unwrap();
        assert!(!transport.connected());
        assert!(transport.output.is_empty());
        assert!(transport.take_disconnected());
        assert_eq!(controller.read(&mut [0]).unwrap(), 0);

        let _next = open();
        transport.poll().unwrap();
        assert!(
            transport.connected(),
            "host accepts a fresh controller after overflow"
        );
    }

    #[cfg(windows)]
    #[test]
    fn pipe_streams_requests_and_responses_without_blocking() {
        use std::fs::OpenOptions;

        let path = std::path::PathBuf::from(format!(
            r"\\.\pipe\patterm-host-stream-{}",
            std::process::id()
        ));
        let mut transport = SocketTransport::bind(&path).unwrap();
        assert!(transport.poll().unwrap().is_empty(), "no client yet");
        let mut controller = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        transport.poll().unwrap();
        assert!(transport.connected());
        let mut competitor = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        transport.poll().unwrap();
        assert_eq!(
            competitor.read(&mut [0]).unwrap(),
            0,
            "a second controller is closed"
        );
        assert!(
            transport.connected(),
            "the first controller keeps ownership"
        );

        controller
            .write_all(b"{\"id\":1,\"method\":\"terminal.ping\",\"params\":{}}\n")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let requests = loop {
            let requests = transport.poll().unwrap();
            if !requests.is_empty() {
                break requests;
            }
            assert!(Instant::now() < deadline, "request arrives");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].as_ref().unwrap().method, "terminal.ping");

        // More than one pipe buffer: the transport keeps the rest queued and
        // finishes as the client reads.
        let payload = (0..256 * 1024)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        transport.write_all(&payload).unwrap();
        // The reader hands the client back so it stays connected for the
        // final check; dropping it would correctly read as a disconnect.
        let reader = std::thread::spawn(move || {
            let mut received = vec![0_u8; 256 * 1024];
            controller.read_exact(&mut received).unwrap();
            (received, controller)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !reader.is_finished() {
            transport.poll().unwrap();
            assert!(Instant::now() < deadline, "queued output drains");
            std::thread::sleep(Duration::from_millis(1));
        }
        let (received, _controller) = reader.join().unwrap();
        assert_eq!(received, payload);
        assert!(transport.connected());
    }
}
