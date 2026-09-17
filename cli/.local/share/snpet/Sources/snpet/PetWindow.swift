import AppKit
import Combine

/// The sprite on the desktop: a floating panel that never takes focus, drags
/// by its body, and remembers where it was left.
final class PetWindowController: NSObject {
  static let spriteSide: CGFloat = 128
  static let margin: CGFloat = 14  // room for the badge to hang off the corner
  static let feetInset: CGFloat = 7  // his soles sit this far above the sprite's bottom edge
  /// Distance from the panel's bottom edge up to his soles — where a box's top edge goes.
  static var soleLine: CGFloat { margin + feetInset }

  let panel: NSPanel
  let view = SpriteView()
  private let feed: FeedStore
  private let inbox: InboxPanelController
  private var subs = Set<AnyCancellable>()

  init(feed: FeedStore, inbox: InboxPanelController) {
    self.feed = feed
    self.inbox = inbox
    let side = Self.spriteSide + Self.margin * 2
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: side, height: side),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    super.init()

    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isMovableByWindowBackground = false  // the view drags, so a click can be told from a drag
    panel.contentView = view

    view.sprite = Sprite(url: Self.spriteURL)
    view.inset = Self.margin
    view.onClick = { [weak self] in self?.inbox.toggle() }
    view.contextMenu = { [weak self] in self?.contextMenu() ?? NSMenu() }

    // objectWillChange fires before the value lands, hence the hop to the next turn.
    feed.objectWillChange
      .sink { [weak self] _ in DispatchQueue.main.async { self?.refresh() } }
      .store(in: &subs)
    inbox.visibilityChanged = { [weak self] in self?.refresh() }
    NotificationCenter.default.addObserver(
      forName: NSWindow.didMoveNotification, object: panel, queue: .main
    ) { [weak self] _ in self?.inbox.petMoved() }
  }

  /// The bundled sprite, or the source tree's copy when running the bare binary.
  private static var spriteURL: URL {
    Bundle.main.url(forResource: "miguel", withExtension: "gif")
      ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".local/share/snpet/Resources/miguel.gif")
  }

  func show() {
    if !panel.setFrameUsingName("pet"), let v = NSScreen.main?.visibleFrame {
      panel.setFrameOrigin(NSPoint(x: v.maxX - panel.frame.width - 24, y: v.minY + 24))
    }
    panel.setFrameAutosaveName("pet")
    panel.orderFrontRegardless()
    refresh()
  }

  /// Badge and dance follow the unread count: he dances while something has
  /// arrived that you have not turned to yet, inbox open or not.
  func refresh() {
    let unread = feed.unreadCount
    view.badge = unread
    view.dancing = unread > 0
  }

  private func contextMenu() -> NSMenu {
    let m = NSMenu()
    m.autoenablesItems = false

    let open = NSMenuItem(
      title: inbox.isVisible ? "Close inbox" : "Open inbox", action: #selector(toggleInbox),
      keyEquivalent: "")
    open.target = self
    m.addItem(open)
    m.addItem(.separator())

    let dictate = NSMenuItem(
      title: Wispr.isInstalled ? "Start dictating when I reply" : "Wispr Flow is not installed",
      action: #selector(toggleDictateOnReply), keyEquivalent: "")
    dictate.target = self
    dictate.state = inbox.model.dictateOnReply ? .on : .off
    dictate.isEnabled = Wispr.isInstalled
    m.addItem(dictate)

    let markRead = NSMenuItem(
      title: "Mark read in Slack as I look", action: #selector(toggleMarkRead), keyEquivalent: "")
    markRead.target = self
    markRead.state = inbox.model.markReadInSlack ? .on : .off
    m.addItem(markRead)

    let check = NSMenuItem(
      title: "Check Slack session", action: #selector(checkSession), keyEquivalent: "")
    check.target = self
    m.addItem(check)
    m.addItem(.separator())

    m.addItem(
      withTitle: "Quit snpet", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    return m
  }

  @objc private func toggleInbox() { inbox.toggle() }

  @objc private func toggleDictateOnReply() { inbox.model.dictateOnReply.toggle() }

  @objc private func toggleMarkRead() { inbox.model.markReadInSlack.toggle() }

  @objc private func checkSession() {
    inbox.show()
    inbox.model.setFlash("checking the Slack session…", seconds: 30)
    Task { [inbox] in
      let text: String
      do {
        text = "Slack session ok — \(try await Slack.shared.whoAmI())"
      } catch {
        text = "Slack session failed — \(error.localizedDescription)"
      }
      await MainActor.run { inbox.model.setFlash(text, seconds: 8) }
    }
  }
}
