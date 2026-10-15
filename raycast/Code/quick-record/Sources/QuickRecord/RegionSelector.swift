import AppKit
import OSLog

@MainActor
final class RegionSelector {
    private var windows: [NSWindow] = []
    private var completion: ((CaptureRegion?) -> Void)?

    func show(completion: @escaping (CaptureRegion?) -> Void) {
        self.completion = completion
        // Snapshot before showing overlays, which would otherwise obscure the targets.
        let windowRects = visibleWindowRects()
        for screen in NSScreen.screens {
            let window = SelectionWindow(contentRect: screen.frame, styleMask: .borderless,
                                         backing: .buffered, defer: false)
            window.title = "Quick Record — Select Window or Region"
            window.isOpaque = false
            window.backgroundColor = .clear
            window.level = .screenSaver
            window.hasShadow = false
            window.acceptsMouseMovedEvents = true
            window.isReleasedWhenClosed = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let displayFrame = CGDisplayBounds(screen.displayID)
            let localRects = windowRects.map { $0.offsetBy(dx: -displayFrame.minX, dy: -displayFrame.minY) }
            let view = SelectionView(frame: CGRect(origin: .zero, size: screen.frame.size), windowRects: localRects)
            view.hover(at: CGPoint(x: NSEvent.mouseLocation.x - screen.frame.minX,
                                  y: screen.frame.maxY - NSEvent.mouseLocation.y))
            view.onSelect = { [weak self] rect in
                self?.finish(CaptureRegion(displayUUID: screen.displayUUID, rect: rect))
            }
            view.onCancel = { [weak self] in self?.finish(nil) }
            window.contentView = view
            windows.append(window)
            window.orderFrontRegardless()
        }
        NSApp.activate(ignoringOtherApps: true)
        let underMouse = windows.first { $0.frame.contains(NSEvent.mouseLocation) }
        (underMouse ?? windows.first)?.makeKeyAndOrderFront(nil)
        if let window = underMouse ?? windows.first { window.makeFirstResponder(window.contentView) }
        NSCursor.crosshair.set()
    }

    /// Core Graphics supplies on-screen windows in front-to-back order.
    private func visibleWindowRects() -> [CGRect] {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                   kCGNullWindowID) as? [[String: Any]] else { return [] }
        return info.compactMap { window in
            guard let layer = window[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
                  let owner = window[kCGWindowOwnerPID as String] as? NSNumber,
                  owner.int32Value != ProcessInfo.processInfo.processIdentifier,
                  let alpha = window[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue > 0,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds) else { return nil }
            return rect
        }
    }

    func cancel() { finish(nil) }

    private func finish(_ region: CaptureRegion?) {
        guard let completion else { return }
        self.completion = nil
        windows.forEach { $0.orderOut(nil); $0.close() }
        windows.removeAll()
        NSCursor.arrow.set()
        completion(region)
    }
}

private final class SelectionWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

private final class SelectionView: NSView {
    var onSelect: ((CGRect) -> Void)?
    var onCancel: (() -> Void)?
    private let logger = Logger(subsystem: "com.acerom.quickrecord", category: "selection")
    private var gesture: CaptureSelection
    private var tracking: NSTrackingArea?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, windowRects: [CGRect]) {
        gesture = CaptureSelection(bounds: CGRect(origin: .zero, size: frame.size), windowRects: windowRects)
        super.init(frame: frame)
        setAccessibilityLabel("Click a highlighted window or hold and drag a region. Release to start recording. Escape cancels.")
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
        gesture.hover(at: point)
        needsDisplay = true
    }

    override func mouseMoved(with event: NSEvent) { hover(at: point(event)) }
    override func mouseEntered(with event: NSEvent) { hover(at: point(event)) }
    override func mouseExited(with event: NSEvent) {
        gesture.leave()
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        gesture.press(at: point(event))
        logger.notice("Selection press at \(String(describing: self.gesture.anchor), privacy: .public), target \(String(describing: self.gesture.selection), privacy: .public)")
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        gesture.drag(to: point(event))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        let selection = gesture.release(at: point(event))
        logger.notice("Selection release at \(String(describing: self.point(event)), privacy: .public), result \(String(describing: selection), privacy: .public)")
        if let selection { onSelect?(selection) }
        needsDisplay = true
    }

    override func rightMouseDown(with event: NSEvent) { onCancel?() }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onCancel?() }
        else { super.keyDown(with: event) }
    }

    private func point(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        return CGPoint(x: min(max(0, point.x), bounds.width), y: min(max(0, point.y), bounds.height))
    }

    override func draw(_ dirtyRect: NSRect) {
        // Fully transparent pixels let clicks fall through to the underlying app.
        // Keep the highlighted area almost clear, but part of this window's hit area.
        NSColor.black.withAlphaComponent(0.01).setFill()
        NSBezierPath(rect: bounds).fill()
        let selection = gesture.selection
        let mask = NSBezierPath(rect: bounds)
        if let selection { mask.appendRect(selection) }
        mask.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.30).setFill()
        mask.fill()
        if let selection {
            NSColor.white.setStroke()
            let outline = NSBezierPath(rect: selection.insetBy(dx: 0.5, dy: 0.5))
            outline.lineWidth = 1
            outline.stroke()
            label("\(Int(selection.width)) × \(Int(selection.height))", at:
                    CGPoint(x: selection.midX, y: min(bounds.height - 44, selection.maxY + 12)))
        }
        if gesture.anchor == nil {
            label("Click a window  ·  Hold + drag a region  ·  Esc to cancel",
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
