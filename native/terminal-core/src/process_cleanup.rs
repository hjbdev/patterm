//! Linux ownership for PTY descendants, including daemonised children.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

const REAP_INTERVAL: Duration = Duration::from_secs(30);
const GRACE_PERIOD: Duration = Duration::from_millis(300);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
static SUBREAPER_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn enable_subreaper() -> Result<()> {
    // Keep double-forked children owned by this host after their PTY parent exits.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error()).context("failed to own terminal descendants");
    }
    SUBREAPER_ENABLED.store(true, Ordering::Relaxed);
    Ok(())
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct Identity {
    pid: u32,
    started: u64,
}

pub struct ProcessCleanup {
    enabled: bool,
    // Alacritty owns waitpid for these children. Retain their birth identity until
    // they disappear, including the interval between close and PTY teardown.
    pty_children: HashSet<Identity>,
    deadline: Option<Instant>,
}

impl ProcessCleanup {
    pub fn new() -> Self {
        Self {
            enabled: SUBREAPER_ENABLED.load(Ordering::Relaxed),
            pty_children: HashSet::new(),
            deadline: None,
        }
    }

    pub fn register(&mut self, pid: u32) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let identity = identity(pid, None)?.context("PTY child disappeared before registration")?;
        self.pty_children.insert(identity);
        self.reap_adopted()
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn reap_if_due(&mut self) -> Result<()> {
        if self
            .deadline
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            self.reap_adopted()?;
        }
        Ok(())
    }

    fn reap_adopted(&mut self) -> Result<()> {
        let children = direct_children(std::process::id())?
            .into_iter()
            .map(|pid| identity(pid, None))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<HashSet<_>>();
        self.pty_children.retain(|child| children.contains(child));
        let mut pending = !self.pty_children.is_empty();
        for child in children.difference(&self.pty_children) {
            let result =
                unsafe { libc::waitpid(child.pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
            if result == 0 {
                pending = true;
            } else if result < 0 {
                let error = io::Error::last_os_error();
                if !matches!(error.raw_os_error(), Some(libc::ECHILD | libc::EINTR)) {
                    return Err(error.into());
                }
                pending = true;
            }
        }
        self.deadline = pending.then(|| Instant::now() + REAP_INTERVAL);
        Ok(())
    }

    pub fn shutdown(&mut self) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let started = Instant::now();
        let mut targets: HashMap<Identity, Target> = HashMap::new();
        loop {
            // Repeat discovery after signalling: orphans are adopted here, and
            // a command may have forked between the previous scan and its exit.
            for child in descendants()? {
                if let std::collections::hash_map::Entry::Vacant(entry) = targets.entry(child) {
                    if let Some(target) = Target::open(child)? {
                        entry.insert(target);
                    }
                }
            }
            let signal = if started.elapsed() < GRACE_PERIOD {
                libc::SIGTERM
            } else {
                libc::SIGKILL
            };
            for target in targets.values_mut() {
                target.signal(signal)?;
            }
            let mut exited = Vec::new();
            for (child, target) in &targets {
                if target.exited()? {
                    exited.push(*child);
                }
            }
            for child in exited {
                targets.remove(&child);
            }
            self.reap_adopted()?;
            if targets.is_empty() && descendants()?.is_empty() {
                return Ok(());
            }
            if started.elapsed() >= STOP_TIMEOUT {
                bail!("terminal descendants did not stop within two seconds");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

struct Target {
    descriptor: OwnedFd,
    last_signal: i32,
}

impl Target {
    fn open(child: Identity) -> Result<Option<Self>> {
        let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, child.pid, 0) };
        if descriptor < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(None);
            }
            return Err(error).context("pidfds are required to stop terminal descendants safely");
        }
        let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor as i32) };
        // /proc discovery and pidfd_open are separate operations. Verify that
        // the numeric PID still belongs to the child observed during discovery.
        if identity(child.pid, None)? != Some(child) {
            return Ok(None);
        }
        Ok(Some(Self {
            descriptor,
            last_signal: 0,
        }))
    }

    fn signal(&mut self, signal: i32) -> Result<()> {
        if signal == self.last_signal {
            return Ok(());
        }
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.descriptor.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error).context("failed to stop a terminal descendant");
            }
        }
        self.last_signal = signal;
        Ok(())
    }

    fn exited(&self) -> Result<bool> {
        let mut descriptor = libc::pollfd {
            fd: self.descriptor.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut descriptor, 1, 0) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error.into());
            }
        }
        Ok(descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0)
    }
}

// A process can exit between opening a /proc file and reading it. The read then
// fails with ESRCH rather than ENOENT.
fn gone(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

fn identity(pid: u32, parent: Option<u32>) -> Result<Option<Identity>> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if gone(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    // The command name can itself contain spaces and parentheses.
    let fields = stat.rsplit_once(')').context("invalid process stat")?.1;
    let mut fields = fields.split_whitespace();
    let actual_parent = fields
        .clone()
        .nth(1)
        .context("missing process parent")?
        .parse::<u32>()?;
    if parent.is_some_and(|parent| parent != actual_parent) {
        return Ok(None);
    }
    let started = fields
        .nth(19)
        .context("missing process start time")?
        .parse()?;
    Ok(Some(Identity { pid, started }))
}

fn direct_children(pid: u32) -> Result<HashSet<u32>> {
    let tasks = match fs::read_dir(format!("/proc/{pid}/task")) {
        Ok(tasks) => tasks,
        Err(error) if gone(&error) => return Ok(HashSet::new()),
        Err(error) => return Err(error.into()),
    };
    let mut children = HashSet::new();
    for task in tasks {
        let text = match fs::read_to_string(task?.path().join("children")) {
            Ok(text) => text,
            Err(error) if gone(&error) => continue,
            Err(error) => return Err(error.into()),
        };
        children.extend(
            text.split_whitespace()
                .map(str::parse::<u32>)
                .collect::<std::result::Result<Vec<_>, _>>()?,
        );
    }
    Ok(children)
}

fn descendants() -> Result<HashSet<Identity>> {
    let root = identity(std::process::id(), None)?.context("terminal host process disappeared")?;
    let mut pending = vec![root];
    let mut descendants = HashSet::new();
    while let Some(parent) = pending.pop() {
        if identity(parent.pid, None)? != Some(parent) {
            continue;
        }
        let children = direct_children(parent.pid)?;
        if identity(parent.pid, None)? != Some(parent) {
            continue;
        }
        for pid in children {
            if let Some(child) = identity(pid, Some(parent.pid))? {
                if descendants.insert(child) {
                    pending.push(child);
                }
            }
        }
    }
    Ok(descendants)
}

#[cfg(test)]
mod tests {
    use std::io;

    #[test]
    fn a_process_that_exits_mid_read_counts_as_gone() {
        assert!(super::gone(&io::Error::from_raw_os_error(libc::ESRCH)));
        assert!(super::gone(&io::Error::from(io::ErrorKind::NotFound)));
        assert!(!super::gone(&io::Error::from_raw_os_error(libc::EACCES)));
    }
}
