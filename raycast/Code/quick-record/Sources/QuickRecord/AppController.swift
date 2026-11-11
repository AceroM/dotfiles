import AppKit
import AVFoundation
import QuartzCore
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
    /// Set by the audio toggle: records microphone and system audio regardless of the menu settings.
    private var forceAudio = false
    private var previousApp: NSRunningApplication?
    private var toast: NSPanel?
    private var toastTimer: Timer?
    private var lastError: String?
    /// Demo mode (fn+⌥Q): annotation overlay, microphone narration, and a HAR from Chrome.
    private var demoMode = false
    private var demo: DemoOverlay?
    private var demoTargetApp: NSRunningApplication?
    private var demoVideo: URL?
    private let har = HARBridge()
    private var harID: String?
    private var harStarted = false
    private var harBrowser = "Chrome"
    private var harFile: URL?
    private var harEntries = 0
    private var harNote: String?
    private var harTimeout: Timer?
    /// The demo's drawings with their times, saved beside the video as `.excalidraw`.
    private var annotations: AnnotationLog?
    private var annotationsFile: URL?

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
        har.onEvent = { [weak self] in self?.handleHAR($0) }
        updateMenu()
        writeStatus()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "quickrecord" {
            switch url.host {
            case "toggle": toggle()
            case "last": toggle(useLastRegion: true)
            case "toggle-audio": toggle(withAudio: true)
            case "toggle-demo": toggle(demo: true)
            case "annotate": demo?.toggleDrawing()
            case "dictate": demo?.toggleDictation()
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
    @objc private func demoFromMenu() { toggle(demo: true) }

    private func toggle(useLastRegion: Bool = false, withAudio: Bool = false, demo: Bool = false) {
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
        forceAudio = withAudio
        demoMode = demo
        demoTargetApp = demo ? previousApp : nil
        resetHAR()
        // Fetch content while the user selects, without capturing anything yet. Demo mode
        // fetches again once its canvas window exists, so it can keep that one window.
        if CGPreflightScreenCaptureAccess(), !demo {
            contentTask = Task { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
        }
        if useLastRegion, let region = lastRegion,
           let screen = NSScreen.screens.first(where: { $0.displayUUID == region.displayUUID }),
           region.fits(in: screen.frame.size) {
            beginCapture(region)
            return
        }
        phase = .selecting
        selector.show(lastRegion: lastRegion) { [weak self] region in
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
                // Demo mode always records the narration.
                let microphone = self.forceAudio || self.demoMode || self.defaults.bool(forKey: "microphone")
                let systemAudio = self.forceAudio || self.defaults.bool(forKey: "systemAudio")
                if microphone {
                    let granted = await AVCaptureDevice.requestAccess(for: .audio)
                    guard granted else { throw RecordingError.microphoneDenied }
                }
                guard !self.stopWhenReady else { self.contentTask = nil; self.phase = .idle; return }
                guard let screen = NSScreen.screens.first(where: { $0.displayUUID == region.displayUUID }),
                      region.fits(in: screen.frame.size) else { throw RecordingError.displayChanged }
                let content: SCShareableContent
                var includedWindows: [SCWindow] = []
                if self.demoMode {
                    let size = region.outputSize(scale: screen.backingScaleFactor)
                    let log = AnnotationLog(canvasSize: region.rect.size, videoSize: CGSize(width: size.width, height: size.height))
                    self.annotations = log
                    let overlay = DemoOverlay(region: region, screen: screen, targetApp: self.demoTargetApp, log: log)
                    overlay.onStop = { [weak self] in self?.stop() }
                    overlay.onClosed = { [weak self] in
                        log.overlayClosed = true
                        if self?.saveAnnotations(log) == true, self?.demoVideo != nil { self?.showDemoToast() }
                    }
                    self.demo = overlay
                    overlay.show()
                    (content, includedWindows) = try await self.shareableContent(including: overlay.canvasWindowID)
                    if includedWindows.isEmpty { self.logger.error("Annotation canvas missing from shareable content") }
                } else if let task = self.contentTask { content = try await task.value }
                else { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
                self.contentTask = nil
                guard !self.stopWhenReady else { self.closeDemo(); self.phase = .idle; return }
                guard let display = content.displays.first(where: { $0.displayID == screen.displayID }) else {
                    throw RecordingError.displayChanged
                }
                try FileManager.default.createDirectory(at: self.recordingsDirectory, withIntermediateDirectories: true)
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
                let name = "\(self.demoMode ? "Demo" : "Recording") \(formatter.string(from: Date())) \(UUID().uuidString.prefix(6)).mp4"
                let session = RecordingSession(url: self.recordingsDirectory.appendingPathComponent(name))
                self.session = session
                // Chrome reports window bounds in global display points, top-left origin.
                let displayBounds = CGDisplayBounds(screen.displayID)
                let globalRegion = region.rect.offsetBy(dx: displayBounds.minX, dy: displayBounds.minY)
                if self.demoMode {
                    session.onCaptureStopped = { [weak self] in self?.closeDemo() }
                }
                session.onStarted = { [weak self, weak session] firstFrameHostTime in
                    guard let self, let session, self.session === session else { return }
                    // The video's t = 0 on the wall clock: the HAR and the drawings count from here.
                    let videoStart = Date(timeIntervalSinceNow: firstFrameHostTime - CACurrentMediaTime())
                    self.startedAt = videoStart
                    self.annotations?.videoStarted(hostTime: firstFrameHostTime, date: videoStart)
                    self.startLatencyMS = Int(Date().timeIntervalSince(self.requestedAt ?? Date()) * 1000)
                    self.logger.info("Recording started in \(self.startLatencyMS ?? 0) ms")
                    if self.phase != .stopping { self.phase = .recording }
                    // Not once a stop is queued: the HAR's stop would already have been sent.
                    if self.demoMode && self.phase == .recording {
                        self.startHAR(video: session.url, region: globalRegion, startedAt: videoStart)
                    }
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
                                    systemAudio: systemAudio, includedWindows: includedWindows)
            } catch { self.finish(.failure(error)) }
        }
    }

    /// Retries briefly: a window ordered in a moment ago can be missing from the first listing.
    private func shareableContent(including windowID: CGWindowID) async throws -> (SCShareableContent, [SCWindow]) {
        var attempt = 0
        while true {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let windows = content.windows.filter { $0.windowID == windowID }
            attempt += 1
            if !windows.isEmpty || attempt >= 10 { return (content, windows) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func stop() {
        if phase == .selecting { selector.cancel(); return }
        guard phase == .starting || phase == .recording else { return }
        stopWhenReady = true
        phase = .stopping
        annotations?.videoEnded()
        if demoMode, let harID {
            har.stop(id: harID)
            if harStarted { demo?.setHAR(.saving) }
        }
        if let session { Task { await session.stop() } }
    }

    private func finish(_ result: Result<URL, Error>) {
        timer?.invalidate()
        timer = nil
        startedAt = nil
        session = nil
        contentTask = nil
        startTask = nil
        closeDemo()
        switch result {
        case .success(let url):
            defaults.set(url.path, forKey: "lastFile")
            lastError = nil
            phase = .idle
            logger.info("Recording finalized")
            if demoMode {
                demoVideo = url
                if let annotations {
                    annotations.video = url
                    saveAnnotations(annotations)
                }
                showDemoToast()
            } else {
                showToast(title: "Recording saved", detail: url.lastPathComponent, files: [url])
            }
        case .failure(let error):
            lastError = error.localizedDescription
            phase = .idle
            logger.error("Recording failed: \(error.localizedDescription, privacy: .public)")
            showToast(title: "Recording failed", detail: error.localizedDescription)
        }
    }

    private func closeDemo() {
        demo?.close()
        demo = nil
    }

    // MARK: Annotations

    /// Writes `Demo ….excalidraw` beside the video once both are ready: the video saved, and the
    /// overlay closed (a label waiting on Wispr's transcript can hold it open past the stop).
    /// True when it wrote the file.
    @discardableResult
    private func saveAnnotations(_ log: AnnotationLog) -> Bool {
        guard log.overlayClosed, let video = log.video, !log.saved else { return false }
        log.saved = true
        guard !log.isEmpty else { return false }
        let url = video.deletingPathExtension().appendingPathExtension("excalidraw")
        do {
            try log.write(to: url)
        } catch {
            logger.error("Couldn’t save the annotations: \(error.localizedDescription, privacy: .public)")
            return false
        }
        guard annotations === log else { return false }
        annotationsFile = url
        return true
    }

    // MARK: HAR

    private func resetHAR() {
        harTimeout?.invalidate()
        harTimeout = nil
        harID = nil
        harStarted = false
        harFile = nil
        harEntries = 0
        harNote = nil
        demoVideo = nil
        annotations = nil
        annotationsFile = nil
    }

    private func startHAR(video: URL, region: CGRect, startedAt: Date) {
        let id = UUID().uuidString
        harID = id
        har.start(id: id, path: video.deletingPathExtension().appendingPathExtension("har"), startedAt: startedAt, region: region)
        // The extension answers within a moment when Chrome has it loaded.
        harTimeout = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.harID == id, !self.harStarted else { return }
                self.demo?.setHAR(.unavailable)
            }
        }
    }

    private func handleHAR(_ event: HAREvent) {
        guard event.id == harID else { return }
        switch event.kind {
        case .started:
            harStarted = true
            harBrowser = event.browser
            demo?.setHAR(.recording(event.browser))
        case .saved:
            guard harFile == nil, let path = event.path else { return }
            harStarted = true
            harBrowser = event.browser
            harFile = URL(fileURLWithPath: path)
            harEntries = event.entries
            harNote = nil
            demo?.setHAR(.saved(event.entries))
            if demoVideo != nil { showDemoToast() }
        case .failed:
            guard harFile == nil else { return }
            harNote = "HAR failed: \(event.message ?? "unknown error")"
            if demoVideo != nil { showDemoToast() }
        }
    }

    private func showDemoToast() {
        guard let video = demoVideo else { return }
        var lines = [video.lastPathComponent]
        var files = [video]
        if let annotationsFile, let annotations {
            files.append(annotationsFile)
            let drawn = annotations.shapes.count, pointed = annotations.laserStrokes.count
            var parts: [String] = []
            if drawn > 0 { parts.append("\(drawn) annotation\(drawn == 1 ? "" : "s")") }
            if pointed > 0 { parts.append("\(pointed) laser stroke\(pointed == 1 ? "" : "s")") }
            lines.append("Drawings: \(parts.joined(separator: ", "))")
        }
        if let harFile {
            files.append(harFile)
            lines.append("HAR: \(harEntries) request\(harEntries == 1 ? "" : "s") from \(harBrowser)")
        } else if let harNote {
            lines.append(harNote)
        } else if harStarted {
            lines.append("Saving the HAR from \(harBrowser)…")
        } else {
            lines.append("No HAR: the Quick Record HAR extension isn’t connected in Chrome.")
        }
        showToast(title: "Demo saved", detail: lines.joined(separator: "\n"), files: files)
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
        case .recording:
            button.title = String(format: " %02d:%02d", seconds / 60, seconds % 60)
            demo?.setElapsed(String(format: "%02d:%02d", seconds / 60, seconds % 60))
        case .starting: button.title = " Starting…"
        case .stopping:
            button.title = " Saving…"
            demo?.setElapsed("Saving…")
        default: button.title = ""
        }
        button.toolTip = "Quick Record — \(phase.rawValue)"
        let menu = NSMenu()
        menu.autoenablesItems = false
        let title: String
        switch phase {
        case .idle: title = "Record Window or Region…"
        case .selecting: title = "Cancel Selection"
        case .starting, .recording: title = "Stop Recording"
        case .stopping: title = "Saving Recording…"
        }
        item(title, action: #selector(toggleFromMenu), in: menu, enabled: phase != .stopping)
        item("Record Last Region", action: #selector(lastFromMenu), in: menu, enabled: phase == .idle && lastRegion != nil)
        item("Record Demo (Draw, Narrate, HAR)…", action: #selector(demoFromMenu), in: menu, enabled: phase == .idle)
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
    @objc private func copyLast() { if let lastFile { copy([lastFile]) } }
    @objc private func revealLast() { if let lastFile { NSWorkspace.shared.activateFileViewerSelecting([lastFile]) } }
    @objc private func openFolder() {
        do {
            try FileManager.default.createDirectory(at: recordingsDirectory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(recordingsDirectory)
        } catch { showToast(title: "Couldn’t open recordings", detail: error.localizedDescription) }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    /// A demo's video and HAR go together, so one paste attaches both.
    private func copy(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects(urls.map { $0 as NSURL })
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

    private func showToast(title: String, detail: String, files: [URL] = []) {
        toastTimer?.invalidate()
        toast?.close()
        let lineCount = detail.components(separatedBy: "\n").count
        let height: CGFloat = lineCount > 2 ? 174 : (lineCount > 1 ? 156 : 138)
        let panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 370, height: height),
                            styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Quick Record"
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: SavedToast(title: title, detail: detail, files: files,
            onCopy: { [weak self, weak panel] in self?.copy(files); panel?.orderOut(nil) },
            onReveal: { [weak panel] in NSWorkspace.shared.activateFileViewerSelecting(files); panel?.orderOut(nil) }))
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
            "demo": demoMode && phase != .idle,
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
        case .displayChanged: return "The selected display or region changed. Use Record Window or Region to choose a new area."
        }
    }
}

private struct SavedToast: View {
    let title: String
    let detail: String
    let files: [URL]
    let onCopy: () -> Void
    let onReveal: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: files.isEmpty ? "exclamationmark.triangle" : "checkmark.circle")
                .font(.system(size: 14, weight: .medium))
            Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
                .lineLimit(4).textSelection(.enabled)
            if !files.isEmpty {
                HStack(spacing: 10) {
                    Button(files.count > 1 ? "Copy Files" : "Copy File", action: onCopy)
                    Button("Reveal in Finder", action: onReveal)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
