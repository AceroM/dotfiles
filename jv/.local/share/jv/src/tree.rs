//! The GitHub-style file tree: directories first, single-child directory
//! chains folded into one row (`src/server/api`).

use std::collections::{BTreeMap, HashSet};

use crate::diff::FileDiff;

pub enum Node {
    Dir { name: String, path: String, kids: Vec<Node> },
    File { idx: usize, name: String },
}

pub enum RowKind {
    Dir { path: String, name: String, open: bool },
    File { idx: usize, name: String },
}

pub struct Row {
    pub depth: u16,
    pub kind: RowKind,
}

#[derive(Default)]
struct B {
    dirs: BTreeMap<String, B>,
    files: Vec<(String, usize)>,
}

pub fn build(files: &[FileDiff], idxs: &[usize]) -> Vec<Node> {
    let mut root = B::default();
    for &i in idxs {
        let mut parts: Vec<&str> = files[i].path.split('/').collect();
        let name = parts.pop().unwrap_or("");
        let mut node = &mut root;
        for p in parts {
            node = node.dirs.entry(p.to_string()).or_default();
        }
        node.files.push((name.to_string(), i));
    }
    convert(root, "")
}

fn by_name(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

fn convert(b: B, prefix: &str) -> Vec<Node> {
    let mut out = Vec::new();
    let mut dirs: Vec<(String, B)> = b.dirs.into_iter().collect();
    dirs.sort_by(|a, b| by_name(&a.0, &b.0));
    for (name, sub) in dirs {
        let mut name = name;
        let mut path = join(prefix, &name);
        let mut sub = sub;
        while sub.files.is_empty() && sub.dirs.len() == 1 {
            let (n, s) = sub.dirs.into_iter().next().expect("one child");
            name = format!("{name}/{n}");
            path = join(&path, &n);
            sub = s;
        }
        let kids = convert(sub, &path);
        out.push(Node::Dir { name, path, kids });
    }
    let mut files = b.files;
    files.sort_by(|a, b| by_name(&a.0, &b.0));
    out.extend(files.into_iter().map(|(name, idx)| Node::File { idx, name }));
    out
}

/// File indices in tree order — the diff pane stacks files in this order so
/// moving down the tree moves down the diff.
pub fn order(nodes: &[Node], out: &mut Vec<usize>) {
    for n in nodes {
        match n {
            Node::Dir { kids, .. } => order(kids, out),
            Node::File { idx, .. } => out.push(*idx),
        }
    }
}

pub fn flatten(nodes: &[Node], collapsed: &HashSet<String>, depth: u16, out: &mut Vec<Row>) {
    for n in nodes {
        match n {
            Node::Dir { name, path, kids } => {
                let open = !collapsed.contains(path);
                out.push(Row { depth, kind: RowKind::Dir { path: path.clone(), name: name.clone(), open } });
                if open {
                    flatten(kids, collapsed, depth + 1, out);
                }
            }
            Node::File { idx, name } => {
                out.push(Row { depth, kind: RowKind::File { idx: *idx, name: name.clone() } });
            }
        }
    }
}
