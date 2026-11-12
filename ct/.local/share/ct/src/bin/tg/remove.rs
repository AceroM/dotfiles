//! Removing groups, one after another, off the UI thread. Open groups are ungrouped through the
//! extension (their tabs stay open, and Chrome drops the saved group). Closed groups are deleted
//! through Chrome's bookmarks-bar menu (ax.rs), in a scratch New Tab window that opens behind the
//! others for as long as it takes (Chrome draws the bar only on a New Tab page).

use std::sync::mpsc::Sender;
use std::time::Duration;

use tabkit::bridge::Host;

use crate::ax::{self, Fail};

pub enum Job {
    Ungroup { key: String, title: String, color: String, tabs: Vec<i64> },
    /// `title` is empty for an unnamed group.
    Delete { key: String, title: String, tabs: Vec<String> },
}

impl Job {
    pub fn key(&self) -> &str {
        match self {
            Job::Ungroup { key, .. } | Job::Delete { key, .. } => key,
        }
    }
}

pub enum Event {
    /// Starting job `n` (from 1) of `of`.
    Working { key: String, n: usize, of: usize },
    /// Ungrouped: enough to put it back.
    Ungrouped { key: String, title: String, color: String, tabs: Vec<i64> },
    Deleted { key: String },
    /// This one didn't go; the rest carry on.
    Failed { key: String, why: String },
    /// Chrome did something unexpected: the jobs after this one were left alone.
    Stopped { why: String, left: Vec<String> },
    Finished,
}

pub fn run(host: Host, pid: Option<i32>, jobs: Vec<Job>, tx: Sender<Event>) {
    let of = jobs.len();
    let (ungroups, deletes): (Vec<_>, Vec<_>) = jobs.into_iter().partition(|j| matches!(j, Job::Ungroup { .. }));
    let mut n = 0;
    for job in ungroups {
        n += 1;
        let Job::Ungroup { key, title, color, tabs } = job else { continue };
        let _ = tx.send(Event::Working { key: key.clone(), n, of });
        let _ = tx.send(match host.ungroup(&tabs) {
            Ok(()) => Event::Ungrouped { key, title, color, tabs },
            Err(why) => Event::Failed { key, why },
        });
    }
    if !deletes.is_empty() {
        delete_all(&host, pid, deletes, n, of, &tx);
    }
    let _ = tx.send(Event::Finished);
}

fn delete_all(host: &Host, pid: Option<i32>, jobs: Vec<Job>, mut n: usize, of: usize, tx: &Sender<Event>) {
    let keys = |jobs: &[Job]| jobs.iter().map(|j| j.key().to_string()).collect::<Vec<_>>();
    let stop = |why: String, left: Vec<String>| {
        let _ = tx.send(Event::Stopped { why, left });
    };
    let Some(pid) = pid else {
        return stop("couldn't find the browser's process".into(), keys(&jobs));
    };
    let chrome = match ax::Chrome::connect(pid) {
        Ok(c) => c,
        Err(e) => return stop(e, keys(&jobs)),
    };
    // Always a window of tg's own: wide enough for the whole bar, and closing it takes any menu
    // left over with it.
    let scratch = match host.scratch_open() {
        Ok(w) => Some(w),
        Err(e) => return stop(format!("couldn't open a window to reach the bookmarks bar: {e}"), keys(&jobs)),
    };
    if !chrome.bar_ready(Duration::from_secs(5)) {
        let _ = host.scratch_close(scratch.unwrap_or_default());
        return stop("Chrome's bookmarks bar shows no tab groups (Chrome setting: Show tab groups in bookmarks bar)".into(), keys(&jobs));
    }
    let mut rest = jobs.into_iter();
    while let Some(job) = rest.next() {
        n += 1;
        let Job::Delete { key, title, tabs } = job else { continue };
        let _ = tx.send(Event::Working { key: key.clone(), n, of });
        match chrome.delete_closed(&title, &tabs) {
            Ok(()) => {
                let _ = tx.send(Event::Deleted { key });
            }
            Err(Fail::Skip(why)) => {
                let _ = tx.send(Event::Failed { key, why });
            }
            Err(Fail::Stop(why)) => {
                let mut left = vec![key];
                left.extend(rest.map(|j| j.key().to_string()));
                stop(why, left);
                break;
            }
        }
    }
    if let Some(w) = scratch {
        let _ = host.scratch_close(w);
    }
}
