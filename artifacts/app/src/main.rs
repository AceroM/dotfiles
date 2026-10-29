//! `artifacts-app`: a native window for the artifacts server. The page list sits on the left,
//! and the selected page renders on the right in a WebKit view, exactly as it does in a browser.
//! It reads the running server over HTTP ($ARTIFACTS_URL, default http://127.0.0.1:4620).

// GPUI's derive macros expand to `gpui::…` paths; the Kit stands in for GPUI.
extern crate gpui_kit as gpui;

mod api;
mod view;

use gpui_kit::component::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
use gpui_kit::*;
use view::*;

fn menus() -> Vec<Menu> {
    vec![
        Menu::new("artifacts").items([
            MenuItem::action("Hide artifacts", HideWindow),
            MenuItem::separator(),
            MenuItem::action("Quit artifacts", Quit),
        ]),
        // OS actions, so copy and paste reach the page when the webview has focus.
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Zoom In", ZoomIn),
            MenuItem::action("Zoom Out", ZoomOut),
            MenuItem::action("Actual Size", ZoomReset),
        ]),
        // Menu items are how shortcuts reach the app while the page holds the keyboard.
        Menu::new("Go").items([
            MenuItem::action("Search Pages", SearchPages),
            MenuItem::action("Find in Page", FindInPage),
            MenuItem::separator(),
            MenuItem::action("Page List", FocusList),
            MenuItem::action("Page", FocusPage),
            MenuItem::separator(),
            MenuItem::action("Back", Back),
            MenuItem::action("Forward", Forward),
            MenuItem::action("Reload", Reload),
            MenuItem::action("Open in Browser", OpenInBrowser),
        ]),
    ]
}

fn main() {
    gpui_kit::application().run(|cx: &mut App| {
        gpui_kit::init(cx);
        bind_keys(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &HideWindow, cx| cx.hide());
        cx.set_menus(menus());
        // One window: closing it quits, and Option-A (Hammerspoon) launches it again.
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(1440.), px(920.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("artifacts".into()), ..Default::default() }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| ArtifactsView::new(window, cx)))
            .expect("failed to open the artifacts window");
        cx.activate(true);
    });
}
