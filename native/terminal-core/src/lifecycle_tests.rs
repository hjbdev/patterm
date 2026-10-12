use super::*;
use alacritty_terminal::vte::ansi::Processor;
use std::hint::black_box;
use std::sync::mpsc;

fn manager() -> TerminalManager {
    let (tx, _rx) = mpsc::channel();
    TerminalManager::new(tx)
}

fn spawn(manager: &mut TerminalManager, cols: u16, rows: u16) -> String {
    manager.spawn(super::tests::cat_params(cols, rows)).unwrap()["process_id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn feed(manager: &TerminalManager, id: &str, bytes: &[u8]) {
    let mut parser: Processor = Processor::new();
    parser.advance(&mut *manager.sessions[id].terminal.lock(), bytes);
}

// Full-grid reference preserves the previous output API's treatment of wide-cell
// spacers, combining marks, and trailing Unicode whitespace.
fn reference_lines(session: &TerminalSession) -> Vec<String> {
    let terminal = session.terminal.lock();
    let content = terminal.renderable_content();
    let mut grid = vec![vec![' '; usize::from(session.cols)]; usize::from(session.rows)];
    for indexed in content.display_iter {
        let row = indexed.point.line.0 + content.display_offset as i32;
        if row >= 0
            && row < i32::from(session.rows)
            && indexed.point.column.0 < usize::from(session.cols)
        {
            grid[row as usize][indexed.point.column.0] = indexed.cell.c;
        }
    }
    grid.into_iter()
        .map(|row| row.into_iter().collect::<String>().trim_end().to_string())
        .collect()
}

#[test]
fn output_matches_full_grid_for_limits_unicode_and_scrollback() {
    let mut manager = manager();
    for (cols, rows) in [(12, 3), (80, 24), (240, 150)] {
        let id = spawn(&mut manager, cols, rows);
        for text in [
            "",
            "a\t界🙂 e\u{301}  \r\n".repeat(4000).as_str(),
            "\x1b[?1049h\x1b[Halternate\r\n界 e\u{301}\u{2003}",
        ] {
            feed(&manager, &id, text.as_bytes());
            for offset in [0, 2, 2000] {
                manager.sessions[&id]
                    .terminal
                    .lock()
                    .scroll_display(Scroll::Delta(offset));
                let reference = reference_lines(&manager.sessions[&id]);
                for limit in [None, Some(0), Some(1), Some(5), Some(100), Some(200)] {
                    let mut params = serde_json::json!({ "process_id": id });
                    let expected = if let Some(limit) = limit {
                        params["max_lines"] = serde_json::json!(limit);
                        &reference[reference.len().saturating_sub(limit.clamp(1, 100))..]
                    } else {
                        &reference[..]
                    };
                    let output = manager.output(params).unwrap();
                    assert_eq!(
                        output["lines"],
                        serde_json::json!(expected),
                        "{cols}x{rows}, offset {offset}, limit {limit:?}"
                    );
                    assert_eq!(output["screen"], expected.join("\n"));
                }
            }
        }
        manager
            .stop(serde_json::json!({ "process_id": id }))
            .unwrap();
    }
}

#[test]
fn stop_retains_output_and_close_releases_terminal() {
    let mut manager = manager();
    let id = spawn(&mut manager, 80, 24);
    feed(&manager, &id, b"retained output");
    let terminal = Arc::downgrade(&manager.sessions[&id].terminal);
    manager
        .stop(serde_json::json!({ "process_id": id }))
        .unwrap();
    assert_eq!(
        manager
            .output(serde_json::json!({ "process_id": id }))
            .unwrap()["lines"][0],
        "retained output"
    );
    assert!(terminal.upgrade().is_some());
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
    assert!(manager.sessions.is_empty());
    let deadline = Instant::now() + Duration::from_secs(2);
    while terminal.upgrade().is_some() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(1));
    }
    assert!(
        terminal.upgrade().is_none(),
        "PTY shutdown releases its final terminal reference"
    );
    assert!(manager
        .output(serde_json::json!({ "process_id": id }))
        .is_err());
    let mut frames = Vec::new();
    manager
        .write_event_frame(
            &mut frames,
            TerminalEvent {
                process_id: id,
                event: Event::Wakeup,
                activity_source: true,
            },
        )
        .unwrap();
    assert!(
        frames.is_empty(),
        "late events cannot recreate closed sessions"
    );
}

#[test]
fn natural_exit_retains_output_until_explicit_close() {
    let (tx, rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    let id = manager
        .spawn(super::tests::script_params(
            "printf 'final output'; exit 7",
            "[Console]::Out.Write('final output'); exit 7",
            100,
            30,
        ))
        .unwrap()["process_id"]
        .as_str()
        .unwrap()
        .to_string();
    let mut frames = Vec::new();
    let deadline = Instant::now() + super::tests::SCRIPT_DEADLINE;
    while manager.sessions[&id].status != TerminalStatus::Exited {
        let message = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if let SidecarMessage::TerminalEvent(event) = message {
            manager.write_event_frame(&mut frames, event).unwrap();
        }
    }
    // Alacritty reports ChildExit just before draining remaining PTY bytes.
    while !manager
        .output(serde_json::json!({ "process_id": id }))
        .unwrap()["screen"]
        .as_str()
        .unwrap()
        .contains("final output")
    {
        assert!(Instant::now() < deadline, "final PTY output was drained");
        thread::sleep(Duration::from_millis(1));
    }
    assert!(String::from_utf8_lossy(&frames).contains("\"exit_code\":7"));
    manager
        .stop(serde_json::json!({ "process_id": id }))
        .unwrap();
    assert_eq!(
        manager
            .status(serde_json::json!({ "process_id": id }))
            .unwrap()["status"],
        "exited"
    );
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
    assert!(manager.sessions.is_empty());
}

#[test]
#[ignore]
fn benchmark_terminal_output() {
    for (cols, rows) in [(80, 24), (240, 80), (240, 150)] {
        for (workload, text, offset) in [
            ("ascii", "ascii output abcdef0123456789 ".repeat(8), 0),
            (
                "unicode_scrollback",
                "界🙂 e\u{301} élève\t".repeat(12),
                2000,
            ),
        ] {
            let mut manager = manager();
            let id = spawn(&mut manager, cols, rows);
            feed(&manager, &id, format!("{text}\r\n").repeat(5000).as_bytes());
            manager.sessions[&id]
                .terminal
                .lock()
                .scroll_display(Scroll::Delta(offset));
            for limit in [None, Some(1), Some(10)] {
                let mut params = serde_json::json!({ "process_id": id });
                if let Some(limit) = limit {
                    params["max_lines"] = serde_json::json!(limit);
                }
                let mut samples = Vec::new();
                let cold = Instant::now();
                black_box(manager.output(params.clone()).unwrap());
                let first_us = cold.elapsed().as_secs_f64() * 1e6;
                for sample in 0..=10 {
                    let start = Instant::now();
                    for _ in 0..500 {
                        black_box(manager.output(black_box(params.clone())).unwrap());
                    }
                    if sample != 0 {
                        samples.push(start.elapsed().as_secs_f64() * 1e6 / 500.0);
                    }
                }
                let mut sorted = samples.clone();
                sorted.sort_by(f64::total_cmp);
                println!(
                    "{}",
                    serde_json::json!({ "benchmark": "output", "cols": cols, "rows": rows,
                    "workload": workload, "max_lines": limit, "iterations": 500, "samples_us": samples,
                    "median_us": (sorted[4] + sorted[5]) / 2.0, "p95_us": sorted[9], "first_us": first_us })
                );
            }
            manager
                .stop(serde_json::json!({ "process_id": id }))
                .unwrap();
        }
    }
}

// The runtime reconciler raises failure notifications for running processes
// that exit non-zero. It relies on stop never producing an exit frame, even
// when the program traps the hangup and exits with a code of its own. Windows
// has no trappable hangup, so there the program just keeps running until the
// pseudoconsole closes and ends it.
#[test]
fn stop_emits_no_exit_frame() {
    let (tx, rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    let id = manager
        .spawn(super::tests::script_params(
            "trap 'exit 3' HUP TERM; while :; do sleep 0.05; done",
            "while ($true) { Start-Sleep -Milliseconds 50 }",
            100,
            30,
        ))
        .unwrap()["process_id"]
        .as_str()
        .unwrap()
        .to_string();
    // PowerShell needs longer to reach its loop than a shell does.
    thread::sleep(Duration::from_millis(if cfg!(windows) {
        1500
    } else {
        200
    }));
    manager
        .stop(serde_json::json!({ "process_id": id }))
        .unwrap();
    let mut frames = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if let Ok(SidecarMessage::TerminalEvent(event)) = rx.recv_timeout(Duration::from_millis(50))
        {
            manager.write_event_frame(&mut frames, event).unwrap();
        }
    }
    assert!(!String::from_utf8_lossy(&frames).contains("\"event\":\"exit\""));
}
