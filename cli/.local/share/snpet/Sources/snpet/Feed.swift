import Combine
import Foundation

/// One row of the feed: a Slack notification as notifdb.py recorded it.
struct Notif: Identifiable, Equatable {
  let iden: String
  let date: TimeInterval  // unix seconds
  let title: String  // Slack workspace
  let subtitle: String  // channel, or the sender for a DM
  let body: String
  let link: URL?
  let channel: String?  // set once notifdb.py matched the Slack log; needed to reply
  let ts: String?
  let threadTs: String?

  var id: String { iden }

  /// The message itself. In a channel or group the notification body starts
  /// with `sender: `; a DM's does not (a DM's sender is the subtitle), so only
  /// non-DM rows lose that prefix.
  var text: String {
    guard let channel, !channel.hasPrefix("D"),
      let colon = body.firstIndex(of: ":"),
      body.distance(from: body.startIndex, to: colon) <= 40,
      body.index(after: colon) < body.endIndex,
      body[body.index(after: colon)] == " "
    else { return body }
    return String(body[body.index(colon, offsetBy: 2)...])
  }

  /// The channel or sender, as `sn` labels its rows.
  var place: String {
    if !subtitle.isEmpty { return subtitle }
    if !title.isEmpty { return title }
    return channel ?? ""
  }
}

/// The feed file, polled. Hammerspoon appends a line per notification and now
/// and then rewrites the whole file to trim it, which FSEvents does not report
/// reliably — so this checks the size once a second, the way `sn` does.
final class FeedStore: ObservableObject {
  static let path = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".local/state/slack-notifications.jsonl")
  static let maxRows = 500
  private static let seenKey = "seenThrough"

  @Published private(set) var rows: [Notif] = []
  @Published private(set) var fileMissing = false
  /// Everything dated at or before this has been looked at. Persisted, so a
  /// relaunch does not start dancing about last week.
  @Published private(set) var seenThrough: TimeInterval

  var unreadCount: Int { rows.reduce(0) { $0 + ($1.date > seenThrough ? 1 : 0) } }

  private var lastSize: Int64 = -2  // -1 is "missing"; -2 is "never polled"
  private var timer: Timer?

  init() {
    let defaults = UserDefaults.standard
    if defaults.object(forKey: Self.seenKey) == nil {
      // First launch: what is already in the feed is not news.
      seenThrough = Date().timeIntervalSince1970
      defaults.set(seenThrough, forKey: Self.seenKey)
    } else {
      seenThrough = defaults.double(forKey: Self.seenKey)
    }
  }

  func start() {
    tick()
    let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(t, forMode: .common)  // keeps polling while a window is being dragged
    timer = t
  }

  func markAllSeen() {
    guard let newest = rows.first?.date, newest > seenThrough else { return }
    seenThrough = newest
    UserDefaults.standard.set(newest, forKey: Self.seenKey)
  }

  private func tick() {
    let attrs = try? FileManager.default.attributesOfItem(atPath: Self.path.path)
    let size = (attrs?[.size] as? NSNumber)?.int64Value ?? -1
    guard size != lastSize else { return }
    lastSize = size
    fileMissing = size < 0
    rows = Self.load()
  }

  static func load() -> [Notif] {
    guard let data = try? Data(contentsOf: path),
      let text = String(data: data, encoding: .utf8)
    else { return [] }
    var byIden: [String: Notif] = [:]
    for line in text.split(separator: "\n") {
      // A torn write mid-append fails to parse; the next poll re-reads a whole line.
      guard
        let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        obj["bundle"] as? String == "com.tinyspeck.slackmacgap",
        let iden = obj["iden"] as? String
      else { continue }
      let body = ((obj["body"] as? String) ?? "")
        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
      byIden[iden] = Notif(
        iden: iden,
        date: (obj["date"] as? Double) ?? 0,
        title: (obj["title"] as? String) ?? "",
        subtitle: (obj["subtitle"] as? String) ?? "",
        body: body,
        link: (obj["link"] as? String).flatMap(URL.init(string:)),
        channel: obj["channel"] as? String,
        ts: obj["ts"] as? String,
        threadTs: obj["thread_ts"] as? String)
    }
    return Array(byIden.values.sorted { $0.date > $1.date }.prefix(maxRows))
  }
}
