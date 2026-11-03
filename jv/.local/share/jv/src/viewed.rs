//! "Viewed" marks, persisted across runs in ~/.local/state/jv/viewed as one
//! content hash per line. Keying by content (not PR) means a file you viewed
//! comes back unviewed as soon as its diff changes, like GitHub's checkbox.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

const CAP: usize = 20_000;

pub struct Viewed {
    path: Option<PathBuf>,
    set: HashSet<u64>,
    order: Vec<u64>,
}

fn state_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("XDG_STATE_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join("jv"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state/jv"))
}

impl Viewed {
    pub fn load() -> Self {
        let path = state_dir().map(|d| d.join("viewed"));
        let order: Vec<u64> = path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|s| s.lines().filter_map(|l| u64::from_str_radix(l.trim(), 16).ok()).collect())
            .unwrap_or_default();
        let set = order.iter().copied().collect();
        Viewed { path, set, order }
    }

    pub fn ephemeral() -> Self {
        Viewed { path: None, set: HashSet::new(), order: Vec::new() }
    }

    pub fn has(&self, h: u64) -> bool {
        self.set.contains(&h)
    }

    pub fn set(&mut self, h: u64, on: bool) {
        if self.apply(h, on) {
            self.save();
        }
    }

    /// Mark several files at once (a folder in the tree) with one write.
    pub fn set_many(&mut self, hs: &[u64], on: bool) {
        let mut changed = false;
        for &h in hs {
            changed |= self.apply(h, on);
        }
        if changed {
            self.save();
        }
    }

    fn apply(&mut self, h: u64, on: bool) -> bool {
        if on == self.has(h) {
            return false;
        }
        if on {
            self.set.insert(h);
            self.order.push(h);
            if self.order.len() > CAP {
                let drop = self.order.len() - CAP;
                for old in self.order.drain(..drop) {
                    self.set.remove(&old);
                }
            }
        } else {
            self.set.remove(&h);
            self.order.retain(|&x| x != h);
        }
        true
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let mut s = String::with_capacity(self.order.len() * 17);
        for h in &self.order {
            s.push_str(&format!("{h:016x}\n"));
        }
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, s).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}
