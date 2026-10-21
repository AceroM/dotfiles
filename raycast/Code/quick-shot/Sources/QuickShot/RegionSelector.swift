import AppKit

enum CaptureMode {
    case area
    case window
}

enum Selection {
    /// Display-local points, top-left origin.
    case region(CGDirectDisplayID, CGRect)
    case window(CGWindowID)
}

@MainActor
final class RegionSelector {
    private var windows: [NSWindow] = []
    private var completion: ((Selection?) -> Void)?
    var isActive: Bool { completion != nil }

    /// Area mode draws each display's frozen shot under the overlay; window mode stays live.
    func show(mode: CaptureMode, frozen: [CGDirectDisplayID: Shot], completion: @escaping (Selection?) -> Void) {
        self.completion = completion
        // Snapshot before showing overlays, which would otherwise obscure the targets.
        let targets = visibleWindows()
        for screen in NSScreen.screens {
            let window = SelectionWindow(contentRect: screen.frame, styleMask: .borderless,
                                         backing: .buffered, defer: false)
            window.title = "Quick Shot — Select \(mode == .area ? "Area" : "Window")"
            window.isOpaque = false
            window.backgroundColor = .clear
            window.level = .screenSaver
            window.hasShadow = false
            window.acceptsMouseMovedEvents = true
            window.isReleasedWhenClosed = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let displayID = screen.displayID
            let displayFrame = CGDisplayBounds(displayID)
            let localRects = targets.map { $0.rect.offsetBy(dx: -displayFrame.minX, dy: -displayFrame.minY) }
            let bounds = CGRect(origin: .zero, size: screen.frame.size)
            let container = NSView(frame: bounds)
            if let shot = frozen[displayID] {
                container.wantsLayer = true
                container.layer?.contents = shot.image
                container.layer?.contentsGravity = .resize
            }
            let view = SelectionView(frame: bounds, mode: mode, windowRects: localRects)
            view.hover(at: CGPoint(x: NSEvent.mouseLocation.x - screen.frame.minX,
                                  y: screen.frame.maxY - NSEvent.mouseLocation.y))
            view.onSelect = { [weak self] result in
                switch result {
                case .region(let rect): self?.finish(.region(displayID, rect))
                case .window(let index): self?.finish(.window(targets[index].id))
                }
            }
            view.onCancel = { [weak self] in self?.finish(nil) }
            view.onFullScreen = { [weak self] in self?.selectFullScreen() }
            container.addSubview(view)
            window.contentView = container
            windows.append(window)
            window.orderFrontRegardless()
        }
        NSApp.activate(ignoringOtherApps: true)
        let underMouse = windows.first { $0.frame.contains(NSEvent.mouseLocation) } ?? windows.first
        underMouse?.makeKeyAndOrderFront(nil)
        underMouse?.makeFirstResponder(underMouse?.contentView?.subviews.first)
        NSCursor.crosshair.set()
    }

    /// Core Graphics supplies on-screen windows in front-to-back order.
    private func visibleWindows() -> [(id: CGWindowID, rect: CGRect)] {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                   kCGNullWindowID) as? [[String: Any]] else { return [] }
        return info.compactMap { window in
            guard let layer = window[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
                  let owner = window[kCGWindowOwnerPID as String] as? NSNumber,
                  owner.int32Value != ProcessInfo.processInfo.processIdentifier,
                  let alpha = window[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue > 0,
                  let number = window[kCGWindowNumber as String] as? NSNumber,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds) else { return nil }
            return (number.uint32Value, rect)
        }
    }

    func cancel() { finish(nil) }

    /// The display under the pointer, not the key window's, so F follows the mouse across displays.
    private func selectFullScreen() {
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
        finish(.region(screen.displayID, CGRect(origin: .zero, size: screen.frame.size)))
    }

    private func finish(_ selection: Selection?) {
        guard let completion else { return }
        self.completion = nil
        windows.forEach { $0.orderOut(nil); $0.close() }
        windows.removeAll()
        NSCursor.arrow.set()
        completion(selection)
    }
}

private final class SelectionWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

private final class SelectionView: NSView {
    var onSelect: ((SelectionResult) -> Void)?
    var onCancel: (() -> Void)?
    var onFullScreen: (() -> Void)?
    private let mode: CaptureMode
    private var gesture: CaptureSelection
    private var cursor: CGPoint?
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, mode: CaptureMode, windowRects: [CGRect]) {
        self.mode = mode
        gesture = CaptureSelection(bounds: CGRect(origin: .zero, size: frame.size), windowRects: windowRects,
                                   allowsDrag: mode == .area)
        super.init(frame: frame)
        setAccessibilityLabel(mode == .area
            ? "Drag a region or click a window to capture it. F captures the full screen. Escape cancels."
            : "Click a highlighted window to capture it. Escape cancels.")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.activeAlways, .inVisibleRect, .mouseMoved, .mouseEnteredAndExited],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    func hover(at point: CGPoint) {
        cursor = point
        gesture.hover(at: point)
        needsDisplay = true
    }

    override func mouseMoved(with event: NSEvent) { hover(at: point(event)) }
    override func mouseEntered(with event: NSEvent) { hover(at: point(event)) }
    override func mouseExited(with event: NSEvent) {
        cursor = nil
        gesture.leave()
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        gesture.press(at: point(event))
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        cursor = point(event)
        gesture.drag(to: point(event))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if let result = gesture.release(at: point(event)) { onSelect?(result) }
        needsDisplay = true
    }

    override func rightMouseDown(with event: NSEvent) { onCancel?() }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onCancel?() }
        else if mode == .area, event.charactersIgnoringModifiers?.lowercased() == "f" { onFullScreen?() }
        else { super.keyDown(with: event) }
    }

    private func point(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        return CGPoint(x: min(max(0, point.x), bounds.width), y: min(max(0, point.y), bounds.height))
    }

    override func draw(_ dirtyRect: NSRect) {
        // Fully transparent pixels let clicks fall through to the underlying app.
        NSColor.black.withAlphaComponent(0.01).setFill()
        NSBezierPath(rect: bounds).fill()
        let selection = gesture.selection
        let mask = NSBezierPath(rect: bounds)
        if let selection { mask.appendRect(selection) }
        mask.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(mode == .area && selection == nil ? 0.15 : 0.30).setFill()
        mask.fill()
        if let selection {
            NSColor.white.setStroke()
            let outline = NSBezierPath(rect: selection.insetBy(dx: 0.5, dy: 0.5))
            outline.lineWidth = 1
            outline.stroke()
            label("\(Int(selection.width)) × \(Int(selection.height))",
                  at: CGPoint(x: selection.midX, y: min(bounds.height - 44, selection.maxY + 12)))
        }
        // Crosshair guides for precise starts, until a drag takes over.
        if mode == .area, gesture.isDragging == false, let cursor {
            NSColor.white.withAlphaComponent(0.55).setStroke()
            let guides = NSBezierPath()
            guides.move(to: CGPoint(x: 0, y: cursor.y.rounded() + 0.5))
            guides.line(to: CGPoint(x: bounds.width, y: cursor.y.rounded() + 0.5))
            guides.move(to: CGPoint(x: cursor.x.rounded() + 0.5, y: 0))
            guides.line(to: CGPoint(x: cursor.x.rounded() + 0.5, y: bounds.height))
            guides.lineWidth = 1
            guides.stroke()
        }
        if gesture.anchor == nil {
            label(mode == .area ? "Drag an area  ·  Click a window  ·  F for full screen  ·  Esc to cancel"
                                : "Click a window  ·  Esc to cancel",
                  at: CGPoint(x: bounds.midX, y: 72))
        }
    }

    private func label(_ text: String, at point: CGPoint) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.white,
        ]
        let size = (text as NSString).size(withAttributes: attributes)
        let width = size.width + 28
        let x = max(8, min(bounds.width - width - 8, point.x - width / 2))
        let box = CGRect(x: x, y: point.y, width: width, height: 34)
        NSColor(white: 0.10, alpha: 0.94).setFill()
        NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).fill()
        (text as NSString).draw(at: CGPoint(x: box.minX + 14, y: box.minY + 9), withAttributes: attributes)
    }
}
