//! Unified-diff parsing plus the two things delta adds on top of it: pairing
//! removed lines with the added lines they became, and marking the words that
//! changed inside each pair.

use std::ops::Range;

use similar::{capture_diff_slices, Algorithm, DiffOp};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Ctx,
    Add,
    Del,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub kind: Kind,
    /// Tabs expanded, control characters replaced, no trailing newline.
    pub text: String,
    /// 0 when the line has no number on that side.
    pub old: u32,
    pub new: u32,
    /// Byte ranges of `text` that changed relative to the paired line.
    pub emph: Vec<Range<usize>>,
    pub no_eol: bool,
}

#[derive(Clone, Debug)]
pub struct Hunk {
    pub old_start: u32,
    pub old_len: u32,
    pub new_start: u32,
    pub new_len: u32,
    /// The function/section name git prints after the second `@@`.
    pub context: String,
    pub lines: Vec<Line>,
    /// Split-view rows: (left line, right line) indices into `lines`.
    pub pairs: Vec<(Option<usize>, Option<usize>)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Clone, Debug)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: Status,
    pub binary: bool,
    pub mode: (String, String),
    pub hunks: Vec<Hunk>,
    pub adds: usize,
    pub dels: usize,
    /// Stable hash of path + content; "viewed" marks key off it, so a file
    /// that changes after you viewed it comes back unviewed (like GitHub).
    pub hash: u64,
    pub is_test: bool,
    pub generated: bool,
    pub max_line_no: u32,
}

impl FileDiff {
    fn new(path: String) -> Self {
        FileDiff {
            path,
            old_path: None,
            status: Status::Modified,
            binary: false,
            mode: (String::new(), String::new()),
            hunks: Vec::new(),
            adds: 0,
            dels: 0,
            hash: 0,
            is_test: false,
            generated: false,
            max_line_no: 0,
        }
    }

    pub fn line_count(&self) -> usize {
        self.hunks.iter().map(|h| h.lines.len()).sum()
    }

    /// Added or deleted files have only one side, so split view would leave
    /// half the screen empty; they render single-column.
    pub fn one_sided(&self) -> bool {
        matches!(self.status, Status::Added | Status::Deleted)
    }

    pub fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }

    fn finalize(&mut self) {
        let mut h: u64 = 0xcbf29ce484222325;
        fnv(&mut h, self.path.as_bytes());
        for hunk in &mut self.hunks {
            for l in &hunk.lines {
                match l.kind {
                    Kind::Add => self.adds += 1,
                    Kind::Del => self.dels += 1,
                    Kind::Ctx => {}
                }
                self.max_line_no = self.max_line_no.max(l.old).max(l.new);
                fnv(&mut h, &[l.kind as u8]);
                fnv(&mut h, l.text.as_bytes());
                fnv(&mut h, b"\n");
            }
            align(hunk);
        }
        if self.binary {
            fnv(&mut h, b"binary");
        }
        self.hash = h;
        self.is_test = is_test(&self.path);
        self.generated = is_generated(&self.path);
    }
}

fn fnv(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= *b as u64;
        *h = h.wrapping_mul(0x100000001b3);
    }
}

pub fn is_test(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    path.starts_with("__tests__/")
        || path.contains("/__tests__/")
        || path.contains("__snapshots__/")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("_test.go")
}

fn is_generated(path: &str) -> bool {
    const LOCKS: &[&str] = &[
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lock",
        "bun.lockb",
        "Cargo.lock",
        "Gemfile.lock",
        "poetry.lock",
        "composer.lock",
        "go.sum",
        "uv.lock",
    ];
    let name = path.rsplit('/').next().unwrap_or(path);
    LOCKS.contains(&name)
        || name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || path.contains("__generated__/")
}

pub struct Parsed {
    pub files: Vec<FileDiff>,
}

pub fn parse(input: &str) -> Parsed {
    let lines: Vec<&str> = input.lines().collect();
    let mut files: Vec<FileDiff> = Vec::new();
    let mut cur: Option<FileDiff> = None;
    let mut git = false;
    let mut skip = false; // inside a combined (merge) diff, which we don't render
    let (mut old_left, mut new_left, mut old_no, mut new_no) = (0u32, 0u32, 0u32, 0u32);
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        i += 1;

        if old_left > 0 || new_left > 0 {
            if let Some(h) = cur.as_mut().and_then(|f| f.hunks.last_mut()) {
                match line.as_bytes().first() {
                    None | Some(b' ') => {
                        let body = line.get(1..).unwrap_or("");
                        h.lines.push(Line::new(Kind::Ctx, body, old_no, new_no));
                        old_no += 1;
                        new_no += 1;
                        old_left = old_left.saturating_sub(1);
                        new_left = new_left.saturating_sub(1);
                        continue;
                    }
                    Some(b'-') => {
                        h.lines.push(Line::new(Kind::Del, &line[1..], old_no, 0));
                        old_no += 1;
                        old_left = old_left.saturating_sub(1);
                        continue;
                    }
                    Some(b'+') => {
                        h.lines.push(Line::new(Kind::Add, &line[1..], 0, new_no));
                        new_no += 1;
                        new_left = new_left.saturating_sub(1);
                        continue;
                    }
                    Some(b'\\') => {
                        if let Some(l) = h.lines.last_mut() {
                            l.no_eol = true;
                        }
                        continue;
                    }
                    // Malformed hunk: stop counting and treat the line as a header.
                    _ => {
                        old_left = 0;
                        new_left = 0;
                    }
                }
            } else {
                old_left = 0;
                new_left = 0;
            }
        }

        if let Some(rest) = line.strip_prefix("diff --git ") {
            finish(&mut cur, &mut files);
            let (a, b) = split_git_paths(rest);
            let mut f = FileDiff::new(b.clone());
            if a != b {
                f.old_path = Some(a);
            }
            cur = Some(f);
            git = true;
            skip = false;
            continue;
        }
        if line.starts_with("diff --cc ") || line.starts_with("diff --combined ") {
            finish(&mut cur, &mut files);
            skip = true;
            continue;
        }
        if skip {
            continue;
        }
        if line.starts_with('\\') {
            if let Some(l) = cur
                .as_mut()
                .and_then(|f| f.hunks.last_mut())
                .and_then(|h| h.lines.last_mut())
            {
                l.no_eol = true;
            }
            continue;
        }
        if line.starts_with("--- ") && lines.get(i).is_some_and(|n| n.starts_with("+++ ")) {
            let minus = clean_path(&line[4..], git);
            let plus = clean_path(&lines[i][4..], git);
            i += 1;
            let fresh = match &cur {
                None => true,
                Some(f) => !git || !f.hunks.is_empty(),
            };
            if fresh {
                finish(&mut cur, &mut files);
                cur = Some(FileDiff::new(String::new()));
                git = false;
            }
            let f = cur.as_mut().expect("file just ensured");
            if minus == "/dev/null" {
                f.status = Status::Added;
                f.path = plus;
                f.old_path = None;
            } else if plus == "/dev/null" {
                f.status = Status::Deleted;
                f.path = minus;
                f.old_path = None;
            } else {
                f.path = plus.clone();
                if git && minus != plus {
                    f.old_path = Some(minus);
                    if f.status == Status::Modified {
                        f.status = Status::Renamed;
                    }
                }
            }
            continue;
        }
        if line.starts_with("@@ -") {
            if let Some(f) = cur.as_mut() {
                if let Some((os, ol, ns, nl, ctx)) = parse_hunk_header(line) {
                    f.hunks.push(Hunk {
                        old_start: os,
                        old_len: ol,
                        new_start: ns,
                        new_len: nl,
                        context: clean(ctx),
                        lines: Vec::new(),
                        pairs: Vec::new(),
                    });
                    old_left = ol;
                    new_left = nl;
                    old_no = os;
                    new_no = ns;
                }
            }
            continue;
        }
        if let Some(f) = cur.as_mut() {
            if line.starts_with("new file mode") {
                f.status = Status::Added;
            } else if line.starts_with("deleted file mode") {
                f.status = Status::Deleted;
            } else if let Some(p) = line.strip_prefix("rename from ") {
                f.old_path = Some(unquote(p));
                f.status = Status::Renamed;
            } else if let Some(p) = line.strip_prefix("rename to ") {
                f.path = unquote(p);
                f.status = Status::Renamed;
            } else if let Some(p) = line.strip_prefix("copy from ") {
                f.old_path = Some(unquote(p));
                f.status = Status::Copied;
            } else if let Some(p) = line.strip_prefix("copy to ") {
                f.path = unquote(p);
                f.status = Status::Copied;
            } else if let Some(m) = line.strip_prefix("old mode ") {
                f.mode.0 = m.trim().to_string();
            } else if let Some(m) = line.strip_prefix("new mode ") {
                f.mode.1 = m.trim().to_string();
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                f.binary = true;
            }
            continue;
        }
        // Anything else (commit headers from `git show`, stray text) is skipped.
    }
    finish(&mut cur, &mut files);
    Parsed { files }
}

fn finish(cur: &mut Option<FileDiff>, files: &mut Vec<FileDiff>) {
    if let Some(mut f) = cur.take() {
        if f.path.is_empty() {
            return;
        }
        f.finalize();
        files.push(f);
    }
}

impl Line {
    fn new(kind: Kind, body: &str, old: u32, new: u32) -> Self {
        Line { kind, text: clean(body), old, new, emph: Vec::new(), no_eol: false }
    }
}

/// Tabs become two spaces (delta's `--tabs 2`); other control characters
/// would corrupt the terminal, so they render as a middle dot.
pub fn clean(s: &str) -> String {
    if !s.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return s.to_string();
    }
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\t' => o.push_str("  "),
            c if c.is_control() => o.push('·'),
            c => o.push(c),
        }
    }
    o
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32, &str)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, ctx) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let p = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (os, ol) = p(old)?;
    let (ns, nl) = p(new)?;
    Some((os, ol, ns, nl, ctx.strip_prefix(' ').unwrap_or(ctx)))
}

fn clean_path(s: &str, git: bool) -> String {
    let s = if s.starts_with('"') { s } else { s.split('\t').next().unwrap_or(s) };
    let p = unquote(s.trim_end());
    if p == "/dev/null" {
        return p;
    }
    if git {
        if let Some(r) = p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")) {
            return r.to_string();
        }
    }
    p
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    let Some(inner) = s.strip_prefix('"').and_then(|x| x.strip_suffix('"')) else {
        return s.to_string();
    };
    let b = inner.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            i += 1;
            match b[i] {
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'0'..=b'7' => {
                    let mut v: u32 = 0;
                    let mut k = 0;
                    while k < 3 && i < b.len() && (b'0'..=b'7').contains(&b[i]) {
                        v = v * 8 + (b[i] - b'0') as u32;
                        i += 1;
                        k += 1;
                    }
                    out.push(v as u8);
                    continue;
                }
                c => out.push(c),
            }
            i += 1;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_git_paths(rest: &str) -> (String, String) {
    fn strip(p: String, pre: &str) -> String {
        p.strip_prefix(pre).map(str::to_string).unwrap_or(p)
    }
    if rest.starts_with('"') {
        let bytes = rest.as_bytes();
        let mut j = 1;
        while j < bytes.len() {
            if bytes[j] == b'\\' {
                j += 2;
                continue;
            }
            if bytes[j] == b'"' {
                break;
            }
            j += 1;
        }
        let end = (j + 1).min(rest.len());
        let a = unquote(&rest[..end]);
        let b = unquote(rest.get(end..).unwrap_or("").trim());
        return (strip(a, "a/"), strip(b, "b/"));
    }
    if let Some(idx) = rest.find(" \"") {
        return (strip(rest[..idx].to_string(), "a/"), strip(unquote(&rest[idx + 1..]), "b/"));
    }
    let mut best = None;
    for (idx, _) in rest.match_indices(" b/") {
        let a = rest[..idx].strip_prefix("a/").unwrap_or(&rest[..idx]);
        let b = &rest[idx + 3..];
        if a == b {
            return (a.to_string(), b.to_string());
        }
        best = Some((a.to_string(), b.to_string()));
    }
    if let Some(b) = best {
        return b;
    }
    match rest.split_once(' ') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (rest.to_string(), rest.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Pairing and word-level emphasis

/// Lines further apart than this (share of changed characters) are shown as
/// an unrelated delete + add instead of an edit. delta's default is 0.6.
const MAX_DISTANCE: f32 = 0.6;
/// How far ahead a removed line looks for the added line it became.
const WINDOW: usize = 12;

fn align(h: &mut Hunk) {
    let n = h.lines.len();
    let mut rows = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        if h.lines[i].kind == Kind::Ctx {
            rows.push((Some(i), Some(i)));
            i += 1;
            continue;
        }
        let start = i;
        while i < n && h.lines[i].kind != Kind::Ctx {
            i += 1;
        }
        let dels: Vec<usize> = (start..i).filter(|&k| h.lines[k].kind == Kind::Del).collect();
        let adds: Vec<usize> = (start..i).filter(|&k| h.lines[k].kind == Kind::Add).collect();
        let matched = match_lines(&mut h.lines, &dels, &adds);
        let (mut pd, mut pa) = (0, 0);
        for (di, ai) in matched {
            zip(&mut rows, &dels[pd..di], &adds[pa..ai]);
            rows.push((Some(dels[di]), Some(adds[ai])));
            pd = di + 1;
            pa = ai + 1;
        }
        zip(&mut rows, &dels[pd..], &adds[pa..]);
    }
    h.pairs = rows;
}

fn zip(rows: &mut Vec<(Option<usize>, Option<usize>)>, d: &[usize], a: &[usize]) {
    for k in 0..d.len().max(a.len()) {
        rows.push((d.get(k).copied(), a.get(k).copied()));
    }
}

/// Greedy, order-preserving: each removed line takes the first upcoming added
/// line that is close enough to be "the same line, edited" (delta's approach).
fn match_lines(lines: &mut [Line], dels: &[usize], adds: &[usize]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    if dels.is_empty() || adds.is_empty() {
        return out;
    }
    let mut next = 0;
    for (di, &d) in dels.iter().enumerate() {
        if next >= adds.len() {
            break;
        }
        let end = (next + WINDOW).min(adds.len());
        for ai in next..end {
            if let Some((eo, en)) = emph_pair(&lines[d].text, &lines[adds[ai]].text) {
                lines[d].emph = eo;
                lines[adds[ai]].emph = en;
                out.push((di, ai));
                next = ai + 1;
                break;
            }
        }
    }
    out
}

type Emph = (Vec<Range<usize>>, Vec<Range<usize>>);

fn emph_pair(a: &str, b: &str) -> Option<Emph> {
    if a.trim().is_empty() || b.trim().is_empty() {
        return None;
    }
    if a.len() > 2000 || b.len() > 2000 {
        return None;
    }
    let ta = tokenize(a);
    let tb = tokenize(b);
    let sa: Vec<&str> = ta.iter().map(|r| &a[r.clone()]).collect();
    let sb: Vec<&str> = tb.iter().map(|r| &b[r.clone()]).collect();
    let ops = capture_diff_slices(Algorithm::Myers, &sa, &sb);
    let mut ea: Vec<Range<usize>> = Vec::new();
    let mut eb: Vec<Range<usize>> = Vec::new();
    let span = |toks: &[Range<usize>], i: usize, len: usize| toks[i].start..toks[i + len - 1].end;
    for op in ops {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete { old_index, old_len, .. } => push_merge(&mut ea, span(&ta, old_index, old_len)),
            DiffOp::Insert { new_index, new_len, .. } => push_merge(&mut eb, span(&tb, new_index, new_len)),
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                push_merge(&mut ea, span(&ta, old_index, old_len));
                push_merge(&mut eb, span(&tb, new_index, new_len));
            }
        }
    }
    let changed: usize = ea.iter().chain(eb.iter()).map(|r| r.len()).sum();
    let total = a.len() + b.len();
    if changed as f32 / total.max(1) as f32 > MAX_DISTANCE {
        return None;
    }
    Some((ea, eb))
}

fn push_merge(v: &mut Vec<Range<usize>>, r: Range<usize>) {
    if r.is_empty() {
        return;
    }
    if let Some(last) = v.last_mut() {
        if last.end >= r.start {
            last.end = last.end.max(r.end);
            return;
        }
    }
    v.push(r);
}

/// Words, runs of whitespace, and single punctuation characters.
fn tokenize(s: &str) -> Vec<Range<usize>> {
    fn class(c: char) -> u8 {
        if c.is_alphanumeric() || c == '_' {
            0
        } else if c.is_whitespace() {
            1
        } else {
            2
        }
    }
    let mut out = Vec::new();
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let cls = class(c);
        let mut end = i + c.len_utf8();
        if cls != 2 {
            while let Some(&(j, d)) = it.peek() {
                if class(d) != cls {
                    break;
                }
                end = j + d.len_utf8();
                it.next();
            }
        }
        out.push(i..end);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PR: &str = "diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ import {
 const a = 1
-const b = foo(1)
+const b = foo(2)
+const c = 3
 -- not a header
--- a/looks/like/a/header
@@ -10,2 +11,2 @@
 x
-y
+z
diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
";

    #[test]
    fn parses_files_hunks_and_renames() {
        let p = parse(PR);
        assert_eq!(p.files.len(), 3);
        let a = &p.files[0];
        assert_eq!(a.path, "src/a.ts");
        assert_eq!(a.hunks.len(), 2);
        assert_eq!(a.hunks[0].context, "import {");
        // "-- not a header" is a context line, "--- a/..." a deletion of "-- a/...".
        assert_eq!(a.hunks[0].lines.len(), 6);
        assert_eq!(a.hunks[0].lines[5].kind, Kind::Del);
        assert_eq!(a.adds, 3);
        assert_eq!(a.dels, 3);
        let n = &p.files[1];
        assert_eq!(n.status, Status::Added);
        assert!(n.hunks[0].lines[1].no_eol);
        let r = &p.files[2];
        assert_eq!(r.status, Status::Renamed);
        assert_eq!(r.path, "new name.txt");
        assert_eq!(r.old_path.as_deref(), Some("old name.txt"));
    }

    #[test]
    fn pairs_edits_and_marks_changed_words() {
        let p = parse(PR);
        let h = &p.files[0].hunks[0];
        assert_eq!(h.pairs[1], (Some(1), Some(2)));
        assert_eq!(h.pairs[2], (None, Some(3)));
        let del = &h.lines[1];
        assert_eq!(&del.text[del.emph[0].clone()], "1");
    }

    #[test]
    fn detects_tests() {
        assert!(is_test("src/__tests__/a.ts"));
        assert!(is_test("src/a.test.tsx"));
        assert!(!is_test("src/testing.ts"));
    }
}
