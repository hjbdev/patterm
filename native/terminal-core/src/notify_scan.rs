//! Desktop notification capture from raw PTY output.
//!
//! The vte parser inside `alacritty_terminal` discards OSC 9, 777, and 99, so
//! `ScanningPty` tees every PTY read through `NotificationScanner` before the
//! event loop parses it. The scanner never changes the bytes it sees.

use std::io::{self, Read};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use alacritty_terminal::event::{OnResize, WindowSize};
use alacritty_terminal::tty::{ChildEvent, EventedPty, EventedReadWrite};
use polling::{Event, PollMode, Poller};

use crate::terminal::{SidecarMessage, TerminalNotification};

/// Longest accepted OSC payload, and longest accumulated OSC 99 field.
const MAX_PAYLOAD: usize = 4096;
/// Longest accepted OSC 99 identifier.
const MAX_OSC99_ID: usize = 64;

const BEL: u8 = 0x07;
const ESC: u8 = 0x1b;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Osc9,
    Osc777,
    Osc99,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ground,
    /// ESC seen outside a collected OSC.
    Escape,
    /// Reading the OSC number before the first `;`.
    Number {
        value: u16,
        digits: u8,
    },
    /// Buffering the payload of a recognised OSC.
    Collect(Kind),
    /// ESC seen inside a collected OSC; only `\` completes it.
    CollectEscape(Kind),
    /// Inside an OSC that is not a notification, or one that is too long.
    Skip,
}

struct PendingOsc99 {
    id: Vec<u8>,
    title: Vec<u8>,
    body: Vec<u8>,
    /// Set when a chunk exceeded the cap; the rest of this id is discarded.
    overflowed: bool,
}

/// Streaming recogniser for OSC 9, OSC 777 `notify`, and OSC 99 notifications.
///
/// Memory is bounded: one payload buffer and one pending OSC 99 notification,
/// each capped at `MAX_PAYLOAD` bytes per field.
pub struct NotificationScanner {
    state: State,
    payload: Vec<u8>,
    pending: Option<PendingOsc99>,
}

impl Default for NotificationScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl NotificationScanner {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            payload: Vec::new(),
            pending: None,
        }
    }

    pub fn feed(&mut self, bytes: &[u8], emit: &mut impl FnMut(TerminalNotification)) {
        let mut index = 0;
        while index < bytes.len() {
            match self.state {
                // Plain output: jump straight to the next ESC.
                State::Ground => match memchr::memchr(ESC, &bytes[index..]) {
                    Some(offset) => {
                        index += offset + 1;
                        self.state = State::Escape;
                    }
                    None => return,
                },
                // Unrelated OSC strings such as OSC 52 can be large.
                State::Skip => {
                    match bytes[index..]
                        .iter()
                        .position(|byte| matches!(*byte, BEL | ESC | CAN | SUB))
                    {
                        Some(offset) => {
                            index += offset;
                            self.step(bytes[index], emit);
                            index += 1;
                        }
                        None => return,
                    }
                }
                _ => {
                    self.step(bytes[index], emit);
                    index += 1;
                }
            }
        }
    }

    fn step(&mut self, byte: u8, emit: &mut impl FnMut(TerminalNotification)) {
        self.state = match self.state {
            State::Ground => {
                if byte == ESC {
                    State::Escape
                } else {
                    State::Ground
                }
            }
            State::Escape => escape_next(byte),
            State::Number { value, digits } => match byte {
                b'0'..=b'9' if digits < 3 => State::Number {
                    value: value * 10 + u16::from(byte - b'0'),
                    digits: digits + 1,
                },
                b';' if digits > 0 => match value {
                    9 => self.start(Kind::Osc9),
                    777 => self.start(Kind::Osc777),
                    99 => self.start(Kind::Osc99),
                    _ => State::Skip,
                },
                BEL | CAN | SUB => State::Ground,
                ESC => State::Escape,
                // vte ignores C0 controls inside OSC strings.
                0x00..=0x1f => self.state,
                _ => State::Skip,
            },
            State::Collect(kind) => match byte {
                BEL => {
                    self.dispatch(kind, emit);
                    State::Ground
                }
                ESC => State::CollectEscape(kind),
                CAN | SUB => State::Ground,
                0x00..=0x1f | 0x7f => self.state,
                _ if self.payload.len() >= MAX_PAYLOAD => State::Skip,
                _ => {
                    self.payload.push(byte);
                    self.state
                }
            },
            State::CollectEscape(kind) => {
                if byte == b'\\' {
                    self.dispatch(kind, emit);
                    State::Ground
                } else {
                    // Not ST: abandon the sequence and reinterpret this byte
                    // as the one following a fresh ESC.
                    escape_next(byte)
                }
            }
            State::Skip => match byte {
                BEL | CAN | SUB => State::Ground,
                ESC => State::Escape,
                _ => State::Skip,
            },
        };
    }

    fn start(&mut self, kind: Kind) -> State {
        self.payload.clear();
        State::Collect(kind)
    }

    fn dispatch(&mut self, kind: Kind, emit: &mut impl FnMut(TerminalNotification)) {
        let payload = std::mem::take(&mut self.payload);
        let notification = match kind {
            Kind::Osc9 => osc9(&payload),
            Kind::Osc777 => osc777(&payload),
            Kind::Osc99 => self.osc99(&payload),
        };
        // Reuse the allocation unless an oversized payload grew it.
        self.payload = payload;
        self.payload.clear();
        if let Some(notification) = notification {
            emit(notification);
        }
    }

    fn osc99(&mut self, payload: &[u8]) -> Option<TerminalNotification> {
        let separator = payload.iter().position(|byte| *byte == b';')?;
        let (metadata, data) = (&payload[..separator], &payload[separator + 1..]);
        let mut id: &[u8] = b"";
        let mut done = true;
        let mut body = false;
        let mut base64 = false;
        for entry in metadata.split(|byte| *byte == b':') {
            let Some(equals) = entry.iter().position(|byte| *byte == b'=') else {
                continue;
            };
            let (key, value) = (&entry[..equals], &entry[equals + 1..]);
            match key {
                b"i" => id = value,
                b"d" => done = value != b"0",
                b"e" => base64 = value == b"1",
                b"p" => match value {
                    b"title" => body = false,
                    b"body" => body = true,
                    // Queries, close, alive, icon, and buttons carry no text.
                    _ => return None,
                },
                _ => {}
            }
        }
        if id.len() > MAX_OSC99_ID {
            return None;
        }
        let decoded;
        let data = if base64 {
            decoded = decode_base64(data)?;
            &decoded[..]
        } else {
            data
        };

        let pending = match self.pending.take() {
            Some(pending) if pending.id == id => pending,
            // A different identifier abandons the previous partial notification.
            _ => PendingOsc99 {
                id: id.to_vec(),
                title: Vec::new(),
                body: Vec::new(),
                overflowed: false,
            },
        };
        let mut pending = pending;
        let field = if body {
            &mut pending.body
        } else {
            &mut pending.title
        };
        if field.len() + data.len() > MAX_PAYLOAD {
            pending.overflowed = true;
            pending.title = Vec::new();
            pending.body = Vec::new();
        } else if !pending.overflowed {
            field.extend_from_slice(data);
        }
        if !done {
            self.pending = Some(pending);
            return None;
        }
        if pending.overflowed {
            return None;
        }
        notification("osc99", clean(&pending.title), clean(&pending.body))
    }
}

fn escape_next(byte: u8) -> State {
    match byte {
        b']' => State::Number {
            value: 0,
            digits: 0,
        },
        ESC => State::Escape,
        _ => State::Ground,
    }
}

fn osc9(payload: &[u8]) -> Option<TerminalNotification> {
    // ConEmu uses `OSC 9 ; <n> ; ...` for progress and other sub-commands.
    let digits = payload
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits > 0 && (digits == payload.len() || payload[digits] == b';') {
        return None;
    }
    notification("osc9", None, clean(payload))
}

fn osc777(payload: &[u8]) -> Option<TerminalNotification> {
    let mut parts = payload.splitn(3, |byte| *byte == b';');
    if parts.next() != Some(b"notify") {
        return None;
    }
    let title = parts.next().and_then(clean);
    let body = parts.next().and_then(clean);
    notification("osc777", title, body)
}

fn notification(
    source: &'static str,
    title: Option<String>,
    body: Option<String>,
) -> Option<TerminalNotification> {
    if title.is_none() && body.is_none() {
        return None;
    }
    Some(TerminalNotification {
        source,
        title,
        body,
    })
}

/// Decode lossily, drop control characters, and trim. Empty text is `None`.
fn clean(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text
        .chars()
        .filter_map(|c| match c {
            '\t' | '\n' | '\r' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect::<String>();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn decode_base64(input: &[u8]) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0_u32;
    let mut bits = 0;
    for byte in input {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    Some(output)
}

/// PTY reader that feeds every byte through the scanner before returning it.
pub struct ScanningReader<P> {
    pty: P,
    scanner: NotificationScanner,
    process_id: String,
    tx: Sender<SidecarMessage>,
}

impl<P: EventedReadWrite> Read for ScanningReader<P> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.pty.reader().read(buf)?;
        let (process_id, tx) = (&self.process_id, &self.tx);
        self.scanner.feed(&buf[..read], &mut |notification| {
            let _ = tx.send(SidecarMessage::Notification {
                process_id: process_id.clone(),
                notification,
            });
        });
        Ok(read)
    }
}

/// `EventedPty` wrapper whose reader tees output through `NotificationScanner`.
pub struct ScanningPty<P> {
    reader: ScanningReader<P>,
}

impl<P> ScanningPty<P> {
    pub fn new(pty: P, process_id: String, tx: Sender<SidecarMessage>) -> Self {
        Self {
            reader: ScanningReader {
                pty,
                scanner: NotificationScanner::new(),
                process_id,
                tx,
            },
        }
    }
}

impl<P: EventedReadWrite> EventedReadWrite for ScanningPty<P> {
    type Reader = ScanningReader<P>;
    type Writer = P::Writer;

    unsafe fn register(
        &mut self,
        poll: &Arc<Poller>,
        interest: Event,
        mode: PollMode,
    ) -> io::Result<()> {
        // SAFETY: the wrapped PTY owns the registered sources and lives as long
        // as this wrapper.
        unsafe { self.reader.pty.register(poll, interest, mode) }
    }

    fn reregister(
        &mut self,
        poll: &Arc<Poller>,
        interest: Event,
        mode: PollMode,
    ) -> io::Result<()> {
        self.reader.pty.reregister(poll, interest, mode)
    }

    fn deregister(&mut self, poll: &Arc<Poller>) -> io::Result<()> {
        self.reader.pty.deregister(poll)
    }

    fn reader(&mut self) -> &mut Self::Reader {
        &mut self.reader
    }

    fn writer(&mut self) -> &mut Self::Writer {
        self.reader.pty.writer()
    }
}

impl<P: EventedPty> EventedPty for ScanningPty<P> {
    fn next_child_event(&mut self) -> Option<ChildEvent> {
        self.reader.pty.next_child_event()
    }
}

impl<P: OnResize> OnResize for ScanningPty<P> {
    fn on_resize(&mut self, window_size: WindowSize) {
        self.reader.pty.on_resize(window_size)
    }
}

#[cfg(test)]
#[path = "notify_scan_tests.rs"]
mod tests;
