//! `o --images BLOCK`: the images behind a pane's `[Image #N]` tags
//! (panes.rs), each as big as the pane lets it be (no bigger than the file
//! itself), its tag under it. ⌥⌘N opens it in a floating pane over that pane
//! (float_here, rex/.config/rex/init.lua). Over o's prompt it follows the
//! prompt: an image pasted in shows up, one deleted goes.
//!
//! 1…9 show that image alone (again, or 0: all of them), ← → step through
//! them one at a time; esc, q, ⏎ or space close it, and the pane it was
//! opened over gets the focus back.

use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, SystemTime};

use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::crossterm::terminal;
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use unicode_width::UnicodeWidthStr;

use crate::gfx::{self, Gfx, Images, Pic};
use crate::panes::{self, Tagged};
use crate::term::Inline;
use crate::theme::Palette;

/// How often the pane's file is looked at for changes.
const POLL: Duration = Duration::from_millis(250);
/// Columns between images side by side, rows between rows of them.
const GAP_X: usize = 2;
const GAP_Y: usize = 1;
/// The pane's title: Rex's pane label, and how init.lua tells a viewer.
pub const TITLE: &str = "o images";

/// A file readied for the terminal, and how many times bigger the file
/// itself is (a 5K screenshot goes shrunk, and may be drawn bigger than that).
type Ready = Result<(Pic, f64), String>;

pub struct Viewer {
    pal: Palette,
    pub gfx: Option<Gfx>,
    file: PathBuf,
    /// The file's time when last read; None: not there.
    seen: Option<SystemTime>,
    kind: String,
    pub images: Tagged,
    /// Each file, readied (None while it loads).
    pics: HashMap<PathBuf, Option<Ready>>,
    tx: Sender<(PathBuf, Ready)>,
    rx: Receiver<(PathBuf, Ready)>,
    imgs: Images,
    /// One image alone: its place in `images`.
    pub one: Option<usize>,
    /// False in tests: images load at once, on this thread.
    live: bool,
}

impl Viewer {
    pub fn new(pal: Palette, file: PathBuf) -> Viewer {
        let (tx, rx) = mpsc::channel();
        let mut v = Viewer {
            pal,
            gfx: None,
            file,
            seen: None,
            kind: panes::PROMPT.into(),
            images: Vec::new(),
            pics: HashMap::new(),
            tx,
            rx,
            imgs: Images::default(),
            one: None,
            live: true,
        };
        v.reread();
        v
    }

    /// Read the pane's file again if it changed. Gone (the prompt sent or
    /// emptied, o quit), what was shown stays. True when it changed.
    fn reread(&mut self) -> bool {
        let stamp = std::fs::metadata(&self.file).and_then(|m| m.modified()).ok();
        if stamp == self.seen {
            return false;
        }
        self.seen = stamp;
        let Some((kind, images)) = panes::read(&self.file) else { return false };
        if (kind.as_str(), &images) == (self.kind.as_str(), &self.images) {
            return false;
        }
        // Still showing one alone: the same tag, if it's still there.
        let n = self.one.and_then(|i| self.images.get(i)).map(|(n, _)| *n);
        self.one = n.and_then(|n| images.iter().position(|(m, _)| *m == n));
        (self.kind, self.images) = (kind, images);
        true
    }

    /// Images loaded, the file changed: true when the screen did.
    fn tick(&mut self) -> bool {
        let mut changed = self.reread();
        while let Ok((path, pic)) = self.rx.try_recv() {
            self.pics.insert(path, Some(pic));
            changed = true;
        }
        changed
    }

    /// Start readying the files not seen yet.
    fn load(&mut self) {
        let todo: Vec<PathBuf> = self.images.iter().map(|(_, p)| p.clone()).filter(|p| !self.pics.contains_key(p)).collect();
        for path in todo {
            if !self.live {
                let pic = ready(&path);
                self.pics.insert(path, Some(pic));
                continue;
            }
            self.pics.insert(path.clone(), None);
            let tx = self.tx.clone();
            std::thread::spawn(move || {
                let pic = ready(&path);
                let _ = tx.send((path, pic));
            });
        }
    }

    /// A key: false to close.
    fn key(&mut self, k: KeyEvent) -> Option<bool> {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let count = self.images.len();
        match k.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q' | ' ') => return None,
            KeyCode::Char('c' | 'd') if ctrl => return None,
            KeyCode::Char('0') => self.one = None,
            KeyCode::Char(c @ '1'..='9') => {
                let n = c as usize - '0' as usize;
                let at = self.images.iter().position(|(m, _)| *m == n);
                self.one = if self.one == at { None } else { at.or(self.one) };
            }
            KeyCode::Right if count > 0 => self.one = Some(self.one.map_or(0, |i| (i + 1) % count)),
            KeyCode::Left if count > 0 => self.one = Some(self.one.map_or(count - 1, |i| (i + count - 1) % count)),
            _ => return Some(false),
        }
        Some(true)
    }

    /// The frame for a `w`×`h` pane. Images it draws go to the terminal
    /// first (`imgs.take`).
    pub fn draw(&mut self, w: u16, h: u16) -> Buffer {
        self.load();
        let mut buf = Buffer::empty(Rect::new(0, 0, w, h));
        let (accent, dim, muted, red) = (self.pal.accent, self.pal.dim, self.pal.muted, self.pal.red);
        let total = self.images.len();
        let shown: Vec<usize> = match self.one {
            Some(i) if i < total => vec![i],
            _ => (0..total).collect(),
        };
        let whose = if self.kind == panes::SENT { "sent with this tab's prompt" } else { "in o's prompt" };
        let many = if total == 1 { "1 image".to_string() } else { format!("{total} images") };
        put(&mut buf, 1, 0, &format!("{many} {whose}"), dim);
        let keys = match self.one {
            Some(i) if total > 1 => format!("{} of {total} · ← → · 0 all · esc closes", i + 1),
            Some(_) => "esc closes".to_string(),
            None if total > 1 => "1–9 one alone · ← → · esc closes".to_string(),
            None => "esc closes".to_string(),
        };
        put(&mut buf, 1, h.saturating_sub(1), &keys, dim);
        if total == 0 {
            centered(&mut buf, "no images", dim);
            return buf;
        }
        let Some(g) = self.gfx else {
            // A terminal that doesn't draw images: where they are, at least.
            for (y, &i) in (2..h.saturating_sub(2)).zip(&shown) {
                let (n, path) = &self.images[i];
                let x = put(&mut buf, 1, y, &format!("[Image #{n}]"), accent);
                put(&mut buf, x + 2, y, &tilde(path), muted);
            }
            put(&mut buf, 1, h.saturating_sub(2), "(this terminal doesn't draw images)", dim);
            return buf;
        };
        let mut items = Vec::new();
        let mut failed = Vec::new();
        for &i in &shown {
            let (n, path) = &self.images[i];
            match self.pics.get(path) {
                Some(Some(Ok((pic, up)))) => items.push((i, *n, pic.w, pic.h, *up)),
                Some(Some(Err(_))) => failed.push(*n),
                _ => {
                    centered(&mut buf, "loading…", dim);
                    return buf;
                }
            }
        }
        if !failed.is_empty() {
            let tags: Vec<String> = failed.iter().map(|n| format!("#{n}")).collect();
            let msg = format!("✗ can't read {}", tags.join(" "));
            let x = w.saturating_sub(2 + msg.width() as u16);
            put(&mut buf, x.max(1), 0, &msg, red);
        }
        // Between the title row and the keys' row, a column spare each side.
        let (aw, ah) = (usize::from(w.saturating_sub(2)), usize::from(h.saturating_sub(2)));
        let sizes: Vec<(usize, u32, u32, f64)> = items.iter().map(|&(_, n, pw, ph, up)| (n, pw, ph, up)).collect();
        for ((i, n, ..), (x, y, cols, rows)) in items.iter().zip(grid(&sizes, g, aw, ah)) {
            let (x, y) = (x + 1, y + 1);
            let path = self.images[*i].1.clone();
            let Some(Some(Ok((pic, _)))) = self.pics.get(&path) else { continue };
            let id = self.imgs.id_for((path.clone(), cols, rows), &pic.b64);
            for r in 0..rows {
                for c in 0..cols {
                    if let Some(cell) = buf.cell_mut((x + c, y + r)) {
                        gfx::placeholder(cell, id, r, c);
                    }
                }
            }
            let end = put(&mut buf, x, y + rows, &format!("[Image #{n}]"), accent);
            // Alone: where it is, too.
            if self.one.is_some() {
                put(&mut buf, end + 2, y + rows, &tilde(&path), dim);
            }
        }
        buf
    }
}

/// `path` readied for the terminal, big.
fn ready(path: &Path) -> Ready {
    let pic = gfx::load_pic_at(path, gfx::BIG)?;
    let up = gfx::png_file_size(path).map_or(1.0, |(fw, _)| f64::from(fw) / f64::from(pic.w.max(1)));
    Ok((pic, up))
}

/// Where each image goes in `w`×`h` cells, drawn as big as they all can
/// be: (x, y, cols, rows), a label row under each (its `[Image #n]`, the
/// first of `items`). The images go in rows, as many to a row as makes
/// them biggest together; each row is centered, and the whole of them.
fn grid(items: &[(usize, u32, u32, f64)], g: Gfx, w: usize, h: usize) -> Vec<(u16, u16, u16, u16)> {
    let n = items.len();
    let label = |n: usize| format!("[Image #{n}]").len();
    let mut best: Option<(usize, usize, Vec<(u16, u16)>)> = None;
    for per_row in 1..=n {
        let rows = n.div_ceil(per_row);
        let slot_w = w.saturating_sub(GAP_X * (per_row - 1)) / per_row;
        let slot_h = h.saturating_sub(GAP_Y * (rows - 1)) / rows;
        if slot_w < 4 || slot_h < 2 {
            continue;
        }
        let cells: Vec<(u16, u16)> = items.iter().map(|&(_, iw, ih, up)| gfx::fit_upto(iw, ih, g, slot_w, slot_h - 1, up)).collect();
        let area = cells.iter().map(|&(c, r)| usize::from(c) * usize::from(r)).sum();
        if best.as_ref().is_none_or(|b| area > b.0) {
            best = Some((area, per_row, cells));
        }
    }
    let Some((_, per_row, cells)) = best else { return Vec::new() };
    let rows: Vec<Vec<(usize, (u16, u16))>> = items.iter().map(|i| i.0).zip(cells).collect::<Vec<_>>().chunks(per_row).map(<[_]>::to_vec).collect();
    let row_h: Vec<usize> = rows.iter().map(|r| r.iter().map(|(_, (_, rh))| usize::from(*rh)).max().unwrap_or(0) + 1).collect();
    let mut y = h.saturating_sub(row_h.iter().sum::<usize>() + GAP_Y * (rows.len() - 1)) / 2;
    let mut out = Vec::new();
    for (row, rh) in rows.iter().zip(&row_h) {
        let width = |(n, (c, _)): &(usize, (u16, u16))| usize::from(*c).max(label(*n));
        let across = row.iter().map(width).sum::<usize>() + GAP_X * (row.len() - 1);
        let mut x = w.saturating_sub(across) / 2;
        for item in row {
            let (cols, rws) = item.1;
            out.push((x as u16, y as u16, cols, rws));
            x += width(item) + GAP_X;
        }
        y += rh + GAP_Y;
    }
    out
}

fn put(buf: &mut Buffer, x: u16, y: u16, s: &str, c: Color) -> u16 {
    let max = buf.area.width.saturating_sub(1);
    if x >= max || y >= buf.area.height {
        return x;
    }
    buf.set_stringn(x, y, s, usize::from(max - x), Style::new().fg(c)).0
}

fn centered(buf: &mut Buffer, s: &str, c: Color) {
    let x = buf.area.width.saturating_sub(s.width() as u16) / 2;
    put(buf, x, buf.area.height / 2, s, c);
}

/// A path with the home folder as `~`.
fn tilde(p: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home.and_then(|h| p.strip_prefix(h).ok().map(|r| format!("~/{}", r.display()))) {
        Some(s) => s,
        None => p.display().to_string(),
    }
}

/// `o --images BLOCK`: show block `BLOCK`'s images until a key closes it,
/// then hand the focus back to that block.
pub fn run(block: &str, pal: Palette) -> ExitCode {
    let mut v = Viewer::new(pal, panes::file(block));
    if terminal::enable_raw_mode().is_err() {
        // No terminal: say where they are.
        for (n, p) in &v.images {
            println!("[Image #{n}] {}", p.display());
        }
        return ExitCode::SUCCESS;
    }
    let probe = crate::probe::probe();
    v.gfx = probe.gfx;
    let mut out = io::stdout();
    // The alternate screen, no cursor, and a title (Rex's pane label).
    let _ = write!(out, "\x1b[?1049h\x1b[?25l\x1b]2;{TITLE}\x07");
    let _ = out.flush();
    let (w, h) = terminal::size().unwrap_or((80, 24));
    let mut term = Inline::new(w, h, (0, 0));
    let res = event_loop(&mut v, &mut term);
    let mut s = v.imgs.clear();
    s.extend_from_slice(b"\x1b[0m\x1b[?25h\x1b[?1049l");
    let _ = out.write_all(&s);
    let _ = out.flush();
    let _ = terminal::disable_raw_mode();
    give_back(block);
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("o: {e}");
            ExitCode::FAILURE
        }
    }
}

fn event_loop(v: &mut Viewer, term: &mut Inline) -> io::Result<()> {
    let mut out = io::stdout();
    let mut dirty = true;
    loop {
        dirty |= v.tick();
        if dirty {
            let buf = v.draw(term.width, term.rows);
            let mut s = v.imgs.take();
            term.draw(&mut s, &buf, None);
            out.write_all(&s)?;
            out.flush()?;
            dirty = false;
        }
        if !event::poll(POLL)? {
            continue;
        }
        match event::read()? {
            Event::Resize(w, h) => {
                *term = Inline::new(w, h, (0, 0));
                let mut s = Vec::new();
                term.clear_screen(&mut s);
                out.write_all(&s)?;
                dirty = true;
            }
            Event::Key(k) if k.kind != KeyEventKind::Release => match v.key(k) {
                None => return Ok(()),
                Some(changed) => dirty |= changed,
            },
            _ => {}
        }
    }
}

/// Closing: the focus back on the pane the viewer was opened over (Rex
/// would otherwise pick a pane of the tab itself), when that's another one.
fn give_back(block: &str) {
    let (Some(ses), here) = (std::env::var("REX_SESSION").ok(), std::env::var("REX_BLOCK").unwrap_or_default()) else { return };
    if here == block || !block.starts_with("block:") {
        return;
    }
    let _ = Command::new("rex").args(["focus", "-s", &ses, block]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: Gfx = Gfx { cell_w: 10, cell_h: 20 };

    #[test]
    fn one_image_as_big_as_it_is_centered() {
        // 1000×500 px is 100×25 cells: all of it fits, centered under it.
        assert_eq!(grid(&[(1, 1000, 500, 1.0)], G, 120, 40), [(10, 7, 100, 25)]);
        // A file twice that shown shrunk: drawn up to the file's size.
        assert_eq!(grid(&[(1, 500, 250, 2.0)], G, 120, 40), [(10, 7, 100, 25)]);
        // No bigger than the room.
        assert_eq!(grid(&[(1, 1000, 500, 1.0)], G, 50, 40), [(0, 13, 50, 13)]);
    }

    #[test]
    fn wide_ones_stack_and_tall_ones_go_side_by_side() {
        let wide = [(1, 1000, 500, 1.0), (2, 1000, 500, 1.0)];
        assert_eq!(grid(&wide, G, 100, 40), [(14, 0, 72, 18), (14, 20, 72, 18)]);
        // 300×800 px at 39 rows: 29 columns (the shape kept).
        let tall = [(1, 300, 800, 1.0), (2, 300, 800, 1.0)];
        assert_eq!(grid(&tall, G, 100, 40), [(20, 0, 29, 39), (51, 0, 29, 39)]);
    }

    #[test]
    fn a_label_wider_than_its_image_gets_its_room() {
        // A 2-column image still leaves `[Image #1]` room before the next.
        let out = grid(&[(1, 20, 400, 1.0), (2, 20, 400, 1.0)], G, 100, 40);
        assert_eq!(out.len(), 2);
        assert!(out[1].0 >= out[0].0 + 10 + 2, "{out:?}");
    }

    fn viewer(images: &[(usize, &str, u32, u32)]) -> Viewer {
        let pal = Palette::new(&crate::rex_theme::theme(&[]));
        let mut v = Viewer::new(pal, PathBuf::from("/nonexistent/o-viewer-test.json"));
        v.live = false;
        v.gfx = Some(G);
        for &(n, p, w, h) in images {
            v.images.push((n, PathBuf::from(p)));
            v.pics.insert(PathBuf::from(p), Some(Ok((Pic { w, h, b64: "AAAA".into() }, 1.0))));
        }
        v
    }

    fn rows(b: &Buffer) -> Vec<String> {
        (0..b.area.height).map(|y| crate::term::plain(b, y)).collect()
    }

    #[test]
    fn draws_them_with_their_tags_and_one_alone_with_digits() {
        let mut v = viewer(&[(1, "/a.png", 400, 200), (3, "/c.png", 400, 200)]);
        let b = v.draw(60, 20);
        let r = rows(&b);
        assert_eq!(r[0], " 2 images in o's prompt");
        assert_eq!(r[19], " 1–9 one alone · ← → · esc closes");
        // Stacked (side by side would be no bigger), 28×7 each, a tag under each.
        let pad = " ".repeat(16);
        assert_eq!(r[1], format!("{pad}{}", "▒".repeat(28)));
        assert_eq!(r[8], format!("{pad}[Image #1]"));
        assert_eq!(r[10], format!("{pad}{}", "▒".repeat(28)));
        assert_eq!(r[17], format!("{pad}[Image #3]"));
        // The PNGs went to the terminal, once each.
        assert_eq!(v.imgs.take().windows(4).filter(|w| w == b"a=T,").count(), 2);
        // 3: that one alone, its file named; 3 again: all of them.
        let three = KeyEvent::new(KeyCode::Char('3'), KeyModifiers::NONE);
        assert_eq!(v.key(three), Some(true));
        assert_eq!(v.one, Some(1));
        let r = rows(&v.draw(60, 20));
        // Its own size (40×10), centered.
        assert_eq!(r[4], format!("{}{}", " ".repeat(10), "▒".repeat(40)));
        assert_eq!(r[14], format!("{}[Image #3]  /c.png", " ".repeat(10)));
        assert!(!r.iter().any(|l| l.contains("[Image #1]")));
        assert_eq!(r[19], " 2 of 2 · ← → · 0 all · esc closes");
        v.key(three);
        assert_eq!(v.one, None);
        // A tag that isn't there changes nothing; → and ← go round.
        v.key(KeyEvent::new(KeyCode::Char('2'), KeyModifiers::NONE));
        assert_eq!(v.one, None);
        v.key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        assert_eq!(v.one, Some(1));
        v.key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        assert_eq!(v.one, Some(0));
        // esc, q, ⏎ close.
        for c in [KeyCode::Esc, KeyCode::Char('q'), KeyCode::Enter] {
            assert_eq!(v.key(KeyEvent::new(c, KeyModifiers::NONE)), None);
        }
    }

    #[test]
    fn says_what_it_cant_draw() {
        let mut v = viewer(&[(1, "/a.png", 400, 200)]);
        v.pics.insert(PathBuf::from("/b.png"), Some(Err("nope".into())));
        v.images.push((2, PathBuf::from("/b.png")));
        let r = rows(&v.draw(60, 20));
        assert_eq!(r[0], format!(" 2 images in o's prompt{}✗ can't read #2", " ".repeat(20)));
        // Without images: where they are.
        v.gfx = None;
        let r = rows(&v.draw(60, 20));
        assert_eq!(r[2], " [Image #1]  /a.png");
        assert_eq!(r[3], " [Image #2]  /b.png");
        // None at all.
        let mut v = viewer(&[]);
        assert_eq!(rows(&v.draw(60, 20))[10].trim(), "no images");
    }

    #[test]
    fn follows_the_panes_file() {
        let dir = std::env::temp_dir().join(format!("o-viewer-test-{}", std::process::id()));
        let file = dir.join("b.json");
        let _ = std::fs::create_dir_all(&dir);
        let pal = Palette::new(&crate::rex_theme::theme(&[]));
        // Each write a time of its own, even on a coarse clock.
        let write = |body: &str, secs: u64| {
            std::fs::write(&file, body).unwrap();
            let t = SystemTime::UNIX_EPOCH + Duration::from_secs(secs);
            std::fs::File::options().write(true).open(&file).unwrap().set_modified(t).unwrap();
        };
        write(r#"{"kind":"prompt","images":[{"n":1,"path":"/a.png"},{"n":2,"path":"/b.png"}]}"#, 1000);
        let mut v = Viewer::new(pal, file.clone());
        assert_eq!(v.images.len(), 2);
        v.one = Some(1);
        // #1 deleted from the prompt: #2 still the one shown.
        write(r#"{"kind":"prompt","images":[{"n":2,"path":"/b.png"}]}"#, 2000);
        assert!(v.reread());
        assert_eq!((v.images.len(), v.one), (1, Some(0)));
        // Gone (sent): what was there stays.
        std::fs::remove_file(&file).unwrap();
        assert!(!v.reread());
        assert_eq!(v.images.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

}
