import AppKit
import Darwin

@MainActor
final class MemoryMonitor {
    static let defaultLimits = Limits.defaults(physicalMemory: ProcessInfo.processInfo.physicalMemory)
    private static let chromeID = "com.google.Chrome"
    private let preferences = UserDefaults.standard
    private var breaches = BreachTracker()
    private var chromeRestarting = false
    private var chromeCooldownUntil: ContinuousClock.Instant?
    private var stoppingCommands: Set<ProcessIdentity> = []
    private var samplingTask: Task<Void, Never>?
    private(set) var snapshot: Snapshot?
    private(set) var sampleFailed = false
    private(set) var lastAction: String?

    var onChange: (() -> Void)?
    var onChromeRestart: ((UInt64) -> Void)?

    var paused: Bool {
        get { preferences.bool(forKey: "paused") }
        set {
            preferences.set(newValue, forKey: "paused")
            breaches = BreachTracker()
            EventLog.append(newValue ? "Monitoring paused" : "Monitoring resumed")
            onChange?()
        }
    }

    var limits: Limits {
        get {
            let defaults = Self.defaultLimits
            return Limits(
                nodeGiB: savedLimit("nodeGiB", default: defaults.nodeGiB),
                tsgoGiB: savedLimit("tsgoGiB", default: defaults.tsgoGiB),
                chromeGiB: savedLimit("chromeGiB", default: defaults.chromeGiB)
            )
        }
        set {
            preferences.set(newValue.nodeGiB, forKey: "nodeGiB")
            preferences.set(newValue.tsgoGiB, forKey: "tsgoGiB")
            preferences.set(newValue.chromeGiB, forKey: "chromeGiB")
            breaches = BreachTracker()
            EventLog.append("Limits set to Node \(newValue.nodeGiB) GiB, tsgo \(newValue.tsgoGiB) GiB, Chrome \(newValue.chromeGiB) GiB")
            onChange?()
        }
    }

    func start() {
        samplingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.sample()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func savedLimit(_ key: String, default fallback: Int) -> Int {
        let value = preferences.integer(forKey: key)
        return (1...1024).contains(value) ? value : fallback
    }

    private func sample() async {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: Self.chromeID)
        let descriptors = apps.compactMap { app -> ChromeApp? in
            guard app.activationPolicy == .regular,
                  let bundle = app.bundleURL, let executable = app.executableURL else { return nil }
            return ChromeApp(pid: app.processIdentifier,
                             bundle: bundle.resolvingSymlinksInPath(),
                             executable: executable.resolvingSymlinksInPath().path)
        }
        let fresh: Snapshot
        do {
            fresh = try await Task.detached(priority: .utility) { try Snapshot.collect(chrome: descriptors) }.value
        } catch {
            if !sampleFailed { EventLog.append("Couldn't read the process table: \(error.localizedDescription)") }
            sampleFailed = true
            snapshot = nil
            breaches = BreachTracker()
            onChange?()
            return
        }
        if snapshot == nil {
            let node = fresh.peak(for: .node).map(formatGiB) ?? "none"
            let tsgo = fresh.peak(for: .tsgo).map(formatGiB) ?? "none"
            let chrome = fresh.chromePeak.map(formatGiB) ?? "none"
            EventLog.append("Monitoring \(paused ? "paused" : "ready"). Node peak \(node) / \(limits.nodeGiB) GiB. tsgo peak \(tsgo) / \(limits.tsgoGiB) GiB. Chrome \(chrome) / \(limits.chromeGiB) GiB.")
        }
        sampleFailed = false
        snapshot = fresh
        onChange?()
        guard !paused else { return }

        let chromeReady = !chromeRestarting && (chromeCooldownUntil.map { $0 <= .now } ?? true)
        let eligible = chromeReady ? fresh.commands + fresh.chrome : fresh.commands
        for reading in breaches.observe(eligible, limits: limits) {
            switch reading.target {
            case .command(let command):
                guard stoppingCommands.insert(reading.process.identity).inserted else { continue }
                Task { await stopCommand(reading, command: command) }
            case .chrome(let descriptor):
                guard !chromeRestarting,
                      let app = apps.first(where: { $0.processIdentifier == descriptor.pid }) else { continue }
                chromeRestarting = true
                chromeCooldownUntil = ContinuousClock.now + .seconds(300)
                Task { await restartChrome(reading, app: app, bundle: descriptor.bundle) }
            }
        }
    }

    private func stopCommand(_ reading: Reading, command: MonitoredCommand) async {
        let process = reading.process
        defer { stoppingCommands.remove(process.identity) }
        guard !paused else { return }
        let cwd = ProcessTable.workingDirectory(process.pid) ?? "unknown"
        let label = "\(command.displayName) PID \(process.pid)"
        let detail = "\(label), \(formatGiB(reading.bytes)), cwd \(cwd)"
        do {
            guard try ProcessTable.signal(SIGTERM, to: process) else { return }
            EventLog.append("Sent SIGTERM to \(detail)")
            if await waitForExit(process, seconds: 5) {
                record("Stopped \(label)", detail: "Stopped \(detail)")
                return
            }
            if try ProcessTable.signal(SIGKILL, to: process) {
                EventLog.append("Sent SIGKILL to \(detail)")
            }
            if await waitForExit(process, seconds: 3) {
                record("Stopped \(label)", detail: "Stopped \(detail)")
            } else {
                record("Couldn't stop \(label)", detail: "\(label) was still running after SIGKILL")
            }
        } catch {
            record("Couldn't stop \(label)", detail: "Couldn't stop \(detail): \(error.localizedDescription)")
        }
    }

    private func restartChrome(_ reading: Reading, app: NSRunningApplication, bundle: URL) async {
        defer { chromeRestarting = false }
        let process = reading.process
        let detail = "Chrome PID \(process.pid), \(formatGiB(reading.bytes)) total"
        guard !paused, !app.isTerminated, ProcessTable.isCurrent(process) else { return }
        record("Restarting Chrome…", detail: "Restarting \(detail)")
        do {
            if !app.terminate() {
                try ProcessTable.signal(SIGTERM, to: process)
            }
            if !(await waitForExit(process, seconds: 8)) {
                if try ProcessTable.signal(SIGKILL, to: process) {
                    EventLog.append("Sent SIGKILL to \(detail)")
                }
                guard await waitForExit(process, seconds: 3) else {
                    record("Couldn't stop Chrome", detail: "\(detail) was still running after SIGKILL")
                    return
                }
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.arguments = ["--restore-last-session"]
            let launched = try await NSWorkspace.shared.openApplication(at: bundle, configuration: configuration)
            record("Restarted Chrome", detail: "Restarted Chrome (PID \(process.pid) → \(launched.processIdentifier))")
            onChromeRestart?(reading.bytes)
        } catch {
            record("Couldn't restart Chrome", detail: "Couldn't restart \(detail): \(error.localizedDescription)")
        }
    }

    private func waitForExit(_ process: LocalProcess, seconds: Int) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while ProcessTable.isCurrent(process) {
            if ContinuousClock.now >= deadline { return false }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return true
    }

    private func record(_ summary: String, detail: String) {
        lastAction = summary
        EventLog.append(detail)
        onChange?()
    }
}

func formatGiB(_ bytes: UInt64) -> String {
    String(format: "%.1f GiB", Double(bytes) / Double(gibibyte))
}
