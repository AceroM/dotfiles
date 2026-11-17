//! Chrome's own UI, through macOS accessibility, for the one thing the extension API can't do:
//! delete a closed saved tab group. Closed groups live only on Chrome's bookmarks bar ("Saved Tab
//! Groups"), and each chip there has a context menu with "Delete group" and the group's tabs.
//!
//! Nothing here is fired blindly. A delete goes:
//!   1. no Chrome menu is open, and the chip is labeled "<name> group - Closed";
//!   2. ask the chip for its context menu, and wait for that menu to appear;
//!   3. the menu must be a saved group's (Open group, Delete group, Tabs in group), and the tabs
//!      it lists must be exactly the group's tabs: otherwise cancel it and try the next chip of
//!      that name;
//!   4. press "Delete group" (and "Delete Group" on the "Delete Tab Group?" sheet Chrome puts on
//!      the window to ask first), then check that one chip of that name is gone.
//!
//! Anything unexpected (no menu, a menu of another kind, a menu that won't close) stops the whole
//! run without pressing anything else.
//!
//! The chip's menu comes up either as a native menu (an app-level AXMenu, which AXCancel closes)
//! or as one of Chrome's own (an AXMenu in a window of its own, which ignores AXCancel and closes
//! on Escape). A menu tg opened is never left on screen: it's cancelled, then sent Escape, and if
//! it's still there the run stops and says so. Chrome's grid "Tab groups" menu is never opened.

use std::thread::sleep;
use std::time::{Duration, Instant};

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::{CFString, CFStringRef};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(e: CFTypeRef, attr: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(e: CFTypeRef, attr: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementPerformAction(e: CFTypeRef, action: CFStringRef) -> i32;
    fn AXUIElementCopyActionNames(e: CFTypeRef, names: *mut CFTypeRef) -> i32;
    fn AXUIElementSetMessagingTimeout(e: CFTypeRef, secs: f32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, key: u16, down: bool) -> CFTypeRef;
    fn CGEventPostToPid(pid: i32, event: CFTypeRef);
}

const KEY_ESCAPE: u16 = 0x35;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetTypeID() -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
}

/// One accessibility element.
#[derive(Clone)]
struct El(CFType);

impl El {
    fn raw(&self) -> CFTypeRef {
        self.0.as_CFTypeRef()
    }

    fn attr(&self, name: &str) -> Option<CFType> {
        let mut v: CFTypeRef = std::ptr::null();
        let n = CFString::new(name);
        let err = unsafe { AXUIElementCopyAttributeValue(self.raw(), n.as_concrete_TypeRef(), &mut v) };
        (err == 0 && !v.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(v) })
    }

    fn string(&self, name: &str) -> String {
        match self.attr(name) {
            Some(v) if unsafe { CFGetTypeID(v.as_CFTypeRef()) == CFStringGetTypeID() } => {
                unsafe { CFString::wrap_under_get_rule(v.as_CFTypeRef() as CFStringRef) }.to_string()
            }
            _ => String::new(),
        }
    }

    fn flag(&self, name: &str) -> Option<bool> {
        let v = self.attr(name)?;
        if unsafe { CFGetTypeID(v.as_CFTypeRef()) } != unsafe { CFBooleanGetTypeID() } {
            return None;
        }
        Some(bool::from(unsafe { CFBoolean::wrap_under_get_rule(v.as_CFTypeRef() as _) }))
    }

    fn children(&self) -> Vec<El> {
        match self.attr("AXChildren") {
            Some(v) if unsafe { CFGetTypeID(v.as_CFTypeRef()) == CFArrayGetTypeID() } => {
                let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_get_rule(v.as_CFTypeRef() as CFArrayRef) };
                arr.iter().map(|x| El((*x).clone())).collect()
            }
            _ => Vec::new(),
        }
    }

    fn role(&self) -> String {
        self.string("AXRole")
    }

    fn subrole(&self) -> String {
        self.string("AXSubrole")
    }

    fn title(&self) -> String {
        self.string("AXTitle")
    }

    fn actions(&self) -> Vec<String> {
        let mut v: CFTypeRef = std::ptr::null();
        if unsafe { AXUIElementCopyActionNames(self.raw(), &mut v) } != 0 || v.is_null() {
            return Vec::new();
        }
        let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(v as CFArrayRef) };
        arr.iter()
            .filter(|x| unsafe { CFGetTypeID(x.as_CFTypeRef()) == CFStringGetTypeID() })
            .map(|x| unsafe { CFString::wrap_under_get_rule(x.as_CFTypeRef() as CFStringRef) }.to_string())
            .collect()
    }

    fn perform(&self, action: &str) -> Result<(), String> {
        let a = CFString::new(action);
        match unsafe { AXUIElementPerformAction(self.raw(), a.as_concrete_TypeRef()) } {
            0 => Ok(()),
            e => Err(format!("{action} failed ({e})")),
        }
    }

    /// The first element under this one (itself included) that `pred` picks, at most `depth`
    /// levels down, never into web content.
    fn find(&self, depth: usize, pred: &dyn Fn(&El) -> bool) -> Option<El> {
        if pred(self) {
            return Some(self.clone());
        }
        if depth == 0 || self.role() == "AXWebArea" {
            return None;
        }
        self.children().iter().find_map(|c| c.find(depth - 1, pred))
    }
}

/// How a delete went wrong.
pub enum Fail {
    /// This group couldn't be confirmed. Nothing was pressed; the next group can go ahead.
    Skip(String),
    /// Chrome didn't behave as expected. Stop everything.
    Stop(String),
}

pub struct Chrome {
    app: El,
    pid: i32,
    /// The one window whose bar counts (tg's own, see `watch_new`); none: every window's.
    window: Option<El>,
}

/// What had the front before tg's window took it: the app, and Chrome's own main window.
pub struct Away {
    app: Option<i32>,
    main: Option<El>,
}

/// Chrome's browser windows at one moment, to tell which window opens after it.
pub struct Windows(Vec<El>);

/// View → "Always Show Bookmarks Bar", for the profile of Chrome's key window.
const ALWAYS_SHOW_BAR: &str = "Always Show Bookmarks Bar";

/// A chip on the bookmarks bar's "Saved Tab Groups".
struct Chip {
    el: El,
    /// "Agents"; "unnamed" for a group with no name.
    label: String,
    closed: bool,
}

/// What the bar calls a group: its title, or "unnamed" when it has none.
pub fn label(title: &str) -> String {
    if title.trim().is_empty() {
        "unnamed".to_string()
    } else {
        title.to_string()
    }
}

/// Whether a chip's name is this group's. A group with no title is "unnamed" on the bar (and
/// "3 Tabs" in Chrome's grid menu, so take either).
fn names(chip: &str, title: &str, tabs: usize) -> bool {
    if title.trim().is_empty() {
        chip == "unnamed" || chip == format!("{tabs} Tab{}", if tabs == 1 { "" } else { "s" })
    } else {
        chip == title
    }
}

impl Chrome {
    pub fn connect(pid: i32) -> Result<Chrome, String> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            return Err("this terminal has no Accessibility access (System Settings → Privacy & Security → Accessibility)".into());
        }
        let raw = unsafe { AXUIElementCreateApplication(pid) };
        if raw.is_null() {
            return Err(format!("no accessibility element for pid {pid}"));
        }
        let app = El(unsafe { CFType::wrap_under_create_rule(raw) });
        // Chrome builds its accessibility tree only for clients that ask for it.
        let attr = CFString::new("AXManualAccessibility");
        unsafe {
            AXUIElementSetAttributeValue(app.raw(), attr.as_concrete_TypeRef(), CFBoolean::true_value().as_CFTypeRef());
            AXUIElementSetMessagingTimeout(app.raw(), 2.0);
        }
        Ok(Chrome { app, pid, window: None })
    }

    fn standard_windows(&self) -> Vec<El> {
        self.app.children().into_iter().filter(|c| c.role() == "AXWindow" && c.subrole() == "AXStandardWindow").collect()
    }

    pub fn windows(&self) -> Windows {
        Windows(self.standard_windows())
    }

    /// Look only at the first browser window that isn't in `before` (tg's own) from now on:
    /// windows of other profiles draw bars of their own. Whether one turned up within `wait`; if
    /// none did, every window still counts.
    pub fn watch_new(&mut self, before: &Windows, wait: Duration) -> bool {
        self.window = wait_for(wait, || self.standard_windows().into_iter().find(|w| !before.0.iter().any(|b| same(b, w))));
        debug(|| format!("tg's window {}", if self.window.is_some() { "found" } else { "not found: watching every window" }));
        self.window.is_some()
    }

    /// A menu Chrome has open: a context menu (an app-level AXMenu), or one of Chrome's own menus
    /// (an AXMenu inside a window that isn't a browser window).
    fn open_menu(&self) -> Option<El> {
        for c in self.app.children() {
            match c.role().as_str() {
                "AXMenu" => return Some(c),
                "AXWindow" if c.subrole() != "AXStandardWindow" => {
                    if let Some(m) = c.find(6, &|e| e.role() == "AXMenu") {
                        return Some(m);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// Escape, to Chrome alone (its own menus close on it).
    fn escape(&self) {
        for down in [true, false] {
            let e = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), KEY_ESCAPE, down) };
            if !e.is_null() {
                let e = unsafe { CFType::wrap_under_create_rule(e) };
                unsafe { CGEventPostToPid(self.pid, e.as_CFTypeRef()) };
            }
        }
    }

    /// The chips of the fullest "Saved Tab Groups" bar in the watched window (or in any browser
    /// window). A narrow window moves chips into its overflow menu.
    fn chips(&self) -> Vec<Chip> {
        let mut best: Vec<Chip> = Vec::new();
        let windows = match &self.window {
            Some(w) => vec![w.clone()],
            None => self.standard_windows(),
        };
        for w in windows {
            let Some(bar) = w.find(10, &|e| e.role() == "AXToolbar" && e.title() == "Saved Tab Groups") else { continue };
            let chips: Vec<Chip> = bar
                .children()
                .into_iter()
                .filter(|c| c.role() == "AXButton")
                .filter_map(|el| {
                    let t = el.title();
                    let t = t.trim();
                    let (label, closed) = if let Some(l) = t.strip_suffix(" group - Closed") {
                        (l, true)
                    } else {
                        (t.strip_suffix(" group - Opened")?, false)
                    };
                    Some(Chip { label: label.trim().to_string(), closed, el })
                })
                .collect();
            if chips.len() > best.len() {
                best = chips;
            }
        }
        best
    }

    /// Whether a bar with chips shows anywhere (waits up to `wait` for one to appear).
    pub fn bar_ready(&self, wait: Duration) -> bool {
        let start = Instant::now();
        loop {
            if !self.chips().is_empty() {
                return true;
            }
            if start.elapsed() > wait {
                return false;
            }
            sleep(Duration::from_millis(100));
        }
    }

    /// Make the bar with chips show. Chrome draws the bookmarks bar on its own New Tab page, but
    /// not on one an extension puts there (New Tab Right's), so when it isn't up, turn on "Always
    /// Show Bookmarks Bar" for the run. Whether tg turned it on: then `hide_bar` when done.
    pub fn show_bar(&self) -> Result<bool, String> {
        if self.bar_ready(Duration::from_secs(2)) {
            return Ok(false);
        }
        debug(|| format!("no bar; turning on {ALWAYS_SHOW_BAR}"));
        if !self.set_always_show(true)? {
            return Err("Chrome's bookmarks bar shows no tab groups (Chrome setting: Show tab groups in bookmarks bar)".into());
        }
        if self.bar_ready(Duration::from_secs(5)) {
            return Ok(true);
        }
        let undo = self.hide_bar().err().map(|e| format!("; {e}")).unwrap_or_default();
        Err(format!(
            "Chrome's bookmarks bar shows no tab groups, even with {ALWAYS_SHOW_BAR} on (Chrome setting: Show tab groups in bookmarks bar){undo}"
        ))
    }

    /// Turn "Always Show Bookmarks Bar" off again, after `show_bar` turned it on.
    pub fn hide_bar(&self) -> Result<(), String> {
        debug(|| format!("turning {ALWAYS_SHOW_BAR} off again"));
        let left_on = "Chrome may still show the bookmarks bar on every page (⌘⇧B in Chrome hides it)";
        self.set_always_show(false).map_err(|e| format!("{e}: {left_on}"))?;
        // With the item off, tg's window (an extension's New Tab page) has no bar.
        if self.window.is_some() && wait_for(Duration::from_secs(3), || self.chips().is_empty().then_some(())).is_none() {
            return Err(left_on.to_string());
        }
        Ok(())
    }

    /// Set View → "Always Show Bookmarks Bar" (for the profile of Chrome's key window) to `on`.
    /// Chrome greys the item out while it's in the background: call `come_forward` first. Whether
    /// it pressed (false: the item was `on` already).
    fn set_always_show(&self, on: bool) -> Result<bool, String> {
        let item = self.menu_item(ALWAYS_SHOW_BAR).ok_or_else(|| format!("tg can't find Chrome's View → {ALWAYS_SHOW_BAR}"))?;
        if wait_for(Duration::from_secs(2), || (item.flag("AXEnabled") == Some(true)).then_some(())).is_none() {
            return Err(format!("Chrome kept View → {ALWAYS_SHOW_BAR} greyed out"));
        }
        let was = checked(&item);
        debug(|| format!("{ALWAYS_SHOW_BAR} is {}; want {}", if was { "on" } else { "off" }, if on { "on" } else { "off" }));
        if was == on {
            return Ok(false);
        }
        item.perform("AXPress")?;
        Ok(true)
    }

    /// Bring tg's window (Chrome) to the front: Chrome greys out its menu items while it's in the
    /// background, and ignores presses on a "Delete Tab Group?" sheet that's out of sight. What
    /// was in front, for `go_back`.
    pub fn come_forward(&self) -> Away {
        let away = Away { app: frontmost(), main: self.app.attr("AXMainWindow").map(El) };
        if let Some(w) = &self.window {
            set_flag(w, "AXMain", true);
            let _ = w.perform("AXRaise");
        }
        let came = bring_front(&self.app);
        debug(|| format!("to the front (from {:?}): {came}", away.app));
        debug(|| {
            let t = |a: &str| self.app.attr(a).map(|w| El(w).title()).unwrap_or_default();
            format!("  main “{}”, focused “{}”", t("AXMainWindow"), t("AXFocusedWindow"))
        });
        away
    }

    /// Give the front back to the app that had it before `come_forward`.
    pub fn go_back(&self, away: Away) {
        let back = match away.app {
            Some(pid) if pid != self.pid => bring_front(&app_of(pid)),
            // Chrome was in front: its own window goes back on top.
            _ => away.main.is_some_and(|m| set_flag(&m, "AXMain", true)),
        };
        debug(|| format!("front back to {:?}: {back}", away.app));
    }

    /// The "Delete Group" button of the "Delete Tab Group?" sheet Chrome puts on a window before it
    /// deletes a saved group.
    fn delete_sheet(&self) -> Option<El> {
        let windows = match &self.window {
            Some(w) => vec![w.clone()],
            None => self.standard_windows(),
        };
        windows.iter().find_map(|w| {
            let sheet = w.find(2, &|e| e.role() == "AXSheet" && e.title() == "Delete Tab Group?")?;
            sheet.find(12, &|e| e.role() == "AXButton" && e.title() == "Delete Group")
        })
    }

    /// For TG_DEBUG, when a delete doesn't take: Chrome's windows other than browser windows
    /// (menus, dialogs) and tg's own window, with what's named in them.
    fn describe(&self) -> String {
        fn lines(e: &El, depth: usize, indent: usize, out: &mut Vec<String>) {
            let (role, title, desc) = (e.role(), e.title(), e.string("AXDescription"));
            if !title.is_empty() || !desc.is_empty() || indent == 0 {
                out.push(format!("{}{role} {} “{title}” {desc}", "  ".repeat(indent + 1), e.subrole()));
            }
            if depth > 0 && role != "AXWebArea" {
                e.children().iter().for_each(|c| lines(c, depth - 1, indent + 1, out));
            }
        }
        let mut out = vec!["Chrome's other windows:".to_string()];
        for c in self.app.children().into_iter().filter(|c| c.role() != "AXMenuBar" && c.subrole() != "AXStandardWindow") {
            lines(&c, 8, 0, &mut out);
        }
        if let Some(w) = &self.window {
            out.push("tg's window:".to_string());
            lines(w, 12, 0, &mut out);
        }
        out.join("\n")
    }

    /// An item of Chrome's main menu (one level down), by its title.
    fn menu_item(&self, title: &str) -> Option<El> {
        let bar = El(self.app.attr("AXMenuBar")?);
        bar.children().into_iter().flat_map(|top| top.children()).flat_map(|menu| menu.children()).find(|i| i.title() == title)
    }

    /// Closed chips that could be this group.
    fn closed_chips(&self, title: &str, tabs: usize) -> Vec<Chip> {
        self.chips().into_iter().filter(|c| c.closed && names(&c.label, title, tabs)).collect()
    }

    /// Delete the closed saved group with this title (empty: unnamed) whose tabs are `tabs`
    /// (titles, or URLs for tabs without one).
    pub fn delete_closed(&self, title: &str, tabs: &[String]) -> Result<(), Fail> {
        let label = label(title);
        let label = label.as_str();
        if self.open_menu().is_some() {
            return Err(Fail::Stop("a Chrome menu is open: close it (esc in Chrome) and try again".into()));
        }
        let chips = self.closed_chips(title, tabs.len());
        if chips.is_empty() {
            return Err(Fail::Skip(format!("“{label}” isn't on the bookmarks bar, so tg can't reach it (unpinned, or past the bar's end)")));
        }
        let before = chips.len();
        let mut want: Vec<String> = tabs.iter().map(|t| menu_text(t)).collect();
        want.sort_unstable();
        for chip in &chips {
            if !chip.el.actions().iter().any(|a| a == "AXShowMenu") {
                return Err(Fail::Stop(format!("the “{label}” chip has no menu to open")));
            }
            chip.el.perform("AXShowMenu").map_err(Fail::Stop)?;
            let Some(menu) = wait_for(Duration::from_secs(2), || self.open_menu()) else {
                return Err(Fail::Stop(format!("Chrome didn't open “{label}”'s menu; nothing was pressed")));
            };
            let items = menu.children();
            let titles: Vec<String> = items.iter().map(El::title).collect();
            debug(|| format!("“{label}” menu ({}): {} items, {} tabs listed", if menu_is_native(&self.app, &menu) { "native" } else { "chrome" }, titles.len(), titles.iter().skip_while(|t| *t != "Tabs in group").count().saturating_sub(1)));
            let has = |t: &str| titles.iter().any(|x| x == t);
            if !(has("Open group") && has("Delete group") && has("Tabs in group")) {
                self.cancel(&menu)?;
                return Err(Fail::Stop(format!("the menu that opened isn't a saved group's ({}); nothing was pressed", titles.join(", "))));
            }
            let mut listed: Vec<String> =
                titles.iter().skip_while(|t| *t != "Tabs in group").skip(1).filter(|t| !t.is_empty()).map(|t| menu_text(t)).collect();
            listed.sort_unstable();
            if listed != want {
                debug(|| format!("not this one: its tabs differ; cancelling\n    menu: {listed:?}\n    want: {want:?}"));
                self.cancel(&menu)?;
                continue;
            }
            let delete: Vec<&El> = items.iter().filter(|i| i.title() == "Delete group").collect();
            let [delete] = delete[..] else {
                self.cancel(&menu)?;
                return Err(Fail::Stop("the group's menu has more than one Delete group".into()));
            };
            if delete.flag("AXEnabled") == Some(false) {
                self.cancel(&menu)?;
                return Err(Fail::Skip(format!("Chrome won't delete “{label}” (Delete group is greyed out)")));
            }
            debug(|| "tabs match; pressing Delete group".to_string());
            delete.perform("AXPress").map_err(Fail::Stop)?;
            let deleted = || (self.closed_chips(title, tabs.len()).len() < before).then_some(());
            // Gone, or Chrome asks first (unless it was told not to ask again).
            let asked = wait_for(Duration::from_secs(3), || deleted().map(|()| None).or_else(|| self.delete_sheet().map(Some)));
            let gone = match asked {
                Some(Some(confirm)) => {
                    // Chrome ignores a press on a dialog that comes within a double-click's time
                    // (half a second) of the dialog coming up or of the last press, so wait
                    // that out before each one.
                    debug(|| "Chrome asks first; pressing its Delete Group".to_string());
                    let mut gone = None;
                    for _ in 0..3 {
                        sleep(Duration::from_millis(700));
                        let pressed = confirm.perform("AXPress").is_ok();
                        gone = wait_for(Duration::from_millis(if pressed { 800 } else { 1500 }), deleted);
                        if gone.is_some() || !pressed {
                            break;
                        }
                    }
                    gone
                }
                Some(None) => Some(()),
                None => None,
            };
            if gone.is_none() {
                debug(|| self.describe());
                return Err(Fail::Stop(format!("pressed Delete group, but “{label}” is still on the bar")));
            }
            if self.open_menu().is_some() {
                return Err(Fail::Stop("deleted, but a Chrome menu is still open".into()));
            }
            return Ok(());
        }
        Err(Fail::Skip(format!("no “{label}” chip lists exactly this group's {} tab{}; nothing was pressed", tabs.len(), if tabs.len() == 1 { "" } else { "s" })))
    }

    /// Close a menu tg opened: AXCancel for a native menu, Escape for Chrome's own.
    fn cancel(&self, menu: &El) -> Result<(), Fail> {
        let closed = || self.open_menu().is_none().then_some(());
        let _ = menu.perform("AXCancel");
        if wait_for(Duration::from_millis(300), closed).is_some() {
            debug(|| "closed by AXCancel".to_string());
            return Ok(());
        }
        if self.open_menu().is_some() {
            debug(|| "AXCancel didn't close it; sending Escape".to_string());
            self.escape();
        }
        match wait_for(Duration::from_secs(1), closed) {
            Some(()) => Ok(()),
            None => Err(Fail::Stop("a group's menu won't close: press esc in Chrome".into())),
        }
    }
}

/// A tab title as a menu item shows it, so the two compare: Chrome's menus treat `&` as a
/// shortcut marker and drop it; whitespace runs count as one space.
fn menu_text(s: &str) -> String {
    s.replace('&', "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// TG_DEBUG=1: what each step saw, on stderr (for `tg rm`).
fn debug(m: impl FnOnce() -> String) {
    if std::env::var_os("TG_DEBUG").is_some() {
        eprintln!("tg: {}", m());
    }
}

fn wait_for<T>(limit: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if start.elapsed() > limit {
            return None;
        }
        sleep(Duration::from_millis(50));
    }
}

/// The browser's process: the browser-use native host's parent.
pub fn browser_pid(host_pid: i32) -> Option<i32> {
    let out = std::process::Command::new("/bin/ps").args(["-o", "ppid=", "-p", &host_pid.to_string()]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok().filter(|&p: &i32| p > 1)
}

/// Its executable, for finding its profile directory.
pub fn exe_of(pid: i32) -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("/bin/ps").args(["-o", "comm=", "-p", &pid.to_string()]).output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then(|| s.into())
}

fn menu_is_native(app: &El, menu: &El) -> bool {
    app.children().iter().any(|c| c.role() == "AXMenu" && same(c, menu))
}

/// An app's element, by its process.
fn app_of(pid: i32) -> El {
    El(unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) })
}

/// The process of the app in front, from LaunchServices: accessibility's own answer (the
/// system-wide AXFocusedApplication) fails when the app in front doesn't answer it, as Rex doesn't.
fn frontmost() -> Option<i32> {
    let lsappinfo = |args: &[&str]| {
        let out = std::process::Command::new("/usr/bin/lsappinfo").args(args).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let asn = lsappinfo(&["front"]).filter(|a| a.starts_with("ASN:"))?;
    // "pid"=91613
    lsappinfo(&["info", "-only", "pid", &asn])?.rsplit('=').next()?.trim().parse().ok().filter(|&p: &i32| p > 0)
}

/// Bring an app to the front, and wait until it's there (asking again if it doesn't come).
/// Whether it came.
fn bring_front(app: &El) -> bool {
    for _ in 0..3 {
        set_flag(app, "AXFrontmost", true);
        if wait_for(Duration::from_millis(500), || (app.flag("AXFrontmost") == Some(true)).then_some(())).is_some() {
            return true;
        }
    }
    false
}

/// Set a yes/no attribute; whether the element took it.
fn set_flag(e: &El, attr: &str, value: bool) -> bool {
    let a = CFString::new(attr);
    let v = if value { CFBoolean::true_value() } else { CFBoolean::false_value() };
    unsafe { AXUIElementSetAttributeValue(e.raw(), a.as_concrete_TypeRef(), v.as_CFTypeRef()) == 0 }
}

/// Whether two elements are the same one.
fn same(a: &El, b: &El) -> bool {
    unsafe { core_foundation::base::CFEqual(a.raw(), b.raw()) != 0 }
}

/// Whether a menu item has its check mark.
fn checked(item: &El) -> bool {
    !item.string("AXMenuItemMarkChar").is_empty()
}
