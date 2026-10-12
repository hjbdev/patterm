mod notify_scan;
#[cfg(target_os = "linux")]
mod process_cleanup;
#[cfg(windows)]
mod process_job;
mod protocol;
#[cfg(unix)]
mod socket;
mod terminal;

use std::io::{self, BufRead};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Instant;

use anyhow::Result;
use protocol::{write_frame, CoreRequest, CoreResponse, FRAME_CONTROL_RESPONSE};
use terminal::{SidecarMessage, TerminalManager};

fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    process_cleanup::enable_subreaper()?;
    #[cfg(windows)]
    process_job::enable_kill_on_exit()?;
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !args.is_empty() {
        #[cfg(unix)]
        if args.len() == 4 && args[0] == "--socket" && args[2] == "--host-id" {
            return socket::run(std::path::Path::new(&args[1]), &args[3]);
        }
        anyhow::bail!("usage: patterm-terminal-core [--socket PATH --host-id GENERATION]");
    }
    let (tx, rx) = mpsc::channel();
    spawn_stdin_reader(tx.clone());

    let mut stdout = io::stdout().lock();
    let mut terminals = TerminalManager::new(tx);

    loop {
        // Check deadlines even under continuous requests or PTY events.
        terminals.write_due_events(&mut stdout)?;
        let message = match terminals.next_deadline() {
            Some(deadline) => rx.recv_timeout(deadline.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let message = match message {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match message {
            SidecarMessage::Request(request) => {
                let shutdown = request.method == "terminal.host.shutdown";
                let response = dispatch(&mut terminals, request);
                let shutdown = shutdown && response.error.is_none();
                let payload = serde_json::to_vec(&response)?;
                write_frame(&mut stdout, FRAME_CONTROL_RESPONSE, &payload)?;
                if shutdown {
                    return Ok(());
                }
            }
            SidecarMessage::InvalidRequest(error) => {
                let response = CoreResponse::error(None, error);
                let payload = serde_json::to_vec(&response)?;
                write_frame(&mut stdout, FRAME_CONTROL_RESPONSE, &payload)?;
            }
            SidecarMessage::TerminalEvent(event) => {
                terminals.write_event_frame(&mut stdout, event)?
            }
            SidecarMessage::Notification {
                process_id,
                notification,
            } => terminals.write_notification_frame(&mut stdout, process_id, notification)?,
            SidecarMessage::StdinClosed => break,
        }
    }

    terminals.shutdown()
}

fn spawn_stdin_reader(tx: mpsc::Sender<SidecarMessage>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };

            if line.trim().is_empty() {
                continue;
            }

            let message = match serde_json::from_str::<CoreRequest>(&line) {
                Ok(request) => SidecarMessage::Request(request),
                Err(error) => SidecarMessage::InvalidRequest(format!("invalid request: {error}")),
            };

            if tx.send(message).is_err() {
                break;
            }
        }
        let _ = tx.send(SidecarMessage::StdinClosed);
    });
}

fn dispatch(terminals: &mut TerminalManager, request: CoreRequest) -> CoreResponse {
    let id = request.id;
    let result = match request.method.as_str() {
        "terminal.ping" => Ok(serde_json::json!({ "ok": true })),
        "terminal.host.shutdown" => terminals
            .shutdown()
            .map(|()| serde_json::json!({ "ok": true })),
        "terminal.process.input" => terminals.write_input(request.params),
        "terminal.process.output" => terminals.output(request.params),
        "terminal.process.search" => terminals.search(request.params),
        "terminal.process.select" => terminals.select(request.params),
        "terminal.process.selection_text" => terminals.selection_text(request.params),
        "terminal.process.scroll" => terminals.scroll(request.params),
        "terminal.process.wheel" => terminals.wheel(request.params),
        "terminal.process.mouse" => terminals.mouse(request.params),
        "terminal.process.focus" => terminals.focus(request.params),
        "terminal.process.resize" => terminals.resize(request.params),
        "terminal.process.status" => terminals.status(request.params),
        "terminal.process.list" => terminals.list(),
        "terminal.process.stop" => terminals.stop(request.params),
        "terminal.process.close" => terminals.close(request.params),
        "terminal.process.refresh" => terminals.refresh(request.params),
        "terminal.process.subscribe" => terminals.subscribe(request.params),
        "terminal.process.configure" => terminals.configure(request.params),
        "terminal.process.spawn" => terminals.spawn(request.params),
        other => Err(anyhow::anyhow!("unknown method {other}")),
    };

    match result {
        Ok(value) => CoreResponse::result(id, value),
        Err(error) => CoreResponse::error(Some(id), error.to_string()),
    }
}
