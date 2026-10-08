use super::*;

fn scan_chunks(chunks: &[&[u8]]) -> Vec<TerminalNotification> {
    let mut scanner = NotificationScanner::new();
    let mut found = Vec::new();
    for chunk in chunks {
        scanner.feed(chunk, &mut |notification| found.push(notification));
    }
    found
}

fn scan(bytes: &[u8]) -> Vec<TerminalNotification> {
    scan_chunks(&[bytes])
}

fn note(source: &'static str, title: Option<&str>, body: Option<&str>) -> TerminalNotification {
    TerminalNotification {
        source,
        title: title.map(str::to_string),
        body: body.map(str::to_string),
    }
}

#[test]
fn osc9_with_bel_and_st_terminators() {
    assert_eq!(
        scan(b"before\x1b]9;hello\x07after"),
        [note("osc9", None, Some("hello"))]
    );
    assert_eq!(
        scan(b"\x1b]9;  done  \x1b\\"),
        [note("osc9", None, Some("done"))]
    );
}

#[test]
fn every_split_offset_matches_a_single_read() {
    let stream: &[u8] = b"x\x1b[31m\x1b]9;one\x07y\x1b]777;notify;Two;b;c\x1b\\\
\x1b]99;i=1:d=0;Ti\x1b\\\x1b]99;i=1;tle\x07z";
    let expected = [
        note("osc9", None, Some("one")),
        note("osc777", Some("Two"), Some("b;c")),
        note("osc99", Some("Title"), None),
    ];
    assert_eq!(scan(stream), expected);
    for split in 0..=stream.len() {
        let (left, right) = stream.split_at(split);
        assert_eq!(scan_chunks(&[left, right]), expected, "split at {split}");
    }
    let bytes = stream.iter().map(std::slice::from_ref).collect::<Vec<_>>();
    assert_eq!(scan_chunks(&bytes), expected, "byte at a time");
}

#[test]
fn conemu_osc9_subcommands_are_ignored() {
    assert!(scan(b"\x1b]9;4;1;50\x07").is_empty());
    assert!(scan(b"\x1b]9;4;0\x1b\\").is_empty());
    assert!(scan(b"\x1b]9;1;500\x07").is_empty());
    assert!(scan(b"\x1b]9;12\x07").is_empty());
    assert_eq!(
        scan(b"\x1b]9;3 files done\x07"),
        [note("osc9", None, Some("3 files done"))]
    );
}

#[test]
fn osc777_keeps_semicolons_in_body() {
    assert_eq!(
        scan(b"\x1b]777;notify;Build;step 1; step 2\x07"),
        [note("osc777", Some("Build"), Some("step 1; step 2"))]
    );
    assert_eq!(
        scan(b"\x1b]777;notify;Title only\x07"),
        [note("osc777", Some("Title only"), None)]
    );
    assert!(scan(b"\x1b]777;preexec;x;y\x07").is_empty());
}

#[test]
fn osc99_chunks_base64_and_ignored_payload_types() {
    // base64("Hello") as the title, then a plain body in two chunks.
    assert_eq!(
        scan(b"\x1b]99;i=a:d=0:e=1;SGVsbG8=\x1b\\\x1b]99;i=a:d=0:p=body;wor\x1b\\\x1b]99;i=a:p=body;ld\x1b\\"),
        [note("osc99", Some("Hello"), Some("world"))]
    );
    assert_eq!(
        scan(b"\x1b]99;;Simple\x07"),
        [note("osc99", Some("Simple"), None)]
    );
    assert!(scan(b"\x1b]99;i=a:p=?;\x1b\\").is_empty());
    assert!(scan(b"\x1b]99;i=a:p=close;\x1b\\").is_empty());
    assert!(scan(b"\x1b]99;i=a:p=icon;abcd\x1b\\").is_empty());
    assert!(scan(b"\x1b]99;i=a:d=0;never finished\x1b\\").is_empty());
    // A new identifier abandons the unfinished chunk.
    assert_eq!(
        scan(b"\x1b]99;i=a:d=0;stale\x07\x1b]99;i=b;fresh\x07"),
        [note("osc99", Some("fresh"), None)]
    );
}

#[test]
fn oversized_payload_is_dropped_and_scanner_recovers() {
    let mut stream = b"\x1b]9;".to_vec();
    stream.extend(std::iter::repeat_n(b'a', MAX_PAYLOAD + 1));
    stream.extend(b"\x07\x1b]9;next\x07");
    assert_eq!(scan(&stream), [note("osc9", None, Some("next"))]);

    let mut stream = Vec::new();
    for _ in 0..3 {
        stream.extend(b"\x1b]99;i=x:d=0;");
        stream.extend(std::iter::repeat_n(b'a', 2000));
        stream.push(BEL);
    }
    stream.extend(b"\x1b]99;i=x;end\x07");
    assert!(scan(&stream).is_empty());
}

#[test]
fn control_characters_are_stripped_and_empty_dropped() {
    assert_eq!(
        scan(b"\x1b]9;he\x01l\x7flo\x07"),
        [note("osc9", None, Some("hello"))]
    );
    assert!(scan(b"\x1b]9;   \x07").is_empty());
    assert!(scan(b"\x1b]9;\x07").is_empty());
    assert!(scan(b"\x1b]777;notify;;\x07").is_empty());
    // Invalid UTF-8 decodes lossily.
    assert_eq!(
        scan(b"\x1b]9;caf\xc3\xa9 \xff\x07"),
        [note("osc9", None, Some("café \u{fffd}"))]
    );
}

#[test]
fn plain_output_and_other_sequences_pass_without_notifications() {
    assert!(scan(b"plain text \x9d\x9c with \xe2\x9c\x93 unicode\r\n").is_empty());
    assert!(scan(b"\x1b]0;title\x07\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\").is_empty());
    assert!(scan(b"\x1b]52;c;Y29waWVk\x07\x1b[2J\x1b]90;x\x07\x1b]7777;x\x07").is_empty());
    // ESC without `\` or CAN abandons the OSC, as does a restarted OSC.
    assert!(scan(b"\x1b]9;cut\x1bXrest\x07").is_empty());
    assert!(scan(b"\x1b]9;cancel\x18more\x07").is_empty());
    assert_eq!(
        scan(b"\x1b]9;lost\x1b]9;kept\x07"),
        [note("osc9", None, Some("kept"))]
    );
}

#[test]
fn long_plain_output_does_not_buffer() {
    let mut scanner = NotificationScanner::new();
    let chunk = vec![b'x'; 1 << 20];
    for _ in 0..8 {
        scanner.feed(&chunk, &mut |_| panic!("no notification"));
    }
    assert_eq!(scanner.payload.capacity(), 0);
    assert_eq!(scanner.state, State::Ground);
}
