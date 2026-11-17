import Darwin
import Foundation
import Testing
@testable import MemoryGuard

struct MemoryGuardTests {
    @Test func defaultsOnThisClassOfMac() {
        #expect(Limits.defaults(physicalMemory: 36 * gibibyte) == Limits(nodeGiB: 9, chromeGiB: 12))
    }

    @Test func shortSpikeClearsAndSustainedBreachTriggersOnce() {
        let limits = Limits(nodeGiB: 9, chromeGiB: 12)
        let node = process(10, start: 1)
        let high = Reading(target: .node, process: node, bytes: 9 * gibibyte)
        let low = Reading(target: .node, process: node, bytes: 9 * gibibyte - 1)
        var tracker = BreachTracker()
        #expect(tracker.observe([high], limits: limits).isEmpty)
        #expect(tracker.observe([high], limits: limits).isEmpty)
        #expect(tracker.observe([low], limits: limits).isEmpty)
        #expect(tracker.observe([high], limits: limits).isEmpty)
        #expect(tracker.observe([high], limits: limits).isEmpty)
        #expect(tracker.observe([high], limits: limits).first?.process.identity == node.identity)
        #expect(tracker.observe([high], limits: limits).isEmpty)
    }

    @Test func reusedPIDMustExceedTheLimitForThreeNewSamples() {
        let limits = Limits(nodeGiB: 9, chromeGiB: 12)
        let first = Reading(target: .node, process: process(10, start: 1), bytes: 10 * gibibyte)
        let replacement = Reading(target: .node, process: process(10, start: 2), bytes: 10 * gibibyte)
        var tracker = BreachTracker()
        #expect(tracker.observe([first], limits: limits).isEmpty)
        #expect(tracker.observe([first], limits: limits).isEmpty)
        #expect(tracker.observe([replacement], limits: limits).isEmpty)
        #expect(tracker.observe([replacement], limits: limits).isEmpty)
        #expect(tracker.observe([replacement], limits: limits).first?.process.identity == replacement.process.identity)
    }

    @Test func chromeCountsOnlyDescendantsInsideItsBundle() {
        let root = "/Applications/Google Chrome.app"
        let chrome = ChromeApp(pid: 10, bundle: URL(fileURLWithPath: root), executable: root + "/Contents/MacOS/Google Chrome")
        let helper = root + "/Contents/Frameworks/Google Chrome Helper"
        let table: [pid_t: LocalProcess] = [
            10: process(10, start: 3, executable: chrome.executable),
            11: process(11, parent: 10, start: 4, executable: helper),
            12: process(12, parent: 11, start: 5, executable: helper),
            13: process(13, parent: 1, start: 4, executable: helper),
            14: process(14, parent: 10, start: 4, executable: "/Applications/Unrelated.app/Contents/MacOS/Helper"),
            15: process(15, parent: 10, start: 2, executable: helper),
        ]
        #expect(Set(chrome.members(in: table).map(\.pid)) == [10, 11, 12])
    }

    @Test func chromeCanRunFromACodeSigningClone() {
        let bundle = "/Applications/Google Chrome.app"
        let clone = "/private/var/folders/example/Google Chrome.app.bundle"
        let browser = "/Contents/MacOS/Google Chrome"
        let helper = "/Contents/Frameworks/Google Chrome Helper"
        let chrome = ChromeApp(pid: 10, bundle: URL(fileURLWithPath: bundle), executable: bundle + browser)
        let table: [pid_t: LocalProcess] = [
            10: process(10, start: 1, executable: clone + browser),
            11: process(11, parent: 10, start: 2, executable: bundle + helper),
            12: process(12, parent: 10, start: 2, executable: clone + helper),
        ]
        #expect(Set(chrome.members(in: table).map(\.pid)) == [10, 11, 12])
    }

    @Test func canReadAndStopAnIsolatedNodeNamedProcess() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("node")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/bin/sleep"), to: executable)
        let sign = Process()
        sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        sign.arguments = ["--force", "--sign", "-", executable.path]
        sign.standardError = FileHandle.nullDevice
        try sign.run()
        sign.waitUntilExit()
        try #require(sign.terminationStatus == 0)

        let child = Process()
        child.executableURL = executable
        child.currentDirectoryURL = directory
        child.arguments = ["30"]
        try child.run()
        defer { if child.isRunning { child.terminate() } }

        let snapshot = try Snapshot.collect(chrome: [])
        let reading = try #require(snapshot.node.first { $0.process.pid == child.processIdentifier })
        #expect(reading.bytes > 0)
        let cwd = try #require(ProcessTable.workingDirectory(child.processIdentifier))
        #expect(URL(fileURLWithPath: cwd).resolvingSymlinksInPath().path == directory.resolvingSymlinksInPath().path)

        let stale = process(reading.process.pid, start: 0, executable: reading.process.executable)
        #expect(try !ProcessTable.signal(SIGTERM, to: stale))
        #expect(child.isRunning)
        #expect(try ProcessTable.signal(SIGTERM, to: reading.process))
        child.waitUntilExit()
        #expect(child.terminationReason == .uncaughtSignal)
        #expect(child.terminationStatus == SIGTERM)
        #expect(try !ProcessTable.signal(SIGKILL, to: reading.process))
    }

    private func process(
        _ pid: pid_t, parent: pid_t = 1, start: UInt64, executable: String = "/usr/local/bin/node"
    ) -> LocalProcess {
        LocalProcess(identity: ProcessIdentity(pid: pid, startSeconds: start, startMicroseconds: 0),
                     parent: parent, executable: executable)
    }
}
