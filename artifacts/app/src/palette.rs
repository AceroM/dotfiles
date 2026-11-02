//! ⌘K: one box for running any of the app's actions or going to any page. Typing filters both;
//! Enter runs the action or goes to the page (its tab if one shows it), ⌘Enter opens the page in
//! a new tab, and Esc (or clicking away) closes it.
//!
//! It's a window of its own, floating over the main one: WebKit's native view covers anything
//! GPUI draws over the page. So an action runs by being dispatched in the main window, as if its
//! shortcut had been pressed there, and the shortcut each one shows is that binding.

use crate::api::Item;
use crate::view::*;
use gpui_kit::component::command::{Command, CommandGroup, CommandItem, CommandState};
use gpui_kit::component::IndexPath;
use gpui_kit::*;

/// Width and height, in points.
pub const PALETTE_SIZE: (f32, f32) = (640., 440.);

/// The palette's own keys, on top of its Enter, Esc and arrows. Registered after the input's,
/// at the input's depth, so they win over its own (`ctrl-k` deletes to the end of the line there).
pub fn bind_keys(cx: &mut App) {
    use gpui_kit::base::actions::{Confirm, SelectDown, SelectUp};
    const CONTEXT: Option<&str> = Some("Command > Input");
    cx.bind_keys([
        KeyBinding::new("ctrl-j", SelectDown, CONTEXT),
        KeyBinding::new("ctrl-n", SelectDown, CONTEXT),
        KeyBinding::new("ctrl-k", SelectUp, CONTEXT),
        KeyBinding::new("ctrl-p", SelectUp, CONTEXT),
        // `run` reads the ⌘ off the keyboard: Confirm itself doesn't say which.
        KeyBinding::new("cmd-enter", Confirm { secondary: true }, CONTEXT),
    ]);
}

/// The actions it offers, in order, with other words each one answers to.
fn actions() -> Vec<(&'static str, Box<dyn Action>, &'static [&'static str])> {
    vec![
        ("New Tab", Box::new(NewTab), &["open"]),
        ("Close Tab", Box::new(CloseTab), &[]),
        ("Close Other Tabs", Box::new(CloseOtherTabs), &[]),
        ("Reopen Closed Tab", Box::new(ReopenClosedTab), &["undo"]),
        ("Duplicate Tab", Box::new(DuplicateTab), &["copy"]),
        ("Next Tab", Box::new(NextTab), &[]),
        ("Previous Tab", Box::new(PrevTab), &[]),
        ("Last-Used Tab", Box::new(LastUsedTab), &["switch"]),
        ("Move Tab Left", Box::new(MoveTabLeft), &[]),
        ("Move Tab Right", Box::new(MoveTabRight), &[]),
        ("Search Pages", Box::new(SearchPages), &["list", "filter"]),
        ("Find in Page", Box::new(FindInPage), &["search"]),
        ("Ask Claude About This Page", Box::new(AskClaude), &["prompt", "agent"]),
        ("Toggle Sidebar", Box::new(ToggleSidebar), &["list", "hide", "show"]),
        ("Toggle Code Panel", Box::new(ToggleCode), &["file", "source"]),
        ("Reload", Box::new(Reload), &["refresh"]),
        ("Open in Browser", Box::new(OpenInBrowser), &["safari", "chrome"]),
        ("Back", Box::new(Back), &[]),
        ("Forward", Box::new(Forward), &[]),
        ("Zoom In", Box::new(ZoomIn), &[]),
        ("Zoom Out", Box::new(ZoomOut), &[]),
        ("Actual Size", Box::new(ZoomReset), &["zoom", "reset"]),
    ]
}

pub struct Palette {
    state: Entity<CommandState>,
    actions: Vec<(&'static str, Box<dyn Action>, &'static [&'static str])>,
    /// Every page, newest first, as the list had them when ⌘K opened.
    pages: Vec<Item>,
    view: WeakEntity<ArtifactsView>,
    main: AnyWindowHandle,
    _subscriptions: Vec<Subscription>,
}

impl Palette {
    pub fn new(
        view: WeakEntity<ArtifactsView>,
        main: AnyWindowHandle,
        pages: Vec<Item>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = cx.new(|cx| CommandState::new(window, cx));
        state.update(cx, |state, cx| state.focus(window, cx));
        // Clicking anywhere else (the main window included) closes it, as a menu would.
        let subscriptions = vec![cx.observe_window_activation(window, |_, window, _| {
            if !window.is_window_active() {
                window.remove_window();
            }
        })];
        Self { state, actions: actions(), pages, view, main, _subscriptions: subscriptions }
    }

    /// Close, then do what was picked in the main window.
    fn run(&mut self, at: IndexPath, window: &mut Window, cx: &mut Context<Self>) {
        let new_tab = window.modifiers().platform;
        window.remove_window();
        let (action, page) = match at.section {
            0 => (self.actions.get(at.row).map(|a| a.1.boxed_clone()), None),
            _ => (None, self.pages.get(at.row).map(|p| p.slug.clone())),
        };
        let view = self.view.clone();
        let _ = self.main.update(cx, |_, window, cx| {
            window.activate_window();
            if let Some(action) = action {
                window.dispatch_action(action, cx);
            }
            if let Some(slug) = page {
                let _ = view.update(cx, |view, cx| view.open_page(slug, new_tab, window, cx));
            }
        });
    }
}

impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity().downgrade();
        let actions = self.actions.iter().map(|(label, action, words)| {
            // The action itself only shows its shortcut: dispatched in this window, it does nothing.
            CommandItem::new().label(*label).action(action.boxed_clone()).keywords(words.iter().copied())
        });
        let pages = self.pages.iter().map(|p| {
            let words = [Some(p.slug.clone()), p.ticket.clone()].into_iter().flatten().chain(p.tags.iter().cloned());
            CommandItem::new().label(p.title.clone()).keywords(words)
        });
        div()
            .size_full()
            .on_action(|_: &CommandPalette, window, _| window.remove_window())
            .child(
                Command::new(&self.state)
                    .group(CommandGroup::new().label("Actions").items(actions))
                    .group(CommandGroup::new().label("Pages").items(pages))
                    .placeholder("Run an action or go to a page")
                    .bordered(false)
                    .max_h(px(PALETTE_SIZE.1 - 52.))
                    .on_confirm(move |at, window, cx| {
                        let _ = this.update(cx, |this, cx| this.run(at, window, cx));
                    })
                    .on_cancel(|window, _| window.remove_window()),
            )
    }
}
