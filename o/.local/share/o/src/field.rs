//! The prompt's text: a multi-line field with a cursor and a selection (al's
//! agent box, the same keys), its `[Image #N]` tags, and the images behind
//! them: pasted (^v, or ⌘V with only an image on the clipboard) or dropped in
//! from Finder.
//!
//! Like Claude Code, the prompt keeps the tags, and what's sent lists each
//! one's file at the end, so the agent opens them with its own file tools.

use std::ops::Range;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Where pasted images go: $TMPDIR/o.
pub fn tmp_dir() -> PathBuf {
    std::env::temp_dir().join("o")
}

/// Milliseconds since the epoch, for file names.
pub fn stamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// Whether `bin` is on $PATH.
pub fn which(bin: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
}

/// A prompt's first line with words in it, its spaces squeezed: what the
/// sent list shows.
pub fn first_line(text: &str) -> String {
    text.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).find(|l| !l.is_empty()).unwrap_or_default()
}

/// Rows of `text` as the box shows them: each line wrapped at its spaces to
/// `w` columns, a word longer than a row cut, as byte ranges. A row wrapped
/// mid-line ends where the next one starts; a line's last row ends at its
/// `\n` (or the text's end), one byte short of the next.
pub fn word_rows(text: &str, w: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        out.extend(word_wrap(line, w).into_iter().map(|r| start + r.start..start + r.end));
        start += line.len() + 1;
    }
    out
}

fn word_wrap(text: &str, w: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let (mut start, mut col) = (0, 0);
    // Where this row may break: just past its last space.
    let mut brk = None;
    for (i, c) in text.char_indices() {
        let cw = c.width().unwrap_or(0);
        if col + cw > w && col > 0 {
            match brk.take().filter(|&b| b > start) {
                Some(b) => {
                    out.push(start..b);
                    start = b;
                    col = text[b..i].width();
                }
                None => {
                    out.push(start..i);
                    start = i;
                    col = 0;
                }
            }
        }
        col += cw;
        if c == ' ' {
            brk = Some(i + 1);
        }
    }
    out.push(start..text.len());
    out
}

// ---- images ---------------------------------------------------------------
const IMAGE_EXT: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Save the clipboard's image as a PNG under $TMPDIR/o. None when there's no image.
pub fn clipboard_image() -> Option<PathBuf> {
    let dir = tmp_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("paste-{}-{}.png", std::process::id(), stamp()));
    let quiet = |c: &mut Command| c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    // pngpaste answers in ~60ms; AppleScript takes about a second.
    let ok = if which("pngpaste") {
        quiet(Command::new("pngpaste").arg(&path)).is_ok_and(|s| s.success())
    } else {
        let script = [
            "on run argv",
            "try",
            "set img to the clipboard as «class PNGf»",
            "on error",
            "error number 1",
            "end try",
            "set f to open for access (POSIX file (item 1 of argv)) with write permission",
            "set eof f to 0",
            "write img to f",
            "close access f",
            "end run",
        ];
        let mut c = Command::new("osascript");
        for line in script {
            c.args(["-e", line]);
        }
        quiet(c.arg(&path)).is_ok_and(|s| s.success())
    };
    if ok && std::fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
        Some(path)
    } else {
        let _ = std::fs::remove_file(&path);
        None
    }
}

/// A paste that's nothing but image files (a drag from Finder pastes their
/// shell-escaped paths): those files.
pub fn image_paths(s: &str) -> Option<Vec<PathBuf>> {
    let words = shell_words(s.trim());
    if words.is_empty() {
        return None;
    }
    words
        .into_iter()
        .map(|w| {
            let p = PathBuf::from(w.strip_prefix("file://").unwrap_or(&w));
            let ext = p.extension()?.to_str()?.to_ascii_lowercase();
            (IMAGE_EXT.contains(&ext.as_str()) && p.is_file()).then_some(p)
        })
        .collect()
}

/// Split on unescaped whitespace, honoring `\` escapes and quotes.
fn shell_words(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote) = (Vec::new(), String::new(), None);
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (c, quote) {
            ('\\', q) if q != Some('\'') => cur.extend(chars.next()),
            ('\'' | '"', None) => quote = Some(c),
            (c, Some(q)) if c == q => quote = None,
            (c, None) if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            (c, _) => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `[Image #N]` tags in `text`: their byte ranges and numbers.
pub fn image_tags(text: &str) -> Vec<(Range<usize>, usize)> {
    const OPEN: &str = "[Image #";
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = text[i..].find(OPEN) {
        let s = i + p;
        let rest = &text[s + OPEN.len()..];
        let d = rest.bytes().take_while(u8::is_ascii_digit).count();
        i = s + OPEN.len();
        if d > 0 && rest.as_bytes().get(d) == Some(&b']') {
            let end = i + d + 1;
            out.push((s..end, rest[..d].parse().unwrap_or(0)));
            i = end;
        }
    }
    out
}

/// The prompt as sent: the text, then the file behind each tag it still has.
pub fn with_images(text: &str, images: &[PathBuf]) -> String {
    let mut nums: Vec<usize> = image_tags(text).into_iter().map(|(_, n)| n).collect();
    nums.sort_unstable();
    nums.dedup();
    let files: Vec<String> = nums
        .into_iter()
        .filter_map(|n| Some(format!("[Image #{n}]: {}", images.get(n.checked_sub(1)?)?.display())))
        .collect();
    if files.is_empty() {
        text.to_string()
    } else {
        format!("{text}\n\n{}", files.join("\n"))
    }
}

/// The text alone, as ⌥c copies it: no `[Image #N]` tags, each line's
/// spaces run together and its end trimmed (its indent kept), punctuation
/// back against the word a tag stood after (`see [Image #1] .` reads
/// `see.`), a line that held only tags gone, and blank lines one at most,
/// none at either end.
pub fn plain(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let tags = image_tags(line);
        let mut s = String::new();
        let (mut last, mut after_tag) = (0, false);
        let ends = tags.iter().map(|(r, _)| r.clone()).chain([line.len()..line.len()]);
        for r in ends {
            for w in line[last..r.start].split_whitespace() {
                let stick = after_tag && w.starts_with([',', '.', ';', ':', '!', '?', ')']);
                if !s.is_empty() && !stick {
                    s.push(' ');
                }
                s.push_str(w);
                after_tag = false;
            }
            after_tag = true;
            last = r.end;
        }
        if s.is_empty() {
            if tags.is_empty() && out.last().is_some_and(|l| !l.is_empty()) {
                out.push(String::new());
            }
            continue;
        }
        let indent = &line[..line.len() - line.trim_start().len()];
        out.push(format!("{indent}{s}"));
    }
    while out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    out.join("\n")
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A text field with a cursor (a byte offset into `text`): the prompt box.
/// It edits as a multi-line text box does: ^a ^e (⌘← ⌘→ in Ghostty) and
/// Home End go to the ends of the cursor's line, ^u ^k delete to them, ⌘↑ ⌘↓
/// (and fn↑ fn↓, PgUp PgDn) go to the ends of the whole text, and shift with
/// a move (⌥⇧ for a word, ⌥⇧↑↓ for the line) marks a selection that typing,
/// a paste or ⌫ replaces.
#[derive(Default)]
pub struct Field {
    pub text: String,
    pub cur: usize,
    /// Where a selection started: it runs from here to `cur`.
    pub anchor: Option<usize>,
}

impl Field {
    /// The editing keys every input shares, readline's and macOS's. Returns
    /// true when the text changed; a move only moves the cursor.
    pub fn key(&mut self, k: &KeyEvent) -> bool {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        let sup = k.modifiers.contains(KeyModifiers::SUPER);
        let before = self.text.clone();
        match k.code {
            // Word jumps: alt/ctrl+←→ arrive as modified arrows, or as ESC b /
            // ESC f (Ghostty's ⌥← ⌥→). With shift they select.
            KeyCode::Left if alt || ctrl => self.go(self.word_left_pos(), shift),
            KeyCode::Right if alt || ctrl => self.go(self.word_end(), shift),
            KeyCode::Char('b' | 'B') if alt => self.go(self.word_left_pos(), shift),
            KeyCode::Char('f' | 'F') if alt => self.go(self.word_end(), shift),
            // ⌘←→ (when the terminal sends them as such) and Home / End: the line's ends.
            KeyCode::Left if sup => self.go(self.line_start(self.cur), shift),
            KeyCode::Right if sup => self.go(self.line_end(self.cur), shift),
            KeyCode::Home if ctrl || sup => self.go(0, shift),
            KeyCode::End if ctrl || sup => self.go(self.text.len(), shift),
            KeyCode::Home => self.go(self.line_start(self.cur), shift),
            KeyCode::End => self.go(self.line_end(self.cur), shift),
            // ⌘↑ ⌘↓, as on macOS: the very start (end) of the text; ⇧⌘ selects to it.
            // Ghostty binds them to jump_to_prompt unless unbound (ghostty/config).
            KeyCode::Up if sup => self.go(0, shift),
            KeyCode::Down if sup => self.go(self.text.len(), shift),
            // fn↑ fn↓ (PgUp PgDn) too: they reach the app whatever Ghostty
            // binds ⌘↑ ⌘↓ to.
            KeyCode::PageUp => self.go(0, shift),
            KeyCode::PageDown => self.go(self.text.len(), shift),
            // ⌥↑ ⌥↓, as on macOS: to the start (end) of the line, then the one before (after).
            KeyCode::Up if alt => self.go(self.paragraph(-1), shift),
            KeyCode::Down if alt => self.go(self.paragraph(1), shift),
            KeyCode::Char('d' | 'D') if alt => self.kill_word_right(),
            KeyCode::Char('a' | 'A') if ctrl => self.go(self.line_start(self.cur), shift),
            KeyCode::Char('e' | 'E') if ctrl => self.go(self.line_end(self.cur), shift),
            KeyCode::Char('b') if ctrl => self.go(self.prev(), false),
            KeyCode::Char('f') if ctrl => self.go(self.next(), false),
            KeyCode::Char('d') if ctrl => self.delete(),
            KeyCode::Char('u') if ctrl => self.kill_start(),
            KeyCode::Char('k') if ctrl => self.kill_end(),
            KeyCode::Char('w') if ctrl => self.kill_word(),
            // ^h is ⌫ (some terminals send it for ⌫); ^t swaps the characters
            // around the cursor, as readline's does.
            KeyCode::Char('h') if ctrl => self.backspace(),
            KeyCode::Char('t') if ctrl => self.transpose(),
            KeyCode::Backspace if alt => self.kill_word(),
            // ← → with a selection and no shift: to its edge, as a text box does.
            KeyCode::Left if !shift && self.selection().is_some() => self.go(self.selection().map_or(self.cur, |r| r.start), false),
            KeyCode::Right if !shift && self.selection().is_some() => self.go(self.selection().map_or(self.cur, |r| r.end), false),
            KeyCode::Left => self.go(self.prev(), shift),
            KeyCode::Right => self.go(self.next(), shift),
            KeyCode::Backspace => self.backspace(),
            KeyCode::Delete => self.delete(),
            KeyCode::Char(c) if !ctrl => self.insert(c.encode_utf8(&mut [0; 4])),
            _ => {}
        }
        self.text != before
    }

    /// The selected bytes, when there are any.
    pub fn selection(&self) -> Option<Range<usize>> {
        let a = self.anchor?.min(self.text.len());
        (a != self.cur).then(|| a.min(self.cur)..a.max(self.cur))
    }

    pub fn selected(&self) -> Option<&str> {
        self.selection().map(|r| &self.text[r])
    }

    /// Take the selection out of the text. False when there was none.
    pub fn delete_selection(&mut self) -> bool {
        let sel = self.selection();
        self.anchor = None;
        let Some(r) = sel else { return false };
        self.text.replace_range(r.clone(), "");
        self.cur = r.start;
        true
    }

    /// The cursor to `to`; `extend` (shift) carries the selection along,
    /// starting one where the cursor was, and without it the selection goes.
    fn go(&mut self, to: usize, extend: bool) {
        if extend {
            self.anchor.get_or_insert(self.cur);
        } else {
            self.anchor = None;
        }
        self.cur = to;
    }

    /// Where the line holding byte `i` starts.
    fn line_start(&self, i: usize) -> usize {
        self.text[..i].rfind('\n').map_or(0, |p| p + 1)
    }

    /// Where the line holding byte `i` ends (its `\n`, or the text's end).
    fn line_end(&self, i: usize) -> usize {
        self.text[i..].find('\n').map_or(self.text.len(), |p| i + p)
    }

    /// ⌥↑ / ⌥↓: the line's start (end), or the previous line's start (the
    /// next one's end) when the cursor is already there.
    fn paragraph(&self, dir: isize) -> usize {
        if dir < 0 {
            let s = self.line_start(self.cur);
            if s < self.cur || s == 0 {
                s
            } else {
                self.line_start(s - 1)
            }
        } else {
            let e = self.line_end(self.cur);
            if e > self.cur || e == self.text.len() {
                e
            } else {
                self.line_end(e + 1)
            }
        }
    }

    /// ↑ / ↓ in the wrapped, multi-line box: the same column on the
    /// screen row `dir` away (`rows` as the box draws them); up from the
    /// first row goes to the start, down from the last to the end. With
    /// `extend` (⇧↑ ⇧↓) the selection comes along.
    pub fn vertical_by(&mut self, rows: &[Range<usize>], dir: isize, extend: bool) {
        let to = self.row_target(rows, dir);
        self.go(to, extend);
    }

    fn row_target(&self, rows: &[Range<usize>], dir: isize) -> usize {
        let Some(cr) = rows.iter().rposition(|r| r.start <= self.cur) else { return self.cur };
        let col = self.text[rows[cr].start..self.cur].width();
        match cr.checked_add_signed(dir).filter(|&i| i < rows.len()) {
            Some(to) => self.pos_at(rows, to, col),
            None if dir < 0 => 0,
            None => self.text.len(),
        }
    }

    /// The place at screen column `col` of row `row` (`rows` as drawn): on
    /// the character in that cell, the row's end past its text, the text's
    /// end below its last row. A click, and ↑↓ keeping their column.
    pub fn pos_at(&self, rows: &[Range<usize>], row: usize, col: usize) -> usize {
        let Some(r) = rows.get(row).cloned() else { return self.text.len() };
        // A row wrapped mid-line ends where the next one starts, and a cursor
        // there draws on the next row: stop a character short of it.
        let wrapped = rows.get(row + 1).is_some_and(|n| n.start == r.end);
        let (mut at, mut w) = (r.start, 0);
        for (i, c) in self.text[r.clone()].char_indices() {
            let end = r.start + i + c.len_utf8();
            w += c.width().unwrap_or(0);
            if w > col || (wrapped && end == r.end) {
                break;
            }
            at = end;
        }
        // Never inside an `[Image #N]` tag.
        image_tags(&self.text).into_iter().find(|(t, _)| t.start < at && at < t.end).map_or(at, |(t, _)| t.start)
    }

    /// What a double-click at `at` takes: the word there by Unicode's word
    /// bounds (a run of spaces or of punctuation is one too), the one ending
    /// there at a line's end; an `[Image #N]` tag whole.
    pub fn word_at(&self, at: usize) -> Range<usize> {
        if let Some((t, _)) = image_tags(&self.text).into_iter().find(|(t, _)| t.start <= at && at < t.end) {
            return t;
        }
        let (s, e) = (self.line_start(at), self.line_end(at));
        let words = || self.text[s..e].split_word_bound_indices().map(|(b, w)| s + b..s + b + w.len());
        words().find(|r| r.contains(&at)).or_else(|| words().next_back().filter(|r| r.end == at)).unwrap_or(at..at)
    }

    /// What a triple-click at `at` takes: its line, without the line break.
    pub fn line_at(&self, at: usize) -> Range<usize> {
        self.line_start(at)..self.line_end(at)
    }

    /// Select `r`, the cursor at its end; an empty one is just the cursor.
    pub fn select(&mut self, r: Range<usize>) {
        self.anchor = (r.start != r.end).then_some(r.start);
        self.cur = r.end;
    }

    /// A selection from `anchor` to `cur`, the cursor at `cur`.
    pub fn select_from(&mut self, anchor: usize, cur: usize) {
        self.anchor = Some(anchor);
        self.cur = cur;
    }

    /// Type `s`, over the selection if there is one.
    pub fn insert(&mut self, s: &str) {
        self.delete_selection();
        self.text.insert_str(self.cur, s);
        self.cur += s.len();
    }

    /// `word` as a word of its own: a space before it when the cursor sits
    /// right after text, and one after it. Over the selection, as `insert`.
    pub fn insert_word(&mut self, word: &str) {
        self.delete_selection();
        let before = self.text[..self.cur].chars().next_back().is_some_and(|c| !c.is_whitespace());
        let after = self.text[self.cur..].starts_with(' ');
        self.insert(&format!("{}{word}{}", if before { " " } else { "" }, if after { "" } else { " " }));
    }

    fn prev(&self) -> usize {
        self.text[..self.cur].char_indices().next_back().map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.text[self.cur..].chars().next().map_or(self.cur, |c| self.cur + c.len_utf8())
    }

    /// The very end of the text.
    pub fn end(&mut self) {
        self.go(self.text.len(), false);
    }

    /// The selection, or the character before the cursor; an `[Image #N]`
    /// tag goes in one keystroke, like a single character.
    pub fn backspace(&mut self) {
        if self.delete_selection() {
            return;
        }
        let tag = image_tags(&self.text).into_iter().find(|(r, _)| r.end == self.cur);
        let p = tag.map_or_else(|| self.prev(), |(r, _)| r.start);
        self.text.replace_range(p..self.cur, "");
        self.cur = p;
    }

    pub fn delete(&mut self) {
        if self.delete_selection() {
            return;
        }
        let tag = image_tags(&self.text).into_iter().find(|(r, _)| r.start == self.cur);
        let n = tag.map_or_else(|| self.next(), |(r, _)| r.end);
        self.text.replace_range(self.cur..n, "");
    }

    /// ^t, readline's transpose-chars: the character before the cursor and
    /// the one under it swap, the cursor going on past them; at a line's
    /// end, the two before it swap. Never across a line break.
    pub fn transpose(&mut self) {
        self.anchor = None;
        let mid = if self.cur == self.line_end(self.cur) { self.prev() } else { self.cur };
        let (Some((ai, a)), Some(b)) = (self.text[..mid].char_indices().next_back(), self.text[mid..].chars().next()) else { return };
        if a == '\n' || b == '\n' {
            return;
        }
        let end = mid + b.len_utf8();
        self.text.replace_range(ai..end, &format!("{b}{a}"));
        self.cur = end;
    }

    /// alt-←: back to the start of this word (or the previous one).
    fn word_left_pos(&self) -> usize {
        let mut it = self.text[..self.cur].char_indices().rev().peekable();
        let mut pos = self.cur;
        for word in [false, true] {
            while let Some(&(i, c)) = it.peek() {
                if is_word(c) != word {
                    break;
                }
                pos = i;
                it.next();
            }
        }
        // An `[Image #N]` tag is one word.
        image_tags(&self.text).into_iter().find(|(r, _)| r.start < pos && pos < r.end).map_or(pos, |(r, _)| r.start)
    }

    /// alt-→: on to the end of this word (or the next one).
    fn word_end(&self) -> usize {
        let end = self.word_end_raw();
        image_tags(&self.text).into_iter().find(|(r, _)| r.start < end && end < r.end).map_or(end, |(r, _)| r.end)
    }

    fn word_end_raw(&self) -> usize {
        let mut it = self.text[self.cur..].char_indices().peekable();
        let mut end = 0;
        for word in [false, true] {
            while let Some(&(i, c)) = it.peek() {
                if is_word(c) != word {
                    break;
                }
                end = i + c.len_utf8();
                it.next();
            }
        }
        self.cur + end
    }

    /// alt-d: from the cursor to the end of the word (or the selection).
    pub fn kill_word_right(&mut self) {
        if self.delete_selection() {
            return;
        }
        let e = self.word_end();
        self.text.replace_range(self.cur..e, "");
    }

    /// ^w: the word before the cursor, with the spaces after it (or the selection).
    pub fn kill_word(&mut self) {
        if self.delete_selection() {
            return;
        }
        let before = &self.text[..self.cur];
        let t = before.trim_end().len();
        let cut = before[..t]
            .char_indices()
            .rev()
            .find(|&(_, c)| c.is_whitespace() || c == '/')
            .map_or(0, |(i, c)| i + c.len_utf8());
        self.text.replace_range(cut..self.cur, "");
        self.cur = cut;
    }

    /// ^u (⌘⌫ in Ghostty): back to the start of the cursor's line; at its
    /// start, the line break before it, joining the line above.
    pub fn kill_start(&mut self) {
        if self.delete_selection() {
            return;
        }
        let s = self.line_start(self.cur);
        let s = if s == self.cur { s.saturating_sub(1) } else { s };
        self.text.replace_range(s..self.cur, "");
        self.cur = s;
    }

    /// ^k: on to the end of the cursor's line; at its end, the line break,
    /// joining the line below (emacs's ^k).
    pub fn kill_end(&mut self) {
        if self.delete_selection() {
            return;
        }
        let e = self.line_end(self.cur);
        let e = if e == self.cur && e < self.text.len() { e + 1 } else { e };
        self.text.replace_range(self.cur..e, "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(text: &str, cur: usize) -> Field {
        Field { text: text.into(), cur, ..Default::default() }
    }

    fn press(f: &mut Field, code: KeyCode, mods: KeyModifiers) {
        f.key(&KeyEvent::new(code, mods));
    }

    const CTRL: KeyModifiers = KeyModifiers::CONTROL;
    const SHIFT: KeyModifiers = KeyModifiers::SHIFT;
    const ALT_SHIFT: KeyModifiers = KeyModifiers::ALT.union(KeyModifiers::SHIFT);

    #[test]
    fn ctrl_a_and_e_stay_on_the_line() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Char('a'), CTRL);
        assert_eq!(f.cur, 4);
        press(&mut f, KeyCode::Char('e'), CTRL);
        assert_eq!(f.cur, 13);
        press(&mut f, KeyCode::Home, KeyModifiers::NONE);
        assert_eq!(f.cur, 4);
        press(&mut f, KeyCode::End, KeyModifiers::NONE);
        assert_eq!(f.cur, 13);
    }

    #[test]
    fn ctrl_u_and_k_stay_on_the_line_then_join() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Char('u'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("one\nthree\nfour", 4));
        press(&mut f, KeyCode::Char('u'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("onethree\nfour", 3));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Char('k'), CTRL);
        assert_eq!(f.text, "one\ntwo \nfour");
        press(&mut f, KeyCode::Char('k'), CTRL);
        assert_eq!(f.text, "one\ntwo four");
    }

    #[test]
    fn shift_and_alt_shift_arrows_select() {
        let mut f = field("hello brave world", 6);
        press(&mut f, KeyCode::Right, ALT_SHIFT);
        assert_eq!(f.selected(), Some("brave"));
        press(&mut f, KeyCode::Right, SHIFT);
        assert_eq!(f.selected(), Some("brave "));
        press(&mut f, KeyCode::Left, ALT_SHIFT);
        assert_eq!(f.selected(), None);
        press(&mut f, KeyCode::Left, ALT_SHIFT);
        assert_eq!(f.selected(), Some("hello "));
        // Typing replaces it; ← without shift would have gone to its start.
        press(&mut f, KeyCode::Char('X'), SHIFT);
        assert_eq!((f.text.as_str(), f.cur, f.selection()), ("Xbrave world", 1, None));
    }

    #[test]
    fn alt_shift_up_down_select_to_the_line_ends() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Down, ALT_SHIFT);
        assert_eq!(f.selected(), Some("three"));
        press(&mut f, KeyCode::Down, ALT_SHIFT);
        assert_eq!(f.selected(), Some("three\nfour"));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Up, ALT_SHIFT);
        assert_eq!(f.selected(), Some("two "));
        press(&mut f, KeyCode::Up, ALT_SHIFT);
        assert_eq!(f.selected(), Some("one\ntwo "));
    }

    #[test]
    fn cmd_up_down_go_to_the_text_ends() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Up, KeyModifiers::SUPER);
        assert_eq!((f.cur, f.selection()), (0, None));
        press(&mut f, KeyCode::Down, KeyModifiers::SUPER);
        assert_eq!((f.cur, f.selection()), (18, None));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::Down, KeyModifiers::SUPER.union(SHIFT));
        assert_eq!(f.selected(), Some("three\nfour"));
        press(&mut f, KeyCode::Up, KeyModifiers::SUPER.union(SHIFT));
        assert_eq!(f.selected(), Some("one\ntwo "));
    }

    #[test]
    fn page_up_down_go_to_the_text_ends_too() {
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::PageUp, KeyModifiers::NONE);
        assert_eq!((f.cur, f.selection()), (0, None));
        press(&mut f, KeyCode::PageDown, KeyModifiers::NONE);
        assert_eq!((f.cur, f.selection()), (18, None));
        let mut f = field("one\ntwo three\nfour", 8);
        press(&mut f, KeyCode::PageDown, SHIFT);
        assert_eq!(f.selected(), Some("three\nfour"));
    }

    #[test]
    fn a_selection_goes_on_backspace_and_arrows_collapse_it() {
        let mut f = field("abc def", 7);
        press(&mut f, KeyCode::Char('a'), CTRL.union(SHIFT));
        assert_eq!(f.selected(), Some("abc def"));
        press(&mut f, KeyCode::Left, KeyModifiers::NONE);
        assert_eq!((f.cur, f.selection()), (0, None));
        press(&mut f, KeyCode::Right, SHIFT);
        press(&mut f, KeyCode::Right, SHIFT);
        press(&mut f, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!((f.text.as_str(), f.cur), ("c def", 0));
    }

    #[test]
    fn a_click_lands_on_its_cell() {
        // "hello brave " wraps after its space; the cursor never sits past it.
        let f = field("hello brave world\nnext", 0);
        let rows = [0..12, 12..17, 18..22];
        assert_eq!(f.pos_at(&rows, 0, 1), 1);
        assert_eq!(f.pos_at(&rows, 0, 40), 11);
        assert_eq!(f.pos_at(&rows, 1, 40), 17);
        assert_eq!(f.pos_at(&rows, 2, 2), 20);
        assert_eq!(f.pos_at(&rows, 9, 0), 22);
        // Not inside an image tag.
        let f = field("see [Image #1] here", 0);
        assert_eq!(f.pos_at(&[0..19], 0, 8), 4);
    }

    #[test]
    fn double_and_triple_click_take_a_word_and_a_line() {
        let f = field("one two-three\n[Image #2] four", 0);
        assert_eq!(&f.text[f.word_at(5)], "two");
        assert_eq!(&f.text[f.word_at(3)], " ");
        assert_eq!(&f.text[f.word_at(13)], "three");
        assert_eq!(&f.text[f.word_at(17)], "[Image #2]");
        assert_eq!(&f.text[f.line_at(5)], "one two-three");
        assert_eq!(&f.text[f.line_at(26)], "[Image #2] four");
    }

    #[test]
    fn shift_down_selects_by_row() {
        let mut f = field("abcd\nefgh", 1);
        let rows = [0..4, 5..9];
        f.vertical_by(&rows, 1, true);
        assert_eq!(f.selected(), Some("bcd\ne"));
        f.vertical_by(&rows, -1, false);
        assert_eq!((f.cur, f.selection()), (1, None));
    }

    #[test]
    fn ctrl_t_swaps_and_ctrl_h_deletes() {
        let mut f = field("abc", 1);
        press(&mut f, KeyCode::Char('t'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("bac", 2));
        // At the end: the two before it.
        let mut f = field("ab\ncd", 5);
        press(&mut f, KeyCode::Char('t'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("ab\ndc", 5));
        // Not across a line break, nor before the start.
        let mut f = field("ab\ncd", 3);
        press(&mut f, KeyCode::Char('t'), CTRL);
        assert_eq!(f.text, "ab\ncd");
        let mut f = field("ab", 0);
        press(&mut f, KeyCode::Char('t'), CTRL);
        assert_eq!(f.text, "ab");
        let mut f = field("abc", 2);
        press(&mut f, KeyCode::Char('h'), CTRL);
        assert_eq!((f.text.as_str(), f.cur), ("ac", 1));
    }

    #[test]
    fn wraps_at_words() {
        let rows = |text: &str, w| -> Vec<String> { word_rows(text, w).into_iter().map(|r| text[r].to_string()).collect() };
        assert_eq!(rows("and the JPEG [Image #2] too", 14), ["and the JPEG ", "[Image #2] too"]);
        assert_eq!(rows("one\ntwo three", 5), ["one", "two ", "three"]);
        // A word longer than a row is cut.
        assert_eq!(rows("ab abcdefgh", 4), ["ab ", "abcd", "efgh"]);
        assert_eq!(rows("", 4), [""]);
    }

    #[test]
    fn lists_the_tagged_files_at_the_end() {
        let images = [PathBuf::from("/a/1.png"), PathBuf::from("/a/2.png")];
        assert_eq!(with_images("see [Image #2]", &images), "see [Image #2]\n\n[Image #2]: /a/2.png");
        assert_eq!(with_images("no tags", &images), "no tags");
        assert_eq!(first_line("\n  \n  fix   the header\nand more"), "fix the header");
    }

    #[test]
    fn plain_is_the_text_without_its_tags_or_extra_space() {
        assert_eq!(plain("see [Image #1] here"), "see here");
        assert_eq!(plain("look at [Image #1] . and [Image #2], then [Image #3]"), "look at. and, then");
        assert_eq!(plain("a[Image #1]b"), "a b");
        assert_eq!(plain("\n\n  fix   the    header   \n[Image #1] [Image #2]\n\n\n\nand more\n\n"), "  fix the header\n\nand more");
        assert_eq!(plain("one\n[Image #1]\ntwo"), "one\ntwo");
        assert_eq!(plain("- a\n    - b\t c"), "- a\n    - b c");
        assert_eq!(plain("[Image #1] [Image #2]"), "");
        // Not a tag: kept.
        assert_eq!(plain("[Image #x] stays"), "[Image #x] stays");
    }
}
