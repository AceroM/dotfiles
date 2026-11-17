import Darwin
import Foundation
import OSLog

enum EventLog {
    static let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/Memory Guard", isDirectory: true)
    static let url = directory.appendingPathComponent("events.log")

    private static let logger = Logger(subsystem: "com.acerom.memoryguard", category: "monitor")

    static func append(_ event: String) {
        logger.notice("\(event, privacy: .public)")
        let line = event.replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r")
        let entry = Data("\(Date().ISO8601Format()) \(line)\n".utf8)
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
            let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try file.write(contentsOf: entry)
        } catch {
            logger.error("Couldn't write the event log: \(error.localizedDescription, privacy: .public)")
        }
    }
}
