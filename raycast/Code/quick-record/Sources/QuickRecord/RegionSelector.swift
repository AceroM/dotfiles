import AppKit

@MainActor
final class RegionSelector {
    private var windows: [NSWindow] = []
    private var completion: ((CaptureRegion?) -> Void)?

    func show(completion: @escaping (CaptureRegion?) -> Void) {
        self.completion = completion
        for screen in NSScreen.screens {
            let window = SelectionWindow(contentRect: screen.frame, styleMask: .borderless,
                                         backing: .buffered, defer: false)
            window.title = "Quick Record — Select Region"
            window.isOpaque = false
            window.backgroundColor = .clear
            window.level = .screenSaver
            window.hasShadow = false
            window.isReleasedWhenClosed = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = SelectionView(frame: CGRect(origin: .zero, size: screen.frame.size))
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
    private var anchor: CGPoint?
    private var selection: CGRect?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityLabel("Drag a region. Release to start recording. Escape cancels.")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        anchor = point(event)
        selection = nil
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let anchor else { return }
        let end = point(event)
        selection = CGRect(x: min(anchor.x, end.x), y: min(anchor.y, end.y),
                           width: abs(end.x - anchor.x), height: abs(end.y - anchor.y)).integral
            .intersection(bounds)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        mouseDragged(with: event)
        guard let selection, selection.width >= 16, selection.height >= 16 else {
            anchor = nil
            self.selection = nil
            needsDisplay = true
            return
        }
        onSelect?(selection)
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
        if anchor == nil {
            label("Drag to record  ·  Release to start  ·  Esc to cancel",
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
