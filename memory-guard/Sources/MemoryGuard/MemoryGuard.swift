import AppKit

@main
struct MemoryGuard {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let controller = MenuBar()
        app.setActivationPolicy(.accessory)
        app.delegate = controller
        withExtendedLifetime(controller) { app.run() }
    }
}

@MainActor
private final class MenuBar: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let monitor = MemoryMonitor()
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let name = "MemoryGuard"
        let position = "NSStatusItem Preferred Position \(name)"
        let defaults = UserDefaults.standard
        // Seed the rightmost position only until macOS has a saved position for this item.
        if defaults.object(forKey: position) == nil {
            defaults.set(0, forKey: position)
        }
        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.autosaveName = name
        let menu = NSMenu()
        menu.delegate = self
        status.menu = menu
        statusItem = status
        monitor.onChange = { [weak self] in self?.updateStatus() }
        updateStatus()
        monitor.start()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        add("Memory Guard", to: menu)
        if monitor.paused {
            add("Monitoring paused", to: menu)
        }
        let limits = monitor.limits
        if let snapshot = monitor.snapshot {
            let node = snapshot.nodePeak.map(formatGiB) ?? "—"
            let chrome = snapshot.chromePeak.map(formatGiB) ?? "—"
            add("Node peak  \(node)  /  \(limits.nodeGiB) GiB per process", to: menu)
            add("Chrome  \(chrome)  /  \(limits.chromeGiB) GiB", to: menu)
        } else {
            add(monitor.sampleFailed ? "Process sample unavailable" : "Reading memory usage…", to: menu)
        }
        if let lastAction = monitor.lastAction {
            add(lastAction, to: menu)
        }
        menu.addItem(.separator())
        add(monitor.paused ? "Resume Monitoring" : "Pause Monitoring", action: #selector(togglePause), to: menu)
        add("Memory Limits…", action: #selector(editLimits), key: ",", to: menu)
        add("Open Event Log", action: #selector(openLog), to: menu)
        menu.addItem(.separator())
        add("Quit Memory Guard", action: #selector(NSApplication.terminate(_:)), key: "q", to: menu)
    }

    private func updateStatus() {
        let title = monitor.paused ? "Memory Guard paused" : "Memory Guard"
        let symbol = monitor.paused ? "pause.circle" : "memorychip"
        statusItem?.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        statusItem?.button?.toolTip = title
    }

    private func add(_ title: String, action: Selector? = nil, key: String = "", to menu: NSMenu) {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        if action == #selector(NSApplication.terminate(_:)) {
            item.target = NSApp
        } else if action != nil {
            item.target = self
        } else {
            item.isEnabled = false
        }
    }

    @objc private func togglePause() {
        monitor.paused.toggle()
    }

    @objc private func openLog() {
        if FileManager.default.fileExists(atPath: EventLog.url.path) {
            NSWorkspace.shared.open(EventLog.url)
        }
    }

    @objc private func editLimits() {
        let limits = monitor.limits
        let node = NSTextField(string: String(limits.nodeGiB))
        let chrome = NSTextField(string: String(limits.chromeGiB))
        let fields = NSGridView(views: [
            [NSTextField(labelWithString: "Node per process (GiB)"), node],
            [NSTextField(labelWithString: "Chrome with helpers (GiB)"), chrome],
        ])
        fields.column(at: 1).width = 72
        fields.rowSpacing = 8
        fields.frame.size = fields.fittingSize

        let dialog = NSAlert()
        dialog.messageText = "Memory Limits"
        dialog.informativeText = "Memory Guard acts after three consecutive readings at or above the limit."
        dialog.accessoryView = fields
        dialog.addButton(withTitle: "Save")
        dialog.addButton(withTitle: "Cancel")
        dialog.addButton(withTitle: "Restore Defaults")
        dialog.window.initialFirstResponder = node
        NSApp.activate()

        while true {
            switch dialog.runModal() {
            case .alertFirstButtonReturn:
                let units = 1...1024
                let whitespace = CharacterSet.whitespacesAndNewlines
                if let nodeGiB = Int(node.stringValue.trimmingCharacters(in: whitespace)), units.contains(nodeGiB),
                   let chromeGiB = Int(chrome.stringValue.trimmingCharacters(in: whitespace)), units.contains(chromeGiB) {
                    monitor.limits = Limits(nodeGiB: nodeGiB, chromeGiB: chromeGiB)
                    return
                }
                dialog.informativeText = "Enter a whole number from 1 to 1024 for each limit."
            case .alertThirdButtonReturn:
                monitor.limits = MemoryMonitor.defaultLimits
                return
            default:
                return
            }
        }
    }
}
