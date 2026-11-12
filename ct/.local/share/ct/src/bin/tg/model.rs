//! tg's groups: Chrome's saved groups (the sync store) joined with the groups open right now (the
//! extension). An open group is matched to its saved record by title and color, then by how many
//! tab URLs they share; its tabs come from the live browser. A saved group with no open match is
//! closed. An open group with no record (saving off, or the store not written yet) still shows.

use std::collections::HashSet;

use tabkit::bridge::Snap;

use crate::ax;
use crate::store::SavedGroup;

pub struct Group {
    /// The saved group's guid, or `open:<id>` for an open group with no record.
    pub key: String,
    pub guid: Option<String>,
    /// The extension's id for it while it's open.
    pub open: Option<i64>,
    pub title: String,
    pub color: String,
    /// Its place on the bookmarks bar.
    pub pinned: Option<i64>,
    /// Unix ms; 0 when unknown.
    pub created: f64,
    pub updated: f64,
    pub tabs: Vec<GTab>,
    /// Open groups: the window it's in, and where it starts there (for tab-strip order).
    window: i64,
    first: i64,
}

pub struct GTab {
    /// Open groups only.
    pub id: Option<i64>,
    pub title: String,
    pub url: String,
}

impl GTab {
    /// Its title, or the URL when it has none (what Chrome's menus show).
    pub fn label(&self) -> &str {
        if self.title.trim().is_empty() {
            &self.url
        } else {
            &self.title
        }
    }

    /// `github.com/owner/repo/pull/12`.
    pub fn short_url(&self) -> &str {
        let u = self.url.as_str();
        let u = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(u);
        let u = u.strip_prefix("www.").unwrap_or(u);
        u.strip_suffix('/').unwrap_or(u)
    }
}

impl Group {
    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// The name on its bookmarks-bar chip: the title, or "unnamed".
    pub fn label(&self) -> String {
        ax::label(&self.title)
    }

    /// Same title and color: Chrome draws them as the same pill.
    pub fn look(&self) -> (String, String) {
        (self.title.clone(), self.color.clone())
    }

    pub fn matches(&self, words: &[String]) -> bool {
        if words.is_empty() {
            return true;
        }
        let title = self.title.to_lowercase();
        words.iter().all(|w| {
            title.contains(w.as_str()) || self.tabs.iter().any(|t| t.title.to_lowercase().contains(w.as_str()) || t.url.to_lowercase().contains(w.as_str()))
        })
    }
}

/// Every group: open ones first in tab-strip order, then closed ones in bookmarks-bar order,
/// then the closed ones that aren't on the bar, newest first.
pub fn merge(saved: Vec<SavedGroup>, snap: &Snap) -> Vec<Group> {
    let win_pos = |id: i64| snap.windows.iter().position(|w| w.id == id).unwrap_or(usize::MAX) as i64;
    let mut saved: Vec<Option<SavedGroup>> = saved.into_iter().map(Some).collect();
    let mut out: Vec<Group> = Vec::new();

    let mut open_ids: Vec<i64> = snap.groups.keys().copied().collect();
    open_ids.sort();
    for id in open_ids {
        let g = &snap.groups[&id];
        let tabs: Vec<GTab> = snap
            .tabs
            .iter()
            .filter(|t| t.group == id)
            .map(|t| GTab { id: Some(t.id), title: t.title.clone(), url: t.url.clone() })
            .collect();
        let first = snap.tabs.iter().filter(|t| t.group == id).map(|t| t.index).min().unwrap_or(0);
        let urls: HashSet<&str> = tabs.iter().map(|t| t.url.as_str()).collect();
        // The record with this title and color sharing the most URLs.
        let best = saved
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().map(|s| (i, s)))
            .filter(|(_, s)| s.title == g.title && s.color == g.color)
            .max_by_key(|(_, s)| (s.tabs.iter().filter(|t| urls.contains(t.url.as_str())).count(), s.updated as i64))
            .map(|(i, _)| i);
        let rec = best.and_then(|i| saved[i].take());
        out.push(Group {
            key: rec.as_ref().map_or_else(|| format!("open:{id}"), |r| r.guid.clone()),
            guid: rec.as_ref().map(|r| r.guid.clone()),
            open: Some(id),
            title: g.title.clone(),
            color: g.color.clone(),
            pinned: rec.as_ref().and_then(|r| r.pinned),
            created: rec.as_ref().map_or(0.0, |r| r.created),
            updated: rec.as_ref().map_or(0.0, |r| r.updated),
            tabs,
            window: g.window,
            first,
        });
    }
    out.sort_by_key(|g| (win_pos(g.window), g.first));

    let mut closed: Vec<Group> = saved
        .into_iter()
        .flatten()
        .map(|s| Group {
            key: s.guid.clone(),
            guid: Some(s.guid),
            open: None,
            title: s.title,
            color: s.color.to_string(),
            pinned: s.pinned,
            created: s.created,
            updated: s.updated,
            tabs: s.tabs.into_iter().map(|t| GTab { id: None, title: t.title, url: t.url }).collect(),
            window: -1,
            first: 0,
        })
        .collect();
    closed.sort_by(|a, b| match (a.pinned, b.pinned) {
        (Some(x), Some(y)) => x.cmp(&y).then(b.created.total_cmp(&a.created)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.updated.total_cmp(&a.updated),
    });
    out.extend(closed);
    out
}
