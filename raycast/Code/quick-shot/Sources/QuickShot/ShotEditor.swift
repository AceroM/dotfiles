import AppKit
import UniformTypeIdentifiers

/// Coordinates are image points (pixels / scale), top-left origin.
enum Annotation {
    case arrow(from: CGPoint, to: CGPoint)
    case box(CGRect)

    static let color = NSColor.systemRed
    static let lineWidth: CGFloat = 4

    func draw() {
        Self.color.set()
        switch self {
        case .box(let rect):
            let path = NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3)
            path.lineWidth = Self.lineWidth
            path.stroke()
        case .arrow(let from, let to):
            let angle = atan2(to.y - from.y, to.x - from.x)
            let head = min(22, hypot(to.x - from.x, to.y - from.y) * 0.6)
            let left = CGPoint(x: to.x - head * cos(angle - .pi / 7), y: to.y - head * sin(angle - .pi / 7))
            let right = CGPoint(x: to.x - head * cos(angle + .pi / 7), y: to.y - head * sin(angle + .pi / 7))
            // Stop the shaft inside the head so the tip stays sharp.
            let shaftEnd = CGPoint(x: to.x - head * 0.7 * cos(angle), y: to.y - head * 0.7 * sin(angle))
            let shaft = NSBezierPath()
            shaft.move(to: from)
            shaft.line(to: shaftEnd)
            shaft.lineWidth = Self.lineWidth
            shaft.lineCapStyle = .round
            shaft.stroke()
            let tip = NSBezierPath()
            tip.move(to: to)
            tip.line(to: left)
            tip.line(to: right)
            tip.close()
            tip.fill()
        }
    }
}

enum Tool {
    case arrow
    case box
}

/// Shottr-style editor: Esc and ⌘C copy and close, ⌘S saves, A/R pick arrow/box, ⌘Z undoes.
@MainActor
final class ShotEditor: NSObject, NSWindowDelegate {
    static let saveFolder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents")

    var onClose: ((ShotEditor) -> Void)?
    private let shot: Shot
    private let window: NSWindow
    private let canvas: AnnotationCanvas

    init(shot: Shot) {
        self.shot = shot
        let pointSize = CGSize(width: CGFloat(shot.image.width) / shot.scale,
                               height: CGFloat(shot.image.height) / shot.scale)
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let fit = min(1, visible.width * 0.85 / pointSize.width, (visible.height * 0.85 - 28) / pointSize.height)
        let contentSize = CGSize(width: max(320, (pointSize.width * fit).rounded()),
                                 height: max(120, (pointSize.height * fit).rounded()))
        canvas = AnnotationCanvas(frame: CGRect(origin: .zero, size: contentSize), shot: shot, pointSize: pointSize)
        window = NSWindow(contentRect: CGRect(origin: .zero, size: contentSize),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.contentView = canvas
        window.contentAspectRatio = pointSize
        window.delegate = self
        window.backgroundColor = NSColor(white: 0.12, alpha: 1)
        window.setFrameOrigin(CGPoint(x: visible.midX - contentSize.width / 2,
                                      y: visible.midY - contentSize.height / 2))
        canvas.onCopyAndClose = { [weak self] in self?.copy(); self?.window.close() }
        canvas.onCopy = { [weak self] in self?.copy(); self?.window.close() }
        canvas.onSave = { [weak self] in self?.save() }
        canvas.onClose = { [weak self] in self?.window.close() }
        canvas.onChange = { [weak self] in self?.updateTitle() }
        updateTitle()
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(canvas)
    }

    func windowWillClose(_ notification: Notification) { onClose?(self) }

    private func updateTitle(_ status: String? = nil) {
        let size = "\(shot.image.width) × \(shot.image.height)"
        let tool = canvas.tool == .arrow ? "Arrow" : "Box"
        window.title = status.map { "\(size)  ·  \($0)" }
            ?? "\(size)  ·  \(tool) (A / R)  ·  ⌘Z undo  ·  Esc copy + close  ·  ⌘S save"
    }

    private func copy() {
        guard let image = canvas.rendered(), let png = Self.png(image, scale: shot.scale) else { return }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = CGSize(width: CGFloat(image.width) / shot.scale, height: CGFloat(image.height) / shot.scale)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.declareTypes([.png, .tiff], owner: nil)
        pasteboard.setData(png, forType: .png)
        if let tiff = rep.tiffRepresentation { pasteboard.setData(tiff, forType: .tiff) }
        updateTitle("Copied")
    }

    private func save() {
        guard let image = canvas.rendered(), let png = Self.png(image, scale: shot.scale) else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let url = Self.saveFolder.appendingPathComponent("Quick Shot \(formatter.string(from: Date())).png")
        do {
            try FileManager.default.createDirectory(at: Self.saveFolder, withIntermediateDirectories: true)
            try png.write(to: url, options: .withoutOverwriting)
            updateTitle("Saved \(url.lastPathComponent)")
        } catch {
            updateTitle("Save failed: \(error.localizedDescription)")
        }
    }

    /// DPI metadata makes Retina shots paste and preview at their on-screen size.
    static func png(_ image: CGImage, scale: CGFloat) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            return nil
        }
        let dpi = 72 * scale
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyDPIWidth: dpi,
                                                        kCGImagePropertyDPIHeight: dpi] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}

private final class AnnotationCanvas: NSView {
    var onCopyAndClose: (() -> Void)?
    var onCopy: (() -> Void)?
    var onSave: (() -> Void)?
    var onClose: (() -> Void)?
    var onChange: (() -> Void)?
    private(set) var tool = Tool.arrow
    private let shot: Shot
    private let image: NSImage
    private let pointSize: CGSize
    private var annotations: [Annotation] = []
    private var draft: Annotation?
    private var anchor: CGPoint?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, shot: Shot, pointSize: CGSize) {
        self.shot = shot
        self.pointSize = pointSize
        image = NSImage(cgImage: shot.image, size: pointSize)
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The window keeps the image's aspect ratio, so the image fills the view.
    private var zoom: CGFloat { bounds.width / pointSize.width }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    override func draw(_ dirtyRect: NSRect) {
        image.draw(in: bounds, from: .zero, operation: .copy, fraction: 1, respectFlipped: true,
                   hints: [.interpolation: NSImageInterpolation.high])
        NSGraphicsContext.saveGraphicsState()
        let transform = NSAffineTransform()
        transform.scale(by: zoom)
        transform.concat()
        (annotations + [draft].compactMap { $0 }).forEach { $0.draw() }
        NSGraphicsContext.restoreGraphicsState()
    }

    /// Full-resolution image with annotations burned in.
    func rendered() -> CGImage? {
        guard !annotations.isEmpty else { return shot.image }
        let width = shot.image.width, height = shot.image.height
        let space = shot.image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return nil
        }
        context.draw(shot.image, in: CGRect(x: 0, y: 0, width: width, height: height))
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: shot.scale, y: -shot.scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        annotations.forEach { $0.draw() }
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }

    private func imagePoint(_ event: NSEvent) -> CGPoint {
        let point = convert(event.locationInWindow, from: nil)
        return CGPoint(x: min(max(0, point.x / zoom), pointSize.width), y: min(max(0, point.y / zoom), pointSize.height))
    }

    override func mouseDown(with event: NSEvent) { anchor = imagePoint(event) }

    override func mouseDragged(with event: NSEvent) {
        guard let anchor else { return }
        let point = imagePoint(event)
        switch tool {
        case .arrow: draft = .arrow(from: anchor, to: point)
        case .box: draft = .box(CGRect(x: min(anchor.x, point.x), y: min(anchor.y, point.y),
                                       width: abs(point.x - anchor.x), height: abs(point.y - anchor.y)))
        }
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if let anchor, let draft, hypot(imagePoint(event).x - anchor.x, imagePoint(event).y - anchor.y) >= 4 {
            annotations.append(draft)
        }
        anchor = nil
        draft = nil
        needsDisplay = true
    }

    override func cancelOperation(_ sender: Any?) { onCopyAndClose?() }

    override func keyDown(with event: NSEvent) {
        switch event.charactersIgnoringModifiers?.lowercased() {
        case _ where event.keyCode == 53: onCopyAndClose?()
        case "a": tool = .arrow; onChange?()
        case "r": tool = .box; onChange?()
        default: super.keyDown(with: event)
        }
    }

    /// An agent app has no main menu, so the editor handles its own ⌘ shortcuts.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command else {
            return super.performKeyEquivalent(with: event)
        }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "c": onCopy?()
        case "s": onSave?()
        case "w": onClose?()
        case "z":
            if !annotations.isEmpty { annotations.removeLast(); needsDisplay = true }
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }
}
