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
//!   4. press "Delete group", then check that one chip of that name is gone.
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
}

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
        Ok(Chrome { app, pid })
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

    /// The chips of the fullest "Saved Tab Groups" bar in any browser window. Chrome draws the
    /// bar only on a New Tab page, and a narrow window moves chips into its overflow menu.
    fn chips(&self) -> Vec<Chip> {
        let mut best: Vec<Chip> = Vec::new();
        for w in self.app.children().into_iter().filter(|c| c.role() == "AXWindow" && c.subrole() == "AXStandardWindow") {
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
            let gone = wait_for(Duration::from_secs(3), || (self.closed_chips(title, tabs.len()).len() < before).then_some(()));
            if gone.is_none() {
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
    app.children().iter().any(|c| c.role() == "AXMenu" && unsafe { core_foundation::base::CFEqual(c.raw(), menu.raw()) } != 0)
}
