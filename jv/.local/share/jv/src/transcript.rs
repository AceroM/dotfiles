//! A Claude Code session's transcript as preview lines, for scrolling a
//! Claude tab past its screen: Claude Code redraws one screen in place, so
//! Herdr holds no scrollback for it, but every turn is in
//! ~/.claude/projects/<project>/<session>.jsonl.
//!
//! Read from the end a chunk at a time: a long session opens at once, and
//! scrolling up reads further back.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use ratatui::style::{Color, Modifier, Style};
use serde_json::Value;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::ansi::Line;

const CHUNK: u64 = 256 * 1024;

#[derive(Clone, Copy)]
pub struct Colors {
    pub fg: Color,
    pub bright: Color,
    pub dim: Color,
    pub accent: Color,
    pub green: Color,
}

enum Entry {
    /// Something typed to Claude.
    Prompt(String),
    /// Claude's reply text.
    Reply(String),
    /// A tool call: its name and a one-line gist of its input.
    Tool(String, String),
}

pub struct Transcript {
    path: PathBuf,
    /// Bytes [start, end) of the file are read.
    start: u64,
    end: u64,
    entries: Vec<Entry>,
    width: usize,
    colors: Colors,
    pub lines: Vec<Line>,
}

/// The transcript file for Claude session `id`, in whichever project it's under.
pub fn find(id: &str) -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("HOME")?).join(".claude/projects");
    let name = format!("{id}.jsonl");
    std::fs::read_dir(root).ok()?.flatten().map(|d| d.path().join(&name)).find(|p| p.is_file())
}

fn read_range(path: &PathBuf, from: u64, to: u64) -> Option<Vec<u8>> {
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = vec![0; (to - from) as usize];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

impl Transcript {
    pub fn open(path: PathBuf, width: usize, colors: Colors) -> Option<Transcript> {
        let len = std::fs::metadata(&path).ok()?.len();
        let mut t = Transcript { path, start: len, end: len, entries: Vec::new(), width, colors, lines: Vec::new() };
        // The newest chunk. Its last line may still be being written: keep to whole lines.
        let from = len.saturating_sub(CHUNK);
        let buf = read_range(&t.path, from, len)?;
        let whole = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        t.end = from + whole as u64;
        t.start = t.end;
        t.take_chunk_before(from, &buf[..whole]);
        t.render();
        Some(t)
    }

    /// Parse `buf` (the file from `from` up to `self.start`) onto the front.
    fn take_chunk_before(&mut self, from: u64, buf: &[u8]) {
        // Mid-file, the chunk starts mid-line: drop that piece. A chunk with no
        // newline at all is the middle of one huge line; skip it whole.
        let skip = if from == 0 { 0 } else { buf.iter().position(|&b| b == b'\n').map_or(buf.len(), |i| i + 1) };
        let mut new = parse(&buf[skip.min(buf.len())..]);
        self.start = from + if skip >= buf.len() { 0 } else { skip as u64 };
        new.append(&mut self.entries);
        self.entries = new;
    }

    /// Read the chunk before what's loaded. False once the file's start is in.
    pub fn load_earlier(&mut self) -> bool {
        if self.start == 0 {
            return false;
        }
        let from = self.start.saturating_sub(CHUNK);
        let Some(buf) = read_range(&self.path, from, self.start) else { return false };
        self.take_chunk_before(from, &buf);
        self.render();
        true
    }

    /// Pick up turns written since. True when there are new lines.
    pub fn grow(&mut self) -> bool {
        let len = std::fs::metadata(&self.path).map_or(self.end, |m| m.len());
        if len <= self.end {
            return false;
        }
        let Some(buf) = read_range(&self.path, self.end, len) else { return false };
        let Some(whole) = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1) else { return false };
        self.end += whole as u64;
        let mut new = parse(&buf[..whole]);
        if new.is_empty() {
            return false;
        }
        self.entries.append(&mut new);
        self.render();
        true
    }

    pub fn set_width(&mut self, width: usize) {
        if width != self.width {
            self.width = width;
            self.render();
        }
    }

    fn render(&mut self) {
        let c = self.colors;
        let w = self.width.max(10);
        let mut out: Vec<Line> = Vec::new();
        for e in &self.entries {
            out.push(Vec::new());
            match e {
                Entry::Prompt(text) => block(&mut out, "❯ ", Style::new().fg(c.accent), text, Style::new().fg(c.bright), w),
                Entry::Reply(text) => block(&mut out, "⏺ ", Style::new().fg(c.bright), text, Style::new().fg(c.fg), w),
                Entry::Tool(name, gist) => {
                    let room = w.saturating_sub(name.width() + 4);
                    out.push(vec![
                        ("⏺ ".into(), Style::new().fg(c.green)),
                        (name.clone(), Style::new().fg(c.bright).add_modifier(Modifier::BOLD)),
                        (format!("({})", clip(gist, room)), Style::new().fg(c.dim)),
                    ]);
                }
            }
        }
        self.lines = out;
    }
}

/// `text` word-wrapped to `w`, the first row behind `mark`, the rest indented to match.
fn block(out: &mut Vec<Line>, mark: &str, mark_st: Style, text: &str, st: Style, w: usize) {
    let indent = " ".repeat(mark.width());
    let mut first = true;
    for para in text.trim_end().split('\n') {
        for row in wrap(para, w.saturating_sub(indent.len()).max(4)) {
            let lead = if first { (mark.to_string(), mark_st) } else { (indent.clone(), st) };
            first = false;
            out.push(vec![lead, (row, st)]);
        }
    }
}

/// Word wrap by display width; a word longer than `w` is broken.
fn wrap(s: &str, w: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let (mut row, mut rw) = (String::new(), 0);
    for word in s.split(' ') {
        let ww = word.width();
        if rw > 0 && rw + 1 + ww > w {
            rows.push(std::mem::take(&mut row));
            rw = 0;
        }
        if rw > 0 {
            row.push(' ');
            rw += 1;
        }
        for ch in word.chars() {
            let cw = ch.width().unwrap_or(0);
            if rw + cw > w && rw > 0 {
                rows.push(std::mem::take(&mut row));
                rw = 0;
            }
            row.push(ch);
            rw += cw;
        }
    }
    rows.push(row);
    rows
}

fn clip(s: &str, w: usize) -> String {
    if s.width() <= w {
        return s.to_string();
    }
    let mut out = String::new();
    let mut cw = 0;
    for ch in s.chars() {
        let x = ch.width().unwrap_or(0);
        if cw + x + 1 > w {
            break;
        }
        out.push(ch);
        cw += x;
    }
    out.push('…');
    out
}

/// The turns in whole JSONL lines: prompts, reply text and tool calls.
/// Thinking, tool output, subagents and bookkeeping lines are left out.
fn parse(buf: &[u8]) -> Vec<Entry> {
    let mut out = Vec::new();
    for line in buf.split(|&b| b == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        if v["isSidechain"] == true || v["isMeta"] == true {
            continue;
        }
        let content = &v["message"]["content"];
        match v["type"].as_str() {
            Some("user") => {
                let text = match content {
                    Value::String(s) => s.clone(),
                    Value::Array(blocks) => blocks
                        .iter()
                        .filter_map(|b| match b["type"].as_str() {
                            Some("text") => b["text"].as_str().map(String::from),
                            Some("image") => Some("[Image]".into()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(" "),
                    _ => continue,
                };
                // Slash-command and hook plumbing comes wrapped in <tags>.
                let t = text.trim();
                if !t.is_empty() && !t.starts_with('<') {
                    out.push(Entry::Prompt(t.to_string()));
                }
            }
            Some("assistant") => {
                for b in content.as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = b["text"].as_str().filter(|t| !t.trim().is_empty()) {
                                out.push(Entry::Reply(t.trim().to_string()));
                            }
                        }
                        Some("tool_use") => {
                            out.push(Entry::Tool(b["name"].as_str().unwrap_or("tool").to_string(), gist(&b["input"])));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// One line saying what a tool call was for.
fn gist(input: &Value) -> String {
    let s = |k: &str| input[k].as_str().map(|s| s.lines().next().unwrap_or("").to_string());
    let path = |k: &str| s(k).map(|p| crate::herdr::tilde(&p));
    s("description")
        .or_else(|| path("file_path"))
        .or_else(|| s("command"))
        .or_else(|| s("pattern"))
        .or_else(|| s("prompt"))
        .or_else(|| input.as_object()?.values().find_map(|v| v.as_str().map(|s| s.lines().next().unwrap_or("").to_string())))
        .unwrap_or_default()
}
