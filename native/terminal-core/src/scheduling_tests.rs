use super::*;
use std::sync::mpsc;

fn fixture() -> (TerminalManager, String) {
    let (tx, _rx) = mpsc::channel();
    let mut manager = TerminalManager::new(tx);
    let result = manager.spawn(super::tests::cat_params(20, 3)).unwrap();
    let id = result["process_id"].as_str().unwrap().to_string();
    (manager, id)
}

#[test]
fn frame_deadline_coalesces_and_unsubscribe_cancels_it() {
    let (mut manager, id) = fixture();
    let session = manager.session(&id).unwrap();
    session.damage_subscribed = true;
    session.mark_frame_dirty();
    let deadline = session.frame_deadline;
    session.mark_frame_dirty();
    assert_eq!(session.frame_deadline, deadline);
    assert_eq!(manager.next_deadline(), deadline);
    manager
        .subscribe(serde_json::json!({ "process_id": id, "subscribed": false }))
        .unwrap();
    assert!(manager.next_deadline().is_none());
    let mut output = Vec::new();
    manager.write_due_events(&mut output).unwrap();
    assert!(output.is_empty());
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn subscribe_flushes_snapshot_without_waiting_for_a_slow_frame_interval() {
    let (mut manager, id) = fixture();
    manager
        .configure(serde_json::json!({ "process_id": id, "target_frame_interval_ms": 200 }))
        .unwrap();
    manager
        .subscribe(serde_json::json!({ "process_id": id, "subscribed": true }))
        .unwrap();
    assert!(manager
        .next_deadline()
        .is_some_and(|deadline| deadline <= Instant::now()));
    let mut output = Vec::new();
    manager.write_due_events(&mut output).unwrap();
    assert_eq!(output[4], FRAME_TERMINAL_DAMAGE);
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn due_frames_emit_once_and_do_not_schedule_idle_polling() {
    let (mut manager, id) = fixture();
    let session = manager.session(&id).unwrap();
    session.damage_subscribed = true;
    session.mark_frame_dirty();
    session.frame_deadline = Some(Instant::now());
    let mut output = Vec::new();
    manager.write_due_events(&mut output).unwrap();
    assert_eq!(output[4], FRAME_TERMINAL_DAMAGE);
    assert!(manager.next_deadline().is_none());
    output.clear();
    manager.write_due_events(&mut output).unwrap();
    assert!(output.is_empty());
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn hidden_terminal_activity_resets_deadline_and_eventually_becomes_idle() {
    let (mut manager, id) = fixture();
    let mut output = Vec::new();
    let session = manager.session(&id).unwrap();
    session.mark_activity(&mut output, &id).unwrap();
    assert!(!output.is_empty());
    assert!(session.frame_deadline.is_none());
    session.activity_deadline = Some(Instant::now());
    output.clear();
    session.mark_activity(&mut output, &id).unwrap();
    assert!(output.is_empty());
    assert!(session.activity_deadline.unwrap() > Instant::now());
    session.activity_deadline = Some(Instant::now());
    manager.write_due_events(&mut output).unwrap();
    assert_eq!(output[4], FRAME_TERMINAL_LIFECYCLE);
    let event: Value = serde_json::from_slice(&output[5..]).unwrap();
    assert_eq!(event["activity"], "idle");
    assert!(manager.next_deadline().is_none());
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn queued_submissions_preserve_input_order_and_stop_cancels_them() {
    let (mut manager, id) = fixture();
    let session = manager.session(&id).unwrap();
    session
        .queue_input(b"first".to_vec(), true, AGENT_SUBMIT_SETTLE_DELAY)
        .unwrap();
    session
        .queue_input(b"second".to_vec(), true, AGENT_SUBMIT_SETTLE_DELAY)
        .unwrap();
    session
        .queue_input(b"third".to_vec(), true, Duration::ZERO)
        .unwrap();
    let bytes: Vec<&[u8]> = session
        .pending_input
        .iter()
        .map(|input| input.bytes.as_slice())
        .collect();
    assert_eq!(bytes, [b"\r".as_slice(), b"second", b"\r", b"third", b"\r"]);
    assert_eq!(
        session.pending_input[0].settle_delay,
        AGENT_SUBMIT_SETTLE_DELAY
    );
    assert_eq!(session.pending_input[1].settle_delay, Duration::ZERO);
    assert_eq!(
        session.pending_input[2].settle_delay,
        AGENT_SUBMIT_SETTLE_DELAY
    );
    assert!(manager.next_deadline().is_some());
    manager
        .stop(serde_json::json!({ "process_id": id }))
        .unwrap();
    assert!(manager.session(&id).unwrap().pending_input.is_empty());
    assert!(manager.next_deadline().is_none());
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn raw_agent_input_waits_but_bracketed_paste_submits_immediately() {
    use alacritty_terminal::vte::ansi::Processor;
    let (mut manager, id) = fixture();
    manager.session(&id).unwrap().kind = "agent".into();
    manager.write_input(serde_json::json!({ "process_id": id, "kind": "paste", "text": "raw fallback", "submit": true })).unwrap();
    assert_eq!(
        manager.session(&id).unwrap().pending_input.len(),
        1,
        "paste without terminal support still needs raw-input settling"
    );
    manager.session(&id).unwrap().pending_input.clear();
    manager.session(&id).unwrap().input_deadline = None;
    let mut parser: Processor = Processor::new();
    parser.advance(
        &mut *manager.session(&id).unwrap().terminal.lock(),
        b"\x1b[?2004h",
    );
    manager.write_input(serde_json::json!({ "process_id": id, "kind": "paste", "text": "multi\nline", "submit": true })).unwrap();
    assert!(manager.session(&id).unwrap().pending_input.is_empty());
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn pending_input_is_bounded_without_partial_enqueue() {
    let (mut manager, id) = fixture();
    let session = manager.session(&id).unwrap();
    session.pending_input.push_back(PendingInput {
        settle_delay: Duration::from_secs(1),
        bytes: vec![0; MAX_QUEUED_INPUT_BYTES],
    });
    assert!(session
        .queue_input(b"overflow".to_vec(), true, Duration::ZERO)
        .is_err());
    assert_eq!(session.pending_input.len(), 1);
    session.pending_input.clear();
    for _ in 0..MAX_QUEUED_INPUT_CHUNKS {
        session.pending_input.push_back(PendingInput {
            settle_delay: Duration::from_secs(1),
            bytes: vec![b'\r'],
        });
    }
    assert!(session
        .queue_input(Vec::new(), true, Duration::ZERO)
        .is_err());
    assert_eq!(session.pending_input.len(), MAX_QUEUED_INPUT_CHUNKS);
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn overdue_input_preserves_the_raw_settle_interval() {
    let (mut manager, id) = fixture();
    let session = manager.session(&id).unwrap();
    session
        .queue_input(b"first".to_vec(), true, AGENT_SUBMIT_SETTLE_DELAY)
        .unwrap();
    session
        .queue_input(b"second".to_vec(), true, AGENT_SUBMIT_SETTLE_DELAY)
        .unwrap();
    session.input_deadline = Some(Instant::now() - Duration::from_secs(1));
    let started = Instant::now();
    session.flush_input().unwrap();
    assert_eq!(
        session.pending_input.len(),
        1,
        "second Enter must still wait after dispatching second raw text"
    );
    assert_eq!(session.pending_input[0].bytes, b"\r");
    assert!(session.input_deadline.unwrap() >= started + AGENT_SUBMIT_SETTLE_DELAY);
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}

#[test]
fn wheel_and_mouse_input_wait_behind_pending_submission() {
    use alacritty_terminal::vte::ansi::Processor;
    let (mut manager, id) = fixture();
    let session = manager.session(&id).unwrap();
    session
        .queue_input(b"draft".to_vec(), true, AGENT_SUBMIT_SETTLE_DELAY)
        .unwrap();
    let mut parser: Processor = Processor::new();
    parser.advance(&mut *session.terminal.lock(), b"\x1b[?1049h\x1b[?1007h");
    manager
        .wheel(serde_json::json!({ "process_id": id, "lines": -1 }))
        .unwrap();
    parser.advance(
        &mut *manager.session(&id).unwrap().terminal.lock(),
        b"\x1b[?1000h\x1b[?1006h",
    );
    manager.mouse(serde_json::json!({ "process_id": id, "event": "down", "button": 0, "col": 1, "row": 1 })).unwrap();
    let bytes: Vec<&[u8]> = manager.sessions[&id]
        .pending_input
        .iter()
        .map(|input| input.bytes.as_slice())
        .collect();
    assert_eq!(bytes, [b"\r".as_slice(), b"\x1b[A", b"\x1b[<0;2;2M"]);
    manager
        .close(serde_json::json!({ "process_id": id }))
        .unwrap();
}
