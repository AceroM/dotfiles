import Darwin
import Foundation

struct ProcessIdentity: Hashable, Sendable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
}

struct LocalProcess: Sendable {
    let identity: ProcessIdentity
    let parent: pid_t
    let executable: String

    var pid: pid_t { identity.pid }
}

struct ChromeApp: Sendable {
    let pid: pid_t
    let bundle: URL
    let executable: String

    func members(in table: [pid_t: LocalProcess]) -> [LocalProcess] {
        let bundlePrefix = bundle.path + "/Contents/"
        guard let root = table[pid], executable.hasPrefix(bundlePrefix) else { return [] }
        let executableSuffix = executable.dropFirst(bundle.path.count)
        guard root.executable.hasSuffix(executableSuffix) else { return [] }
        // macOS can run Chrome from a code-signing clone with helpers in either bundle.
        let runningPrefix = root.executable.dropLast(executableSuffix.count) + "/Contents/"
        return [root] + table.values.filter { process in
            guard process.pid != pid,
                  process.executable.hasPrefix(bundlePrefix) || process.executable.hasPrefix(runningPrefix)
            else { return false }
            var child = process
            while let ancestor = table[child.parent], ancestor.pid != child.pid {
                // A parent born later can be a reused PID in the snapshot.
                guard ancestor.identity.started(noLaterThan: child.identity) else { return false }
                if ancestor.pid == pid { return true }
                child = ancestor
            }
            return false
        }
    }
}

private extension ProcessIdentity {
    func started(noLaterThan other: Self) -> Bool {
        (startSeconds, startMicroseconds) <= (other.startSeconds, other.startMicroseconds)
    }
}

enum ProcessTable {
    static func read() throws -> [pid_t: LocalProcess] {
        let uid = getuid()
        let kind = UInt32(PROC_UID_ONLY)
        let estimatedSize = proc_listpids(kind, uid, nil, 0)
        guard estimatedSize > 0 else { throw CocoaError(.fileReadUnknown) }
        var pids = [pid_t](repeating: 0, count: Int(estimatedSize) / MemoryLayout<pid_t>.stride + 128)
        let count: Int = try pids.withUnsafeMutableBytes { buffer in
            let bytes = proc_listpids(kind, uid, buffer.baseAddress, Int32(buffer.count))
            guard bytes > 0, bytes < buffer.count else { throw CocoaError(.fileReadUnknown) }
            return Int(bytes) / MemoryLayout<pid_t>.stride
        }
        return Dictionary(uniqueKeysWithValues: pids.prefix(count).compactMap { pid in
            read(pid).map { (pid, $0) }
        })
    }

    static func read(_ pid: pid_t) -> LocalProcess? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard pid > 1, getuid() != 0,
              proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_uid == getuid(), info.pbi_status != SZOMB else { return nil }
        // PROC_PIDPATHINFO_MAXSIZE is defined as 4 * MAXPATHLEN in libproc's headers.
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let pathSize = UInt32(path.count)
        guard proc_pidpath(pid, &path, pathSize) > 0 else { return nil }
        let executable = String(decoding: path.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return LocalProcess(
            identity: ProcessIdentity(
                pid: pid, startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec
            ),
            parent: pid_t(info.pbi_ppid),
            executable: executable
        )
    }

    static func footprint(_ pid: pid_t) -> UInt64? {
        var usage = rusage_info_v2()
        let result = withUnsafeMutablePointer(to: &usage) {
            $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
                proc_pid_rusage(pid, RUSAGE_INFO_V2, $0)
            }
        }
        return result == 0 ? usage.ri_phys_footprint : nil
    }

    static func workingDirectory(_ pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        return withUnsafeBytes(of: &info.pvi_cdir.vip_path) {
            String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    static func isCurrent(_ process: LocalProcess) -> Bool {
        guard let current = read(process.pid) else { return false }
        return current.identity == process.identity && current.executable == process.executable
    }

    @discardableResult
    static func signal(_ signal: Int32, to process: LocalProcess) throws -> Bool {
        guard isCurrent(process) else { return false }
        if kill(process.pid, signal) == 0 { return true }
        let error = errno
        if error == ESRCH { return false }
        throw POSIXError(POSIXErrorCode(rawValue: error) ?? .EIO)
    }
}
