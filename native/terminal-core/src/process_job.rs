//! Windows ownership for PTY descendants, including detached children.
//!
//! The host joins a kill-on-close job object. Console clients and everything
//! they start inherit the job, so they end when the host exits, even when a
//! descendant detaches from its pseudoconsole.

use std::ffi::c_void;
use std::io;
use std::mem;
use std::ptr;

use anyhow::{Context, Result};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub fn enable_kill_on_exit() -> Result<()> {
    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(io::Error::last_os_error()).context("failed to create terminal job");
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            return Err(io::Error::last_os_error()).context("failed to configure terminal job");
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            return Err(io::Error::last_os_error()).context("failed to own terminal descendants");
        }
        // The handle stays open for the life of the host. The OS closes it on
        // exit, which terminates every remaining member of the job.
    }
    Ok(())
}
