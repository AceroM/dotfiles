//! jn's half of the PR list: which PRs are ticked, and the net diff of them
//! on the right. net.rs builds it on a background thread, one set at a
//! time, and each set's result stays cached for the session, so unticking
//! back to an earlier set is instant. Moving the cursor never changes the
//! diff; only ticks do.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::{Act, App};
use crate::net::{self, Base, Net, Pick};
use crate::prs::Pr;

/// A finished merge: the base it went onto and the net diff, or None when
/// a newer set called it off.
type Got = Result<Option<(Base, Net)>, String>;

/// The merge running in the background.
struct Job {
    key: String,
    /// Set when the ticks have moved on: the merge stops at its next PR.
    stop: Arc<AtomicBool>,
    /// The PR being merged, counting from 1 (0 while fetching).
    at: Arc<AtomicUsize>,
    total: usize,
}

pub struct NetPane {
    /// Ticked PR numbers (one repo, so numbers are enough).
    pub ticked: BTreeSet<u32>,
    /// origin's default branch; None until known, and again after `r`.
    pub base: Option<Base>,
    cache: HashMap<String, Result<Net, String>>,
    job: Option<Job>,
    tx: mpsc::Sender<(String, Got)>,
    rx: mpsc::Receiver<(String, Got)>,
    /// The set whose diff `App::files` holds.
    loaded: Option<String>,
    /// The file on screen when the diff went away, found again in the next.
    keep: Option<String>,
    /// `r`: merge again only once the fresh PR list is in.
    hold: bool,
}

/// The PRs in `items` stacked with `items[i]`: linked to it, directly or
/// through others, by one's base branch being another's head.
pub fn stack_of(items: &[Pr], i: usize, trunk: &str) -> Vec<u32> {
    let mut seen = HashSet::from([i]);
    let mut todo = vec![i];
    while let Some(j) = todo.pop() {
        let (head, base) = (&items[j].head, &items[j].base);
        for (k, pr) in items.iter().enumerate() {
            let linked = (pr.base == *head && *head != trunk) || (pr.head == *base && *base != trunk);
            if linked && seen.insert(k) {
                todo.push(k);
            }
        }
    }
    let mut v: Vec<u32> = seen.into_iter().map(|k| items[k].number).collect();
    v.sort_unstable();
    v
}

impl App {
    /// Turn this App into jn: jp's list, with `ticked` merged on the right.
    pub fn start_net(&mut self, query: crate::prs::Query, items: Vec<Pr>, base: Option<Base>, ticked: BTreeSet<u32>) {
        let (tx, rx) = mpsc::channel();
        self.net = Some(NetPane {
            ticked,
            base,
            cache: HashMap::new(),
            job: None,
            tx,
            rx,
            loaded: None,
            keep: None,
            hold: false,
        });
        self.start_prs(query, items);
        // Start on the first ticked PR. There's no layout yet, so leave the
        // scrolling to `layout_for` (pr_set would scroll for a 1-row list).
        let first = self.prs.as_ref().and_then(|p| {
            let t = &self.net.as_ref()?.ticked;
            p.shown.iter().position(|&i| t.contains(&p.items[i].number))
        });
        if let (Some(i), Some(p)) = (first, self.prs.as_mut()) {
            p.cur = i;
        }
    }

    fn trunk(&self) -> String {
        self.net.as_ref().and_then(|n| n.base.as_ref()).map_or_else(|| "main".to_string(), |b| b.name.clone())
    }

    /// The ticked PRs that are in the list, as the merge wants them.
    fn net_picks(&self) -> Vec<Pick> {
        let (Some(p), Some(n)) = (self.prs.as_ref(), self.net.as_ref()) else { return Vec::new() };
        p.items.iter().filter(|pr| n.ticked.contains(&pr.number)).map(Pick::of).collect()
    }

    /// Names a set of PRs at their current heads: a push makes it a new set.
    fn net_key(&self) -> String {
        let mut picks = self.net_picks();
        picks.sort_by_key(|p| p.number);
        picks.iter().map(|p| format!("{}@{}", p.number, p.oid)).collect::<Vec<_>>().join(",")
    }

    /// The net diff on screen, once it's there.
    pub fn net_shown(&self) -> Option<&Net> {
        let n = self.net.as_ref()?;
        match n.cache.get(n.loaded.as_ref()?) {
            Some(Ok(net)) => Some(net),
            _ => None,
        }
    }

    /// PRs that change `path`, in merge order.
    pub fn net_prs_for(&self, path: &str) -> &[u32] {
        self.net_shown().and_then(|n| n.touched.get(path)).map_or(&[], Vec::as_slice)
    }

    pub fn net_busy(&self) -> bool {
        self.net.as_ref().is_some_and(|n| n.job.is_some() || n.hold)
    }

    /// Unticked PRs under a ticked one, down its stack: merging it brings
    /// their commits along.
    pub fn net_below(&self, pr: &Pr) -> Vec<u32> {
        let (Some(p), Some(n)) = (self.prs.as_ref(), self.net.as_ref()) else { return Vec::new() };
        let trunk = self.trunk();
        let mut out = Vec::new();
        let mut base = pr.base.clone();
        let mut seen = HashSet::from([pr.number]);
        while base != trunk {
            let Some(below) = p.items.iter().find(|x| x.head == base) else { break };
            if !seen.insert(below.number) {
                break;
            }
            if !n.ticked.contains(&below.number) {
                out.push(below.number);
            }
            base = below.base.clone();
        }
        out
    }

    /// What the top bar says: how many PRs, onto what, and which.
    pub fn net_summary(&self) -> Option<(String, Vec<u32>)> {
        let n = self.net.as_ref()?;
        let picks = self.net_picks();
        let k = picks.len();
        let onto = n.base.as_ref().map_or_else(|| "the default branch".to_string(), |b| b.name.clone());
        let order = match self.net_shown() {
            Some(net) => net.order.clone(),
            None => net::order(&picks, &self.trunk()).iter().map(|p| p.number).collect(),
        };
        Some((format!("net of {k} PR{} onto {onto}", if k == 1 { "" } else { "s" }), order))
    }

    /// What the diff pane says instead of a diff.
    pub fn net_placeholder(&self) -> Option<String> {
        let n = self.net.as_ref()?;
        if n.ticked.is_empty() || self.net_picks().is_empty() {
            return Some("Tick PRs to see their net diff here: space ticks one, S its whole stack, a every PR listed.".into());
        }
        let key = self.net_key();
        match n.cache.get(&key) {
            Some(Err(e)) => Some(format!("Net diff failed: {}  ·  r tries again", e.lines().next().unwrap_or(""))),
            Some(Ok(_)) if n.loaded.as_ref() == Some(&key) => None,
            _ if n.hold => Some("Refreshing the PR list…".into()),
            _ => {
                let k = self.net_picks().len();
                let onto = n.base.as_ref().map_or("the default branch", |b| b.name.as_str());
                let mut msg = format!("Merging {k} PR{} onto {onto}…", if k == 1 { "" } else { "s" });
                match n.job.as_ref().filter(|j| j.key == key).map(|j| (j.at.load(Ordering::Relaxed), j.total)) {
                    Some((0, _)) => msg.push_str("  fetching"),
                    Some((d, t)) if t > 1 => msg.push_str(&format!("  {d}/{t}")),
                    _ => {}
                }
                Some(msg)
            }
        }
    }

    // ---- building the diff ----------------------------------------------------

    /// Put the ticked set's net diff on the right, from the cache or by
    /// starting the merge. `apply_pr` calls this every frame in jn.
    pub(super) fn apply_net(&mut self) {
        let key = self.net_key();
        let refreshing = self.prs.as_ref().is_some_and(|p| p.refreshing());
        let Some(n) = self.net.as_mut() else { return };
        if n.hold {
            if refreshing {
                return;
            }
            n.hold = false;
        }
        // A merge for a set we've moved on from stops at its next PR.
        if let Some(j) = n.job.as_ref().filter(|j| j.key != key) {
            j.stop.store(true, Ordering::Relaxed);
        }
        if n.loaded.as_ref() == Some(&key) {
            return;
        }
        if key.is_empty() {
            n.loaded = Some(key);
            self.load_files("");
            return;
        }
        let got = n.cache.get(&key).map(|r| r.as_ref().map(|net| net.text.clone()).map_err(|_| ()));
        match got {
            Some(Ok(text)) => {
                n.loaded = Some(key);
                let keep = n.keep.take();
                self.load_files(&text);
                if let Some(f) = keep.and_then(|p| self.files.iter().position(|x| x.path == p)) {
                    self.jump_file(f);
                }
                if let Some(msg) = self.net_trouble() {
                    self.flash(msg);
                }
            }
            Some(Err(())) => {
                n.loaded = Some(key);
                self.load_files("");
            }
            None => {
                // The old set's diff goes now: keep its file to come back to.
                if n.loaded.take().is_some() {
                    let keep = self.cur_file().map(|f| self.files[f].path.clone());
                    if let Some(n) = self.net.as_mut() {
                        n.keep = keep.or(n.keep.take());
                    }
                    self.load_files("");
                }
                self.spawn_net(key);
            }
        }
    }

    /// Conflicts and PRs left out, for the status line.
    fn net_trouble(&self) -> Option<String> {
        let net = self.net_shown()?;
        let (c, s) = (net.conflicts.len(), net.skipped.len());
        if c + s > 2 {
            let files = net.conflict_paths().len();
            let mut t = format!("⚠ {c} of {} PRs conflict (markers in {files} file{})", net.order.len(), if files == 1 { "" } else { "s" });
            if s > 0 {
                t.push_str(&format!(" · {s} left out"));
            }
            return Some(t);
        }
        let mut parts: Vec<String> = net
            .conflicts
            .iter()
            .map(|(n, f)| format!("#{n} conflicts in {} file{}", f.len(), if f.len() == 1 { "" } else { "s" }))
            .collect();
        parts.extend(net.skipped.iter().map(|(n, why)| format!("#{n} left out: {why}")));
        (!parts.is_empty()).then(|| format!("⚠ {}", parts.join(" · ")))
    }

    fn spawn_net(&mut self, key: String) {
        let picks = self.net_picks();
        let Some(n) = self.net.as_mut() else { return };
        if n.job.is_some() {
            return;
        }
        let base = n.base.clone();
        let tx = n.tx.clone();
        let (stop, at) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        n.job = Some(Job { key: key.clone(), stop: stop.clone(), at: at.clone(), total: picks.len() });
        thread::spawn(move || {
            let go = |k: usize| {
                at.store(k, Ordering::Relaxed);
                !stop.load(Ordering::Relaxed)
            };
            let got = (|| {
                let base = match base {
                    Some(b) => b,
                    None => net::default_branch()?,
                };
                Ok(net::compute(&base, &picks, &go)?.map(|net| (base, net)))
            })();
            let _ = tx.send((key, got));
        });
    }

    /// Take in a finished merge. Returns true when a redraw is needed.
    pub(super) fn poll_net(&mut self) -> bool {
        let Some(n) = self.net.as_mut() else { return false };
        let mut dirty = false;
        while let Ok((key, got)) = n.rx.try_recv() {
            if n.job.as_ref().is_some_and(|j| j.key == key) {
                n.job = None;
            }
            dirty = true;
            let got = match got {
                Ok(Some((base, net))) => {
                    n.base = Some(base);
                    Ok(net)
                }
                // Called off: nothing to keep.
                Ok(None) => continue,
                Err(e) => Err(e),
            };
            n.cache.insert(key, got);
        }
        dirty
    }

    /// `r`: forget every merge, ask the remote for the default branch and
    /// the PR list again, then merge the ticked set afresh.
    fn net_reload(&mut self) {
        let here = self.cur_file().map(|f| self.files[f].path.clone());
        let Some(n) = self.net.as_mut() else { return };
        n.cache.clear();
        n.base = None;
        n.hold = true;
        if let Some(j) = &n.job {
            j.stop.store(true, Ordering::Relaxed);
        }
        if n.loaded.take().is_some() {
            n.keep = here.or(n.keep.take());
        }
        self.load_files("");
        self.spawn_list(true);
        self.flash("fetching the PRs and merging again…");
    }

    // ---- ticking ----------------------------------------------------------------

    fn set_ticks(&mut self, nums: &[u32], on: bool) {
        let Some(n) = self.net.as_mut() else { return };
        for &x in nums {
            if on {
                n.ticked.insert(x);
            } else {
                n.ticked.remove(&x);
            }
        }
    }

    fn net_toggle(&mut self, n: isize) {
        let Some(pr) = self.prs.as_ref().and_then(|p| p.cur_item()).cloned() else { return };
        let on = !self.net.as_ref().is_some_and(|t| t.ticked.contains(&pr.number));
        self.set_ticks(&[pr.number], on);
        self.note_below(&pr, on);
        self.pr_move(n);
    }

    /// Ticking a PR stacked on unticked ones: say their changes come too.
    fn note_below(&mut self, pr: &Pr, on: bool) {
        let below = self.net_below(pr);
        if on && !below.is_empty() {
            let list: Vec<String> = below.iter().map(|b| format!("#{b}")).collect();
            let k = below.len();
            self.flash(format!(
                "#{} sits on {} ({}): merging it brings {} · S ticks the stack",
                pr.number,
                list.join(" "),
                if k == 1 { "unticked" } else { "all unticked" },
                if k == 1 { "that one too" } else { "them too" }
            ));
        }
    }

    /// `S`: the cursor PR's whole stack, ticked (or unticked, when it all is).
    fn net_toggle_stack(&mut self) {
        let trunk = self.trunk();
        let Some(p) = self.prs.as_ref() else { return };
        let Some(&i) = p.shown.get(p.cur) else { return };
        let stack = stack_of(&p.items, i, &trunk);
        let all = self.net.as_ref().is_some_and(|t| stack.iter().all(|x| t.ticked.contains(x)));
        self.set_ticks(&stack, !all);
        let k = stack.len();
        self.flash(match (all, k) {
            (_, 1) => "no stack: this PR stands alone".to_string(),
            (true, _) => format!("unticked a stack of {k}"),
            (false, _) => format!("ticked a stack of {k}"),
        });
    }

    /// `a`: every PR the list shows (filtered or not), or none of them.
    fn net_toggle_all(&mut self) {
        let Some(p) = self.prs.as_ref() else { return };
        let nums: Vec<u32> = p.shown.iter().map(|&i| p.items[i].number).collect();
        let all = self.net.as_ref().is_some_and(|t| nums.iter().all(|x| t.ticked.contains(x)));
        self.set_ticks(&nums, !all);
        let k = nums.len();
        self.flash(if all { format!("unticked {k} PRs") } else { format!("ticked {k} PRs") });
    }

    /// `x` on a PR: the net diff's files it touches, viewed (or not, when all are).
    fn net_viewed(&mut self) {
        let Some(num) = self.prs.as_ref().and_then(|p| p.cur_item()).map(|pr| pr.number) else { return };
        let hashes: Vec<u64> = self
            .files
            .iter()
            .filter(|f| self.show_tests || !f.is_test)
            .filter(|f| self.net_prs_for(&f.path).contains(&num))
            .map(|f| f.hash)
            .collect();
        if hashes.is_empty() {
            self.flash(format!("#{num} touches nothing in this net diff"));
            return;
        }
        let on = !hashes.iter().all(|&h| self.viewed.has(h));
        self.viewed.set_many(&hashes, on);
        self.fold.clear();
        self.rebuild_doc();
        let k = hashes.len();
        self.flash(if on { format!("✓ viewed the {k} files #{num} touches") } else { format!("unmarked #{num}'s files") });
    }

    /// `O` in the diff: this file in the PR that changes it (the first one,
    /// when several do).
    pub(super) fn net_pr_url(&self, path: &str) -> Option<String> {
        let num = *self.net_prs_for(path).first()?;
        self.prs.as_ref()?.items.iter().find(|p| p.number == num).map(|p| p.url.clone())
    }

    /// A click on a PR's tick column.
    pub(super) fn net_click_tick(&mut self, i: usize) {
        let Some(p) = self.prs.as_ref() else { return };
        let Some(&ix) = p.shown.get(i) else { return };
        let pr = p.items[ix].clone();
        let on = !self.net.as_ref().is_some_and(|t| t.ticked.contains(&pr.number));
        self.set_ticks(&[pr.number], on);
        self.note_below(&pr, on);
    }

    /// jn's keys, ahead of jp's. None leaves the key to jp (and then jv).
    pub(super) fn key_net(&mut self, k: KeyEvent, n: isize) -> Option<Act> {
        self.net.as_ref()?;
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if k.code == KeyCode::Char('r') && !ctrl {
            self.net_reload();
            return Some(Act::None);
        }
        if !self.prs_on() {
            return None;
        }
        match (k.code, ctrl) {
            (KeyCode::Char(' '), false) => self.net_toggle(n),
            (KeyCode::Char('S'), _) => self.net_toggle_stack(),
            (KeyCode::Char('a'), false) => self.net_toggle_all(),
            (KeyCode::Char('x'), false) => self.net_viewed(),
            _ => return None,
        }
        Some(Act::None)
    }
}

/// The checkout's branch, for the stack jn starts with ticked.
pub fn current_branch() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !b.is_empty() && b != "HEAD").then_some(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u32, head: &str, base: &str) -> Pr {
        Pr { number: n, head: head.into(), base: base.into(), ..Pr::default() }
    }

    #[test]
    fn stacks() {
        let items = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b"), pr(4, "x", "main"), pr(5, "d", "a")];
        assert_eq!(stack_of(&items, 2, "main"), vec![1, 2, 3, 5]);
        assert_eq!(stack_of(&items, 3, "main"), vec![4]);
    }
}
