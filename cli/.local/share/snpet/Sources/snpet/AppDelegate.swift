import AppKit
import Carbon

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var feed: FeedStore!
  private var inbox: InboxPanelController!
  private var pet: PetWindowController!
  private var hotKeys: [HotKey] = []

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = Self.mainMenu()
    feed = FeedStore()
    inbox = InboxPanelController(feed: feed)
    pet = PetWindowController(feed: feed, inbox: inbox)
    inbox.anchor = { [weak self] in self?.pet.panel.frame ?? .zero }
    inbox.movePet = { [weak self] in self?.pet.panel.setFrameOrigin($0) }
    inbox.raisePet = { [weak self] in
      guard let self else { return }
      self.pet.panel.order(.above, relativeTo: self.inbox.panel.windowNumber)
    }
    // ⌥` and ⌃` from anywhere — a global hot key beats any app's own binding,
    // so ⌃` will no longer reach an editor's terminal toggle while this runs.
    for (label, mods) in [("⌥`", optionKey), ("⌃`", controlKey)] {
      if let hk = HotKey(keyCode: kVK_ANSI_Grave, modifiers: mods, action: { [weak self] in
        self?.inbox.toggle()
      }) {
        hotKeys.append(hk)
      } else {
        NSLog("snpet: could not register \(label) — something else holds it")
      }
    }
    feed.start()
    pet.show()
    NSLog("snpet: up — pet at \(NSStringFromRect(pet.panel.frame))")
  }

  func applicationWillTerminate(_ notification: Notification) {
    if inbox.model.dictating { inbox.model.stopDictation() }
  }

  /// Just enough menu for ⌘Q, and for cut/copy/paste to reach the reply field —
  /// key equivalents only dispatch through the main menu.
  private static func mainMenu() -> NSMenu {
    let menu = NSMenu()
    let app = NSMenuItem()
    menu.addItem(app)
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Quit snpet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    app.submenu = appMenu

    let edit = NSMenuItem()
    menu.addItem(edit)
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(
      withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.submenu = editMenu
    return menu
  }
}
