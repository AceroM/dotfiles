//! The window: the page list (search, kind and slot filters, grouped by day) beside a webview
//! showing the selected page. The list follows the server live through its event stream.
//!
//! The keyboard is always in one of three places, and a ring shows which: the list, its search
//! box, or the page. The page runs the server's own vim keys (`keys.js`); in here they talk back
//! over IPC, so `h`/Esc return to the list and `[` `]` move its selection.

use crate::api::{self, Item, Query};
use async_channel::{Receiver, Sender};
use chrono::{Local, TimeZone};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::theme::Theme;
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
/// list keys here, and focus events tell the app when the page takes the keyboard.
const PAGE_BRIDGE: &str = r#"
window.artifactsApp = { post: (m) => window.ipc.postMessage(m) };
window.addEventListener('focus', () => window.ipc.postMessage('focus'));
"#;

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        // Global: these are menu shortcuts too, so they work while the page has the keyboard.
        KeyBinding::new("cmd-f", FindInPage, None),
        KeyBinding::new("cmd-1", FocusList, None),
        KeyBinding::new("cmd-2", FocusPage, None),
        KeyBinding::new("cmd-r", Reload, None),
        KeyBinding::new("cmd-o", OpenInBrowser, None),
        KeyBinding::new("cmd-[", Back, None),
        KeyBinding::new("cmd-]", Forward, None),
        KeyBinding::new("cmd-=", ZoomIn, None),
        KeyBinding::new("cmd-+", ZoomIn, None),
        KeyBinding::new("cmd--", ZoomOut, None),
        KeyBinding::new("cmd-0", ZoomReset, None),
        KeyBinding::new("cmd-w", HideWindow, None),
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
        KeyBinding::new("o", OpenInBrowser, Some(LIST)),
        KeyBinding::new("r", Reload, Some(LIST)),
        // The search box: move through the results while typing, Esc back to them.
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

/// What the page tells the app, from `PAGE_BRIDGE` and the navigation handler.
enum PageMsg {
    Focused,
    ToList,
    Next,
    Prev,
    Navigated(String),
}

pub struct ArtifactsView {
    search: Entity<InputState>,
    list_focus: FocusHandle,
    scroll: ScrollHandle,
    webview: Option<Entity<WebView>>,
    pane: Pane,
    query: Query,
    items: Vec<Item>,
    slots: Vec<i64>,
    selected: Option<String>,
    /// The slug the webview was last pointed at, so reselecting it doesn't reload the page.
    loaded: Option<String>,
    error: Option<String>,
    scroll_to_selected: bool,
    title: String,
    fetch: Task<()>,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl ArtifactsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search pages"));
        let list_focus = cx.focus_handle();
        let (tx, rx) = async_channel::unbounded();
        let mut error = None;
        let webview = match build_webview(tx, window, cx) {
            Ok(webview) => Some(cx.new(|_| webview)),
            Err(e) => {
                error = Some(format!("couldn't create the webview: {e}"));
                None
            }
        };
        let subscriptions = vec![
            cx.subscribe_in(&search, window, |this, state, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    this.query.q = state.read(cx).value().to_string();
                    this.refresh(cx);
                }
                InputEvent::PressEnter { .. } => this.focus_pane(Pane::List, window, cx),
                InputEvent::Focus => {
                    this.pane = Pane::Search;
                    cx.notify();
                }
                _ => {}
            }),
            cx.observe_window_appearance(window, |_, window, cx| Theme::sync_system_appearance(Some(window), cx)),
        ];

        let mut this = Self {
            search,
            list_focus,
            scroll: ScrollHandle::new(),
            webview,
            pane: Pane::List,
            query: Query::default(),
            items: vec![],
            slots: vec![],
            selected: None,
            loaded: None,
            error,
            scroll_to_selected: false,
            title: String::new(),
            fetch: Task::ready(()),
            _tasks: vec![],
            _subscriptions: subscriptions,
        };
        this._tasks = vec![this.watch(cx), this.listen(rx, window, cx)];
        this.focus_pane(Pane::List, window, cx);
        this.refresh(cx);
        this
    }

    /// Refetch the list for the current query. Replacing `fetch` drops (cancels) one in flight.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let query = self.query.clone();
        let task = cx.background_executor().spawn(async move { api::fetch(&query) });
        self.fetch = cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| this.apply(result, cx)).ok();
        });
    }

    fn apply(&mut self, result: Result<(Vec<Item>, Vec<i64>), String>, cx: &mut Context<Self>) {
        match result {
            Ok((items, slots)) => {
                self.items = items;
                self.slots = slots;
                self.error = None;
                let keep = self.selected.clone().filter(|s| self.items.iter().any(|i| &i.slug == s));
                match keep.or_else(|| self.items.first().map(|i| i.slug.clone())) {
                    Some(slug) => self.select(slug, cx),
                    None => self.selected = None,
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
            if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
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
                if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    return;
                }
            }
            if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                return;
            }
        })
    }

    /// Handle what the page sends: focus changes, list keys and its own navigations.
    fn listen(&self, rx: Receiver<PageMsg>, window: &mut Window, cx: &mut Context<Self>) -> Task<()> {
        cx.spawn_in(window, async move |this, cx| {
            while let Ok(msg) = rx.recv().await {
                let handled = this.update_in(cx, |this, window, cx| match msg {
                    PageMsg::Focused => {
                        this.pane = Pane::Page;
                        cx.notify();
                    }
                    PageMsg::ToList => this.focus_pane(Pane::List, window, cx),
                    PageMsg::Next => this.step(1, cx),
                    PageMsg::Prev => this.step(-1, cx),
                    PageMsg::Navigated(slug) => {
                        // A link inside the page: follow it in the list without reloading.
                        this.loaded = Some(slug.clone());
                        if this.selected.as_ref() != Some(&slug) {
                            this.selected = Some(slug);
                            this.scroll_to_selected = true;
                            cx.notify();
                        }
                    }
                });
                if handled.is_err() {
                    return;
                }
            }
        })
    }

    /// Move the keyboard, natively too: WebKit holds it while the page is focused.
    fn focus_pane(&mut self, pane: Pane, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
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

    fn select(&mut self, slug: String, cx: &mut Context<Self>) {
        if self.loaded.as_ref() != Some(&slug) {
            if let Some(webview) = &self.webview {
                webview.update(cx, |w, _| w.load_url(&api::page_url(&slug)));
            }
            self.loaded = Some(slug.clone());
        }
        self.selected = Some(slug);
        self.scroll_to_selected = true;
        cx.notify();
    }

    fn step(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.items.is_empty() {
            return;
        }
        let last = self.items.len() - 1;
        let ix = match self.selected.as_ref().and_then(|s| self.items.iter().position(|i| &i.slug == s)) {
            Some(ix) => ix.saturating_add_signed(delta).min(last),
            None => 0,
        };
        self.select(self.items[ix].slug.clone(), cx);
    }

    fn select_next(&mut self, _: &SelectNext, _: &mut Window, cx: &mut Context<Self>) {
        self.step(1, cx);
    }

    fn select_prev(&mut self, _: &SelectPrev, _: &mut Window, cx: &mut Context<Self>) {
        self.step(-1, cx);
    }

    fn select_first(&mut self, _: &SelectFirst, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.items.first() {
            self.select(item.slug.clone(), cx);
        }
    }

    fn select_last(&mut self, _: &SelectLast, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.items.last() {
            self.select(item.slug.clone(), cx);
        }
    }

    fn search_pages(&mut self, _: &SearchPages, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_pane(Pane::Search, window, cx);
    }

    fn find_in_page(&mut self, _: &FindInPage, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_pane(Pane::Page, window, cx);
        if let Some(webview) = &self.webview {
            let _ = webview.read(cx).raw().evaluate_script("window.artifactsApp?.find?.()");
        }
    }

    fn focus_list(&mut self, _: &FocusList, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_pane(Pane::List, window, cx);
    }

    fn focus_page(&mut self, _: &FocusPage, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_pane(Pane::Page, window, cx);
    }

    fn reload(&mut self, _: &Reload, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            let _ = webview.read(cx).raw().reload();
        }
        self.refresh(cx);
    }

    fn open_in_browser(&mut self, _: &OpenInBrowser, _: &mut Window, cx: &mut Context<Self>) {
        let url = self.webview.as_ref().and_then(|w| w.read(cx).raw().url().ok());
        let url = url.or_else(|| self.selected.as_deref().map(api::page_url));
        if let Some(url) = url {
            cx.open_url(&url);
        }
    }

    fn back(&mut self, _: &Back, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            webview.update(cx, |w, _| w.back()).ok();
        }
    }

    fn forward(&mut self, _: &Forward, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            webview.update(cx, |w, _| w.forward()).ok();
        }
    }

    /// Page zoom, in browser-like steps. WebKit keeps it across navigations.
    fn zoom(&mut self, factor: Option<f64>, cx: &mut Context<Self>) {
        if let Some(webview) = &self.webview {
            let webview = webview.read(cx);
            let zoom = factor.map_or(1.0, |f| (webview.zoom() * f).clamp(0.3, 3.0));
            let _ = webview.set_zoom(zoom);
        }
        cx.notify();
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
        self.refresh(cx);
    }

    fn set_slot(&mut self, slot: Option<i64>, cx: &mut Context<Self>) {
        self.query.slot = slot;
        self.refresh(cx);
    }

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
        let focused = self.pane == Pane::List;
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
            let selected = self.selected.as_ref() == Some(&item.slug);
            if selected {
                selected_row = Some(rows.len());
            }
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
                    .when(selected && focused, |d| d.bg(c.list_active).border_color(c.ring))
                    .when(selected && !focused, |d| d.bg(c.muted).border_color(transparent_black()))
                    .when(!selected, |d| d.border_color(transparent_black()).hover(|d| d.bg(c.list_hover)))
                    .child(div().text_sm().truncate().child(item.title.clone()))
                    .child(div().text_xs().text_color(c.muted_foreground).truncate().child(meta.join(" · ")))
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
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
}

/// The page view: link clicks inside the server stay here and the list follows them, the index
/// hands the keyboard back to the list, and anything else (GitHub, Linear, zed://) opens outside.
fn build_webview(tx: Sender<PageMsg>, window: &mut Window, cx: &mut App) -> wry::Result<WebView> {
    let ipc = tx.clone();
    let builder = wry::WebViewBuilder::new()
        .with_url("about:blank")
        .with_initialization_script(PAGE_BRIDGE)
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            let msg = match req.body().as_str() {
                "focus" => PageMsg::Focused,
                "sidebar" => PageMsg::ToList,
                "next" => PageMsg::Next,
                "prev" => PageMsg::Prev,
                _ => return,
            };
            let _ = ipc.try_send(msg);
        })
        .with_navigation_handler(move |url| {
            if ["about:", "data:", "blob:"].iter().any(|p| url.starts_with(p)) {
                return true;
            }
            let Some(path) = api::local_path(&url) else {
                open_outside(&url);
                return false;
            };
            match path.strip_prefix("/a/").and_then(|rest| rest.split('/').next()).filter(|s| !s.is_empty()) {
                Some(slug) => {
                    let _ = tx.try_send(PageMsg::Navigated(slug.to_string()));
                    true
                }
                None => {
                    let _ = tx.try_send(PageMsg::ToList);
                    false
                }
            }
        })
        .with_new_window_req_handler(|url, _| {
            open_outside(&url);
            wry::NewWindowResponse::Deny
        });
    WebView::build(builder, window, cx)
}

fn open_outside(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}

impl Render for ArtifactsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self
            .selected
            .as_ref()
            .and_then(|s| self.items.iter().find(|i| &i.slug == s))
            .map_or_else(|| "artifacts".to_string(), |i| i.title.clone());
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }

        let c = cx.theme().colors.clone();
        let ring = |active: bool| if active { c.ring } else { transparent_black() };
        let rows = self.rows(cx);
        let empty = rows.is_empty() && self.error.is_none();
        let search = Input::new(&self.search).cleanable(true);
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
            .child(div().p_2().key_context(SEARCH).child(search))
            .child(self.filters(cx))
            .when_some(self.error.clone(), |d, error| {
                d.child(div().mx_2().mb_2().p_2().rounded_md().text_xs().bg(c.danger.opacity(0.12)).text_color(c.danger).child(error))
            })
            .child(
                div()
                    .id("list")
                    .key_context(LIST)
                    .track_focus(&self.list_focus)
                    .flex_1()
                    .mx_1()
                    .mb_1()
                    .pb_1()
                    .rounded_md()
                    .border_2()
                    .border_color(ring(self.pane == Pane::List))
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .when(empty, |d| {
                        d.child(div().p_3().text_sm().text_color(c.muted_foreground).child("Nothing here. `artifacts add notes.md` from any checkout."))
                    })
                    .children(rows),
            );

        // The ring sits outside the webview's bounds: the native view covers anything inside them.
        let page = div()
            .flex_1()
            .h_full()
            .min_w_0()
            .p_1()
            .child(div().size_full().border_2().border_color(ring(self.pane == Pane::Page)).map(|d| match &self.webview {
                Some(webview) => d.child(webview.clone()),
                None => d.p_4().text_color(c.muted_foreground).child(self.error.clone().unwrap_or_default()),
            }));

        h_flex()
            .size_full()
            .bg(c.background)
            .text_color(c.foreground)
            .on_action(cx.listener(Self::search_pages))
            .on_action(cx.listener(Self::find_in_page))
            .on_action(cx.listener(Self::focus_list))
            .on_action(cx.listener(Self::focus_page))
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
