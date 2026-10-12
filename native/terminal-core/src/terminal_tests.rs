use super::*;
use alacritty_terminal::vte::ansi::Processor;
use std::hint::black_box;
use std::sync::mpsc;

/// Spawn parameters for a child that stays alive, prints nothing of its own,
/// and echoes what it is sent: `/bin/cat` on Unix, `findstr ^` on Windows.
pub(super) fn cat_params(cols: u16, rows: u16) -> Value {
    #[cfg(windows)]
    let (command, args) = ("findstr.exe", vec!["^"]);
    #[cfg(not(windows))]
    let (command, args) = ("/bin/cat", Vec::<&str>::new());
    serde_json::json!({ "command": command, "args": args, "cols": cols, "rows": rows })
}

/// How long a scripted child may take to start, run, and exit. Cold
/// PowerShell starts on a busy CI runner, with tests running in parallel,
/// take many seconds.
pub(super) const SCRIPT_DEADLINE: Duration =
    Duration::from_secs(if cfg!(windows) { 30 } else { 2 });

/// Spawn parameters that run `unix` under `/bin/sh -c`, or `windows` as a
/// Windows PowerShell command (the Windows scripts build escapes with
/// `[char]27`, which 5.1 and 7 both understand).
pub(super) fn script_params(unix: &str, windows: &str, cols: u16, rows: u16) -> Value {
    let (command, args) = if cfg!(windows) {
        (
            "powershell.exe",
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windows,
            ],
        )
    } else {
        ("/bin/sh", vec!["-c", unix])
    };
    serde_json::json!({ "command": command, "args": args, "cols": cols, "rows": rows })
}

struct Fixture {
    manager: TerminalManager,
    process_id: String,
    parser: Processor,
}

impl Fixture {
    fn new(cols: u16, rows: u16) -> Self {
        let (tx, _rx) = mpsc::channel();
        let mut manager = TerminalManager::new(tx);
        let result = manager.spawn(cat_params(cols, rows)).unwrap();
        Self {
            manager,
            process_id: result["process_id"].as_str().unwrap().to_string(),
            parser: Processor::new(),
        }
    }

    fn session(&mut self) -> &mut TerminalSession {
        self.manager.sessions.get_mut(&self.process_id).unwrap()
    }

    fn feed(&mut self, bytes: &[u8]) {
        let session = self.manager.sessions.get_mut(&self.process_id).unwrap();
        self.parser.advance(&mut *session.terminal.lock(), bytes);
    }

    fn frame(&mut self) -> Vec<u8> {
        let id = self.process_id.clone();
        self.session().damage_payload(&id).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .manager
            .stop(serde_json::json!({ "process_id": self.process_id }));
    }
}

// Independent full-viewport reference for checking the incremental encoder.
fn reference_frame(
    fixture: &mut Fixture,
    previous: &mut Vec<Vec<EncodedCell>>,
    last_cursor: &mut Option<CursorPosition>,
) -> Vec<u8> {
    let id = fixture.process_id.clone();
    let session = fixture.session();
    let mut terminal = session.terminal.lock();
    let damaged_rows = if session.next_frame_kind == TerminalFrameKind::Snapshot {
        (0..session.rows).collect()
    } else {
        collect_damage_rows(&mut terminal, session.rows)
    };
    let content = terminal.renderable_content();
    let cursor = CursorPosition {
        col: u16::try_from(content.cursor.point.column.0)
            .unwrap_or(0)
            .min(session.cols - 1),
        row: u16::try_from(content.cursor.point.line.0)
            .unwrap_or(0)
            .min(session.rows - 1),
        visible: content.cursor.shape != CursorShape::Hidden,
        shape: EncodedCursorShape::from_shape(content.cursor.shape),
        resize_seq: session.resize_seq,
    };
    let mut grid = blank_encoded_grid(session.cols, session.rows);
    for indexed in content.display_iter {
        let row = indexed.point.line.0 + content.display_offset as i32;
        if row >= 0
            && row < i32::from(session.rows)
            && indexed.point.column.0 < usize::from(session.cols)
        {
            grid[row as usize][indexed.point.column.0] = EncodedCell::from_cell(indexed.cell);
        }
    }
    let runs = if session.next_frame_kind == TerminalFrameKind::Snapshot {
        full_damage_runs(&grid, session.cols, session.rows)
    } else {
        sparse_damage_runs(previous, &grid, &damaged_rows, session.cols, session.rows)
    };
    *previous = grid;
    let changed = *last_cursor != Some(cursor);
    *last_cursor = Some(cursor);
    if runs.is_empty() && !changed {
        return Vec::new();
    }
    encode_damage_payload(
        &id,
        session.cols,
        session.rows,
        cursor,
        session.next_frame_kind,
        session.next_frame_seq,
        session.epoch,
        &runs,
    )
    .unwrap()
}

#[test]
fn damage_matches_full_viewport_reference() {
    let mut fixture = Fixture::new(80, 24);
    let mut previous = Vec::new();
    let mut cursor = None;
    let operations = [
        "",
        "hello",
        "\rJ",
        "\x1b[12;40H\x1b[1;38;2;120;30;210m中é🦀\x1b[0m",
        "\x1b[2K",
        "\x1b[?25l",
        "\x1b[?25h\x1b[5 q",
        "\x1b[?1049hTUI\x1b[24;1Hbottom",
        "\x1b[2J",
        "\x1b[?1049l",
        "\x1b[4hinsert\x1b[4l",
        "\x1b[1;1H\x1b[2M",
        "",
    ];
    for operation in operations {
        fixture.feed(operation.as_bytes());
        let expected = reference_frame(&mut fixture, &mut previous, &mut cursor);
        assert_eq!(fixture.frame(), expected, "operation {operation:?}");
    }
    for index in 0..200 {
        fixture.feed(format!("line {index}\r\n").as_bytes());
        if index % 9 == 0 {
            fixture
                .session()
                .terminal
                .lock()
                .scroll_display(Scroll::Delta(3));
        }
        if index % 13 == 0 {
            fixture
                .session()
                .terminal
                .lock()
                .scroll_display(Scroll::Bottom);
        }
        if index % 17 == 0 {
            fixture.session().next_frame_kind = TerminalFrameKind::Snapshot;
        }
        if index % 23 == 0 {
            let cols = if index % 2 == 0 { 40 } else { 100 };
            let rows = if index % 2 == 0 { 12 } else { 30 };
            let session = fixture.session();
            session.cols = cols;
            session.rows = rows;
            session.epoch += 1;
            session.resize_seq += 1;
            session.next_frame_kind = TerminalFrameKind::Snapshot;
            session.terminal.lock().resize(TerminalSize {
                cols: cols.into(),
                rows: rows.into(),
            });
        }
        let expected = reference_frame(&mut fixture, &mut previous, &mut cursor);
        assert_eq!(fixture.frame(), expected, "stream operation {index}");
    }
}

// Run in release mode with --ignored --nocapture --test-threads=1.
// Measures parsing separately from frame encoding; excludes PTY and pipe latency.
#[test]
#[ignore]
fn benchmark_terminal_frames() {
    const SAMPLES: usize = 10;
    const ITERATIONS: usize = 400;
    for (cols, rows) in [(80, 24), (160, 48), (240, 80)] {
        for workload in [
            "noop",
            "cursor",
            "single_cell",
            "line",
            "full",
            "snapshot",
            "scrollback",
            "resize",
        ] {
            let mut first_frame_us = Vec::new();
            let mut encode_us = Vec::new();
            let mut parse_us = Vec::new();
            let mut payload_bytes = 0;
            for sample in 0..=SAMPLES {
                let mut fixture = Fixture::new(cols, rows);
                fixture.feed("initial content\r\n".repeat(200).as_bytes());
                let start = Instant::now();
                black_box(fixture.frame());
                if sample != 0 {
                    first_frame_us.push(start.elapsed().as_secs_f64() * 1e6);
                }
                if workload == "scrollback" {
                    fixture
                        .session()
                        .terminal
                        .lock()
                        .scroll_display(Scroll::Delta(50));
                    black_box(fixture.frame());
                }

                let mut encode_elapsed = Duration::ZERO;
                let mut parse_elapsed = Duration::ZERO;
                for index in 0..ITERATIONS {
                    let ch = if index % 2 == 0 { "x" } else { "y" };
                    let input = match workload {
                        "noop" | "snapshot" | "resize" => String::new(),
                        "cursor" => format!("\x1b[{};{}H", rows / 2, 1 + index % 2),
                        "single_cell" => format!("\x1b[{};{}H{ch}", rows / 2, cols / 2),
                        "line" => {
                            format!("\x1b[{};1H{}", rows / 2, ch.repeat(usize::from(cols - 1)))
                        }
                        "full" => {
                            format!("\x1b[H{}", ch.repeat(usize::from(cols) * usize::from(rows)))
                        }
                        "scrollback" => format!("line {index}\r\n"),
                        _ => unreachable!(),
                    };
                    let start = Instant::now();
                    fixture.feed(black_box(input.as_bytes()));
                    parse_elapsed += start.elapsed();
                    if workload == "snapshot" {
                        fixture.session().next_frame_kind = TerminalFrameKind::Snapshot;
                    }
                    if workload == "resize" {
                        fixture
                            .manager
                            .resize(serde_json::json!({
                                "process_id": fixture.process_id, "cols": cols + (index % 2) as u16,
                                "rows": rows, "resize_seq": index
                            }))
                            .unwrap();
                    }
                    let start = Instant::now();
                    let payload = fixture.frame();
                    encode_elapsed += start.elapsed();
                    payload_bytes = black_box(payload).len();
                }
                if sample != 0 {
                    encode_us.push(encode_elapsed.as_secs_f64() * 1e6 / ITERATIONS as f64);
                    parse_us.push(parse_elapsed.as_secs_f64() * 1e6 / ITERATIONS as f64);
                }
            }
            first_frame_us.sort_by(f64::total_cmp);
            encode_us.sort_by(f64::total_cmp);
            parse_us.sort_by(f64::total_cmp);
            println!(
                "BENCH {}",
                serde_json::json!({
                    "cols": cols, "rows": rows, "workload": workload, "samples": SAMPLES, "iterations": ITERATIONS,
                    "encode_median_us": (encode_us[4] + encode_us[5]) / 2.0, "encode_p95_us": encode_us[9],
                    "parse_median_us": (parse_us[4] + parse_us[5]) / 2.0, "parse_p95_us": parse_us[9], "last_payload_bytes": payload_bytes,
                    "encode_samples_us": encode_us, "parse_samples_us": parse_us,
                "first_frame_median_us": (first_frame_us[4] + first_frame_us[5]) / 2.0, "first_frame_p95_us": first_frame_us[9], "first_frame_samples_us": first_frame_us
                })
            );
        }
    }
}

fn full_damage_runs(grid: &[Vec<EncodedCell>], cols: u16, rows: u16) -> Vec<DamageRun> {
    (0..rows)
        .map(|row| DamageRun {
            row,
            start_col: 0,
            cells: grid
                .get(usize::from(row))
                .cloned()
                .unwrap_or_else(|| vec![EncodedCell::blank(); usize::from(cols)]),
        })
        .collect()
}

fn sparse_damage_runs(
    previous: &[Vec<EncodedCell>],
    current: &[Vec<EncodedCell>],
    damaged_rows: &[u16],
    cols: u16,
    rows: u16,
) -> Vec<DamageRun> {
    let mut runs = Vec::new();
    let blank = EncodedCell::blank();

    for row in damaged_rows.iter().copied().filter(|row| *row < rows) {
        let row_index = usize::from(row);
        let mut col = 0usize;
        while col < usize::from(cols) {
            let current_cell = current
                .get(row_index)
                .and_then(|line| line.get(col))
                .unwrap_or(&blank);
            let previous_cell = previous
                .get(row_index)
                .and_then(|line| line.get(col))
                .unwrap_or(&blank);

            if current_cell == previous_cell {
                col += 1;
                continue;
            }

            let start_col = col;
            let mut cells = Vec::new();
            while col < usize::from(cols) {
                let current_cell = current
                    .get(row_index)
                    .and_then(|line| line.get(col))
                    .unwrap_or(&blank);
                let previous_cell = previous
                    .get(row_index)
                    .and_then(|line| line.get(col))
                    .unwrap_or(&blank);

                if current_cell == previous_cell {
                    break;
                }

                cells.push(current_cell.clone());
                col += 1;
            }

            runs.push(DamageRun {
                row,
                start_col: u16::try_from(start_col).unwrap_or(0),
                cells,
            });
        }
    }

    runs
}

// Decode the wire format independently so hyperlink metadata cannot be silently
// discarded between Alacritty and the renderer.
fn frame_links(payload: &[u8]) -> Vec<(u16, u16, u16, String)> {
    fn u16_at(payload: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([payload[offset], payload[offset + 1]])
    }
    assert_eq!(u16_at(payload, 0), 3);
    let header_end = 29 + usize::from(u16_at(payload, 15));
    let run_count = u16_at(payload, header_end - 2);
    let mut offset = header_end;
    for _ in 0..run_count {
        offset += 6 + usize::from(u16_at(payload, offset + 4)) * 16;
    }
    let count = u16_at(payload, offset);
    offset += 2;
    let mut links = Vec::new();
    for _ in 0..count {
        let run = u16_at(payload, offset);
        let start = u16_at(payload, offset + 2);
        let cells = u16_at(payload, offset + 4);
        let len = usize::from(u16_at(payload, offset + 6));
        offset += 8;
        let uri = String::from_utf8(payload[offset..offset + len].to_vec()).unwrap();
        offset += len;
        links.push((run, start, cells, uri));
    }
    assert_eq!(offset, payload.len());
    links
}

#[test]
fn osc8_links_survive_frames_and_link_only_updates() {
    let mut fixture = Fixture::new(20, 3);
    fixture
        .feed(b"It's on PR \x1b]8;;https://example.com/pull/85\x07\x1b[4m#85\x1b[0m\x1b]8;;\x1b\\");
    assert_eq!(
        frame_links(&fixture.frame()),
        vec![(0, 11, 3, "https://example.com/pull/85".into())]
    );

    // Same label and style, different destination: this must emit damage.
    fixture
        .feed(b"\x1b[1;12H\x1b]8;;https://example.com/pull/86\x07\x1b[4m#85\x1b[0m\x1b]8;;\x1b\\");
    assert_eq!(
        frame_links(&fixture.frame()),
        vec![(0, 0, 3, "https://example.com/pull/86".into())]
    );

    // Removing only the link must overwrite the renderer's old cell metadata.
    fixture.feed(b"\x1b[1;12H\x1b[4m#85\x1b[0m");
    let payload = fixture.frame();
    assert!(frame_links(&payload).is_empty());
    let header_end = 29 + fixture.process_id.len();
    assert!(u16::from_le_bytes([payload[header_end - 2], payload[header_end - 1]]) > 0);
}

#[test]
fn osc8_links_survive_wrapping_scrollback_and_alternate_screens() {
    let mut fixture = Fixture::new(6, 2);
    fixture.feed(b"1234\x1b]8;;https://example.com/85\x07#85\x1b]8;;\x07");
    assert_eq!(
        frame_links(&fixture.frame()),
        vec![
            (0, 4, 2, "https://example.com/85".into()),
            (1, 0, 1, "https://example.com/85".into())
        ]
    );
    fixture.feed(b"\r\nnext\r\nnext");
    fixture.frame();
    fixture
        .session()
        .terminal
        .lock()
        .scroll_display(Scroll::Top);
    fixture.session().next_frame_kind = TerminalFrameKind::Snapshot;
    assert_eq!(frame_links(&fixture.frame()).len(), 2);

    fixture.feed(b"\x1b[?1049hother");
    assert!(frame_links(&fixture.frame()).is_empty());
    fixture.feed(b"\x1b[?1049l");
    fixture
        .session()
        .terminal
        .lock()
        .scroll_display(Scroll::Top);
    fixture.session().next_frame_kind = TerminalFrameKind::Snapshot;
    assert_eq!(frame_links(&fixture.frame()).len(), 2);
}

#[test]
fn osc52_copy_emits_clipboard_lifecycle_frame() {
    let (tx, rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    let result = manager.spawn(cat_params(20, 3)).unwrap();
    let process_id = result["process_id"].as_str().unwrap().to_string();
    let session = manager.sessions.get_mut(&process_id).unwrap();
    // base64("copied text"); the OSC 52 read form must stay ignored.
    Processor::<alacritty_terminal::vte::ansi::StdSyncHandler>::new().advance(
        &mut *session.terminal.lock(),
        b"\x1b]52;c;Y29waWVkIHRleHQ=\x07\x1b]52;c;?\x07",
    );

    let mut clipboard_frames = Vec::new();
    while let Ok(message) = rx.recv_timeout(Duration::from_millis(200)) {
        let SidecarMessage::TerminalEvent(event) = message else {
            continue;
        };
        let mut output = Vec::new();
        manager.write_event_frame(&mut output, event).unwrap();
        let text = String::from_utf8_lossy(&output).into_owned();
        if text.contains("\"clipboard\"") {
            clipboard_frames.push(text);
        }
    }
    let _ = manager.stop(serde_json::json!({ "process_id": process_id }));
    assert_eq!(clipboard_frames.len(), 1);
    assert!(clipboard_frames[0].contains("\"text\":\"copied text\""));
}

// Runs a real PTY child and returns every notification lifecycle frame it caused.
fn notification_frames(unix: &str, windows: &str) -> Vec<Value> {
    let (tx, rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    let result = manager.spawn(script_params(unix, windows, 20, 3)).unwrap();
    let process_id = result["process_id"].as_str().unwrap().to_string();
    let mut frames = Vec::new();
    let deadline = Instant::now() + SCRIPT_DEADLINE.max(Duration::from_secs(10));
    let mut exited = false;
    while Instant::now() < deadline {
        // Alacritty reports the exit before draining the final output.
        let Ok(message) = rx.recv_timeout(Duration::from_millis(300)) else {
            if exited {
                break;
            }
            continue;
        };
        let mut output = Vec::new();
        match message {
            SidecarMessage::TerminalEvent(event) => {
                exited |= matches!(event.event, Event::ChildExit(_));
                manager.write_event_frame(&mut output, event).unwrap();
            }
            SidecarMessage::Notification {
                process_id,
                notification,
            } => manager
                .write_notification_frame(&mut output, process_id, notification)
                .unwrap(),
            _ => {}
        }
        let mut rest = &output[..];
        while rest.len() >= 5 {
            let length = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
            let (frame, tail) = rest[4..].split_at(length);
            if frame[0] == FRAME_TERMINAL_LIFECYCLE {
                let value: Value = serde_json::from_slice(&frame[1..]).unwrap();
                if value["event"] == "notification" {
                    assert_eq!(value["process_id"], process_id.as_str());
                    frames.push(value);
                }
            }
            rest = tail;
        }
    }
    let _ = manager.stop(serde_json::json!({ "process_id": process_id }));
    assert!(exited, "child should exit");
    frames
}

#[test]
fn osc_notifications_emit_lifecycle_frames() {
    let frames = notification_frames(
        r"printf '\033]9;hello\007\033]9;4;1;50\007\033]777;notify;Title;a;b\033\\'",
        r#"$e = [char]27; $b = [char]7; [Console]::Out.Write("$e]9;hello$b$e]9;4;1;50$b$e]777;notify;Title;a;b$e\")"#,
    );
    let frames = frames
        .into_iter()
        .map(|mut frame| {
            frame.as_object_mut().unwrap().remove("process_id");
            frame
        })
        .collect::<Vec<_>>();
    assert_eq!(
        frames,
        [
            serde_json::json!({ "event": "notification", "source": "osc9", "body": "hello" }),
            serde_json::json!({
                "event": "notification", "source": "osc777", "title": "Title", "body": "a;b"
            }),
        ]
    );
}

#[test]
fn bell_floods_are_throttled() {
    let frames = notification_frames(
        r"printf '\007\007\007'; printf '\007'",
        r#"$b = [char]7; [Console]::Out.Write("$b$b$b"); [Console]::Out.Write($b)"#,
    );
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["source"], "bell");
}

#[test]
fn focus_reports_follow_client_focus_once_enabled() {
    let (tx, rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    // The tty echoes control input as ^[, so focus reports show up on screen.
    let result = manager
        .spawn(script_params(
            r"printf '\033[?1004h'; exec sleep 5",
            r#"[Console]::Out.Write(([char]27) + '[?1004h'); Start-Sleep 5"#,
            80,
            6,
        ))
        .unwrap();
    let process_id = result["process_id"].as_str().unwrap().to_string();
    let pump = |manager: &mut TerminalManager, until: Duration| {
        let deadline = Instant::now() + until;
        while Instant::now() < deadline {
            if let Ok(SidecarMessage::TerminalEvent(event)) =
                rx.recv_timeout(Duration::from_millis(50))
            {
                manager.write_event_frame(&mut Vec::new(), event).unwrap();
            }
            manager.write_due_events(&mut Vec::new()).unwrap();
        }
    };
    // Wait for the child to turn focus reporting on; PowerShell starts slowly.
    let deadline = Instant::now() + SCRIPT_DEADLINE;
    while !manager.sessions[&process_id].focus_reporting && Instant::now() < deadline {
        pump(&mut manager, Duration::from_millis(100));
    }
    // Enabling focus reporting while unfocused reports focus-out once.
    let unchanged = manager
        .focus(serde_json::json!({ "process_id": process_id, "focused": false }))
        .unwrap();
    assert_eq!(unchanged["reported"], false);
    let focused = manager
        .focus(serde_json::json!({ "process_id": process_id, "focused": true }))
        .unwrap();
    assert_eq!(focused["reported"], true);
    pump(&mut manager, Duration::from_millis(800));
    let screen = manager
        .output(serde_json::json!({ "process_id": process_id }))
        .unwrap()["screen"]
        .as_str()
        .unwrap()
        .to_string();
    let _ = manager.stop(serde_json::json!({ "process_id": process_id }));
    // ConPTY has no tty echo of control input, so only Unix can see the reports.
    #[cfg(unix)]
    assert!(screen.contains("^[[O^[[I"), "screen was {screen:?}");
    #[cfg(not(unix))]
    let _ = screen;
}

#[test]
fn echoing_child_shows_input_it_is_sent() {
    let (tx, _rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    let result = manager.spawn(cat_params(40, 5)).unwrap();
    let process_id = result["process_id"].as_str().unwrap().to_string();
    manager
        .write_input(serde_json::json!({ "process_id": process_id, "text": "echoed-input-7\r" }))
        .unwrap();
    // ConPTY adds its own setup sequences around the echo, so match on content.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut screen = String::new();
    while Instant::now() < deadline {
        manager.write_due_events(&mut Vec::new()).unwrap();
        screen = manager
            .output(serde_json::json!({ "process_id": process_id }))
            .unwrap()["screen"]
            .as_str()
            .unwrap()
            .to_string();
        if screen.contains("echoed-input-7") {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = manager.stop(serde_json::json!({ "process_id": process_id }));
    assert!(screen.contains("echoed-input-7"), "screen was {screen:?}");
}
