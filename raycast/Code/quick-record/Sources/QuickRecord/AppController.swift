import AppKit
import AVFoundation
import ScreenCaptureKit
import SwiftUI
import OSLog

@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    private enum Phase: String { case idle, selecting, starting, recording, stopping }
    private var phase: Phase = .idle { didSet { updateMenu(); writeStatus() } }
    private let defaults = UserDefaults.standard
    private let logger = Logger(subsystem: "com.acerom.quickrecord", category: "recording")
    private var statusItem: NSStatusItem!
    private let selector = RegionSelector()
    private var session: RecordingSession?
    private var contentTask: Task<SCShareableContent, Error>?
    private var startTask: Task<Void, Never>?
    private var timer: Timer?
    private var startedAt: Date?
    private var requestedAt: Date?
    private var startLatencyMS: Int?
    private var stopWhenReady = false
    private var previousApp: NSRunningApplication?
    private var toast: NSPanel?
    private var toastTimer: Timer?
    private var lastError: String?

    private var recordingsDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Quick Record", isDirectory: true)
    }
    private var lastFile: URL? {
        guard let path = defaults.string(forKey: "lastFile"), FileManager.default.fileExists(atPath: path) else { return nil }
        return URL(fileURLWithPath: path)
    }
    private var lastRegion: CaptureRegion? {
        guard let data = defaults.data(forKey: "lastRegion") else { return nil }
        return try? JSONDecoder().decode(CaptureRegion.self, from: data)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        defaults.register(defaults: ["microphone": false, "systemAudio": false])
        updateMenu()
        writeStatus()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "quickrecord" {
            switch url.host {
            case "toggle": toggle()
            case "last": toggle(useLastRegion: true)
            case "stop": stop()
            case "quit": if phase == .idle { NSApp.terminate(nil) }
            default: break
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Launching/reopening keeps the helper resident. Only an explicit command
        // or menu action may start/stop a recording.
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard phase == .idle || phase == .selecting else {
            stop()
            return .terminateCancel
        }
        selector.cancel()
        return .terminateNow
    }

    @objc private func toggleFromMenu() { toggle() }
    @objc private func lastFromMenu() { toggle(useLastRegion: true) }

    private func toggle(useLastRegion: Bool = false) {
        switch phase {
        case .recording, .starting: stop(); return
        case .stopping: return
        case .selecting: selector.cancel(); return
        case .idle: break
        }
        toast?.orderOut(nil)
        previousApp = NSWorkspace.shared.frontmostApplication
        lastError = nil
        startLatencyMS = nil
        stopWhenReady = false
        // Fetch content while the user drags, without capturing anything yet.
        if CGPreflightScreenCaptureAccess() {
            contentTask = Task { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
        }
        if useLastRegion, let region = lastRegion,
           let screen = NSScreen.screens.first(where: { $0.displayUUID == region.displayUUID }),
           region.fits(in: screen.frame.size) {
            beginCapture(region)
            return
        }
        phase = .selecting
        selector.show { [weak self] region in
            guard let self else { return }
            self.restoreFocus()
            guard let region else {
                self.contentTask?.cancel()
                self.contentTask = nil
                self.phase = .idle
                return
            }
            if let data = try? JSONEncoder().encode(region) { self.defaults.set(data, forKey: "lastRegion") }
            self.beginCapture(region)
        }
    }

    private func beginCapture(_ region: CaptureRegion) {
        phase = .starting
        requestedAt = Date()
        startTask = Task { [weak self] in
            guard let self else { return }
            guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
                self.phase = .idle
                self.contentTask = nil
                self.showScreenPermissionHelp()
                return
            }
            do {
                let microphone = self.defaults.bool(forKey: "microphone")
                if microphone {
                    let granted = await AVCaptureDevice.requestAccess(for: .audio)
                    guard granted else { throw RecordingError.microphoneDenied }
                }
                guard !self.stopWhenReady else { self.contentTask = nil; self.phase = .idle; return }
                guard let screen = NSScreen.screens.first(where: { $0.displayUUID == region.displayUUID }),
                      region.fits(in: screen.frame.size) else { throw RecordingError.displayChanged }
                let content: SCShareableContent
                if let task = self.contentTask { content = try await task.value }
                else { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
                self.contentTask = nil
                guard !self.stopWhenReady else { self.phase = .idle; return }
                guard let display = content.displays.first(where: { $0.displayID == screen.displayID }) else {
                    throw RecordingError.displayChanged
                }
                try FileManager.default.createDirectory(at: self.recordingsDirectory, withIntermediateDirectories: true)
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
                let name = "Recording \(formatter.string(from: Date())) \(UUID().uuidString.prefix(6)).mp4"
                let session = RecordingSession(url: self.recordingsDirectory.appendingPathComponent(name))
                self.session = session
                session.onStarted = { [weak self, weak session] in
                    guard let self, let session, self.session === session else { return }
                    self.startedAt = Date()
                    self.startLatencyMS = Int(Date().timeIntervalSince(self.requestedAt ?? Date()) * 1000)
                    self.logger.info("Recording started in \(self.startLatencyMS ?? 0) ms")
                    if self.phase != .stopping { self.phase = .recording }
                    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                        Task { @MainActor in self?.updateMenu() }
                    }
                    self.timer = timer
                    RunLoop.main.add(timer, forMode: .common)
                }
                session.onFinished = { [weak self, weak session] result in
                    guard let self, let session, self.session === session else { return }
                    self.finish(result)
                }
                await session.start(display: display, region: region, scale: screen.backingScaleFactor,
                                    applications: content.applications, microphone: microphone,
                                    systemAudio: self.defaults.bool(forKey: "systemAudio"))
            } catch { self.finish(.failure(error)) }
        }
    }

    private func stop() {
        if phase == .selecting { selector.cancel(); return }
        guard phase == .starting || phase == .recording else { return }
        stopWhenReady = true
        phase = .stopping
        if let session { Task { await session.stop() } }
    }

    private func finish(_ result: Result<URL, Error>) {
        timer?.invalidate()
        timer = nil
        startedAt = nil
        session = nil
        contentTask = nil
        startTask = nil
        switch result {
        case .success(let url):
            defaults.set(url.path, forKey: "lastFile")
            lastError = nil
            phase = .idle
            logger.info("Recording finalized")
            showToast(title: "Recording saved", detail: url.lastPathComponent, file: url)
        case .failure(let error):
            lastError = error.localizedDescription
            phase = .idle
            logger.error("Recording failed: \(error.localizedDescription, privacy: .public)")
            showToast(title: "Recording failed", detail: error.localizedDescription)
        }
    }

    private func restoreFocus() {
        if let previousApp, previousApp.bundleIdentifier != Bundle.main.bundleIdentifier,
           previousApp.bundleIdentifier != "com.raycast.macos" {
            previousApp.activate(options: [])
        } else { NSApp.hide(nil) }
        previousApp = nil
    }

    private func updateMenu() {
        guard let button = statusItem?.button else { return }
        let active = phase == .recording || phase == .starting || phase == .stopping
        let symbol = active ? "record.circle.fill" : "record.circle"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Quick Record")
        image?.isTemplate = !active
        if active {
            let tinted = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
                image?.draw(in: rect)
                NSColor.systemRed.setFill()
                rect.fill(using: .sourceAtop)
                return true
            }
            button.image = tinted
        } else { button.image = image }
        button.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        let seconds = Int(Date().timeIntervalSince(startedAt ?? Date()))
        switch phase {
        case .recording: button.title = String(format: " %02d:%02d", seconds / 60, seconds % 60)
        case .starting: button.title = " Starting…"
        case .stopping: button.title = " Saving…"
        default: button.title = ""
        }
        button.toolTip = "Quick Record — \(phase.rawValue)"
        let menu = NSMenu()
        menu.autoenablesItems = false
        let title: String
        switch phase {
        case .idle: title = "Record Region…"
        case .selecting: title = "Cancel Selection"
        case .starting, .recording: title = "Stop Recording"
        case .stopping: title = "Saving Recording…"
        }
        item(title, action: #selector(toggleFromMenu), in: menu, enabled: phase != .stopping)
        item("Record Last Region", action: #selector(lastFromMenu), in: menu, enabled: phase == .idle && lastRegion != nil)
        menu.addItem(.separator())
        item("Microphone", action: #selector(toggleMicrophone), in: menu, enabled: phase == .idle,
             checked: defaults.bool(forKey: "microphone"))
        item("System Audio", action: #selector(toggleSystemAudio), in: menu, enabled: phase == .idle,
             checked: defaults.bool(forKey: "systemAudio"))
        menu.addItem(.separator())
        item("Copy Last Recording", action: #selector(copyLast), in: menu, enabled: lastFile != nil)
        item("Reveal Last Recording", action: #selector(revealLast), in: menu, enabled: lastFile != nil)
        item("Open Recordings Folder", action: #selector(openFolder), in: menu)
        menu.addItem(.separator())
        if !CGPreflightScreenCaptureAccess() { item("Allow Screen Recording…", action: #selector(showScreenPermissionHelp), in: menu) }
        item("Quit Quick Record", action: #selector(quit), in: menu, enabled: phase == .idle)
        statusItem.menu = menu
    }

    private func item(_ title: String, action: Selector, in menu: NSMenu, enabled: Bool = true, checked: Bool = false) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = enabled
        item.state = checked ? .on : .off
        menu.addItem(item)
    }

    @objc private func toggleMicrophone() { defaults.set(!defaults.bool(forKey: "microphone"), forKey: "microphone"); updateMenu() }
    @objc private func toggleSystemAudio() { defaults.set(!defaults.bool(forKey: "systemAudio"), forKey: "systemAudio"); updateMenu() }
    @objc private func copyLast() { if let lastFile { copy(lastFile) } }
    @objc private func revealLast() { if let lastFile { NSWorkspace.shared.activateFileViewerSelecting([lastFile]) } }
    @objc private func openFolder() {
        do {
            try FileManager.default.createDirectory(at: recordingsDirectory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(recordingsDirectory)
        } catch { showToast(title: "Couldn’t open recordings", detail: error.localizedDescription) }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    private func copy(_ url: URL) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([url as NSURL])
    }

    @objc private func showScreenPermissionHelp() {
        let alert = NSAlert()
        alert.messageText = "Allow Quick Record to record your screen"
        alert.informativeText = "In System Settings → Privacy & Security → Screen & System Audio Recording, enable Quick Record. Then quit and reopen Quick Record if macOS asks, and run Toggle Recording again."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    private func showToast(title: String, detail: String, file: URL? = nil) {
        toastTimer?.invalidate()
        toast?.close()
        let panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 370, height: 138),
                            styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Quick Record"
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: SavedToast(title: title, detail: detail, file: file,
            onCopy: { [weak self, weak panel] in if let file { self?.copy(file) }; panel?.orderOut(nil) },
            onReveal: { [weak panel] in if let file { NSWorkspace.shared.activateFileViewerSelecting([file]) }; panel?.orderOut(nil) }))
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main {
            panel.setFrameOrigin(CGPoint(x: screen.visibleFrame.maxX - panel.frame.width - 20,
                                         y: screen.visibleFrame.minY + 20))
        }
        toast = panel
        panel.orderFrontRegardless()
        toastTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak panel] _ in
            Task { @MainActor in panel?.orderOut(nil) }
        }
    }

    /// Local diagnostics also let the installer avoid replacing an active recorder.
    private func writeStatus() {
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Quick Record")
        let values: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "state": phase.rawValue,
            "screenPermission": CGPreflightScreenCaptureAccess(),
            "lastFile": lastFile?.path ?? "",
            "error": lastError ?? "",
            "startLatencyMS": startLatencyMS ?? -1,
        ]
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: directory.appendingPathComponent("status.json"), options: .atomic)
        } catch { logger.error("Couldn’t write recorder status: \(error.localizedDescription, privacy: .public)") }
    }
}

private enum RecordingError: LocalizedError {
    case microphoneDenied, displayChanged
    var errorDescription: String? {
        switch self {
        case .microphoneDenied: return "Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone, or turn Microphone off in the Quick Record menu."
        case .displayChanged: return "The selected display or region changed. Use Record Region to choose a new box."
        }
    }
}

private struct SavedToast: View {
    let title: String
    let detail: String
    let file: URL?
    let onCopy: () -> Void
    let onReveal: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: file == nil ? "exclamationmark.triangle" : "checkmark.circle")
                .font(.system(size: 14, weight: .medium))
            Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
                .lineLimit(3).textSelection(.enabled)
            if file != nil {
                HStack(spacing: 10) {
                    Button("Copy File", action: onCopy)
                    Button("Reveal in Finder", action: onReveal)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
