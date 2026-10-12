use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::Arc;
#[cfg(test)]
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Column, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::{Cell, Hyperlink};
use alacritty_terminal::term::{viewport_to_point, Config, Term, TermDamage, TermMode};
use alacritty_terminal::tty::{self, Options, Shell};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
use anyhow::{Context, Result};
use serde_json::Value;

use crate::notify_scan::ScanningPty;
use crate::protocol::{write_frame, FRAME_TERMINAL_DAMAGE, FRAME_TERMINAL_LIFECYCLE};

const TERMINAL_FRAME_VERSION: u16 = 3;
const AGENT_SUBMIT_SETTLE_DELAY: Duration = Duration::from_millis(100);
const MAX_QUEUED_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUEUED_INPUT_CHUNKS: usize = 1024;
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
const BELL_THROTTLE: Duration = Duration::from_millis(2_000);
const ACTIVITY_IDLE_DELAY: Duration = Duration::from_millis(2_000);
const DEFAULT_FRAME_INTERVAL: Duration = Duration::from_millis(8);
const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(2);
const MAX_FRAME_INTERVAL: Duration = Duration::from_millis(200);
const TERMINAL_FOREGROUND: Rgb = Rgb {
    r: 0xfa,
    g: 0xfa,
    b: 0xfa,
};
const TERMINAL_BACKGROUND: Rgb = Rgb {
    r: 0x15,
    g: 0x15,
    b: 0x15,
};

// Keep OSC palette replies aligned with TerminalRenderer.ts namedColor().
const TERMINAL_PALETTE: [u32; 16] = [
    0x18181b, 0xef4444, 0x22c55e, 0xeab308, 0x3b82f6, 0xd946ef, 0x06b6d4, 0xe4e4e7, 0x71717a,
    0xf87171, 0x4ade80, 0xfacc15, 0x60a5fa, 0xe879f9, 0x22d3ee, 0xfafafa,
];

pub enum SidecarMessage {
    Request(crate::protocol::CoreRequest),
    InvalidRequest(String),
    TerminalEvent(TerminalEvent),
    /// OSC 9, 777, or 99 desktop notification captured from raw PTY output.
    Notification {
        process_id: String,
        notification: TerminalNotification,
    },
    StdinClosed,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TerminalNotification {
    pub source: &'static str,
    pub title: Option<String>,
    pub body: Option<String>,
}

pub struct TerminalEvent {
    process_id: String,
    event: Event,
    activity_source: bool,
}

pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
    next_id: u64,
    id_prefix: String,
    tx: Sender<SidecarMessage>,
    #[cfg(target_os = "linux")]
    process_cleanup: crate::process_cleanup::ProcessCleanup,
}

struct TerminalSession {
    title: String,
    kind: String,
    status: TerminalStatus,
    exit_code: Option<i32>,
    terminal: Arc<FairMutex<Term<SidecarEventProxy>>>,
    event_loop: EventLoopSender,
    pending_input: VecDeque<PendingInput>,
    input_deadline: Option<Instant>,
    cols: u16,
    rows: u16,
    cell_width: u16,
    cell_height: u16,
    resize_seq: u32,
    epoch: u32,
    next_frame_seq: u32,
    next_frame_kind: TerminalFrameKind,
    frame_dirty: bool,
    frame_deadline: Option<Instant>,
    frame_interval: Duration,
    visible_grid: Vec<Vec<EncodedCell>>,
    last_cursor: Option<CursorPosition>,
    activity: ActivityState,
    activity_deadline: Option<Instant>,
    damage_subscribed: bool,
    last_bell: Option<Instant>,
    // Whether a client is focused on this terminal, and whether the program
    // had focus reporting (DECSET 1004) on at the last wakeup.
    focused: bool,
    focus_reporting: bool,
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        // A closed stdio controller can fail an output write before its EOF
        // message is handled. Errors must still release managed descendants.
        if let Err(error) = self.shutdown() {
            eprintln!("terminal cleanup failed: {error:#}");
        }
    }
}

struct PendingInput {
    settle_delay: Duration,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ActivityState {
    Working,
    Idle,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TerminalFrameKind {
    Snapshot,
    Damage,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TerminalStatus {
    Running,
    Exited,
    Stopped,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MouseEventKind {
    Down,
    Up,
    Move,
}

#[derive(Clone)]
struct SidecarEventProxy {
    process_id: String,
    tx: Sender<SidecarMessage>,
}

#[derive(Clone, Copy)]
struct TerminalSize {
    cols: usize,
    rows: usize,
}

struct DamageRun {
    row: u16,
    start_col: u16,
    cells: Vec<EncodedCell>,
}

#[derive(Clone, PartialEq, Eq)]
struct EncodedCell {
    codepoint: u32,
    flags: u16,
    fg: EncodedColor,
    bg: EncodedColor,
    hyperlink: Option<Hyperlink>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct EncodedColor {
    kind: u8,
    value: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct CursorPosition {
    col: u16,
    row: u16,
    visible: bool,
    shape: EncodedCursorShape,
    resize_seq: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EncodedCursorShape {
    Block,
    Beam,
    Underline,
    Hidden,
}

impl TerminalManager {
    pub fn new(tx: Sender<SidecarMessage>) -> Self {
        Self::with_id_prefix(tx, "proc".to_string())
    }

    pub fn with_id_prefix(tx: Sender<SidecarMessage>, id_prefix: String) -> Self {
        tty::setup_env();
        Self {
            sessions: HashMap::new(),
            next_id: 0,
            id_prefix,
            tx,
            #[cfg(target_os = "linux")]
            process_cleanup: crate::process_cleanup::ProcessCleanup::new(),
        }
    }

    pub fn spawn(&mut self, params: Value) -> Result<Value> {
        self.next_id += 1;
        let process_id = format!("{}_{}", self.id_prefix, self.next_id);
        let title = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("terminal")
            .to_string();
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("terminal")
            .to_string();
        let cols = optional_u16(&params, "cols", 100).max(2);
        let rows = optional_u16(&params, "rows", 30).max(1);
        let cell_width = optional_u16(&params, "cell_width", 8).max(1);
        let cell_height = optional_u16(&params, "cell_height", 16).max(1);
        let cwd = params.get("cwd").and_then(Value::as_str).map(PathBuf::from);
        let command = params.get("command").and_then(Value::as_str);
        let args = params
            .get("args")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // Extra environment variables (string values only) merged into the
        // child's inherited environment — used to inject Patterm MCP context.
        let env = params
            .get("env")
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|text| (key.clone(), text.to_string()))
                    })
                    .collect::<HashMap<String, String>>()
            })
            .unwrap_or_default();
        let verbatim_args = params
            .get("verbatim_args")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        #[cfg(not(windows))]
        let _ = verbatim_args;

        let window_size = WindowSize {
            num_lines: rows,
            num_cols: cols,
            cell_width,
            cell_height,
        };
        let term_size = TerminalSize {
            cols: cols.into(),
            rows: rows.into(),
        };
        let event_proxy = SidecarEventProxy {
            process_id: process_id.clone(),
            tx: self.tx.clone(),
        };
        let terminal = Arc::new(FairMutex::new(Term::new(
            Config::default(),
            &term_size,
            event_proxy.clone(),
        )));
        let mut options = Options {
            working_directory: cwd,
            drain_on_exit: true,
            env,
            // ConPTY receives one command line. Quote arguments the way the
            // child's C runtime parses them, unless the caller already built
            // the command line tail (a cmd.exe invocation).
            #[cfg(windows)]
            escape_args: !verbatim_args,
            ..Options::default()
        };

        if let Some(command) = command {
            options.shell = Some(Shell::new(program_for_command_line(command), args));
        }

        let pty = tty::new(&options, window_size, self.next_id).context("failed to spawn pty")?;
        #[cfg(target_os = "linux")]
        self.process_cleanup.register(pty.child().id())?;
        let pty = ScanningPty::new(pty, process_id.clone(), self.tx.clone());
        let event_loop = EventLoop::new(terminal.clone(), event_proxy, pty, true, false)
            .context("failed to create terminal event loop")?;
        let event_loop_sender = event_loop.channel();
        event_loop.spawn();

        self.sessions.insert(
            process_id.clone(),
            TerminalSession {
                title,
                kind,
                status: TerminalStatus::Running,
                exit_code: None,
                terminal,
                event_loop: event_loop_sender,
                pending_input: VecDeque::new(),
                input_deadline: None,
                cols,
                rows,
                cell_width,
                cell_height,
                resize_seq: 0,
                epoch: 1,
                next_frame_seq: 0,
                next_frame_kind: TerminalFrameKind::Snapshot,
                frame_dirty: false,
                frame_deadline: None,
                frame_interval: DEFAULT_FRAME_INTERVAL,
                visible_grid: blank_encoded_grid(cols, rows),
                last_cursor: None,
                activity: ActivityState::Idle,
                activity_deadline: None,
                damage_subscribed: false,
                last_bell: None,
                focused: false,
                focus_reporting: false,
            },
        );

        Ok(serde_json::json!({
            "process_id": process_id,
            "status": "running",
            "engine": "alacritty_terminal",
            "transport": "framed-binary"
        }))
    }

    pub fn write_input(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let session = self.session(process_id)?;
        let kind = params.get("kind").and_then(Value::as_str).unwrap_or("text");
        let mut text = params
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let submit = params
            .get("submit")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let bracketed_paste = kind == "paste"
            && !text.is_empty()
            && session
                .terminal
                .lock()
                .mode()
                .contains(TermMode::BRACKETED_PASTE);
        if bracketed_paste {
            text = format!("\x1b[200~{text}\x1b[201~");
        }

        // Codex treats immediate Enter after raw text as part of a paste burst.
        // Bracketed paste has an explicit end marker and can submit immediately.
        let delay = if submit && session.kind == "agent" && !bracketed_paste {
            AGENT_SUBMIT_SETTLE_DELAY
        } else {
            Duration::ZERO
        };
        session.queue_input(text.into_bytes(), submit, delay)?;

        Ok(serde_json::json!({ "ok": true }))
    }

    pub fn resize(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let cols = optional_u16(&params, "cols", 100).max(2);
        let rows = optional_u16(&params, "rows", 30).max(1);
        let cell_width = optional_u16(&params, "cell_width", 8).max(1);
        let cell_height = optional_u16(&params, "cell_height", 16).max(1);
        let resize_seq = optional_u32(&params, "resize_seq", 0);
        let tx = self.tx.clone();
        let process_id_owned = process_id.to_string();
        let session = self.session(process_id)?;
        if session.cols == cols
            && session.rows == rows
            && session.cell_width == cell_width
            && session.cell_height == cell_height
        {
            // A returning view can wait for a new resize sequence even when
            // the PTY already fits. Acknowledge it without resizing the grid.
            if session.resize_seq != resize_seq {
                session.resize_seq = resize_seq;
                session.next_frame_kind = TerminalFrameKind::Snapshot;
                let _ = tx.send(SidecarMessage::TerminalEvent(TerminalEvent {
                    process_id: process_id_owned,
                    event: Event::Wakeup,
                    activity_source: false,
                }));
            }
            debug_log(|| {
                serde_json::json!({
                    "source": "terminal-sidecar",
                    "event": "resize.noop",
                    "process_id": process_id,
                    "cols": cols,
                    "rows": rows,
                    "cell_width": cell_width,
                    "cell_height": cell_height,
                    "resize_seq": resize_seq,
                    "epoch": session.epoch
                })
            });
            return Ok(serde_json::json!({ "ok": true, "cols": cols, "rows": rows }));
        }

        let previous_cols = session.cols;
        let previous_rows = session.rows;
        let previous_cell_width = session.cell_width;
        let previous_cell_height = session.cell_height;
        let previous_epoch = session.epoch;

        let window_size = WindowSize {
            num_lines: rows,
            num_cols: cols,
            cell_width,
            cell_height,
        };

        session.cols = cols;
        session.rows = rows;
        session.cell_width = cell_width;
        session.cell_height = cell_height;
        session.resize_seq = resize_seq;
        session.epoch = session.epoch.saturating_add(1).max(1);
        session.next_frame_kind = TerminalFrameKind::Snapshot;
        session.terminal.lock().resize(TerminalSize {
            cols: cols.into(),
            rows: rows.into(),
        });
        debug_log(|| {
            serde_json::json!({
                "source": "terminal-sidecar",
                "event": "resize.applied",
                "process_id": process_id,
                "from": {
                    "cols": previous_cols,
                    "rows": previous_rows,
                    "cell_width": previous_cell_width,
                    "cell_height": previous_cell_height,
                    "epoch": previous_epoch
                },
                "to": {
                    "cols": cols,
                    "rows": rows,
                    "cell_width": cell_width,
                    "cell_height": cell_height,
                    "epoch": session.epoch,
                    "resize_seq": resize_seq
                }
            })
        });
        session
            .event_loop
            .send(Msg::Resize(window_size))
            .context("failed to resize terminal")?;
        let _ = tx.send(SidecarMessage::TerminalEvent(TerminalEvent {
            process_id: process_id_owned,
            event: Event::Wakeup,
            activity_source: false,
        }));
        debug_log(|| {
            serde_json::json!({
                "source": "terminal-sidecar",
                "event": "resize.forced-wakeup",
                "process_id": process_id,
                "resize_seq": resize_seq,
                "epoch": session.epoch
            })
        });

        Ok(serde_json::json!({ "ok": true, "cols": cols, "rows": rows }))
    }

    // Force a fresh snapshot for a process without changing its size. Used when
    // a view attaches to an already-running PTY (e.g. switching terminal tabs).
    pub fn refresh(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let tx = self.tx.clone();
        let process_id_owned = process_id.to_string();
        let session = self.session(process_id)?;
        if !session.damage_subscribed {
            return Ok(serde_json::json!({ "ok": true, "subscribed": false }));
        }
        session.next_frame_kind = TerminalFrameKind::Snapshot;
        let _ = tx.send(SidecarMessage::TerminalEvent(TerminalEvent {
            process_id: process_id_owned,
            event: Event::Wakeup,
            activity_source: false,
        }));
        Ok(serde_json::json!({ "ok": true }))
    }

    pub fn subscribe(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let subscribed = params
            .get("subscribed")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // A view can detach after close has already removed the session.
        if !subscribed && !self.sessions.contains_key(process_id) {
            return Ok(serde_json::json!({ "ok": true, "subscribed": false }));
        }
        let session = self.session(process_id)?;
        session.damage_subscribed = subscribed;
        session.frame_dirty = false;
        session.frame_deadline = None;

        if subscribed {
            // Flush the attach snapshot on the next loop iteration. The frame
            // interval may still hold a slow cadence from when the view was
            // hidden, and the client reconfigures it after subscribing.
            session.next_frame_kind = TerminalFrameKind::Snapshot;
            session.frame_dirty = true;
            session.frame_deadline = Some(Instant::now());
        }

        Ok(serde_json::json!({ "ok": true, "subscribed": subscribed }))
    }

    pub fn configure(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let interval_ms = params
            .get("target_frame_interval_ms")
            .and_then(Value::as_f64)
            .unwrap_or(DEFAULT_FRAME_INTERVAL.as_secs_f64() * 1_000.0);
        let interval = Duration::from_secs_f64((interval_ms / 1_000.0).max(0.001))
            .clamp(MIN_FRAME_INTERVAL, MAX_FRAME_INTERVAL);
        let session = self.session(process_id)?;
        session.frame_interval = interval;

        Ok(serde_json::json!({
            "ok": true,
            "process_id": process_id,
            "target_frame_interval_ms": interval.as_secs_f64() * 1_000.0
        }))
    }

    pub fn stop(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let session = self.session(process_id)?;

        if matches!(
            session.status,
            TerminalStatus::Exited | TerminalStatus::Stopped
        ) {
            return Ok(serde_json::json!({ "ok": true, "status": session.status.as_str() }));
        }

        session.status = TerminalStatus::Stopped;
        session.pending_input.clear();
        session.input_deadline = None;
        session.activity_deadline = None;
        if session.event_loop.send(Msg::Shutdown).is_err() {
            return Ok(serde_json::json!({ "ok": true, "status": "stopped" }));
        }

        Ok(serde_json::json!({ "ok": true, "status": "stopped" }))
    }

    pub fn close(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        if let Some(session) = self.sessions.remove(process_id) {
            // The PTY reader retains its own terminal reference until shutdown.
            // Explicit close releases scrollback and cached frames; stop retains them.
            let _ = session.event_loop.send(Msg::Shutdown);
        }
        Ok(serde_json::json!({ "ok": true, "status": "closed" }))
    }

    pub fn output(&self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let session = self
            .sessions
            .get(process_id)
            .ok_or_else(|| anyhow::anyhow!("process not found: {process_id}"))?;

        let limit = params
            .get("max_lines")
            .and_then(Value::as_u64)
            .map(|limit| limit.clamp(1, 100) as usize);
        let lines = session.screen_lines(limit);

        Ok(serde_json::json!({
            "process_id": process_id,
            "status": session.status.as_str(),
            "transport": "framed-binary",
            "cols": session.cols,
            "rows": session.rows,
            "display_offset": session.display_offset(),
            "mouse": mouse_mode_json(*session.terminal.lock().mode()),
            "screen": lines.join("\n"),
            "lines": lines
        }))
    }

    pub fn search(&self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let query = params.get("query").and_then(Value::as_str).unwrap_or("");
        let case_sensitive = params
            .get("case_sensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let session = self
            .sessions
            .get(process_id)
            .ok_or_else(|| anyhow::anyhow!("process not found: {process_id}"))?;

        let needle = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };
        let matches = if needle.is_empty() {
            Vec::new()
        } else {
            session
                .screen_lines(None)
                .into_iter()
                .enumerate()
                .flat_map(|(row, line)| {
                    let haystack = if case_sensitive { line.clone() } else { line.to_lowercase() };
                    find_all(&haystack, &needle)
                        .into_iter()
                        .map(move |col| serde_json::json!({ "row": row, "col": col, "length": query.chars().count() }))
                })
                .collect::<Vec<_>>()
        };

        Ok(serde_json::json!({ "process_id": process_id, "query": query, "matches": matches }))
    }

    pub fn select(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let clear = params
            .get("clear")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let session = self.session(process_id)?;
        if clear {
            session.terminal.lock().selection = None;
            return Ok(serde_json::json!({ "ok": true, "selected": false }));
        }

        let start_col = optional_u16(&params, "start_col", 0).min(session.cols.saturating_sub(1));
        let start_row = optional_u16(&params, "start_row", 0).min(session.rows.saturating_sub(1));
        let end_col =
            optional_u16(&params, "end_col", start_col).min(session.cols.saturating_sub(1));
        let end_row =
            optional_u16(&params, "end_row", start_row).min(session.rows.saturating_sub(1));
        session.set_selection(start_col, start_row, end_col, end_row);

        Ok(serde_json::json!({ "ok": true, "selected": true, "text": session.selection_text() }))
    }

    pub fn selection_text(&self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let session = self
            .sessions
            .get(process_id)
            .ok_or_else(|| anyhow::anyhow!("process not found: {process_id}"))?;

        Ok(serde_json::json!({ "process_id": process_id, "text": session.selection_text() }))
    }

    pub fn scroll(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let lines = params.get("lines").and_then(Value::as_i64).unwrap_or(0);
        let tx = self.tx.clone();
        let process_id_owned = process_id.to_string();
        let session = self.session(process_id)?;
        let scroll = if lines < 0 {
            Some(Scroll::Delta(
                lines.unsigned_abs().min(i32::MAX as u64) as i32
            ))
        } else if lines > 0 {
            Some(Scroll::Delta(
                -(lines.unsigned_abs().min(i32::MAX as u64) as i32),
            ))
        } else {
            None
        };

        if let Some(scroll) = scroll {
            session.terminal.lock().scroll_display(scroll);
            session.next_frame_kind = TerminalFrameKind::Snapshot;
            let _ = tx.send(SidecarMessage::TerminalEvent(TerminalEvent {
                process_id: process_id_owned,
                event: Event::Wakeup,
                activity_source: false,
            }));
        }

        Ok(serde_json::json!({ "ok": true, "display_offset": session.display_offset() }))
    }

    pub fn wheel(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let lines = params.get("lines").and_then(Value::as_i64).unwrap_or(0);
        let col = optional_u16(&params, "col", 0);
        let row = optional_u16(&params, "row", 0);
        let tx = self.tx.clone();
        let process_id_owned = process_id.to_string();
        let session = self.session(process_id)?;

        let mode = *session.terminal.lock().mode();
        let input = if mode.intersects(TermMode::MOUSE_MODE) {
            Some(mouse_wheel_sequence(
                lines,
                col,
                row,
                mode.contains(TermMode::SGR_MOUSE),
            ))
        } else if mode.contains(TermMode::ALT_SCREEN) && mode.contains(TermMode::ALTERNATE_SCROLL) {
            Some(alternate_scroll_sequence(lines))
        } else {
            None
        };

        if let Some(text) = input {
            if !text.is_empty() {
                session.queue_input(text.into_bytes(), false, Duration::ZERO)?;
            }
        } else {
            scroll_session(session, lines, tx, process_id_owned);
        }

        Ok(serde_json::json!({ "ok": true, "display_offset": session.display_offset() }))
    }

    pub fn mouse(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let event = match params.get("event").and_then(Value::as_str).unwrap_or("") {
            "down" => MouseEventKind::Down,
            "up" => MouseEventKind::Up,
            "move" => MouseEventKind::Move,
            other => return Err(anyhow::anyhow!("unknown mouse event {other}")),
        };
        let button = params.get("button").and_then(Value::as_i64).unwrap_or(-1);
        let buttons = params.get("buttons").and_then(Value::as_u64).unwrap_or(0);
        let col = optional_u16(&params, "col", 0);
        let row = optional_u16(&params, "row", 0);
        let modifiers = mouse_modifier_code(
            params.get("alt").and_then(Value::as_bool).unwrap_or(false),
            params.get("ctrl").and_then(Value::as_bool).unwrap_or(false),
            params.get("meta").and_then(Value::as_bool).unwrap_or(false),
        );
        let session = self.session(process_id)?;
        let mode = *session.terminal.lock().mode();
        let Some(sequence) = mouse_sequence(event, button, buttons, col, row, modifiers, mode)
        else {
            return Ok(serde_json::json!({
                "ok": true,
                "reported": false,
                "mouse": mouse_mode_json(mode)
            }));
        };

        session.queue_input(sequence.into_bytes(), false, Duration::ZERO)?;

        Ok(serde_json::json!({
            "ok": true,
            "reported": true,
            "mouse": mouse_mode_json(mode)
        }))
    }

    // Focus in or out, as a terminal window reports it. Programs that enable
    // focus reporting receive CSI I or CSI O when the state changes.
    pub fn focus(&mut self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let focused = params
            .get("focused")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow::anyhow!("focused is required"))?;
        let session = self.session(process_id)?;
        let changed = session.focused != focused;
        session.focused = focused;
        let reporting = session
            .terminal
            .lock()
            .mode()
            .contains(TermMode::FOCUS_IN_OUT);
        let reported = changed && reporting && session.status == TerminalStatus::Running;
        if reported {
            session.queue_input(focus_sequence(focused).to_vec(), false, Duration::ZERO)?;
        }
        Ok(serde_json::json!({ "ok": true, "focused": focused, "reported": reported }))
    }

    pub fn status(&self, params: Value) -> Result<Value> {
        let process_id = required_string(&params, "process_id")?;
        let session = self
            .sessions
            .get(process_id)
            .ok_or_else(|| anyhow::anyhow!("process not found: {process_id}"))?;

        Ok(serde_json::json!({
            "process_id": process_id,
            "title": session.title,
            "kind": session.kind,
            "status": session.status.as_str(),
            "exit_code": session.exit_code,
            "activity": session.activity.as_str(),
            "engine": "alacritty_terminal",
            "implementation": "event_loop",
            "cols": session.cols,
            "rows": session.rows,
            "mouse": mouse_mode_json(*session.terminal.lock().mode())
        }))
    }

    pub fn list(&self) -> Result<Value> {
        let mut ids = self.sessions.keys().collect::<Vec<_>>();
        ids.sort();
        let processes = ids
            .into_iter()
            .map(|id| self.status(serde_json::json!({ "process_id": id })))
            .collect::<Result<Vec<_>>>()?;
        Ok(serde_json::json!({ "processes": processes }))
    }

    pub fn unsubscribe_all(&mut self) {
        for session in self.sessions.values_mut() {
            session.damage_subscribed = false;
            session.frame_dirty = false;
            session.frame_deadline = None;
        }
    }

    pub fn shutdown(&mut self) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.process_cleanup.shutdown()?;
        for session in self.sessions.values_mut() {
            session.pending_input.clear();
            session.input_deadline = None;
            let _ = session.event_loop.send(Msg::Shutdown);
        }
        // Let normal PTY teardown finish. The service supervisor enforces the
        // final deadline and kills descendants that ignore the terminal hangup.
        let deadline = Instant::now() + Duration::from_millis(500);
        while self
            .sessions
            .values()
            .any(|session| Arc::strong_count(&session.terminal) > 1)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        self.sessions.clear();
        Ok(())
    }

    pub fn write_event_frame<W: Write>(
        &mut self,
        writer: &mut W,
        event: TerminalEvent,
    ) -> Result<()> {
        match event.event {
            Event::Wakeup => {
                if let Some(session) = self.sessions.get_mut(&event.process_id) {
                    if event.activity_source {
                        session.mark_activity(writer, &event.process_id)?;
                    }
                    session.sync_focus_reporting();
                    session.mark_frame_dirty();
                }
            }
            Event::Title(title) => {
                if let Some(session) = self.sessions.get_mut(&event.process_id) {
                    session.title = title.clone();
                    write_lifecycle_frame(
                        writer,
                        serde_json::json!({
                            "process_id": event.process_id,
                            "event": "title",
                            "title": title
                        }),
                    )?;
                }
            }
            Event::ResetTitle => {
                if let Some(session) = self.sessions.get_mut(&event.process_id) {
                    session.title = "terminal".to_string();
                    write_lifecycle_frame(
                        writer,
                        serde_json::json!({
                            "process_id": event.process_id,
                            "event": "title",
                            "title": "terminal"
                        }),
                    )?;
                }
            }
            Event::ChildExit(status) => {
                if let Some(session) = self.sessions.get_mut(&event.process_id) {
                    if session.activity != ActivityState::Idle {
                        session.activity = ActivityState::Idle;
                        write_activity_frame(writer, &event.process_id, ActivityState::Idle)?;
                    }
                    session.status = TerminalStatus::Exited;
                    session.exit_code = status.code();
                    session.pending_input.clear();
                    session.input_deadline = None;
                    session.activity_deadline = None;
                    session.frame_dirty = true;
                    session.frame_deadline = None;
                    write_lifecycle_frame(
                        writer,
                        serde_json::json!({
                            "process_id": event.process_id,
                            "event": "exit",
                            "status": "exited",
                            "exit_code": status.code()
                        }),
                    )?;
                    if session.damage_subscribed {
                        let payload = session.damage_payload(&event.process_id)?;
                        if !payload.is_empty() {
                            write_frame(writer, FRAME_TERMINAL_DAMAGE, &payload)?;
                        }
                    }
                }
            }
            Event::PtyWrite(text) => {
                if let Some(session) = self.sessions.get_mut(&event.process_id) {
                    session
                        .event_loop
                        .send(Msg::Input(Cow::Owned(text.into_bytes())))
                        .context("failed to write terminal event response")?;
                }
            }
            Event::ColorRequest(index, format_response) => {
                let color = if let Some(value) = TERMINAL_PALETTE.get(index) {
                    Some(Rgb {
                        r: (value >> 16) as u8,
                        g: (value >> 8) as u8,
                        b: *value as u8,
                    })
                } else if index == NamedColor::Foreground as usize {
                    Some(TERMINAL_FOREGROUND)
                } else if index == NamedColor::Background as usize {
                    Some(TERMINAL_BACKGROUND)
                } else {
                    None
                };

                if let (Some(session), Some(color)) =
                    (self.sessions.get_mut(&event.process_id), color)
                {
                    let response = format_response(color);
                    session
                        .event_loop
                        .send(Msg::Input(Cow::Owned(response.into_bytes())))
                        .context("failed to write terminal color response")?;
                }
            }
            // OSC 52 copy. The engine's default policy already rejects OSC 52
            // reads, so programs can set but never inspect the user's clipboard.
            Event::ClipboardStore(_, text) => {
                if self.sessions.contains_key(&event.process_id)
                    && text.len() <= MAX_CLIPBOARD_BYTES
                {
                    write_lifecycle_frame(
                        writer,
                        serde_json::json!({
                            "process_id": event.process_id,
                            "event": "clipboard",
                            "text": text
                        }),
                    )?;
                }
            }
            // Throttle bells so a flood of BEL bytes produces few frames.
            Event::Bell => {
                if let Some(session) = self.sessions.get_mut(&event.process_id) {
                    let now = Instant::now();
                    if session
                        .last_bell
                        .is_none_or(|last| now.duration_since(last) >= BELL_THROTTLE)
                    {
                        session.last_bell = Some(now);
                        write_lifecycle_frame(
                            writer,
                            serde_json::json!({
                                "process_id": event.process_id,
                                "event": "notification",
                                "source": "bell"
                            }),
                        )?;
                    }
                }
            }
            Event::MouseCursorDirty => {
                if let Some(session) = self.sessions.get(&event.process_id) {
                    write_mouse_mode_frame(
                        writer,
                        &event.process_id,
                        *session.terminal.lock().mode(),
                    )?;
                }
            }
            _ => {}
        }

        Ok(())
    }

    pub fn write_notification_frame<W: Write>(
        &self,
        writer: &mut W,
        process_id: String,
        notification: TerminalNotification,
    ) -> Result<()> {
        if !self.sessions.contains_key(&process_id) {
            return Ok(());
        }
        let mut payload = serde_json::json!({
            "process_id": process_id,
            "event": "notification",
            "source": notification.source,
        });
        if let Some(title) = notification.title {
            payload["title"] = Value::String(title);
        }
        if let Some(body) = notification.body {
            payload["body"] = Value::String(body);
        }
        write_lifecycle_frame(writer, payload)
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        // A linear scan keeps scheduling simple for the workbench's terminal count.
        // Profile this scan before introducing a deadline heap for larger workloads.
        let deadline = self
            .sessions
            .values()
            .flat_map(|session| {
                [
                    session.frame_deadline,
                    session.activity_deadline,
                    session.input_deadline,
                ]
            })
            .flatten()
            .min();
        #[cfg(target_os = "linux")]
        let deadline = deadline
            .into_iter()
            .chain(self.process_cleanup.deadline())
            .min();
        deadline
    }

    pub fn write_due_events<W: Write>(&mut self, writer: &mut W) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.process_cleanup.reap_if_due()?;
        let now = Instant::now();
        for (process_id, session) in &mut self.sessions {
            // Failed delivery clears the queue. The lifecycle event reports PTY
            // exit; sibling terminals must keep running.
            let _ = session.flush_input();
            if session
                .frame_deadline
                .is_some_and(|deadline| deadline <= now)
            {
                session.frame_deadline = None;
                session.write_pending_damage(writer, process_id)?;
            }
            if session
                .activity_deadline
                .is_some_and(|deadline| deadline <= now)
            {
                session.activity_deadline = None;
                if session.status == TerminalStatus::Running
                    && session.activity == ActivityState::Working
                {
                    session.activity = ActivityState::Idle;
                    write_activity_frame(writer, process_id, ActivityState::Idle)?;
                }
            }
        }
        Ok(())
    }

    fn session(&mut self, process_id: &str) -> Result<&mut TerminalSession> {
        self.sessions
            .get_mut(process_id)
            .ok_or_else(|| anyhow::anyhow!("process not found: {process_id}"))
    }
}

fn write_activity_frame<W: Write>(
    writer: &mut W,
    process_id: &str,
    activity: ActivityState,
) -> Result<()> {
    write_lifecycle_frame(
        writer,
        serde_json::json!({
            "process_id": process_id,
            "event": "activity",
            "activity": activity.as_str()
        }),
    )
}

fn write_mouse_mode_frame<W: Write>(
    writer: &mut W,
    process_id: &str,
    mode: TermMode,
) -> Result<()> {
    write_lifecycle_frame(
        writer,
        serde_json::json!({
            "process_id": process_id,
            "event": "mouse_mode",
            "mouse": mouse_mode_json(mode)
        }),
    )
}

impl ActivityState {
    fn as_str(&self) -> &'static str {
        match self {
            ActivityState::Working => "working",
            ActivityState::Idle => "idle",
        }
    }
}

fn scroll_session(
    session: &mut TerminalSession,
    lines: i64,
    tx: Sender<SidecarMessage>,
    process_id: String,
) {
    let scroll = if lines < 0 {
        Some(Scroll::Delta(
            lines.unsigned_abs().min(i32::MAX as u64) as i32
        ))
    } else if lines > 0 {
        Some(Scroll::Delta(
            -(lines.unsigned_abs().min(i32::MAX as u64) as i32),
        ))
    } else {
        None
    };

    if let Some(scroll) = scroll {
        session.terminal.lock().scroll_display(scroll);
        session.next_frame_kind = TerminalFrameKind::Snapshot;
        let _ = tx.send(SidecarMessage::TerminalEvent(TerminalEvent {
            process_id,
            event: Event::Wakeup,
            activity_source: false,
        }));
    }
}

fn alternate_scroll_sequence(lines: i64) -> String {
    let count = lines.unsigned_abs().min(100) as usize;
    let sequence = if lines < 0 { "\x1b[A" } else { "\x1b[B" };
    sequence.repeat(count)
}

fn mouse_wheel_sequence(lines: i64, col: u16, row: u16, sgr_mouse: bool) -> String {
    let count = lines.unsigned_abs().min(100) as usize;
    if count == 0 {
        return String::new();
    }

    let button = if lines < 0 { 64 } else { 65 };
    let x = u32::from(col) + 1;
    let y = u32::from(row) + 1;
    let sequence = if sgr_mouse {
        format!("\x1b[<{button};{x};{y}M")
    } else {
        normal_mouse_sequence(button, x, y)
    };
    sequence.repeat(count)
}

fn mouse_sequence(
    event: MouseEventKind,
    button: i64,
    buttons: u64,
    col: u16,
    row: u16,
    modifiers: u32,
    mode: TermMode,
) -> Option<String> {
    if !mode.intersects(TermMode::MOUSE_MODE) {
        return None;
    }

    let button = match event {
        MouseEventKind::Down => mouse_button_code(button)?,
        MouseEventKind::Up => mouse_button_code(button)?,
        MouseEventKind::Move if buttons == 0 => {
            if !mode.contains(TermMode::MOUSE_MOTION) {
                return None;
            }
            35
        }
        MouseEventKind::Move => {
            if !(mode.contains(TermMode::MOUSE_DRAG) || mode.contains(TermMode::MOUSE_MOTION)) {
                return None;
            }
            32 + mouse_buttons_code(buttons)?
        }
    } + modifiers;

    Some(mouse_button_sequence(
        button,
        col,
        row,
        mode.contains(TermMode::SGR_MOUSE),
        event == MouseEventKind::Up,
    ))
}

fn mouse_button_sequence(
    button: u32,
    col: u16,
    row: u16,
    sgr_mouse: bool,
    release: bool,
) -> String {
    let x = u32::from(col) + 1;
    let y = u32::from(row) + 1;
    if sgr_mouse {
        let suffix = if release { 'm' } else { 'M' };
        return format!("\x1b[<{button};{x};{y}{suffix}");
    }

    normal_mouse_sequence(if release { 3 + (button & !3) } else { button }, x, y)
}

fn mouse_button_code(button: i64) -> Option<u32> {
    match button {
        0 => Some(0),
        1 => Some(1),
        2 => Some(2),
        _ => None,
    }
}

fn mouse_buttons_code(buttons: u64) -> Option<u32> {
    if buttons & 1 != 0 {
        Some(0)
    } else if buttons & 4 != 0 {
        Some(1)
    } else if buttons & 2 != 0 {
        Some(2)
    } else {
        None
    }
}

fn mouse_modifier_code(alt: bool, ctrl: bool, meta: bool) -> u32 {
    let mut code = 0;
    if alt || meta {
        code += 8;
    }
    if ctrl {
        code += 16;
    }
    code
}

fn normal_mouse_sequence(button: u32, x: u32, y: u32) -> String {
    let encode = |value: u32| char::from_u32((value + 32).min(255)).unwrap_or('\u{fffd}');
    format!("\x1b[M{}{}{}", encode(button), encode(x), encode(y))
}

fn focus_sequence(focused: bool) -> &'static [u8] {
    if focused {
        b"\x1b[I"
    } else {
        b"\x1b[O"
    }
}

fn mouse_mode_json(mode: TermMode) -> Value {
    serde_json::json!({
        "click": mode.contains(TermMode::MOUSE_REPORT_CLICK),
        "drag": mode.contains(TermMode::MOUSE_DRAG),
        "motion": mode.contains(TermMode::MOUSE_MOTION),
        "sgr": mode.contains(TermMode::SGR_MOUSE)
    })
}

impl TerminalSession {
    // A program that turns focus reporting on while nobody is looking at it
    // learns it is unfocused, as it would in a background terminal window.
    fn sync_focus_reporting(&mut self) {
        let reporting = self.terminal.lock().mode().contains(TermMode::FOCUS_IN_OUT);
        if reporting
            && !self.focus_reporting
            && !self.focused
            && self.status == TerminalStatus::Running
        {
            let _ = self.queue_input(focus_sequence(false).to_vec(), false, Duration::ZERO);
        }
        self.focus_reporting = reporting;
    }

    fn queue_input(&mut self, text: Vec<u8>, submit: bool, delay: Duration) -> Result<()> {
        let added_chunks = usize::from(!text.is_empty()) + usize::from(submit);
        if added_chunks == 0 {
            return Ok(());
        }
        if self.status != TerminalStatus::Running {
            return Err(anyhow::anyhow!("terminal is not running"));
        }
        let queued_bytes: usize = self
            .pending_input
            .iter()
            .map(|input| input.bytes.len())
            .sum();
        if self.pending_input.len() + added_chunks > MAX_QUEUED_INPUT_CHUNKS
            || queued_bytes + text.len() + usize::from(submit) > MAX_QUEUED_INPUT_BYTES
        {
            return Err(anyhow::anyhow!("terminal input queue is full"));
        }
        if !text.is_empty() {
            self.pending_input.push_back(PendingInput {
                settle_delay: Duration::ZERO,
                bytes: text,
            });
        }
        if submit {
            self.pending_input.push_back(PendingInput {
                settle_delay: delay,
                bytes: b"\r".to_vec(),
            });
        }
        if self.input_deadline.is_none() {
            self.input_deadline = self
                .pending_input
                .front()
                .map(|input| Instant::now() + input.settle_delay);
        }
        self.flush_input()
    }

    fn flush_input(&mut self) -> Result<()> {
        while self
            .input_deadline
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            let input = self.pending_input.pop_front().unwrap();
            self.input_deadline = None;
            if let Err(error) = self.event_loop.send(Msg::Input(Cow::Owned(input.bytes))) {
                self.pending_input.clear();
                return Err(error).context("failed to write terminal input");
            }
            // Start the next wait from actual dispatch. A stalled main loop must
            // not collapse an overdue raw paste and Enter into the same burst.
            self.input_deadline = self
                .pending_input
                .front()
                .map(|input| Instant::now() + input.settle_delay);
        }
        Ok(())
    }

    fn mark_activity<W: Write>(&mut self, writer: &mut W, process_id: &str) -> Result<()> {
        if self.status != TerminalStatus::Running {
            return Ok(());
        }
        self.activity_deadline = Some(Instant::now() + ACTIVITY_IDLE_DELAY);
        if self.activity != ActivityState::Working {
            self.activity = ActivityState::Working;
            write_activity_frame(writer, process_id, ActivityState::Working)?;
        }
        Ok(())
    }

    fn mark_frame_dirty(&mut self) {
        if !self.damage_subscribed {
            return;
        }
        self.frame_dirty = true;
        self.frame_deadline
            .get_or_insert_with(|| Instant::now() + self.frame_interval);
    }

    fn write_pending_damage<W: Write>(&mut self, writer: &mut W, process_id: &str) -> Result<()> {
        if !self.frame_dirty {
            return Ok(());
        }

        self.frame_dirty = false;
        let payload = self.damage_payload(process_id)?;
        if payload.is_empty() {
            return Ok(());
        }

        write_frame(writer, FRAME_TERMINAL_DAMAGE, &payload)?;
        Ok(())
    }

    fn damage_payload(&mut self, process_id: &str) -> Result<Vec<u8>> {
        let mut terminal = self.terminal.lock();
        let frame_kind = self.next_frame_kind;
        let damaged_rows = if frame_kind == TerminalFrameKind::Snapshot {
            (0..self.rows).collect()
        } else {
            collect_damage_rows(&mut terminal, self.rows)
        };

        let renderable = terminal.renderable_content();
        let cursor = CursorPosition {
            col: u16::try_from(renderable.cursor.point.column.0)
                .unwrap_or(0)
                .min(self.cols.saturating_sub(1)),
            row: u16::try_from(renderable.cursor.point.line.0)
                .unwrap_or(0)
                .min(self.rows.saturating_sub(1)),
            visible: renderable.cursor.shape != CursorShape::Hidden,
            shape: EncodedCursorShape::from_shape(renderable.cursor.shape),
            resize_seq: self.resize_seq,
        };
        let previous_cursor = self.last_cursor;
        if self.visible_grid.len() != usize::from(self.rows)
            || self.visible_grid.first().map(Vec::len) != Some(usize::from(self.cols))
        {
            self.visible_grid = blank_encoded_grid(self.cols, self.rows);
        }

        // Damage rows are viewport coordinates, including when viewing scrollback.
        // Update the retained grid in place instead of rebuilding every visible cell.
        let mut runs = Vec::new();
        for &row in &damaged_rows {
            let point = viewport_to_point(
                renderable.display_offset,
                Point::new(usize::from(row), Column(0)),
            );
            let line = &terminal.grid()[point.line];
            let cached = &mut self.visible_grid[usize::from(row)];
            if frame_kind == TerminalFrameKind::Snapshot {
                for (col, cell) in cached.iter_mut().enumerate() {
                    *cell = EncodedCell::from_cell(&line[Column(col)]);
                }
                runs.push(DamageRun {
                    row,
                    start_col: 0,
                    cells: cached.clone(),
                });
                continue;
            }

            let mut start_col = 0;
            let mut cells = Vec::new();
            for col in 0..usize::from(self.cols) {
                let cell = EncodedCell::from_cell(&line[Column(col)]);
                if cached[col] != cell {
                    if cells.is_empty() {
                        start_col = col as u16;
                    }
                    cached[col] = cell.clone();
                    cells.push(cell);
                } else if !cells.is_empty() {
                    runs.push(DamageRun {
                        row,
                        start_col,
                        cells,
                    });
                    cells = Vec::new();
                }
            }
            if !cells.is_empty() {
                runs.push(DamageRun {
                    row,
                    start_col,
                    cells,
                });
            }
        }
        let cursor_changed = previous_cursor != Some(cursor);

        if runs.is_empty() && !cursor_changed {
            self.last_cursor = Some(cursor);
            terminal.reset_damage();
            debug_log(|| {
                serde_json::json!({
                    "source": "terminal-sidecar",
                    "event": "frame.skip-empty-damage",
                    "process_id": process_id,
                    "frame_kind": frame_kind.as_str(),
                    "epoch": self.epoch,
                    "resize_seq": self.resize_seq,
                    "cols": self.cols,
                    "rows": self.rows,
                    "damaged_rows": damaged_rows.len()
                })
            });
            return Ok(Vec::new());
        }

        self.last_cursor = Some(cursor);
        let frame_seq = self.next_frame_seq;
        self.next_frame_seq = self.next_frame_seq.wrapping_add(1);
        self.next_frame_kind = TerminalFrameKind::Damage;

        terminal.reset_damage();
        debug_log(|| {
            serde_json::json!({
                "source": "terminal-sidecar",
                "event": "frame.emit",
                "process_id": process_id,
                "frame_kind": frame_kind.as_str(),
                "frame_seq": frame_seq,
                "epoch": self.epoch,
                "resize_seq": self.resize_seq,
                "cols": self.cols,
                "rows": self.rows,
                "run_count": runs.len(),
                "cell_count": runs.iter().map(|run| run.cells.len()).sum::<usize>(),
                "damaged_rows": damaged_rows.len(),
                "cursor": {
                    "col": cursor.col,
                    "row": cursor.row,
                    "visible": cursor.visible,
                    "shape": cursor.shape.as_str()
                }
            })
        });
        encode_damage_payload(
            process_id, self.cols, self.rows, cursor, frame_kind, frame_seq, self.epoch, &runs,
        )
    }

    fn screen_lines(&self, limit: Option<usize>) -> Vec<String> {
        let terminal = self.terminal.lock();
        let display_offset = terminal.grid().display_offset();
        let rows = usize::from(self.rows);
        let start = rows.saturating_sub(limit.unwrap_or(rows));
        (start..rows)
            .map(|row| {
                let point = viewport_to_point(display_offset, Point::new(row, Column(0)));
                let line = &terminal.grid()[point.line];
                let mut text = String::with_capacity(usize::from(self.cols));
                for col in 0..usize::from(self.cols) {
                    text.push(line[Column(col)].c);
                }
                text.truncate(text.trim_end().len());
                text
            })
            .collect()
    }

    fn set_selection(&self, start_col: u16, start_row: u16, end_col: u16, end_row: u16) {
        let mut terminal = self.terminal.lock();
        let display_offset = terminal.grid().display_offset();
        let start = viewport_to_point(
            display_offset,
            Point::new(usize::from(start_row), Column(usize::from(start_col))),
        );
        let end = viewport_to_point(
            display_offset,
            Point::new(usize::from(end_row), Column(usize::from(end_col))),
        );
        // Select whole cells: start at the left boundary and end at the right boundary.
        let mut selection = Selection::new(SelectionType::Simple, start, Side::Left);
        selection.update(end, Side::Right);
        terminal.selection = Some(selection);
    }

    fn selection_text(&self) -> String {
        self.terminal
            .lock()
            .selection_to_string()
            .unwrap_or_default()
    }

    fn display_offset(&self) -> usize {
        self.terminal.lock().grid().display_offset()
    }
}

impl TerminalStatus {
    fn as_str(self) -> &'static str {
        match self {
            TerminalStatus::Running => "running",
            TerminalStatus::Exited => "exited",
            TerminalStatus::Stopped => "stopped",
        }
    }
}

impl EncodedCell {
    fn blank() -> Self {
        Self {
            codepoint: u32::from(' '),
            flags: 0,
            fg: EncodedColor::named(NamedColor::Foreground),
            bg: EncodedColor::named(NamedColor::Background),
            hyperlink: None,
        }
    }

    fn from_cell(cell: &Cell) -> Self {
        Self {
            codepoint: cell.c as u32,
            flags: cell.flags.bits(),
            fg: EncodedColor::from_color(cell.fg),
            bg: EncodedColor::from_color(cell.bg),
            hyperlink: cell.hyperlink(),
        }
    }
}

impl EncodedColor {
    fn named(color: NamedColor) -> Self {
        Self {
            kind: 0,
            value: color as u32,
        }
    }

    fn from_color(color: Color) -> Self {
        match color {
            Color::Named(color) => Self::named(color),
            Color::Indexed(index) => Self {
                kind: 1,
                value: u32::from(index),
            },
            Color::Spec(rgb) => {
                let value = (u32::from(rgb.r) << 16) | (u32::from(rgb.g) << 8) | u32::from(rgb.b);
                Self { kind: 2, value }
            }
        }
    }
}

impl EncodedCursorShape {
    fn from_shape(shape: CursorShape) -> Self {
        match shape {
            CursorShape::Block | CursorShape::HollowBlock => Self::Block,
            CursorShape::Beam => Self::Beam,
            CursorShape::Underline => Self::Underline,
            CursorShape::Hidden => Self::Hidden,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Block => 0,
            Self::Beam => 1,
            Self::Underline => 2,
            Self::Hidden => 3,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Beam => "beam",
            Self::Underline => "underline",
            Self::Hidden => "hidden",
        }
    }
}

impl EventListener for SidecarEventProxy {
    fn send_event(&self, event: Event) {
        let _ = self.tx.send(SidecarMessage::TerminalEvent(TerminalEvent {
            process_id: self.process_id.clone(),
            event,
            activity_source: true,
        }));
    }
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

fn collect_damage_rows<T: EventListener>(terminal: &mut Term<T>, rows: u16) -> Vec<u16> {
    let mut rows: Vec<u16> = match terminal.damage() {
        TermDamage::Full => (0..rows).collect(),
        TermDamage::Partial(damage) => damage
            .filter_map(|line| u16::try_from(line.line).ok())
            .filter(|line| *line < rows)
            .collect(),
    };
    rows.sort_unstable();
    rows.dedup();
    rows
}

fn blank_encoded_grid(cols: u16, rows: u16) -> Vec<Vec<EncodedCell>> {
    vec![vec![EncodedCell::blank(); usize::from(cols)]; usize::from(rows)]
}

fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    haystack
        .match_indices(needle)
        .map(|(byte_index, _)| haystack[..byte_index].chars().count())
        .collect()
}

fn encode_damage_payload(
    process_id: &str,
    cols: u16,
    rows: u16,
    cursor: CursorPosition,
    frame_kind: TerminalFrameKind,
    frame_seq: u32,
    epoch: u32,
    runs: &[DamageRun],
) -> Result<Vec<u8>> {
    let process_id_bytes = process_id.as_bytes();
    let process_id_len = u16::try_from(process_id_bytes.len())
        .map_err(|_| anyhow::anyhow!("process id too long"))?;
    let run_count =
        u16::try_from(runs.len()).map_err(|_| anyhow::anyhow!("too many damage runs"))?;
    // Version 3 retains the v2 cell layout and appends hyperlink spans:
    // count:u16, then (run index, cell offset, cell count, URI byte length):u16
    // followed by UTF-8 URI bytes. Each span stores its URI once.
    let mut links = Vec::new();
    for (run_index, run) in runs.iter().enumerate() {
        let mut start = 0;
        while start < run.cells.len() {
            let Some(link) = &run.cells[start].hyperlink else {
                start += 1;
                continue;
            };
            let mut end = start + 1;
            while end < run.cells.len()
                && run.cells[end].hyperlink.as_ref().map(Hyperlink::uri) == Some(link.uri())
            {
                end += 1;
            }
            // Oversized destinations remain visible but cannot be opened.
            if let Ok(uri_len) = u16::try_from(link.uri().len()) {
                links.push((
                    run_index as u16,
                    start as u16,
                    (end - start) as u16,
                    uri_len,
                    link.uri(),
                ));
            }
            start = end;
        }
    }
    let link_count =
        u16::try_from(links.len()).map_err(|_| anyhow::anyhow!("too many hyperlink spans"))?;

    let payload_len = 29
        + 2
        + links.iter().map(|link| 8 + link.4.len()).sum::<usize>()
        + process_id_bytes.len()
        + runs
            .iter()
            .map(|run| 6 + run.cells.len() * 16)
            .sum::<usize>();
    let mut payload = Vec::with_capacity(payload_len);

    payload.extend_from_slice(&TERMINAL_FRAME_VERSION.to_le_bytes());
    payload.push(frame_kind.as_u8());
    payload.extend_from_slice(&frame_seq.to_le_bytes());
    payload.extend_from_slice(&epoch.to_le_bytes());
    payload.extend_from_slice(&cursor.resize_seq.to_le_bytes());
    payload.extend_from_slice(&process_id_len.to_le_bytes());
    payload.extend_from_slice(process_id_bytes);
    payload.extend_from_slice(&cols.to_le_bytes());
    payload.extend_from_slice(&rows.to_le_bytes());
    payload.extend_from_slice(&cursor.col.to_le_bytes());
    payload.extend_from_slice(&cursor.row.to_le_bytes());
    payload.push(u8::from(cursor.visible));
    payload.push(cursor.shape.as_u8());
    payload.extend_from_slice(&run_count.to_le_bytes());

    for run in runs {
        let cell_count =
            u16::try_from(run.cells.len()).map_err(|_| anyhow::anyhow!("too many cells"))?;
        payload.extend_from_slice(&run.row.to_le_bytes());
        payload.extend_from_slice(&run.start_col.to_le_bytes());
        payload.extend_from_slice(&cell_count.to_le_bytes());
        for cell in &run.cells {
            payload.extend_from_slice(&cell.codepoint.to_le_bytes());
            payload.extend_from_slice(&cell.flags.to_le_bytes());
            payload.push(cell.fg.kind);
            payload.extend_from_slice(&cell.fg.value.to_le_bytes());
            payload.push(cell.bg.kind);
            payload.extend_from_slice(&cell.bg.value.to_le_bytes());
        }
    }

    payload.extend_from_slice(&link_count.to_le_bytes());
    for (run, start, count, uri_len, uri) in links {
        payload.extend_from_slice(&run.to_le_bytes());
        payload.extend_from_slice(&start.to_le_bytes());
        payload.extend_from_slice(&count.to_le_bytes());
        payload.extend_from_slice(&uri_len.to_le_bytes());
        payload.extend_from_slice(uri.as_bytes());
    }

    Ok(payload)
}

impl TerminalFrameKind {
    fn as_u8(self) -> u8 {
        match self {
            Self::Snapshot => 0,
            Self::Damage => 1,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::Damage => "damage",
        }
    }
}

fn debug_log(value: impl FnOnce() -> serde_json::Value) {
    if env::var_os("PATTERM_DEBUG_TERMINAL").is_some() {
        eprintln!("{}", value());
    }
}

fn write_lifecycle_frame<W: Write>(writer: &mut W, payload: serde_json::Value) -> Result<()> {
    let payload = serde_json::to_vec(&payload)?;
    write_frame(writer, FRAME_TERMINAL_LIFECYCLE, &payload)?;
    Ok(())
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing string param {key}"))
}

/// Alacritty writes the program into the Windows command line unescaped, so a
/// path such as `C:\Program Files\...\pwsh.exe` would be split at the space.
#[cfg(windows)]
fn program_for_command_line(command: &str) -> String {
    if command.contains([' ', '\t']) && !command.starts_with('"') {
        format!("\"{command}\"")
    } else {
        command.to_string()
    }
}

#[cfg(not(windows))]
fn program_for_command_line(command: &str) -> String {
    command.to_string()
}

fn optional_u16(params: &Value, key: &str, default: u16) -> u16 {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(default)
}

fn optional_u32(params: &Value, key: &str, default: u32) -> u32 {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(default)
}

#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "scheduling_tests.rs"]
mod scheduling_tests;
