import Foundation

// Native messaging host for the Quick Record HAR Chrome extension.
//
// Chrome starts this (one per browser, for as long as the extension keeps its port open) with the
// extension's origin as the argument, and frames messages on stdio as a 4-byte little-endian
// length + UTF-8 JSON. Quick Record reaches it over distributed notifications:
//
//   com.acerom.quickrecord.har.command  {command: start|stop, id, path, startedAt, x, y, width, height}
//   com.acerom.quickrecord.har.event    {event: started|saved|failed, id, browser, path, entries, message}
//
// The extension streams the finished HAR back in chunks; this process writes it next to the video.
// Nothing but framed messages may go to stdout. Diagnostics go to har-host.log.

let commandName = Notification.Name("com.acerom.quickrecord.har.command")
let eventName = Notification.Name("com.acerom.quickrecord.har.event")
let home = FileManager.default.homeDirectoryForCurrentUser
let recordings = home.appendingPathComponent("Movies/Quick Record", isDirectory: true).standardizedFileURL
let support = home.appendingPathComponent("Library/Application Support/Quick Record", isDirectory: true)
let logURL = support.appendingPathComponent("har-host.log")

func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) [\(getpid())] \(message)\n"
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? Data(line.utf8).write(to: logURL)
    }
}

let output = FileHandle.standardOutput
let outputLock = NSLock()

func send(_ message: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: message) else { return }
    var length = UInt32(body.count).littleEndian
    outputLock.lock()
    defer { outputLock.unlock() }
    output.write(Data(bytes: &length, count: 4))
    output.write(body)
}

func post(_ info: [String: Any]) {
    DistributedNotificationCenter.default().postNotificationName(eventName, object: nil, userInfo: info, deliverImmediately: true)
}

/// Only plain `.har` files directly inside the recordings folder, and never over an existing file.
func destination(for path: String, browser: String) -> URL? {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard url.pathExtension == "har", url.deletingLastPathComponent().path == recordings.path else { return nil }
    guard FileManager.default.fileExists(atPath: url.path) else { return url }
    // A second browser running the extension saves alongside, named for itself.
    let base = url.deletingPathExtension().lastPathComponent
    for suffix in [" (\(browser))"] + (2...20).map({ " (\(browser) \($0))" }) {
        let candidate = recordings.appendingPathComponent(base + suffix).appendingPathExtension("har")
        if !FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    return nil
}

final class Recording {
    let path: String
    var file: URL?
    var handle: FileHandle?
    init(path: String) { self.path = path }
}

var browser = "Chrome"
var active: [String: Recording] = [:]

func handleCommand(_ info: [AnyHashable: Any]) {
    guard let command = info["command"] as? String, let id = info["id"] as? String else { return }
    switch command {
    case "start":
        guard let path = info["path"] as? String else { return }
        active[id] = Recording(path: path)
        var message: [String: Any] = ["type": "start", "id": id]
        for key in ["startedAt", "x", "y", "width", "height"] { message[key] = info[key] }
        send(message)
        log("start \(id)")
    case "stop":
        guard active[id] != nil else { return }
        send(["type": "stop", "id": id])
        log("stop \(id)")
    default:
        break
    }
}

func fail(_ id: String, _ message: String) {
    log("failed \(id): \(message)")
    if let recording = active.removeValue(forKey: id) {
        try? recording.handle?.close()
        if let file = recording.file { try? FileManager.default.removeItem(at: file.appendingPathExtension("part")) }
    }
    post(["event": "failed", "id": id, "browser": browser, "message": message])
}

func handleExtension(_ message: [String: Any]) {
    let type = message["type"] as? String ?? ""
    let id = message["id"] as? String ?? ""
    switch type {
    case "hello":
        browser = message["browser"] as? String ?? browser
        log("hello from \(browser) \(message["version"] as? String ?? "")")
    case "started":
        guard active[id] != nil else { return }
        post(["event": "started", "id": id, "browser": browser, "entries": message["tabs"] as? Int ?? 0])
    case "chunk":
        guard let recording = active[id], let data = message["data"] as? String else { return }
        do {
            if recording.handle == nil {
                guard let target = destination(for: recording.path, browser: browser) else { return fail(id, "Refusing to write \(recording.path)") }
                let part = target.appendingPathExtension("part")
                try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
                FileManager.default.createFile(atPath: part.path, contents: nil)
                recording.file = target
                recording.handle = try FileHandle(forWritingTo: part)
            }
            try recording.handle?.write(contentsOf: Data(data.utf8))
        } catch { fail(id, error.localizedDescription) }
    case "done":
        guard let recording = active.removeValue(forKey: id) else { return }
        guard let file = recording.file, let handle = recording.handle else {
            return post(["event": "failed", "id": id, "browser": browser, "message": "The HAR was empty"])
        }
        do {
            try handle.close()
            try FileManager.default.moveItem(at: file.appendingPathExtension("part"), to: file)
            let entries = message["entries"] as? Int ?? 0
            log("saved \(id): \(entries) entries → \(file.path)")
            post(["event": "saved", "id": id, "browser": browser, "path": file.path, "entries": entries])
        } catch {
            active[id] = recording
            fail(id, error.localizedDescription)
        }
    case "failed":
        guard active[id] != nil else { return }
        fail(id, message["message"] as? String ?? "The extension couldn’t build the HAR")
    default:
        break
    }
}

/// Reads exactly `count` bytes, or nil at end of input (Chrome closed the port).
func read(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let chunk = FileHandle.standardInput.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

log("host started for \(CommandLine.arguments.dropFirst().first ?? "unknown origin")")
DistributedNotificationCenter.default().addObserver(forName: commandName, object: nil, queue: .main) { note in
    if let info = note.userInfo { handleCommand(info) }
}

Thread.detachNewThread {
    while true {
        guard let header = read(4) else { break }
        let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
        guard let body = read(Int(length)) else { break }
        guard let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            log("unreadable message (\(length) bytes)")
            continue
        }
        DispatchQueue.main.async { handleExtension(message) }
    }
    DispatchQueue.main.async {
        for id in Array(active.keys) { fail(id, "Chrome disconnected before the HAR was saved") }
        log("port closed")
        exit(0)
    }
}

RunLoop.main.run()
