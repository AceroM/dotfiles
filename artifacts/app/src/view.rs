//! The window: the page list (search, kind and tag filters, grouped by day) beside tabs of pages,
//! each tab its own WebKit view. The list follows the server live through its event stream.
//!
//! The list has a cursor of its own: `j`/`k` (with vim counts, against relative line numbers)
//! move it without touching the page, and `l`/Enter open its page in the active tab. The keyboard
//! is always in one of three places, and a ring shows which: the list, its search box, or the page.
//! The page runs the server's own vim keys (`keys.js`); in here they talk back over IPC, so
//! `h`/Esc return to the list, `[` `]` step through it, and `H` `L` switch tabs.

use crate::api::{self, Fetched, Item, Query};
use crate::saved::{self, Saved};
use async_channel::{Receiver, Sender};
use chrono::{Local, TimeZone};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::theme::{Theme, ThemeColor};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use gpui_webview::WebView;
use std::time::Duration;

gpui_kit::actions!(
    artifacts,
    [
        SearchPages,
        FindInPage,
        FocusList,
        OpenCursor,
        ListEscape,
        SearchEscape,
        SelectNext,
        SelectPrev,
        SelectFirst,
        SelectLast,
        PrevTag,
        NextTag,
        NewTab,
        CancelNewTab,
        OpenInNewTab,
        DuplicateTab,
        CloseTab,
        CloseOtherTabs,
        ReopenClosedTab,
        NextTab,
        PrevTab,
        LastUsedTab,
        MoveTabLeft,
        MoveTabRight,
        GoToTab1,
        GoToTab2,
        GoToTab3,
        GoToTab4,
        GoToTab5,
        GoToTab6,
        GoToTab7,
        GoToTab8,
        GoToLastTab,
        Reload,
        OpenInBrowser,
        Back,
        Forward,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        HideWindow,
        Quit,
    ]
);

const LIST: &str = "ArtifactList";
const SEARCH: &str = "ArtifactSearch";
/// The text input inside the search box. Its own bindings (Escape, arrows) sit at this depth, so
/// ours have to as well; registered after the input's, they win.
const SEARCH_INPUT: &str = "ArtifactSearch > Input";
const KINDS: [(&str, &str); 3] = [("code-path", "code path"), ("md", "notes"), ("html", "page")];
const SIDEBAR_WIDTH: f32 = 340.;
const SIDEBAR_MIN: f32 = 220.;
const SIDEBAR_MAX: f32 = 640.;

/// Runs in every page before its own scripts. The `in-app` class drops the page's own header (the
/// window has its own chrome), `keys.js` finds `artifactsApp` and routes its list and tab keys
/// here, and focus events tell the app when the page takes the keyboard.
const PAGE_BRIDGE: &str = r#"
document.documentElement.classList.add('in-app');
window.artifactsApp = { post: (m) => window.ipc.postMessage(m) };
window.addEventListener('focus', () => window.ipc.postMessage('focus'));
"#;

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        // Global: these are menu shortcuts too, so they work while the page has the keyboard.
        KeyBinding::new("cmd-/", SearchPages, None),
        KeyBinding::new("cmd-f", FindInPage, None),
        KeyBinding::new("cmd-t", NewTab, None),
        KeyBinding::new("cmd-n", NewTab, None),
        KeyBinding::new("cmd-l", OpenInNewTab, None),
        KeyBinding::new("cmd-w", CloseTab, None),
        KeyBinding::new("cmd-shift-t", ReopenClosedTab, None),
        KeyBinding::new("cmd-alt-w", CloseOtherTabs, None),
        KeyBinding::new("cmd-shift-]", NextTab, None),
        KeyBinding::new("cmd-shift-[", PrevTab, None),
        KeyBinding::new("cmd-}", NextTab, None),
        KeyBinding::new("cmd-{", PrevTab, None),
        KeyBinding::new("ctrl-tab", NextTab, None),
        KeyBinding::new("ctrl-shift-tab", PrevTab, None),
        KeyBinding::new("ctrl-shift-pagedown", MoveTabRight, None),
        KeyBinding::new("ctrl-shift-pageup", MoveTabLeft, None),
        KeyBinding::new("cmd-1", GoToTab1, None),
        KeyBinding::new("cmd-2", GoToTab2, None),
        KeyBinding::new("cmd-3", GoToTab3, None),
        KeyBinding::new("cmd-4", GoToTab4, None),
        KeyBinding::new("cmd-5", GoToTab5, None),
        KeyBinding::new("cmd-6", GoToTab6, None),
        KeyBinding::new("cmd-7", GoToTab7, None),
        KeyBinding::new("cmd-8", GoToTab8, None),
        KeyBinding::new("cmd-9", GoToLastTab, None),
        KeyBinding::new("cmd-r", Reload, None),
        KeyBinding::new("cmd-o", OpenInBrowser, None),
        KeyBinding::new("cmd-[", Back, None),
        KeyBinding::new("cmd-]", Forward, None),
        KeyBinding::new("cmd-=", ZoomIn, None),
        KeyBinding::new("cmd-+", ZoomIn, None),
        KeyBinding::new("cmd--", ZoomOut, None),
        KeyBinding::new("cmd-0", ZoomReset, None),
        KeyBinding::new("cmd-h", HideWindow, None),
        KeyBinding::new("cmd-q", Quit, None),
        // The list. Digits before a motion are a count (`10j`), read by the list's key handler.
        KeyBinding::new("j", SelectNext, Some(LIST)),
        KeyBinding::new("down", SelectNext, Some(LIST)),
        KeyBinding::new("k", SelectPrev, Some(LIST)),
        KeyBinding::new("up", SelectPrev, Some(LIST)),
        KeyBinding::new("g g", SelectFirst, Some(LIST)),
        KeyBinding::new("shift-g", SelectLast, Some(LIST)),
        KeyBinding::new("l", OpenCursor, Some(LIST)),
        KeyBinding::new("right", OpenCursor, Some(LIST)),
        KeyBinding::new("enter", OpenCursor, Some(LIST)),
        KeyBinding::new("tab", OpenCursor, Some(LIST)),
        KeyBinding::new("escape", ListEscape, Some(LIST)),
        KeyBinding::new("/", SearchPages, Some(LIST)),
        KeyBinding::new("shift-h", PrevTag, Some(LIST)),
        KeyBinding::new("shift-l", NextTag, Some(LIST)),
        KeyBinding::new("o", OpenInBrowser, Some(LIST)),
        KeyBinding::new("r", Reload, Some(LIST)),
        KeyBinding::new("t", DuplicateTab, Some(LIST)),
        KeyBinding::new("x", CloseTab, Some(LIST)),
        KeyBinding::new("shift-x", ReopenClosedTab, Some(LIST)),
        KeyBinding::new("^", LastUsedTab, Some(LIST)),
        KeyBinding::new("shift-6", LastUsedTab, Some(LIST)),
        KeyBinding::new("<", MoveTabLeft, Some(LIST)),
        KeyBinding::new("shift-,", MoveTabLeft, Some(LIST)),
        KeyBinding::new(">", MoveTabRight, Some(LIST)),
        KeyBinding::new("shift-.", MoveTabRight, Some(LIST)),
        // The search box: move the cursor while typing, Enter opens, Esc leaves.
        KeyBinding::new("ctrl-j", SelectNext, Some(SEARCH_INPUT)),
        KeyBinding::new("ctrl-k", SelectPrev, Some(SEARCH_INPUT)),
        KeyBinding::new("escape", SearchEscape, Some(SEARCH_INPUT)),
    ]);
}

#[derive(Clone, Copy, PartialEq)]
enum Pane {
    List,
    Search,
    Page,
}

/// What a page tells the app, from `PAGE_BRIDGE`, `keys.js` and the navigation handlers.
enum PageMsg {
    Focused,
    ToList,
    Next,
    Prev,
    Navigated(String),
    OpenTab(String),
    OpenOutside(String),
    NextTab,
    PrevTab,
    CloseTab,
    ReopenTab,
    DuplicateTab,
    LastUsedTab,
    MoveTabLeft,
    MoveTabRight,
}

/// A page message, tagged with the tab whose webview sent it.
struct FromPage {
    tab: u64,
    msg: PageMsg,
}

struct Tab {
    id: u64,
    /// The page the tab shows; empty for a blank tab.
    slug: String,
    /// Built the first time the tab is shown, so restored tabs don't all load at launch.
    webview: Option<Entity<WebView>>,
}

/// What's dragged when resizing the sidebar.
struct SidebarResize;

struct DragPreview;

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

pub struct ArtifactsView {
    search: Entity<InputState>,
    list_focus: FocusHandle,
    scroll: ScrollHandle,
    tab_scroll: ScrollHandle,
    tabs: Vec<Tab>,
    active: usize,
    /// The previously active tab, for `^`.
    last_used: Option<u64>,
    /// Slugs of closed tabs, most recent last, for reopening.
    closed: Vec<String>,
    next_id: u64,
    tx: Sender<FromPage>,
    zoom: f64,
    sidebar_width: f32,
    pane: Pane,
    query: Query,
    items: Vec<Item>,
    all: Vec<Item>,
    tags: Vec<String>,
    /// The list's highlight: moving it doesn't touch the page until it's opened.
    cursor: String,
    /// The row under the mouse, for ⌘L.
    hovered: Option<String>,
    /// Digits typed before a motion, vim-style.
    count: String,
    /// Choosing a page for a new tab (⌘T, from the search box): opening the cursor makes a tab
    /// instead. Esc, or going to the page, cancels.
    new_tab: bool,
    /// Where the keyboard was when ⌘T started choosing, for Esc to put it back.
    before_new_tab: Pane,
    /// The next fetch came from a new query: if the cursor isn't among its results, move it to
    /// the first one (a live refresh mustn't move it).
    pick: bool,
    error: Option<String>,
    scroll_to_cursor: bool,
    scroll_to_tab: bool,
    title: String,
    fetch: Task<()>,
    save_soon: Task<()>,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl ArtifactsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search pages"));
        let (tx, rx) = async_channel::unbounded();
        let subscriptions = vec![
            cx.subscribe_in(&search, window, |this, state, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    this.query.q = state.read(cx).value().to_string();
                    this.refresh(true, cx);
                }
                InputEvent::PressEnter { .. } => this.open_cursor(window, cx),
                InputEvent::Focus => {
                    this.pane = Pane::Search;
                    cx.notify();
                }
                _ => {}
            }),
            cx.observe_window_appearance(window, |_, window, cx| Theme::sync_system_appearance(Some(window), cx)),
        ];
        let saved = saved::load();
        let mut this = Self {
            search,
            list_focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            tab_scroll: ScrollHandle::new(),
            tabs: vec![],
            active: 0,
            last_used: None,
            closed: vec![],
            next_id: 0,
            tx,
            zoom: saved.zoom.unwrap_or(1.0),
            sidebar_width: saved.sidebar_width.unwrap_or(SIDEBAR_WIDTH).clamp(SIDEBAR_MIN, SIDEBAR_MAX),
            pane: Pane::List,
            query: Query::default(),
            items: vec![],
            all: vec![],
            tags: vec![],
            cursor: String::new(),
            hovered: None,
            count: String::new(),
            new_tab: false,
            before_new_tab: Pane::List,
            pick: false,
            error: None,
            scroll_to_cursor: false,
            scroll_to_tab: false,
            title: String::new(),
            fetch: Task::ready(()),
            save_soon: Task::ready(()),
            _tasks: vec![],
            _subscriptions: subscriptions,
        };
        let slugs = if saved.tabs.is_empty() { vec![String::new()] } else { saved.tabs };
        for slug in slugs {
            this.push_tab(slug);
        }
        let active = saved.active.min(this.tabs.len() - 1);
        this.active = active;
        this.activate(active, window, cx);
        this._tasks = vec![this.watch(cx), this.listen(rx, window, cx)];
        this.focus_pane(Pane::List, window, cx);
        this.refresh(false, cx);
        this
    }

    // ---- the list ------------------------------------------------------------------------------

    /// Refetch the list for the current query. Replacing `fetch` drops (cancels) one in flight.
    fn refresh(&mut self, pick: bool, cx: &mut Context<Self>) {
        self.pick |= pick;
        let query = self.query.clone();
        let task = cx.background_executor().spawn(async move { api::fetch(&query) });
        self.fetch = cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| this.apply(result, cx)).ok();
        });
    }

    fn apply(&mut self, result: Result<Fetched, String>, cx: &mut Context<Self>) {
        match result {
            Ok(Fetched { items, all, tags }) => {
                self.items = items;
                self.all = all;
                self.tags = tags;
                self.error = None;
                // A tag that no longer matches anything stops filtering.
                if self.query.tag.as_ref().is_some_and(|t| !self.tags.contains(t)) {
                    self.query.tag = None;
                    return self.refresh(false, cx);
                }
                let pick = std::mem::take(&mut self.pick);
                let listed = self.items.iter().any(|i| i.slug == self.cursor);
                if self.cursor.is_empty() || (pick && !listed) {
                    if let Some(first) = self.items.first() {
                        self.cursor = first.slug.clone();
                        self.scroll_to_cursor = true;
                    }
                }
                // A blank tab (the very first launch) shows the newest page.
                if self.active_slug().is_empty() && !self.cursor.is_empty() && !self.new_tab {
                    self.select(self.cursor.clone(), cx);
                }
            }
            Err(e) => {
                self.error = Some(format!("No server at {} ({e}). Start it with `artifacts up`.", api::base_url()))
            }
        }
        cx.notify();
    }

    /// Follow the server's event stream, refreshing on every change. When the server goes away,
    /// keep retrying, and refresh again on reconnect since pages may have changed meanwhile.
    fn watch(&self, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn(async move |this, cx| loop {
            let ex = cx.background_executor().clone();
            let Ok(mut events) = ex.spawn(async { api::Events::connect() }).await else {
                ex.timer(Duration::from_secs(2)).await;
                continue;
            };
            if this.update(cx, |this, cx| this.refresh(false, cx)).is_err() {
                return;
            }
            loop {
                let (back, next) = ex
                    .spawn(async move {
                        let next = events.next();
                        (events, next)
                    })
                    .await;
                events = back;
                if next.is_err() {
                    break;
                }
                if this.update(cx, |this, cx| this.refresh(false, cx)).is_err() {
                    return;
                }
            }
            if this.update(cx, |this, cx| this.refresh(false, cx)).is_err() {
                return;
            }
        })
    }

    /// Show `slug` in the active tab, with the cursor on it.
    fn select(&mut self, slug: String, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.get_mut(self.active) {
            if tab.slug != slug {
                tab.slug = slug.clone();
                if let Some(webview) = &tab.webview {
                    let url = api::page_url(&slug);
                    webview.update(cx, |w, _| w.load_url(&url));
                }
            }
        }
        self.cursor = slug;
        self.scroll_to_cursor = true;
        self.save();
        cx.notify();
    }

    fn take_count(&mut self) -> Option<usize> {
        std::mem::take(&mut self.count).parse().ok()
    }

    fn cursor_ix(&self) -> Option<usize> {
        self.items.iter().position(|i| i.slug == self.cursor)
    }

    fn move_cursor(&mut self, ix: usize, cx: &mut Context<Self>) {
        if let Some(item) = self.items.get(ix.min(self.items.len().saturating_sub(1))) {
            self.cursor = item.slug.clone();
            self.scroll_to_cursor = true;
            cx.notify();
        }
    }

    /// `j`/`k`, times the count.
    fn step(&mut self, delta: isize, cx: &mut Context<Self>) {
        let n = self.take_count().unwrap_or(1) as isize;
        let ix = match self.cursor_ix() {
            Some(ix) => ix.saturating_add_signed(delta * n),
            None => 0,
        };
        self.move_cursor(ix, cx);
    }

    /// Open the cursor's page: in the active tab, or in a new one while choosing for ⌘T.
    fn open_cursor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.count.clear();
        if self.cursor.is_empty() {
            return self.focus_pane(Pane::Page, window, cx);
        }
        let slug = self.cursor.clone();
        if std::mem::take(&mut self.new_tab) {
            self.open_tab(slug, window, cx);
            // The search was only for choosing: clear it for next time.
            self.search.update(cx, |s, cx| s.set_value("", window, cx));
            self.query.q.clear();
            self.refresh(false, cx);
        } else {
            self.select(slug, cx);
        }
        self.focus_pane(Pane::Page, window, cx);
    }

    /// `[` `]` from the page: the next or previous page in the list, in the active tab.
    fn page_step(&mut self, delta: isize, cx: &mut Context<Self>) {
        let current = self.active_slug().to_string();
        let Some(ix) = self.items.iter().position(|i| i.slug == current) else {
            return;
        };
        if let Some(item) = self.items.get(ix.saturating_add_signed(delta)) {
            self.select(item.slug.clone(), cx);
        }
    }

    fn cycle_tag(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.tags.is_empty() {
            return;
        }
        // "All" sits before the first tag.
        let len = self.tags.len() as isize + 1;
        let at = self.query.tag.as_ref().and_then(|t| self.tags.iter().position(|x| x == t)).map_or(0, |i| i as isize + 1);
        let to = (at + delta).rem_euclid(len);
        self.set_tag(if to == 0 { None } else { Some(self.tags[to as usize - 1].clone()) }, cx);
    }

    // ---- tabs ----------------------------------------------------------------------------------

    fn active_slug(&self) -> &str {
        self.tabs.get(self.active).map_or("", |t| t.slug.as_str())
    }

    fn active_webview(&self) -> Option<&Entity<WebView>> {
        self.tabs.get(self.active)?.webview.as_ref()
    }

    fn push_tab(&mut self, slug: String) -> usize {
        self.next_id += 1;
        self.tabs.push(Tab { id: self.next_id, slug, webview: None });
        self.tabs.len() - 1
    }

    fn tab_ix(&self, id: u64) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    fn page_item(&self, slug: &str) -> Option<&Item> {
        self.all.iter().find(|i| i.slug == slug)
    }

    fn ensure_webview(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let tab = &self.tabs[ix];
        if tab.webview.is_some() {
            return;
        }
        let url = if tab.slug.is_empty() { "about:blank".to_string() } else { api::page_url(&tab.slug) };
        match build_webview(tab.id, &url, self.tx.clone(), window, cx) {
            Ok(webview) => {
                let _ = webview.set_zoom(self.zoom);
                self.tabs[ix].webview = Some(cx.new(|_| webview));
            }
            Err(e) => self.error = Some(format!("couldn't create the webview: {e}")),
        }
    }

    /// Bring tab `ix` forward: only the active tab's webview is shown (the native views would
    /// otherwise sit on top of each other), the cursor moves to its page, and the keyboard stays
    /// in the pane it was in.
    fn activate(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.tabs.len() {
            return;
        }
        self.new_tab = false;
        if ix != self.active {
            if let Some(previous) = self.tabs.get(self.active) {
                self.last_used = Some(previous.id);
                if let Some(webview) = previous.webview.clone() {
                    webview.update(cx, |w, _| w.hide());
                }
            }
        }
        self.active = ix;
        self.ensure_webview(ix, window, cx);
        if let Some(webview) = self.active_webview().cloned() {
            webview.update(cx, |w, _| w.show());
            if self.pane == Pane::Page {
                let _ = webview.read(cx).raw().focus();
            }
        }
        if !self.tabs[ix].slug.is_empty() {
            self.cursor = self.tabs[ix].slug.clone();
        }
        self.scroll_to_cursor = true;
        self.scroll_to_tab = true;
        self.save();
        cx.notify();
    }

    fn open_tab(&mut self, slug: String, window: &mut Window, cx: &mut Context<Self>) {
        let ix = self.push_tab(slug);
        self.activate(ix, window, cx);
    }

    fn close_tab(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.tabs.len() {
            return;
        }
        // The last tab stays: closing it hides the app instead, as closing a window would.
        if self.tabs.len() == 1 {
            cx.hide();
            return;
        }
        let tab = self.tabs.remove(ix);
        if let Some(webview) = &tab.webview {
            webview.update(cx, |w, _| w.hide());
        }
        if !tab.slug.is_empty() {
            self.closed.push(tab.slug);
        }
        // Closing the active tab lands on the one that slid into its place (or the new last one).
        let next = if ix < self.active { self.active - 1 } else { self.active.min(self.tabs.len() - 1) };
        if ix == self.active {
            self.last_used = None;
        }
        self.active = next;
        self.activate(next, window, cx);
    }

    fn cycle_tab(&mut self, delta: isize, window: &mut Window, cx: &mut Context<Self>) {
        let len = self.tabs.len() as isize;
        let ix = (self.active as isize + delta).rem_euclid(len) as usize;
        self.activate(ix, window, cx);
    }

    fn move_tab(&mut self, delta: isize, cx: &mut Context<Self>) {
        let to = self.active as isize + delta;
        if to < 0 || to >= self.tabs.len() as isize {
            return;
        }
        self.tabs.swap(self.active, to as usize);
        self.active = to as usize;
        self.scroll_to_tab = true;
        self.save();
        cx.notify();
    }

    fn reopen_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(slug) = self.closed.pop() {
            self.open_tab(slug, window, cx);
        }
    }

    fn last_used_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ix) = self.last_used.and_then(|id| self.tab_ix(id)) {
            self.activate(ix, window, cx);
        }
    }

    fn save(&self) {
        saved::save(&Saved {
            tabs: self.tabs.iter().filter(|t| !t.slug.is_empty()).map(|t| t.slug.clone()).collect(),
            active: self.active,
            zoom: Some(self.zoom),
            sidebar_width: Some(self.sidebar_width),
        });
    }

    // ---- focus and the page --------------------------------------------------------------------

    /// Handle what the pages send: focus changes, list and tab keys, and their own navigations.
    fn listen(&self, rx: Receiver<FromPage>, window: &mut Window, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn_in(window, async move |this, cx| {
            while let Ok(FromPage { tab, msg }) = rx.recv().await {
                if this.update_in(cx, |this, window, cx| this.on_page(tab, msg, window, cx)).is_err() {
                    return;
                }
            }
        })
    }

    fn on_page(&mut self, tab: u64, msg: PageMsg, window: &mut Window, cx: &mut Context<Self>) {
        let from_active = self.tabs.get(self.active).is_some_and(|t| t.id == tab);
        match msg {
            // A link inside a page: that tab follows it, and so does the cursor if it's in front.
            PageMsg::Navigated(slug) => {
                if let Some(ix) = self.tab_ix(tab) {
                    self.tabs[ix].slug = slug.clone();
                }
                if from_active {
                    self.cursor = slug;
                    self.scroll_to_cursor = true;
                }
                self.save();
                cx.notify();
            }
            PageMsg::OpenTab(slug) => self.open_tab(slug, window, cx),
            PageMsg::OpenOutside(url) => cx.open_url(&url),
            // Keys from a page in the background don't count.
            _ if !from_active => {}
            PageMsg::Focused => {
                self.pane = Pane::Page;
                self.new_tab = false;
                cx.notify();
            }
            PageMsg::ToList => self.focus_pane(Pane::List, window, cx),
            PageMsg::Next => self.page_step(1, cx),
            PageMsg::Prev => self.page_step(-1, cx),
            PageMsg::NextTab => self.cycle_tab(1, window, cx),
            PageMsg::PrevTab => self.cycle_tab(-1, window, cx),
            PageMsg::CloseTab => self.close_tab(self.active, window, cx),
            PageMsg::ReopenTab => self.reopen_tab(window, cx),
            PageMsg::DuplicateTab => self.open_tab(self.active_slug().to_string(), window, cx),
            PageMsg::LastUsedTab => self.last_used_tab(window, cx),
            PageMsg::MoveTabLeft => self.move_tab(-1, cx),
            PageMsg::MoveTabRight => self.move_tab(1, cx),
        }
    }

    /// Move the keyboard, natively too: WebKit holds it while the page is focused.
    fn focus_pane(&mut self, pane: Pane, window: &mut Window, cx: &mut Context<Self>) {
        self.count.clear();
        if pane == Pane::Page {
            self.new_tab = false;
        }
        if let Some(webview) = self.active_webview() {
            let raw = webview.read(cx).raw();
            let _ = if pane == Pane::Page { raw.focus() } else { raw.focus_parent() };
        }
        match pane {
            Pane::List => self.list_focus.focus(window, cx),
            Pane::Search => self.search.update(cx, |s, cx| s.focus(window, cx)),
            Pane::Page => {}
        }
        self.pane = pane;
        cx.notify();
    }

    /// Page zoom, in browser-like steps, for every tab. WebKit keeps it across navigations.
    fn zoom(&mut self, factor: Option<f64>, cx: &mut Context<Self>) {
        self.zoom = factor.map_or(1.0, |f| (self.zoom * f).clamp(0.3, 3.0));
        for webview in self.tabs.iter().filter_map(|t| t.webview.as_ref()) {
            let _ = webview.read(cx).set_zoom(self.zoom);
        }
        self.save();
    }

    // ---- actions -------------------------------------------------------------------------------

    fn select_next(&mut self, _: &SelectNext, _: &mut Window, cx: &mut Context<Self>) {
        self.step(1, cx);
    }

    fn select_prev(&mut self, _: &SelectPrev, _: &mut Window, cx: &mut Context<Self>) {
        self.step(-1, cx);
    }

    /// `gg`, or `5gg` for the fifth page.
    fn select_first(&mut self, _: &SelectFirst, _: &mut Window, cx: &mut Context<Self>) {
        let ix = self.take_count().map_or(0, |n| n.saturating_sub(1));
        self.move_cursor(ix, cx);
    }

    /// `G`, or `5G` for the fifth page.
    fn select_last(&mut self, _: &SelectLast, _: &mut Window, cx: &mut Context<Self>) {
        let ix = self.take_count().map_or(usize::MAX, |n| n.saturating_sub(1));
        self.move_cursor(ix, cx);
    }

    fn prev_tag(&mut self, _: &PrevTag, _: &mut Window, cx: &mut Context<Self>) {
        self.cycle_tag(-1, cx);
    }

    fn next_tag(&mut self, _: &NextTag, _: &mut Window, cx: &mut Context<Self>) {
        self.cycle_tag(1, cx);
    }

    fn open_cursor_action(&mut self, _: &OpenCursor, window: &mut Window, cx: &mut Context<Self>) {
        self.open_cursor(window, cx);
    }

    /// Esc in the list: drop a pending ⌘T, else go back to the page.
    fn list_escape(&mut self, _: &ListEscape, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab {
            return self.cancel_new_tab(&CancelNewTab, window, cx);
        }
        self.cursor = self.active_slug().to_string();
        self.scroll_to_cursor = true;
        self.focus_pane(Pane::Page, window, cx);
    }

    /// Esc in the search box: drop a pending ⌘T, else back to the list.
    fn search_escape(&mut self, _: &SearchEscape, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab {
            return self.cancel_new_tab(&CancelNewTab, window, cx);
        }
        self.focus_pane(Pane::List, window, cx);
    }

    fn search_pages(&mut self, _: &SearchPages, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_pane(Pane::Search, window, cx);
    }

    fn find_in_page(&mut self, _: &FindInPage, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_pane(Pane::Page, window, cx);
        if let Some(webview) = self.active_webview() {
            let _ = webview.read(cx).raw().evaluate_script("window.artifactsApp?.find?.()");
        }
    }

    fn focus_list(&mut self, _: &FocusList, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab {
            return self.cancel_new_tab(&CancelNewTab, window, cx);
        }
        self.focus_pane(Pane::List, window, cx);
    }

    /// Start choosing a page for a new tab, from the search box with the cursor on the open page.
    /// Pressed again, it cancels.
    fn new_tab(&mut self, _: &NewTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab {
            return self.cancel_new_tab(&CancelNewTab, window, cx);
        }
        self.before_new_tab = self.pane;
        self.cursor = self.active_slug().to_string();
        self.scroll_to_cursor = true;
        self.scroll_to_tab = true;
        self.focus_pane(Pane::Search, window, cx);
        self.search.update(cx, |s, cx| s.select_all(window, cx));
        self.new_tab = true;
    }

    /// Stop choosing, and put the keyboard back where it was before ⌘T.
    fn cancel_new_tab(&mut self, _: &CancelNewTab, window: &mut Window, cx: &mut Context<Self>) {
        if std::mem::take(&mut self.new_tab) {
            self.cursor = self.active_slug().to_string();
            self.scroll_to_cursor = true;
            self.focus_pane(self.before_new_tab, window, cx);
        }
    }

    /// ⌘L: the row under the mouse, else the cursor's page, in a new tab.
    fn open_in_new_tab(&mut self, _: &OpenInNewTab, window: &mut Window, cx: &mut Context<Self>) {
        let slug = self.hovered.clone().unwrap_or_else(|| self.cursor.clone());
        if !slug.is_empty() {
            self.open_tab(slug, window, cx);
        }
    }

    fn duplicate_tab(&mut self, _: &DuplicateTab, window: &mut Window, cx: &mut Context<Self>) {
        self.open_tab(self.active_slug().to_string(), window, cx);
    }

    fn close_active_tab(&mut self, _: &CloseTab, window: &mut Window, cx: &mut Context<Self>) {
        self.close_tab(self.active, window, cx);
    }

    fn close_other_tabs(&mut self, _: &CloseOtherTabs, window: &mut Window, cx: &mut Context<Self>) {
        let keep = self.tabs.remove(self.active);
        for tab in self.tabs.drain(..) {
            if let Some(webview) = &tab.webview {
                webview.update(cx, |w, _| w.hide());
            }
            if !tab.slug.is_empty() {
                self.closed.push(tab.slug);
            }
        }
        self.tabs.push(keep);
        self.active = 0;
        self.last_used = None;
        self.activate(0, window, cx);
    }

    fn reopen_closed_tab(&mut self, _: &ReopenClosedTab, window: &mut Window, cx: &mut Context<Self>) {
        self.reopen_tab(window, cx);
    }

    fn next_tab(&mut self, _: &NextTab, window: &mut Window, cx: &mut Context<Self>) {
        self.cycle_tab(1, window, cx);
    }

    fn prev_tab(&mut self, _: &PrevTab, window: &mut Window, cx: &mut Context<Self>) {
        self.cycle_tab(-1, window, cx);
    }

    fn last_used(&mut self, _: &LastUsedTab, window: &mut Window, cx: &mut Context<Self>) {
        self.last_used_tab(window, cx);
    }

    fn move_left(&mut self, _: &MoveTabLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_tab(-1, cx);
    }

    fn move_right(&mut self, _: &MoveTabRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_tab(1, cx);
    }

    fn go_to_last_tab(&mut self, _: &GoToLastTab, window: &mut Window, cx: &mut Context<Self>) {
        self.activate(self.tabs.len() - 1, window, cx);
    }

    fn reload(&mut self, _: &Reload, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = self.active_webview() {
            let _ = webview.read(cx).raw().reload();
        }
        self.refresh(false, cx);
    }

    fn open_in_browser(&mut self, _: &OpenInBrowser, _: &mut Window, cx: &mut Context<Self>) {
        let url = self.active_webview().and_then(|w| w.read(cx).raw().url().ok());
        let slug = self.active_slug();
        let url = url.filter(|u| u.starts_with("http")).or_else(|| (!slug.is_empty()).then(|| api::page_url(slug)));
        if let Some(url) = url {
            cx.open_url(&url);
        }
    }

    fn back(&mut self, _: &Back, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = self.active_webview() {
            webview.update(cx, |w, _| w.back()).ok();
        }
    }

    fn forward(&mut self, _: &Forward, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = self.active_webview() {
            webview.update(cx, |w, _| w.forward()).ok();
        }
    }

    fn zoom_in(&mut self, _: &ZoomIn, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom(Some(1.1), cx);
    }

    fn zoom_out(&mut self, _: &ZoomOut, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom(Some(1.0 / 1.1), cx);
    }

    fn zoom_reset(&mut self, _: &ZoomReset, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom(None, cx);
    }

    fn set_kind(&mut self, kind: Option<String>, cx: &mut Context<Self>) {
        self.query.kind = kind;
        self.refresh(true, cx);
    }

    fn set_tag(&mut self, tag: Option<String>, cx: &mut Context<Self>) {
        self.query.tag = tag;
        self.refresh(true, cx);
        cx.notify();
    }

    /// Dragging the sidebar's edge; the width is saved once the dragging settles.
    fn resize_sidebar(&mut self, e: &DragMoveEvent<SidebarResize>, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_width = f32::from(e.event.position.x).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
        self.save_soon = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            this.update(cx, |this, _| this.save()).ok();
        });
        cx.notify();
    }

    /// Digits before a motion: `10j`. A leading 0 isn't a count.
    fn count_key(&mut self, e: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &e.keystroke;
        if ks.modifiers.modified() || ks.key.len() != 1 {
            return;
        }
        let Some(digit) = ks.key.chars().next().filter(char::is_ascii_digit) else {
            return;
        };
        if digit == '0' && self.count.is_empty() {
            return;
        }
        self.count.push(digit);
        cx.stop_propagation();
    }

    // ---- rendering -----------------------------------------------------------------------------

    fn chip(&self, id: impl Into<ElementId>, label: String, active: bool, cx: &App) -> Stateful<Div> {
        let c = cx.theme();
        div()
            .id(id)
            .px_2()
            .py_0p5()
            .rounded_md()
            .text_xs()
            .cursor_pointer()
            .when(active, |d| d.bg(c.accent).text_color(c.accent_foreground))
            .when(!active, |d| d.text_color(c.muted_foreground).hover(|d| d.bg(c.list_hover)))
            .child(label)
    }

    fn filters(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut kinds = vec![self
            .chip("kind-all", "all".into(), self.query.kind.is_none(), cx)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_kind(None, cx)))];
        for (ix, (kind, label)) in KINDS.iter().enumerate() {
            let active = self.query.kind.as_deref() == Some(*kind);
            kinds.push(
                self.chip(("kind", ix), (*label).into(), active, cx)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_kind(Some(kind.to_string()), cx))),
            );
        }
        // Tags show up once this machine has rules (`artifacts tag add`).
        let mut tags = vec![];
        if !self.tags.is_empty() {
            tags.push(
                self.chip("tag-all", "all tags".into(), self.query.tag.is_none(), cx)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_tag(None, cx))),
            );
            for (ix, tag) in self.tags.iter().enumerate() {
                let value = tag.clone();
                tags.push(
                    self.chip(("tag", ix), tag.clone(), self.query.tag.as_ref() == Some(tag), cx)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_tag(Some(value.clone()), cx))),
                );
            }
        }
        v_flex()
            .px_2()
            .pb_2()
            .gap_1()
            .child(h_flex().gap_1().flex_wrap().children(kinds))
            .when(!tags.is_empty(), |d| d.child(h_flex().gap_1().flex_wrap().children(tags)))
    }

    fn rows(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let focused = matches!(self.pane, Pane::List | Pane::Search);
        let active_slug = self.active_slug().to_string();
        let open: Vec<String> = self.tabs.iter().map(|t| t.slug.clone()).collect();
        let cursor_ix = self.cursor_ix();
        let now = Local::now().timestamp();
        let mut rows = vec![];
        let mut day = String::new();
        let mut cursor_row = None;
        for (ix, item) in self.items.iter().enumerate() {
            let this_day = day_label(item.updated_at);
            if this_day != day {
                rows.push(
                    div()
                        .pl(px(34.))
                        .pt_3()
                        .pb_1()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(c.muted_foreground)
                        .child(this_day.clone())
                        .into_any_element(),
                );
                day = this_day;
            }
            let at_cursor = Some(ix) == cursor_ix;
            if at_cursor {
                cursor_row = Some(rows.len());
            }
            // Vim's relative numbers: the cursor's row shows its own number, the rest how far away.
            let number = match cursor_ix {
                Some(c) if c != ix => ix.abs_diff(c),
                _ => ix + 1,
            };
            // A dot for pages open in tabs: bright for the active tab's.
            let dot = if item.slug == active_slug {
                Some(c.ring)
            } else if open.contains(&item.slug) {
                Some(c.muted_foreground)
            } else {
                None
            };
            let mut meta = vec![kind_label(&item.kind).to_string()];
            meta.extend(item.tags.iter().cloned());
            meta.extend(item.ticket.clone());
            meta.push(age(now - item.updated_at));
            let slug = item.slug.clone();
            let hover_slug = item.slug.clone();
            rows.push(
                h_flex()
                    .id(("row", ix))
                    .mx_1()
                    .pr_2()
                    .py_1p5()
                    .rounded_md()
                    .cursor_pointer()
                    .when(at_cursor && focused, |d| d.bg(c.list_active))
                    .when(at_cursor && !focused, |d| d.bg(c.muted))
                    .when(!at_cursor, |d| d.hover(|d| d.bg(c.list_hover)))
                    .child(
                        div()
                            .w(px(26.))
                            .flex_none()
                            .self_start()
                            .pr_2()
                            .text_right()
                            .text_xs()
                            .text_color(if at_cursor { c.foreground } else { c.muted_foreground })
                            .child(number.to_string()),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(
                                h_flex()
                                    .gap_1p5()
                                    .child(div().flex_1().min_w_0().text_sm().truncate().child(item.title.clone()))
                                    .when_some(dot, |d, color| d.child(div().flex_none().size(px(6.)).rounded_full().bg(color))),
                            )
                            .child(div().text_xs().text_color(c.muted_foreground).truncate().child(meta.join(" · "))),
                    )
                    .on_hover(cx.listener(move |this, hovered: &bool, _, _| {
                        if *hovered {
                            this.hovered = Some(hover_slug.clone());
                        } else if this.hovered.as_ref() == Some(&hover_slug) {
                            this.hovered = None;
                        }
                    }))
                    // A click opens the page: in a new tab with ⌘, or while choosing for ⌘T (which
                    // reads the page); otherwise in the active tab, keeping the keyboard in the list.
                    .on_click(cx.listener(move |this, e: &ClickEvent, window, cx| {
                        this.cursor = slug.clone();
                        if this.new_tab {
                            return this.open_cursor(window, cx);
                        }
                        if e.modifiers().platform {
                            this.open_tab(slug.clone(), window, cx);
                        } else {
                            this.select(slug.clone(), cx);
                        }
                        this.focus_pane(Pane::List, window, cx);
                    }))
                    .into_any_element(),
            );
        }
        if std::mem::take(&mut self.scroll_to_cursor) {
            if let Some(row) = cursor_row {
                self.scroll.scroll_to_item(row);
            }
        }
        rows
    }

    fn tab_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        let page_focused = self.pane == Pane::Page;
        let mut tabs: Vec<AnyElement> = vec![];
        for (ix, tab) in self.tabs.iter().enumerate() {
            let active = ix == self.active;
            let id = tab.id;
            let group = SharedString::from(format!("tab-{id}"));
            let item = self.page_item(&tab.slug);
            let title = match item {
                Some(item) => item.title.clone(),
                None if tab.slug.is_empty() => "New tab".to_string(),
                None => tab.slug.clone(),
            };
            let dot = item.map_or(c.muted_foreground, |i| kind_color(&i.kind, &c));
            tabs.push(
                h_flex()
                    .id(("tab", id as usize))
                    .group(group.clone())
                    .flex_none()
                    .w(px(200.))
                    .h(px(28.))
                    .pl_2()
                    .pr_1()
                    .gap_1p5()
                    .rounded_md()
                    .border_1()
                    .text_sm()
                    .cursor_pointer()
                    .when(active, |d| {
                        d.bg(c.background).text_color(c.foreground).border_color(if page_focused { c.ring } else { c.border })
                    })
                    .when(!active, |d| {
                        d.text_color(c.muted_foreground).border_color(transparent_black()).hover(|d| d.bg(c.list_hover))
                    })
                    .child(div().flex_none().size(px(6.)).rounded_full().bg(dot))
                    .child(div().flex_1().min_w_0().truncate().child(title))
                    .child(
                        div()
                            .id(("close", id as usize))
                            .flex_none()
                            .size(px(18.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_sm()
                            .text_xs()
                            .text_color(c.muted_foreground)
                            .hover(|d| d.bg(c.list_hover).text_color(c.foreground))
                            .when(!active, |d| d.invisible().group_hover(group.clone(), |s| s.visible()))
                            .child("✕")
                            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                                cx.stop_propagation();
                                if let Some(ix) = this.tab_ix(id) {
                                    this.close_tab(ix, window, cx);
                                }
                            })),
                    )
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        if let Some(ix) = this.tab_ix(id) {
                            this.activate(ix, window, cx);
                        }
                    }))
                    .on_mouse_down(
                        MouseButton::Middle,
                        cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                            if let Some(ix) = this.tab_ix(id) {
                                this.close_tab(ix, window, cx);
                            }
                        }),
                    )
                    .into_any_element(),
            );
        }
        // Where the ⌘T tab will go while its page is being chosen.
        if self.new_tab {
            tabs.push(
                h_flex()
                    .flex_none()
                    .w(px(140.))
                    .h(px(28.))
                    .px_2()
                    .rounded_md()
                    .border_1()
                    .border_dashed()
                    .border_color(c.primary)
                    .text_sm()
                    .italic()
                    .text_color(c.primary)
                    .child("New tab")
                    .into_any_element(),
            );
        }
        if std::mem::take(&mut self.scroll_to_tab) {
            self.tab_scroll.scroll_to_item(if self.new_tab { self.tabs.len() } else { self.active });
        }
        h_flex()
            .id("tabs")
            .flex_none()
            .h(px(38.))
            .px_1()
            .gap_1()
            .items_center()
            .overflow_x_scroll()
            .track_scroll(&self.tab_scroll)
            .children(tabs)
            .child(
                div()
                    .id("new-tab")
                    .flex_none()
                    .size(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .text_color(c.muted_foreground)
                    .cursor_pointer()
                    .hover(|d| d.bg(c.list_hover).text_color(c.foreground))
                    .child("+")
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.new_tab(&NewTab, window, cx))),
            )
    }
}

/// A tab's page view: link clicks inside the server stay in the tab and the list follows them,
/// links that ask for a new window open a new tab, the index hands the keyboard back to the list,
/// and anything else (GitHub, Linear, zed://) opens in its own app.
fn build_webview(tab: u64, url: &str, tx: Sender<FromPage>, window: &mut Window, cx: &mut App) -> wry::Result<WebView> {
    let ipc = tx.clone();
    let popups = tx.clone();
    let builder = wry::WebViewBuilder::new()
        .with_url(url)
        .with_initialization_script(PAGE_BRIDGE)
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            let msg = match req.body().as_str() {
                "focus" => PageMsg::Focused,
                "sidebar" => PageMsg::ToList,
                "next" => PageMsg::Next,
                "prev" => PageMsg::Prev,
                "nextTab" => PageMsg::NextTab,
                "prevTab" => PageMsg::PrevTab,
                "closeTab" => PageMsg::CloseTab,
                "reopenTab" => PageMsg::ReopenTab,
                "duplicateTab" => PageMsg::DuplicateTab,
                "lastTab" => PageMsg::LastUsedTab,
                "moveTabLeft" => PageMsg::MoveTabLeft,
                "moveTabRight" => PageMsg::MoveTabRight,
                _ => return,
            };
            let _ = ipc.try_send(FromPage { tab, msg });
        })
        .with_navigation_handler(move |url| {
            if ["about:", "data:", "blob:"].iter().any(|p| url.starts_with(p)) {
                return true;
            }
            let (msg, allow) = match api::local_path(&url) {
                None => (PageMsg::OpenOutside(url), false),
                Some(path) => match page_slug(&path) {
                    Some(slug) => (PageMsg::Navigated(slug), true),
                    None => (PageMsg::ToList, false),
                },
            };
            let _ = tx.try_send(FromPage { tab, msg });
            allow
        })
        .with_new_window_req_handler(move |url, _| {
            let msg = match api::local_path(&url).and_then(|path| page_slug(&path)) {
                Some(slug) => PageMsg::OpenTab(slug),
                None => PageMsg::OpenOutside(url),
            };
            let _ = popups.try_send(FromPage { tab, msg });
            wry::NewWindowResponse::Deny
        });
    WebView::build(builder, window, cx)
}

/// `/a/<slug>/…` → `<slug>`.
fn page_slug(path: &str) -> Option<String> {
    let slug = path.strip_prefix("/a/")?.split(['/', '?', '#']).next()?;
    (!slug.is_empty()).then(|| slug.to_string())
}

impl Render for ArtifactsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = match self.page_item(self.active_slug()) {
            Some(item) => item.title.clone(),
            None => "artifacts".to_string(),
        };
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }

        let c = cx.theme().colors.clone();
        let ring = |active: bool| if active { c.ring } else { transparent_black() };
        let rows = self.rows(cx);
        let empty = rows.is_empty() && self.error.is_none();
        let choosing = self.new_tab;
        let list = div()
            .id("list")
            .key_context(LIST)
            .track_focus(&self.list_focus)
            .size_full()
            .rounded_md()
            .border_2()
            .border_color(if choosing { c.primary } else { ring(self.pane == Pane::List) })
            .pb_1()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .on_key_down(cx.listener(Self::count_key))
            .when(empty, |d| {
                d.child(div().p_3().text_sm().text_color(c.muted_foreground).child("Nothing here. `artifacts add notes.md` from any checkout."))
            })
            .children(rows);
        let sidebar = v_flex()
            .w(px(self.sidebar_width))
            .h_full()
            .flex_none()
            .bg(c.sidebar)
            .text_color(c.sidebar_foreground)
            .on_action(cx.listener(Self::select_next))
            .on_action(cx.listener(Self::select_prev))
            .on_action(cx.listener(Self::select_first))
            .on_action(cx.listener(Self::select_last))
            .on_action(cx.listener(Self::prev_tag))
            .on_action(cx.listener(Self::next_tag))
            .on_action(cx.listener(Self::open_cursor_action))
            .on_action(cx.listener(Self::list_escape))
            .on_action(cx.listener(Self::search_escape))
            // Clicking anywhere in the sidebar takes the keyboard back from the page.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    if this.pane == Pane::Page {
                        this.focus_pane(Pane::List, window, cx);
                    }
                }),
            )
            .child(div().p_2().key_context(SEARCH).child(Input::new(&self.search).cleanable(true).when(choosing, |i| {
                // While choosing for ⌘T, the search box says what Enter will do.
                i.prefix(
                    div()
                        .px_1p5()
                        .rounded_sm()
                        .bg(c.primary)
                        .text_color(c.primary_foreground)
                        .text_xs()
                        .font_weight(FontWeight::BOLD)
                        .child("NEW TAB"),
                )
            })))
            .child(self.filters(cx))
            .when_some(self.error.clone(), |d, error| {
                d.child(div().mx_2().mb_2().p_2().rounded_md().text_xs().bg(c.danger.opacity(0.12)).text_color(c.danger).child(error))
            })
            .child(div().flex_1().min_h_0().mx_1().mb_1().child(list));

        // Drag to resize; the handle doubles as the sidebar's border.
        let handle = div()
            .id("sidebar-resize")
            .w(px(5.))
            .h_full()
            .flex_none()
            .border_l_1()
            .border_color(c.sidebar_border)
            .cursor(CursorStyle::ResizeLeftRight)
            .hover(|d| d.bg(c.ring.opacity(0.4)))
            .on_drag(SidebarResize, |_, _, _, cx| cx.new(|_| DragPreview));

        // The ring sits outside the webview's bounds: the native view covers anything inside them.
        let page_ring = ring(self.pane == Pane::Page);
        let tab_bar = self.tab_bar(cx);
        let page = v_flex().flex_1().h_full().min_w_0().child(tab_bar).child(
            div().flex_1().min_h_0().px_1().pb_1().child(
                div().size_full().border_2().border_color(page_ring).map(|d| match self.active_webview() {
                    Some(webview) => d.child(webview.clone()),
                    None => d.p_4().text_color(c.muted_foreground).child(self.error.clone().unwrap_or_default()),
                }),
            ),
        );

        h_flex()
            .size_full()
            .bg(c.background)
            .text_color(c.foreground)
            .on_drag_move(cx.listener(Self::resize_sidebar))
            .on_action(cx.listener(Self::search_pages))
            .on_action(cx.listener(Self::find_in_page))
            .on_action(cx.listener(Self::focus_list))
            .on_action(cx.listener(Self::new_tab))
            .on_action(cx.listener(Self::cancel_new_tab))
            .on_action(cx.listener(Self::open_in_new_tab))
            .on_action(cx.listener(Self::duplicate_tab))
            .on_action(cx.listener(Self::close_active_tab))
            .on_action(cx.listener(Self::close_other_tabs))
            .on_action(cx.listener(Self::reopen_closed_tab))
            .on_action(cx.listener(Self::next_tab))
            .on_action(cx.listener(Self::prev_tab))
            .on_action(cx.listener(Self::last_used))
            .on_action(cx.listener(Self::move_left))
            .on_action(cx.listener(Self::move_right))
            .on_action(cx.listener(|this, _: &GoToTab1, w, cx| this.activate(0, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab2, w, cx| this.activate(1, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab3, w, cx| this.activate(2, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab4, w, cx| this.activate(3, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab5, w, cx| this.activate(4, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab6, w, cx| this.activate(5, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab7, w, cx| this.activate(6, w, cx)))
            .on_action(cx.listener(|this, _: &GoToTab8, w, cx| this.activate(7, w, cx)))
            .on_action(cx.listener(Self::go_to_last_tab))
            .on_action(cx.listener(Self::reload))
            .on_action(cx.listener(Self::open_in_browser))
            .on_action(cx.listener(Self::back))
            .on_action(cx.listener(Self::forward))
            .on_action(cx.listener(Self::zoom_in))
            .on_action(cx.listener(Self::zoom_out))
            .on_action(cx.listener(Self::zoom_reset))
            .child(sidebar)
            .child(handle)
            .child(page)
    }
}

fn kind_label(kind: &str) -> &str {
    KINDS.iter().find(|(k, _)| *k == kind).map_or(kind, |(_, l)| l)
}

fn kind_color(kind: &str, c: &ThemeColor) -> Hsla {
    match kind {
        "code-path" => c.info,
        "md" => c.success,
        "html" => c.warning,
        _ => c.muted_foreground,
    }
}

/// "Today", "Yesterday", a weekday within the week, else the date.
fn day_label(ts: i64) -> String {
    let Some(t) = Local.timestamp_opt(ts, 0).single() else {
        return String::new();
    };
    match (Local::now().date_naive() - t.date_naive()).num_days() {
        0 => "Today".into(),
        1 => "Yesterday".into(),
        n if n < 7 => t.format("%A").to_string(),
        _ => t.format("%b %-d, %Y").to_string(),
    }
}

fn age(secs: i64) -> String {
    match secs.max(0) {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}
