import AppKit
import Carbon.HIToolbox
import OSLog
import ServiceManagement

@MainActor
final class AppController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let logger = Logger(subsystem: "com.acerom.quickshot", category: "app")
    private let hotKeys = HotKeys()
    private let selector = RegionSelector()
    private var statusItem: NSStatusItem?
    private var editors: [ShotEditor] = []
    private var previousApp: NSRunningApplication?
    private var isCapturing = false
    private var missingHotKeys: [UInt32] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let commandShift = cmdKey | shiftKey
        hotKeys.add(1, keyCode: kVK_ANSI_2, modifiers: commandShift) { [weak self] in self?.capture(.area) }
        hotKeys.add(2, keyCode: kVK_ANSI_1, modifiers: commandShift) { [weak self] in self?.captureFullScreen() }
        missingHotKeys = hotKeys.registerMissing()
        if !missingHotKeys.isEmpty { logger.error("Hotkeys unavailable: \(self.missingHotKeys, privacy: .public)") }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: "Quick Shot")
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        // Retry here so quitting a conflicting app (e.g. Shottr) frees the shortcut without a relaunch.
        missingHotKeys = hotKeys.registerMissing()
        menu.removeAllItems()
        let area = menu.addItem(withTitle: "Capture Area", action: #selector(captureArea), keyEquivalent: "2")
        area.keyEquivalentModifierMask = [.command, .shift]
        let full = menu.addItem(withTitle: "Capture Full Screen", action: #selector(captureFullScreen), keyEquivalent: "1")
        full.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(withTitle: "Capture Window", action: #selector(captureWindow), keyEquivalent: "")
        if !missingHotKeys.isEmpty {
            menu.addItem(.separator())
            let warning = menu.addItem(withTitle: "Shortcut taken by another app (quit Shottr?)", action: nil,
                                       keyEquivalent: "")
            warning.isEnabled = false
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open Saved Shots Folder", action: #selector(openFolder), keyEquivalent: "")
        let login = menu.addItem(withTitle: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Quick Shot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.items.forEach { if $0.action != #selector(NSApplication.terminate(_:)) { $0.target = self } }
    }

    @objc private func captureArea() { capture(.area) }
    @objc private func captureWindow() { capture(.window) }

    @objc private func openFolder() {
        try? FileManager.default.createDirectory(at: ShotEditor.saveFolder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(ShotEditor.saveFolder)
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            alert("Couldn't change Open at Login", error.localizedDescription)
        }
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let string = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: string) else { return }
        switch url.host {
        case "area": capture(.area)
        case "window": capture(.window)
        case "full": captureFullScreen()
        case "quit": NSApp.terminate(nil)
        default: logger.error("Unknown command \(string, privacy: .public)")
        }
    }

    /// The display under the pointer, straight into the editor.
    @objc func captureFullScreen() {
        if selector.isActive { selector.cancel() }
        guard !isCapturing, hasScreenAccess() else { return }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let screen else { return }
        isCapturing = true
        rememberFrontApp()
        Task {
            defer { isCapturing = false }
            do { open(try await Capture.display(id: screen.displayID)) }
            catch {
                restoreFocus()
                alert("Capture failed", error.localizedDescription)
            }
        }
    }

    private func hasScreenAccess() -> Bool {
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            alert("Screen Recording permission needed",
                  "Enable Quick Shot in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.")
            return false
        }
        return true
    }

    private func rememberFrontApp() {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != getpid() {
            previousApp = NSWorkspace.shared.frontmostApplication
        }
    }

    /// The same shortcut again cancels an open selector.
    func capture(_ mode: CaptureMode) {
        if selector.isActive { selector.cancel(); return }
        guard !isCapturing, hasScreenAccess() else { return }
        isCapturing = true
        rememberFrontApp()
        Task {
            do {
                let frozen = mode == .area ? try await Capture.displays() : [:]
                selector.show(mode: mode, frozen: frozen) { [weak self] selection in
                    self?.finish(selection, frozen: frozen)
                }
            } catch {
                isCapturing = false
                alert("Capture failed", error.localizedDescription)
            }
        }
    }

    private func finish(_ selection: Selection?, frozen: [CGDirectDisplayID: Shot]) {
        switch selection {
        case nil:
            isCapturing = false
            restoreFocus()
        case .region(let displayID, let rect):
            isCapturing = false
            guard let shot = frozen[displayID],
                  let image = shot.image.cropping(to: CGRect(x: rect.minX * shot.scale, y: rect.minY * shot.scale,
                                                             width: rect.width * shot.scale,
                                                             height: rect.height * shot.scale).integral) else {
                restoreFocus()
                return
            }
            open(Shot(image: image, scale: shot.scale))
        case .window(let id):
            Task {
                defer { isCapturing = false }
                do { open(try await Capture.window(id: id)) }
                catch { alert("Capture failed", error.localizedDescription) }
            }
        }
    }

    private func open(_ shot: Shot) {
        let editor = ShotEditor(shot: shot)
        editor.onClose = { [weak self] closed in
            self?.editors.removeAll { $0 === closed }
            if self?.editors.isEmpty == true { self?.restoreFocus() }
        }
        editors.append(editor)
        editor.show()
    }

    private func restoreFocus() {
        previousApp?.activate()
        previousApp = nil
    }

    private func alert(_ title: String, _ message: String) {
        logger.error("\(title, privacy: .public): \(message, privacy: .public)")
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}
