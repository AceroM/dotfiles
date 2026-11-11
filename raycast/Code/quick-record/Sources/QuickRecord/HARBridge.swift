import AppKit

/// The app's side of the HAR handshake. Chrome runs QuickRecordHAR (this package's native
/// messaging host) for the Quick Record HAR extension; the app and that host talk over
/// distributed notifications, so neither needs to know whether the other is running:
///
///   app  --command {start|stop}-->  host  --stdio-->  extension
///   app  <--event {started|saved|failed}--  host  <--stdio--  extension
///
/// The app picks the HAR path (beside the video); the host only writes under the recordings folder.
enum HARProtocol {
    static let command = Notification.Name("com.acerom.quickrecord.har.command")
    static let event = Notification.Name("com.acerom.quickrecord.har.event")

    static var recordingsDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Quick Record", isDirectory: true)
    }
}

struct HAREvent {
    enum Kind: String { case started, saved, failed }
    let kind: Kind
    let id: String
    let browser: String
    let path: String?
    let entries: Int
    let message: String?

    init?(_ info: [AnyHashable: Any]?) {
        guard let info, let raw = info["event"] as? String, let kind = Kind(rawValue: raw),
              let id = info["id"] as? String else { return nil }
        self.kind = kind
        self.id = id
        browser = info["browser"] as? String ?? "Chrome"
        path = info["path"] as? String
        entries = (info["entries"] as? NSNumber)?.intValue ?? 0
        message = info["message"] as? String
    }
}

@MainActor
final class HARBridge {
    var onEvent: ((HAREvent) -> Void)?
    private var observer: NSObjectProtocol?

    init() {
        observer = DistributedNotificationCenter.default().addObserver(forName: HARProtocol.event, object: nil, queue: .main) { [weak self] note in
            guard let event = HAREvent(note.userInfo) else { return }
            MainActor.assumeIsolated { self?.onEvent?(event) }
        }
    }

    /// `region` is the recorded area in global display points (top-left origin, as Chrome reports
    /// window bounds), so the extension can tell which windows' tabs are on camera.
    func start(id: String, path: URL, startedAt: Date, region: CGRect) {
        post(["command": "start", "id": id, "path": path.path,
              "startedAt": NSNumber(value: (startedAt.timeIntervalSince1970 * 1000).rounded()),
              "x": NSNumber(value: Double(region.minX)), "y": NSNumber(value: Double(region.minY)),
              "width": NSNumber(value: Double(region.width)), "height": NSNumber(value: Double(region.height))])
    }

    func stop(id: String) { post(["command": "stop", "id": id]) }

    private func post(_ info: [String: Any]) {
        DistributedNotificationCenter.default().postNotificationName(HARProtocol.command, object: nil, userInfo: info,
                                                                     deliverImmediately: true)
    }
}
