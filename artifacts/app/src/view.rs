//! The window: the page list (search, kind and slot filters, grouped by day) beside tabs of
//! pages, each tab its own WebKit view. The list follows the server live through its event stream,
//! and tracks the active tab: moving through the list moves that tab.
//!
//! The keyboard is always in one of three places, and a ring shows which: the list, its search
//! box, or the page. The page runs the server's own vim keys (`keys.js`); in here they talk back
//! over IPC, so `h`/Esc return to the list, `[` `]` move its selection and `H` `L` switch tabs.

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
        FocusPage,
        SelectNext,
        SelectPrev,
        SelectFirst,
        SelectLast,
        NewTab,
        CancelNewTab,
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

/// Runs in every page before its own scripts: `keys.js` finds `artifactsApp` and routes its
/// list and tab keys here, and focus events tell the app when the page takes the keyboard.
const PAGE_BRIDGE: &str = r#"
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
        // The list.
        KeyBinding::new("j", SelectNext, Some(LIST)),
        KeyBinding::new("down", SelectNext, Some(LIST)),
        KeyBinding::new("k", SelectPrev, Some(LIST)),
        KeyBinding::new("up", SelectPrev, Some(LIST)),
        KeyBinding::new("g g", SelectFirst, Some(LIST)),
        KeyBinding::new("shift-g", SelectLast, Some(LIST)),
        KeyBinding::new("l", FocusPage, Some(LIST)),
        KeyBinding::new("right", FocusPage, Some(LIST)),
        KeyBinding::new("enter", FocusPage, Some(LIST)),
        KeyBinding::new("tab", FocusPage, Some(LIST)),
        KeyBinding::new("/", SearchPages, Some(LIST)),
        KeyBinding::new("escape", CancelNewTab, Some(LIST)),
        KeyBinding::new("o", OpenInBrowser, Some(LIST)),
        KeyBinding::new("r", Reload, Some(LIST)),
        KeyBinding::new("shift-h", PrevTab, Some(LIST)),
        KeyBinding::new("shift-l", NextTab, Some(LIST)),
        KeyBinding::new("t", DuplicateTab, Some(LIST)),
        KeyBinding::new("x", CloseTab, Some(LIST)),
        KeyBinding::new("shift-x", ReopenClosedTab, Some(LIST)),
        KeyBinding::new("^", LastUsedTab, Some(LIST)),
        KeyBinding::new("shift-6", LastUsedTab, Some(LIST)),
        KeyBinding::new("<", MoveTabLeft, Some(LIST)),
        KeyBinding::new("shift-,", MoveTabLeft, Some(LIST)),
        KeyBinding::new(">", MoveTabRight, Some(LIST)),
        KeyBinding::new("shift-.", MoveTabRight, Some(LIST)),
        // The search box: move through the results while typing, Esc back to them (or, choosing a
        // new tab, back to where you were).
        KeyBinding::new("ctrl-j", SelectNext, Some(SEARCH_INPUT)),
        KeyBinding::new("ctrl-k", SelectPrev, Some(SEARCH_INPUT)),
        KeyBinding::new("escape", FocusList, Some(SEARCH_INPUT)),
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
    /// While choosing a page for a new tab (⌘T, from the search box): the list's cursor, which
    /// moves without touching the open tab. Enter opens it in a new tab; Esc, or going to the
    /// page, cancels.
    new_tab: Option<String>,
    /// Where the keyboard was when ⌘T started choosing, for Esc to put it back.
    before_new_tab: Pane,
    next_id: u64,
    tx: Sender<FromPage>,
    zoom: f64,
    pane: Pane,
    query: Query,
    items: Vec<Item>,
    all: Vec<Item>,
    slots: Vec<i64>,
    /// The next fetch came from a new query: if the active page isn't among its results, show
    /// the first one (a live refresh mustn't move the page you're reading).
    pick: bool,
    error: Option<String>,
    scroll_to_selected: bool,
    scroll_to_tab: bool,
    title: String,
    fetch: Task<()>,
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
                InputEvent::PressEnter { .. } if this.new_tab.is_some() => this.commit_new_tab(window, cx),
                InputEvent::PressEnter { .. } => this.focus_pane(Pane::List, window, cx),
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
            new_tab: None,
            before_new_tab: Pane::List,
            next_id: 0,
            tx,
            zoom: saved.zoom.unwrap_or(1.0),
            pane: Pane::List,
            query: Query::default(),
            items: vec![],
            all: vec![],
            slots: vec![],
            pick: false,
            error: None,
            scroll_to_selected: false,
            scroll_to_tab: false,
            title: String::new(),
            fetch: Task::ready(()),
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
            Ok(Fetched { items, all }) => {
                let mut slots: Vec<i64> = all.iter().filter_map(|i| i.slot).collect();
                slots.sort_unstable();
                slots.dedup();
                self.items = items;
                self.all = all;
                self.slots = slots;
                self.error = None;
                let pick = std::mem::take(&mut self.pick);
                let current = self.cursor().to_string();
                let listed = self.items.iter().any(|i| i.slug == current);
                if current.is_empty() || (pick && !listed) {
                    if let Some(first) = self.items.first() {
                        self.go_to(first.slug.clone(), cx);
                    }
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

    /// Show `slug` in the active tab: the list's selection is always the active tab's page.
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
        self.scroll_to_selected = true;
        self.save();
        cx.notify();
    }

    fn step(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.items.is_empty() {
            return;
        }
        let last = self.items.len() - 1;
        let current = self.cursor();
        let ix = match self.items.iter().position(|i| i.slug == current) {
            Some(ix) => ix.saturating_add_signed(delta).min(last),
            None => 0,
        };
        self.go_to(self.items[ix].slug.clone(), cx);
    }

    /// Where the list's highlight is: the new-tab cursor while choosing, else the active tab.
    fn cursor(&self) -> &str {
        self.new_tab.as_deref().unwrap_or_else(|| self.active_slug())
    }

    /// Move the list's highlight: the new-tab cursor while choosing, else the active tab's page.
    fn go_to(&mut self, slug: String, cx: &mut Context<Self>) {
        match &mut self.new_tab {
            Some(cursor) => {
                *cursor = slug;
                self.scroll_to_selected = true;
                cx.notify();
            }
            None => self.select(slug, cx),
        }
    }

    /// Open the new-tab cursor's page in a new tab, and read it. That search is done, so the box
    /// clears.
    fn commit_new_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(slug) = self.new_tab.take() {
            self.open_tab(slug, window, cx);
            self.focus_pane(Pane::Page, window, cx);
            if !self.query.q.is_empty() {
                // `set_value` doesn't emit a change, so refetch here, without picking: the new
                // tab keeps its page even when the unfiltered list doesn't reach it.
                self.search.update(cx, |s, cx| s.set_value("", window, cx));
                self.query.q.clear();
                self.refresh(false, cx);
            }
        }
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
    /// otherwise sit on top of each other), and the keyboard stays in the pane it was in.
    fn activate(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.tabs.len() {
            return;
        }
        self.new_tab = None;
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
        self.scroll_to_selected = true;
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
            // A link inside a page: that tab follows it, and so does the list if it's in front.
            PageMsg::Navigated(slug) => {
                if let Some(ix) = self.tab_ix(tab) {
                    self.tabs[ix].slug = slug;
                }
                self.scroll_to_selected |= from_active;
                self.save();
                cx.notify();
            }
            PageMsg::OpenTab(slug) => self.open_tab(slug, window, cx),
            // Keys from a page in the background don't count.
            _ if !from_active => {}
            PageMsg::Focused => {
                self.new_tab = None;
                self.pane = Pane::Page;
                cx.notify();
            }
            PageMsg::ToList => self.focus_pane(Pane::List, window, cx),
            PageMsg::Next => self.step(1, cx),
            PageMsg::Prev => self.step(-1, cx),
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
        if pane == Pane::Page {
            self.new_tab = None;
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

    fn select_first(&mut self, _: &SelectFirst, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.items.first() {
            self.go_to(item.slug.clone(), cx);
        }
    }

    fn select_last(&mut self, _: &SelectLast, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.items.last() {
            self.go_to(item.slug.clone(), cx);
        }
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
        if self.new_tab.is_some() {
            return self.cancel_new_tab(&CancelNewTab, window, cx);
        }
        self.focus_pane(Pane::List, window, cx);
    }

    fn focus_page(&mut self, _: &FocusPage, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab.is_some() {
            return self.commit_new_tab(window, cx);
        }
        self.focus_pane(Pane::Page, window, cx);
    }

    /// Start choosing a page for a new tab: the search box takes the keyboard with its text
    /// selected, so typing starts a new search, and the list's cursor starts on the open page.
    /// Pressed again, it cancels.
    fn new_tab(&mut self, _: &NewTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab.is_some() {
            return self.cancel_new_tab(&CancelNewTab, window, cx);
        }
        self.before_new_tab = self.pane;
        self.new_tab = Some(self.active_slug().to_string());
        self.scroll_to_selected = true;
        self.scroll_to_tab = true;
        self.focus_pane(Pane::Search, window, cx);
        self.search.update(cx, |s, cx| s.select_all(window, cx));
    }

    /// Stop choosing, and put the keyboard back where it was before ⌘T.
    fn cancel_new_tab(&mut self, _: &CancelNewTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab.take().is_some() {
            self.scroll_to_selected = true;
            self.focus_pane(self.before_new_tab, window, cx);
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

    fn set_slot(&mut self, slot: Option<i64>, cx: &mut Context<Self>) {
        self.query.slot = slot;
        self.refresh(true, cx);
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
        let mut slots = vec![];
        if !self.slots.is_empty() {
            slots.push(
                self.chip("slot-all", "all slots".into(), self.query.slot.is_none(), cx)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_slot(None, cx))),
            );
            for &slot in &self.slots {
                slots.push(
                    self.chip(("slot", slot as usize), format!("s{slot}"), self.query.slot == Some(slot), cx)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.set_slot(Some(slot), cx))),
                );
            }
        }
        v_flex()
            .px_2()
            .pb_2()
            .gap_1()
            .child(h_flex().gap_1().flex_wrap().children(kinds))
            .when(!slots.is_empty(), |d| d.child(h_flex().gap_1().flex_wrap().children(slots)))
    }

    fn rows(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let choosing = self.new_tab.is_some();
        // Choosing a new tab from the search box, the row Enter will open stays lit.
        let focused = self.pane == Pane::List || choosing;
        let mark = if choosing { c.primary } else { c.ring };
        let current = self.cursor().to_string();
        let open: Vec<String> = self.tabs.iter().map(|t| t.slug.clone()).collect();
        let now = Local::now().timestamp();
        let mut rows = vec![];
        let mut day = String::new();
        let mut selected_row = None;
        for (ix, item) in self.items.iter().enumerate() {
            let this_day = day_label(item.updated_at);
            if this_day != day {
                rows.push(
                    div()
                        .px_3()
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
            let selected = item.slug == current;
            if selected {
                selected_row = Some(rows.len());
            }
            // A page open in a tab (other than the highlighted one) gets a dot.
            let in_tab = !selected && open.contains(&item.slug);
            let mut meta = vec![kind_label(&item.kind).to_string()];
            meta.extend(item.slot.map(|s| format!("s{s}")));
            meta.extend(item.ticket.clone());
            meta.push(age(now - item.updated_at));
            let slug = item.slug.clone();
            rows.push(
                v_flex()
                    .id(("row", ix))
                    .mx_1()
                    .px_2()
                    .py_1p5()
                    .rounded_md()
                    .border_l_2()
                    .cursor_pointer()
                    // The selection is bright while the list has the keyboard, and dim otherwise.
                    .when(selected && focused, |d| d.bg(c.list_active).border_color(mark))
                    .when(selected && !focused, |d| d.bg(c.muted).border_color(transparent_black()))
                    .when(!selected, |d| d.border_color(transparent_black()).hover(|d| d.bg(c.list_hover)))
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(div().flex_1().min_w_0().text_sm().truncate().child(item.title.clone()))
                            .when(in_tab, |d| d.child(div().flex_none().size(px(5.)).rounded_full().bg(c.muted_foreground))),
                    )
                    .child(div().text_xs().text_color(c.muted_foreground).truncate().child(meta.join(" · ")))
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        if this.new_tab.is_some() {
                            this.new_tab = Some(slug.clone());
                            return this.commit_new_tab(window, cx);
                        }
                        this.select(slug.clone(), cx);
                        this.focus_pane(Pane::List, window, cx);
                    }))
                    .into_any_element(),
            );
        }
        if std::mem::take(&mut self.scroll_to_selected) {
            if let Some(row) = selected_row {
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
        let choosing = self.new_tab.is_some();
        if choosing {
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
            self.tab_scroll.scroll_to_item(if choosing { self.tabs.len() } else { self.active });
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
/// and anything else (GitHub, Linear, zed://) opens outside.
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
            let Some(path) = api::local_path(&url) else {
                open_outside(&url);
                return false;
            };
            let msg = match page_slug(&path) {
                Some(slug) => PageMsg::Navigated(slug),
                None => PageMsg::ToList,
            };
            let allow = matches!(msg, PageMsg::Navigated(_));
            let _ = tx.try_send(FromPage { tab, msg });
            allow
        })
        .with_new_window_req_handler(move |url, _| {
            match api::local_path(&url).and_then(|path| page_slug(&path)) {
                Some(slug) => {
                    let _ = popups.try_send(FromPage { tab, msg: PageMsg::OpenTab(slug) });
                }
                None => open_outside(&url),
            }
            wry::NewWindowResponse::Deny
        });
    WebView::build(builder, window, cx)
}

/// `/a/<slug>/…` → `<slug>`.
fn page_slug(path: &str) -> Option<String> {
    let slug = path.strip_prefix("/a/")?.split(['/', '?', '#']).next()?;
    (!slug.is_empty()).then(|| slug.to_string())
}

fn open_outside(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
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
        let choosing = self.new_tab.is_some();
        let sidebar = v_flex()
            .w(px(340.))
            .h_full()
            .flex_none()
            .bg(c.sidebar)
            .text_color(c.sidebar_foreground)
            .border_r_1()
            .border_color(c.sidebar_border)
            .on_action(cx.listener(Self::select_next))
            .on_action(cx.listener(Self::select_prev))
            .on_action(cx.listener(Self::select_first))
            .on_action(cx.listener(Self::select_last))
            // Clicking anywhere in the sidebar takes the keyboard back from the page.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    if this.pane == Pane::Page {
                        this.focus_pane(Pane::List, window, cx);
                    }
                }),
            )
            // Choosing a new tab, the search box says what Enter will do.
            .child(div().p_2().key_context(SEARCH).child(Input::new(&self.search).cleanable(true).when(choosing, |i| {
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
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .mx_1()
                    .mb_1()
                    .rounded_md()
                    .border_2()
                    .border_color(if choosing { c.primary } else { ring(self.pane == Pane::List) })
                    .child(
                        div()
                            .id("list")
                            .key_context(LIST)
                            .track_focus(&self.list_focus)
                            .size_full()
                            .pb_1()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .when(empty, |d| {
                                d.child(div().p_3().text_sm().text_color(c.muted_foreground).child("Nothing here. `artifacts add notes.md` from any checkout."))
                            })
                            .children(rows),
                    ),
            );

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
            .on_action(cx.listener(Self::search_pages))
            .on_action(cx.listener(Self::find_in_page))
            .on_action(cx.listener(Self::focus_list))
            .on_action(cx.listener(Self::focus_page))
            .on_action(cx.listener(Self::new_tab))
            .on_action(cx.listener(Self::cancel_new_tab))
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
