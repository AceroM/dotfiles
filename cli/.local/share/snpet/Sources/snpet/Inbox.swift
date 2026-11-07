import AppKit
import Combine
import SwiftUI

enum ReplyMode { case reply, thread }

/// Somewhere a message can go: a channel or a DM, by id, with the name shown for it.
struct Recipient: Equatable {
  let id: String
  let name: String
}

/// A new message being written — `C` — to someone, rather than under something.
struct Compose {
  var to = ""
  var target: Recipient?
  var text = ""
  var resolving = false  // asking Slack who `to` is
  var sending = false
  var error: String?
}

/// A reply being typed.
struct Draft {
  let notif: Notif
  let target: ReplyTarget
  let place: String  // header label: the channel/sender, plus "· thread" when threaded
  var text = ""
  var sending = false
  var error: String?
}

/// What the inbox shows and does; the SwiftUI view renders this, the panel
/// controller feeds it keys.
final class InboxModel: ObservableObject {
  let feed: FeedStore
  @Published var selection = 0 {
    didSet { if visible { scheduleMarkRead() } }
  }
  var visible = false  // set by the panel; reading only counts while it is up
  @Published var draft: Draft?
  @Published var compose: Compose?
  @Published var flash = ""
  @Published var dictating = false  // Wispr Flow hands-free, started from here
  @Published var suggestions: [String] = []  // emoji names for the `:frag` being typed
  @Published var searching = false  // the `/` box is up
  @Published var filter = "" {
    didSet { if filter != oldValue { selection = 0 } }
  }
  private var customEmoji: [String] = []
  private var emojiRequested = false
  @Published var dictateOnReply = UserDefaults.standard.bool(forKey: "dictateOnReply") {
    didSet { UserDefaults.standard.set(dictateOnReply, forKey: "dictateOnReply") }
  }
  /// Looking at a message here marks it read in Slack too. On unless turned off.
  @Published var markReadInSlack = UserDefaults.standard.object(forKey: "markReadInSlack") as? Bool ?? true
  {
    didSet { UserDefaults.standard.set(markReadInSlack, forKey: "markReadInSlack") }
  }
  private var markTimer: Timer?
  private var marked: [String: Double] = [:]  // conversation → latest ts already marked
  private var flashTimer: Timer?

  init(feed: FeedStore) { self.feed = feed }

  /// What the list shows: the feed, narrowed by `/` when one is set.
  var rows: [Notif] {
    guard !filter.isEmpty else { return feed.rows }
    return feed.rows.filter {
      $0.body.localizedCaseInsensitiveContains(filter)
        || $0.place.localizedCaseInsensitiveContains(filter)
    }
  }

  var selected: Notif? { rows.indices.contains(selection) ? rows[selection] : nil }

  // MARK: pages — the list shows one, the selection decides which

  @Published var pageSize = 12
  @Published var contentHeight: CGFloat = 0  // measured by the view; the panel follows it
  private static let rowHeight: CGFloat = 23  // compact row + spacing
  private static let chrome: CGFloat = 40  // paddings and the page line

  var page: Int { selection / max(1, pageSize) }
  var pageCount: Int { max(1, (rows.count + pageSize - 1) / max(1, pageSize)) }
  var pageStart: Int { page * pageSize }
  var pageRows: [Notif] {
    let all = rows
    guard pageStart < all.count else { return [] }
    return Array(all[pageStart..<min(pageStart + pageSize, all.count)])
  }

  /// Rows per page for a box dragged to `height` — counted in compact rows;
  /// the open row's extra lines make the box taller rather than the page shorter.
  func fit(height: CGFloat) {
    let n = max(1, Int((height - Self.chrome) / Self.rowHeight))
    if n != pageSize { pageSize = n }
  }

  func nextPage() {
    let start = (page + 1) * pageSize
    if start < rows.count { selection = start }
  }

  func previousPage() {
    guard page > 0 else { return }
    selection = (page - 1) * pageSize
  }

  func openSearch() {
    cancelDraft()
    cancelCompose()
    searching = true
  }

  // MARK: read in Slack

  /// The highlight has to rest on a row before it counts as read.
  func scheduleMarkRead() {
    markTimer?.invalidate()
    guard markReadInSlack else { return }
    markTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in
      guard let self, let row = self.selected else { return }
      self.markRead(row)
    }
  }

  /// `M`: everything on this page.
  func markPageRead() {
    let rows = pageRows.filter { $0.channel != nil && $0.ts != nil }
    rows.forEach(markRead)
    setFlash("marked \(rows.count) read")
  }

  private func markRead(_ row: Notif) {
    guard markReadInSlack, let channel = row.channel, let ts = row.ts else { return }
    let key = channel + (row.threadTs.map { ":\($0)" } ?? "")
    let stamp = Double(ts) ?? 0
    if let done = marked[key], done >= stamp { return }  // already read this far
    marked[key] = stamp
    Task {
      do {
        try await Slack.shared.markRead(channel: channel, ts: ts, threadTs: row.threadTs)
      } catch {
        NSLog("snpet: mark read \(row.place) — \(error.localizedDescription)")
      }
    }
  }

  // MARK: compose

  /// Conversations the feed has seen, newest first — the people and channels
  /// you actually talk to, each with the id a message can be posted to.
  var knownRecipients: [Recipient] {
    var seen = Set<String>()
    var out: [Recipient] = []
    for r in feed.rows {
      guard let c = r.channel, !seen.contains(c) else { continue }
      seen.insert(c)
      out.append(Recipient(id: c, name: r.place))
    }
    return out
  }

  /// Known recipients matching the `to` being typed; the first is what Tab picks.
  var composeSuggestions: [Recipient] {
    guard let c = compose, c.target == nil else { return [] }
    let q = c.to.trimmingCharacters(in: .whitespaces).lowercased()
    let all = knownRecipients
    guard !q.isEmpty else { return Array(all.prefix(6)) }
    let prefix = all.filter { $0.name.lowercased().hasPrefix(q) }
    let rest = all.filter { !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q) }
    return Array((prefix + rest).prefix(6))
  }

  func openCompose() {
    cancelDraft()
    searching = false
    compose = Compose()
  }

  func cancelCompose() {
    if compose != nil, dictating { stopDictation() }
    compose = nil
  }

  /// Tab or enter in the `to` field: the first suggestion, else Slack is asked
  /// who that is — a channel for `#name`, a person otherwise.
  func pickRecipient() {
    guard var c = compose, c.target == nil, !c.resolving else { return }
    if let first = composeSuggestions.first {
      c.target = first
      c.to = first.name
      compose = c
      if dictateOnReply { startDictation() }
      return
    }
    let q = c.to.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return }
    c.resolving = true
    c.error = nil
    compose = c
    Task { [weak self] in
      guard let self else { return }
      do {
        let found = try await Slack.shared.resolveRecipient(q)
        await MainActor.run {
          guard var c = self.compose else { return }
          c.target = Recipient(id: found.id, name: found.name)
          c.to = found.name
          c.resolving = false
          self.compose = c
          if self.dictateOnReply { self.startDictation() }
        }
      } catch {
        await MainActor.run {
          guard var c = self.compose else { return }
          c.resolving = false
          c.error = error.localizedDescription
          self.compose = c
        }
      }
    }
  }

  func sendCompose() {
    guard var c = compose, let to = c.target, !c.sending else { return }
    if dictating {
      stopDictation()
      setFlash("dictation stopped — the transcript lands in the box, enter sends it", seconds: 4)
      return
    }
    let text = c.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    c.sending = true
    c.error = nil
    compose = c
    Task { [weak self] in
      guard let self else { return }
      do {
        try await Slack.shared.post(to.id, text: text)
        await MainActor.run {
          self.compose = nil
          self.setFlash("sent to \(to.name)")
        }
      } catch {
        await MainActor.run {
          guard var c = self.compose else { return }
          c.sending = false
          c.error = error.localizedDescription
          self.compose = c
        }
      }
    }
  }

  /// Enter keeps the narrowing and hands the keys back to the list.
  func commitSearch() { searching = false }

  func cancelSearch() {
    searching = false
    filter = ""
  }

  /// The reply field binds here, so every edit re-reads the emoji being typed.
  var draftText: String {
    get { draft?.text ?? "" }
    set {
      draft?.text = newValue
      guard let typing = Emoji.typing(in: newValue) else { return suggestions = [] }
      suggestions = Emoji.matches(typing.fragment, custom: customEmoji)
    }
  }

  /// Tab: the first suggestion replaces the fragment. False when there is none.
  func completeEmoji() -> Bool {
    guard var d = draft, let first = suggestions.first, let typing = Emoji.typing(in: d.text)
    else { return false }
    d.text.replaceSubrange(typing.range, with: ":\(first): ")
    draft = d
    suggestions = []
    return true
  }

  func move(_ by: Int) { selection = max(0, min(selection + by, rows.count - 1)) }

  func clampSelection() { selection = max(0, min(selection, rows.count - 1)) }

  func setFlash(_ text: String, seconds: TimeInterval = 2) {
    flash = text
    flashTimer?.invalidate()
    flashTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
      self?.flash = ""
    }
  }

  /// "reply" answers where the message already lives — inside its thread when
  /// it is threaded, in the channel otherwise. "thread" always answers in a
  /// thread, opening one on a top-level message.
  func openDraft(_ mode: ReplyMode) {
    guard let row = selected else { return }
    searching = false
    cancelCompose()
    guard let channel = row.channel, let ts = row.ts else {
      setFlash("no channel on this row — open it in Slack instead")
      return
    }
    let threadTs = mode == .thread ? (row.threadTs ?? ts) : row.threadTs
    draft = Draft(
      notif: row,
      target: ReplyTarget(channel: channel, ts: ts, threadTs: threadTs),
      place: threadTs != nil ? "\(row.place) · thread" : row.place)
    // Resolve the session behind the box, so typing can start while the
    // Keychain and Slack round-trips run.
    Task { [weak self] in
      guard let self else { return }
      do {
        _ = try await Slack.shared.creds()
      } catch {
        await MainActor.run {
          guard self.draft?.notif.iden == row.iden else { return }
          self.draft?.error = error.localizedDescription
        }
      }
    }
    if dictateOnReply { startDictation() }
    if !emojiRequested {
      emojiRequested = true
      Task { [weak self] in
        guard let self, let names = try? await Slack.shared.emojiNames() else { return }
        await MainActor.run { self.customEmoji = names }
      }
    }
  }

  func send() {
    guard var d = draft, !d.sending else { return }
    if dictating {
      // Wispr types the transcript only once it stops listening: stop, let the
      // words land in the box, and the next enter sends them.
      stopDictation()
      setFlash("dictation stopped — the transcript lands in the box, enter sends it", seconds: 4)
      return
    }
    let text = d.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    d.sending = true
    d.error = nil
    draft = d
    suggestions = []
    let sent = d
    // `+:eyes:` is a reaction, anything else a message — Slack's own composer rule.
    if let name = Emoji.reaction(in: text) {
      deliver(sent, done: "reacted :\(name): in \(sent.place)") {
        try await Slack.shared.react(sent.target, name: name)
      }
    } else {
      deliver(sent, done: "replied in \(sent.place)") {
        try await Slack.shared.reply(sent.target, text: text)
      }
    }
  }

  private func deliver(_ sent: Draft, done: String, _ op: @escaping () async throws -> Void) {
    Task { [weak self] in
      guard let self else { return }
      do {
        try await op()
        await MainActor.run {
          self.draft = nil
          self.setFlash(done)
        }
      } catch {
        await MainActor.run {
          guard self.draft?.notif.iden == sent.notif.iden else { return }
          self.draft?.sending = false
          self.draft?.error = error.localizedDescription
        }
      }
    }
  }

  func cancelDraft() {
    if dictating { stopDictation() }
    draft = nil
    suggestions = []
  }

  func toggleDictation() { dictating ? stopDictation() : startDictation() }

  func startDictation() {
    guard Wispr.isInstalled else { return setFlash("Wispr Flow is not installed") }
    guard draft != nil || compose?.target != nil else {
      return setFlash("open a reply or a message first, then dictate")
    }
    Wispr.startHandsFree()
    dictating = true
  }

  func stopDictation() {
    Wispr.stopHandsFree()
    dictating = false
  }

  /// `y` copies the message, `Y` its link.
  func yank(link: Bool = false) {
    guard let row = selected else { return }
    let text = link ? (row.link?.absoluteString ?? "") : row.text
    guard !text.isEmpty else { return setFlash(link ? "no link on this row" : "nothing to copy") }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    setFlash(link ? "copied link" : "copied")
  }

  func openInSlack() {
    guard let row = selected else { return }
    NSWorkspace.shared.open(row.link ?? URL(string: "slack://open")!)
    setFlash(row.link != nil ? "opened \(row.place) in Slack" : "no channel link — opened Slack")
  }
}

/// A borderless-looking panel that can still take the keyboard.
final class InboxPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

/// The inbox window: placed next to the pet, keyed like `sn`, and handing focus
/// back to whatever app had it once it closes.
final class InboxPanelController {
  private static let sizeKey = "inboxSize"

  let panel: NSPanel
  let model: InboxModel
  private let feed: FeedStore
  private var keyMonitor: Any?
  private var previousApp: NSRunningApplication?
  private var subs = Set<AnyCancellable>()

  /// The pet: where he is, how to move him, how to lift him above the box.
  var anchor: (() -> NSRect)?
  var movePet: ((NSPoint) -> Void)?
  var raisePet: (() -> Void)?
  var visibilityChanged: (() -> Void)?
  private var repositioning = false  // our own moves must not echo back and forth
  private var petOffsetX: CGFloat = 0  // his x relative to the box, kept while the box is dragged
  private var desiredHeight: CGFloat = 380  // what you dragged it to; sets rows per page

  var isVisible: Bool { panel.isVisible }

  init(feed: FeedStore) {
    self.feed = feed
    model = InboxModel(feed: feed)
    panel = InboxPanel(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 380),
      styleMask: [.titled, .fullSizeContentView, .resizable], backing: .buffered, defer: false)
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      panel.standardWindowButton(b)?.isHidden = true
    }
    panel.isMovableByWindowBackground = true
    panel.level = .floating
    panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.minSize = NSSize(width: 400, height: 60)

    // Solid, not a material: the system's glass reads wrong over light content.
    // The view paints its own background; the window only clips the corners.
    let host = NSHostingView(rootView: InboxView(model: model, feed: feed))
    host.sizingOptions = []  // or it pins the window's minimum to content + the hidden title bar
    panel.contentView = host

    // Size is remembered; position is recomputed under the pet each time. The
    // height you drag to decides rows per page; the box then snaps to fit them.
    if let saved = UserDefaults.standard.string(forKey: Self.sizeKey) {
      let size = NSSizeFromString(saved)
      if size.width > 0 { panel.setContentSize(size) }
    }
    desiredHeight = panel.frame.height
    model.fit(height: desiredHeight)
    NotificationCenter.default.addObserver(
      forName: NSWindow.didEndLiveResizeNotification, object: panel, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.desiredHeight = self.panel.frame.height
      self.model.fit(height: self.desiredHeight)
      UserDefaults.standard.set(NSStringFromSize(self.panel.frame.size), forKey: Self.sizeKey)
      self.fitToContent()
    }
    model.objectWillChange
      .sink { [weak self] _ in DispatchQueue.main.async { self?.fitToContent() } }
      .store(in: &subs)

    feed.objectWillChange
      .sink { [weak self] _ in DispatchQueue.main.async { self?.model.clampSelection() } }
      .store(in: &subs)
    // Unread clears when the inbox is *looked at* — opened, closed, keyed or
    // clicked — not merely because it happens to be open. So a message that
    // lands while it sits there still gets the pet dancing until you turn to it.
    NotificationCenter.default.addObserver(
      forName: NSWindow.didBecomeKeyNotification, object: panel, queue: .main
    ) { [weak self] _ in
      self?.feed.markAllSeen()
      self?.raisePet?()  // his shoes stay over the box's edge
    }
    NotificationCenter.default.addObserver(
      forName: NSWindow.didMoveNotification, object: panel, queue: .main
    ) { [weak self] _ in self?.boxMoved() }
  }

  /// The box takes exactly the height its content measured, top edge fixed
  /// under his feet — so a one-line selection leaves no gap and a three-line
  /// one grows the box downward.
  private func fitToContent() {
    guard isVisible, !panel.inLiveResize, model.contentHeight > 0 else { return }
    let target = ceil(model.contentHeight)
    let f = panel.frame
    guard abs(f.height - target) > 0.5 else { return }
    withoutEcho {
      panel.setFrame(
        NSRect(x: f.minX, y: f.maxY - target, width: f.width, height: target), display: true)
    }
  }

  /// He was dragged: the box goes back under his feet.
  func petMoved() {
    guard isVisible, !repositioning else { return }
    place()
  }

  /// The box was dragged: he rides along.
  private func boxMoved() {
    guard isVisible, !repositioning else { return }
    let f = panel.frame
    withoutEcho {
      movePet?(NSPoint(x: f.minX + petOffsetX, y: f.maxY - PetWindowController.soleLine))
    }
  }

  private func withoutEcho(_ body: () -> Void) {
    repositioning = true
    body()
    DispatchQueue.main.async { [weak self] in self?.repositioning = false }
  }

  func toggle() { isVisible ? hide() : show() }

  func show() {
    let front = NSWorkspace.shared.frontmostApplication
    previousApp =
      front?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : front
    place()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    raisePet?()
    if keyMonitor == nil {
      keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
        guard let self, event.window === self.panel else { return event }
        return self.handle(event) ? nil : event
      }
    }
    model.visible = true
    model.selection = 0
    model.scheduleMarkRead()  // row 0 is the same row as before, so didSet may not fire
    feed.markAllSeen()
    visibilityChanged?()
    fitToContent()
  }

  func hide() {
    model.visible = false
    model.cancelDraft()
    model.cancelCompose()
    panel.orderOut(nil)
    if let m = keyMonitor {
      NSEvent.removeMonitor(m)
      keyMonitor = nil
    }
    feed.markAllSeen()
    // Hand focus back to where it was before the inbox took it.
    if let prev = previousApp { prev.activate(from: .current, options: []) }
    previousApp = nil
    visibilityChanged?()
  }

  /// Under his feet, so he stands on the box's top edge — at its right end when
  /// he is on the right half of the screen, its left end otherwise. When the
  /// screen bottom is in the way the pair is lifted together.
  private func place() {
    guard let a = anchor?(), a != .zero else { return panel.center() }
    let screen = NSScreen.screens.first { $0.frame.intersects(a) } ?? NSScreen.main
    guard let v = screen?.visibleFrame else { return panel.center() }
    let s = panel.frame.size
    let m = PetWindowController.margin
    var x = a.midX > v.midX ? (a.maxX - m + 10) - s.width : a.minX + m - 10
    x = min(max(x, v.minX), v.maxX - s.width)
    var top = a.minY + PetWindowController.soleLine
    var pet = a.origin
    if top - s.height < v.minY {
      top = v.minY + s.height
      pet.y = top - PetWindowController.soleLine
    }
    withoutEcho {
      panel.setFrameOrigin(NSPoint(x: x, y: top - s.height))
      if pet != a.origin { movePet?(pet) }
      petOffsetX = pet.x - x
    }
  }


  /// Keys the list owns while the panel is up. The reply field keeps everything
  /// but escape and ⌘-shortcuts once it has focus; enter reaches it as onSubmit.
  private func handle(_ e: NSEvent) -> Bool {
    feed.markAllSeen()  // any key in here means you are looking
    let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let chars = e.charactersIgnoringModifiers ?? ""
    if flags.contains(.command) {
      switch chars {
      case "d": model.toggleDictation()
      case "w": hide()
      default: return false  // ⌘Q, ⌘V and friends go to the menu
      }
      return true
    }
    if e.keyCode == 53 {  // esc peels one layer: compose, search, reply, filter, inbox
      if model.compose != nil {
        model.cancelCompose()
      } else if model.searching {
        model.cancelSearch()
      } else if model.draft != nil {
        model.cancelDraft()
      } else if !model.filter.isEmpty {
        model.filter = ""
      } else {
        hide()
      }
      return true
    }
    if panel.firstResponder is NSTextView {  // typing
      guard e.keyCode == 48 else { return false }  // tab: pick the recipient, or an emoji name
      if let c = model.compose, c.target == nil {
        model.pickRecipient()
        return true
      }
      return model.completeEmoji()
    }

    switch e.keyCode {
    case 125: model.move(1)  // ↓
    case 126: model.move(-1)  // ↑
    case 124: model.nextPage()  // →
    case 123: model.previousPage()  // ←
    case 36, 76: model.openInSlack()  // return, enter
    default:
      switch chars {
      case "j": model.move(1)
      case "k": model.move(-1)
      case "h": model.previousPage()
      case "l": model.nextPage()
      case "g": model.selection = 0
      case "G": model.selection = max(0, model.rows.count - 1)
      case "/": model.openSearch()
      case "c": model.openDraft(.reply)
      case "C": model.openCompose()
      case "M": model.markPageRead()
      case "y": model.yank()
      case "Y": model.yank(link: true)
      case "r": model.openDraft(.thread)
      case "q": hide()
      default: return false
      }
    }
    return true
  }
}
