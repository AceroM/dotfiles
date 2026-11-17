import Foundation

let gibibyte: UInt64 = 1 << 30

struct Limits: Equatable {
    var nodeGiB: Int
    var chromeGiB: Int

    static func defaults(physicalMemory: UInt64) -> Self {
        let ram = Int(physicalMemory / gibibyte)
        return Limits(nodeGiB: max(4, ram / 4), chromeGiB: max(6, ram / 3))
    }

    func bytes(for target: Reading.Target) -> UInt64 {
        let limit = switch target {
        case .node: nodeGiB
        case .chrome: chromeGiB
        }
        return UInt64(limit) * gibibyte
    }
}

struct Reading: Sendable {
    enum Target: Sendable {
        case node
        case chrome(ChromeApp)
    }

    let target: Target
    let process: LocalProcess
    let bytes: UInt64
}

struct BreachTracker {
    private var streaks: [ProcessIdentity: Int] = [:]

    mutating func observe(_ readings: [Reading], limits: Limits) -> [Reading] {
        var next: [ProcessIdentity: Int] = [:]
        var breaches: [Reading] = []
        for reading in readings where reading.bytes >= limits.bytes(for: reading.target) {
            let identity = reading.process.identity
            let previous = streaks[identity, default: 0]
            let count = min(previous + 1, 3)
            next[identity] = count
            if previous == 2 { breaches.append(reading) }
        }
        streaks = next
        return breaches
    }
}

struct Snapshot: Sendable {
    let node: [Reading]
    let chrome: [Reading]

    var nodePeak: UInt64? { node.map(\.bytes).max() }
    var chromePeak: UInt64? { chrome.map(\.bytes).max() }

    static func collect(chrome apps: [ChromeApp]) throws -> Self {
        let table = try ProcessTable.read()
        let node = table.values.filter(\.isNode).compactMap { process -> Reading? in
            guard let bytes = ProcessTable.footprint(process.pid) else { return nil }
            return Reading(target: .node, process: process, bytes: bytes)
        }
        let chrome = apps.compactMap { app -> Reading? in
            let members = app.members(in: table)
            guard let root = members.first, let browserBytes = ProcessTable.footprint(root.pid) else {
                return nil
            }
            let bytes = members.dropFirst().reduce(browserBytes) { total, process in
                total + (ProcessTable.footprint(process.pid) ?? 0)
            }
            return Reading(target: .chrome(app), process: root, bytes: bytes)
        }
        return Snapshot(node: node, chrome: chrome)
    }
}
