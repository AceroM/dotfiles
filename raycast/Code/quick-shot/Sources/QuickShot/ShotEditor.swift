import AppKit
import UniformTypeIdentifiers

/// Coordinates are image points (pixels / scale), top-left origin.
enum Annotation {
    case arrow(from: CGPoint, to: CGPoint)
    case box(CGRect)
    /// Starts at `origin`, its top left, and wraps at `width`.
    case text(String, origin: CGPoint, width: CGFloat)

    static let color = NSColor.systemRed
    static let lineWidth: CGFloat = 4
    static let fontSize: CGFloat = 22

    static func textAttributes(zoom: CGFloat = 1) -> [NSAttributedString.Key: Any] {
        [.font: NSFont.systemFont(ofSize: fontSize * zoom, weight: .bold), .foregroundColor: color]
    }

    static func textSize(_ string: String, width: CGFloat) -> CGSize {
        let rect = (string as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                                     options: [.usesLineFragmentOrigin], attributes: textAttributes())
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
    }

    var bounds: CGRect {
        switch self {
        case .arrow(let from, let to):
            CGRect(x: min(from.x, to.x), y: min(from.y, to.y), width: abs(to.x - from.x), height: abs(to.y - from.y))
        case .box(let rect): rect
        case .text(let string, let origin, let width): CGRect(origin: origin, size: Self.textSize(string, width: width))
        }
    }

    func contains(_ point: CGPoint, tolerance: CGFloat) -> Bool {
        switch self {
        case .arrow(let from, let to):
            let dx = to.x - from.x, dy = to.y - from.y
            let t = max(0, min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / max(1, dx * dx + dy * dy)))
            return hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy)) <= tolerance
        case .box, .text:
            return bounds.insetBy(dx: -tolerance, dy: -tolerance).contains(point)
        }
    }

    func offsetBy(dx: CGFloat, dy: CGFloat) -> Annotation {
        switch self {
        case .arrow(let from, let to):
            .arrow(from: CGPoint(x: from.x + dx, y: from.y + dy), to: CGPoint(x: to.x + dx, y: to.y + dy))
        case .box(let rect): .box(rect.offsetBy(dx: dx, dy: dy))
        case .text(let string, let origin, let width): .text(string, origin: CGPoint(x: origin.x + dx, y: origin.y + dy), width: width)
        }
    }

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
        case .text(let string, let origin, let width):
            (string as NSString).draw(with: CGRect(origin: origin, size: CGSize(width: width, height: .greatestFiniteMagnitude)),
                                      options: [.usesLineFragmentOrigin], attributes: Self.textAttributes(), context: nil)
        }
    }
}

enum Tool {
    case select
    case arrow
    case box
    case text
}

/// Shottr-style editor: Esc and ⌘C copy and close, ⌘S saves, V/A/R/T pick move/arrow/box/text, ⌘Z undoes.
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
        let tool = switch canvas.tool { case .select: "Move"; case .arrow: "Arrow"; case .box: "Box"; case .text: "Text" }
        window.title = status.map { "\(size)  ·  \($0)" }
            ?? "\(size)  ·  \(tool) (V / A / R / T)  ·  ⌘Z undo  ·  Esc copy + close  ·  ⌘S save"
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

private final class AnnotationCanvas: NSView, NSTextViewDelegate {
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
    /// Snapshots taken before each change, for ⌘Z.
    private var history: [[Annotation]] = []
    private var draft: Annotation?
    private var anchor: CGPoint?
    private var selected: Int?
    private var move: (start: CGPoint, original: Annotation, recorded: Bool)?
    /// Text being typed; `editingIndex` is set when it replaces an existing annotation.
    private var editor: NSTextView?
    private var editingIndex: Int?
    private var editingOrigin = CGPoint.zero
    private var editingWidth: CGFloat = 0
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

    override func resetCursorRects() {
        let cursor: NSCursor = switch tool { case .select: .arrow; case .text: .iBeam; default: .crosshair }
        addCursorRect(bounds, cursor: cursor)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutEditor()
    }

    override func draw(_ dirtyRect: NSRect) {
        image.draw(in: bounds, from: .zero, operation: .copy, fraction: 1, respectFlipped: true,
                   hints: [.interpolation: NSImageInterpolation.high])
        NSGraphicsContext.saveGraphicsState()
        let transform = NSAffineTransform()
        transform.scale(by: zoom)
        transform.concat()
        for (index, annotation) in annotations.enumerated() where index != editingIndex { annotation.draw() }
        draft?.draw()
        if let selected, selected < annotations.count {
            let outline = NSBezierPath(rect: annotations[selected].bounds.insetBy(dx: -6, dy: -6))
            outline.lineWidth = 1.5 / zoom
            outline.setLineDash([4 / zoom, 3 / zoom], count: 2, phase: 0)
            NSColor.controlAccentColor.setStroke()
            outline.stroke()
        }
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

    /// Topmost first, with a tolerance of about 8 screen points.
    private func hit(_ point: CGPoint, textOnly: Bool = false) -> Int? {
        annotations.indices.reversed().first { index in
            if textOnly { guard case .text = annotations[index] else { return false } }
            return annotations[index].contains(point, tolerance: 8 / zoom)
        }
    }

    private func record() { history.append(annotations) }

    private func setTool(_ newTool: Tool) {
        tool = newTool
        if tool != .select { selected = nil }
        window?.invalidateCursorRects(for: self)
        needsDisplay = true
        onChange?()
    }

    override func mouseDown(with event: NSEvent) {
        let point = imagePoint(event)
        let wasEditing = editor != nil
        if wasEditing { commitText() }
        // Clicking text with the text tool, or double-clicking it with any tool, edits it.
        if let index = hit(point, textOnly: true), tool == .text || event.clickCount == 2 {
            editText(at: index)
            return
        }
        guard !wasEditing else { return }
        switch tool {
        case .select:
            selected = hit(point)
            if let selected { move = (point, annotations[selected], false) }
        case .text:
            beginText(at: point)
        case .arrow, .box:
            anchor = point
        }
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        let point = imagePoint(event)
        if let selected, let current = move {
            if !current.recorded { record(); move?.recorded = true }
            annotations[selected] = current.original.offsetBy(dx: point.x - current.start.x, dy: point.y - current.start.y)
            needsDisplay = true
            return
        }
        guard let anchor else { return }
        switch tool {
        case .arrow: draft = .arrow(from: anchor, to: point)
        case .box: draft = .box(CGRect(x: min(anchor.x, point.x), y: min(anchor.y, point.y),
                                       width: abs(point.x - anchor.x), height: abs(point.y - anchor.y)))
        case .select, .text: return
        }
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if let anchor, let draft, hypot(imagePoint(event).x - anchor.x, imagePoint(event).y - anchor.y) >= 4 {
            record()
            annotations.append(draft)
        }
        anchor = nil
        draft = nil
        move = nil
        needsDisplay = true
    }

    // MARK: Text

    /// Centers the first line on the click and wraps at the image's right edge.
    private func beginText(at point: CGPoint) {
        let lineHeight = Annotation.textSize("Ag", width: .greatestFiniteMagnitude).height
        let x = min(point.x, max(0, pointSize.width - 84))
        startEditor(origin: CGPoint(x: x, y: max(0, point.y - lineHeight / 2)),
                    width: max(80, pointSize.width - x - 4), string: "", index: nil)
    }

    private func editText(at index: Int) {
        guard case .text(let string, let origin, let width) = annotations[index] else { return }
        selected = nil
        startEditor(origin: origin, width: width, string: string, index: index)
    }

    private func startEditor(origin: CGPoint, width: CGFloat, string: String, index: Int?) {
        editingOrigin = origin
        editingWidth = width
        editingIndex = index
        let view = NSTextView(frame: .zero)
        view.isRichText = false
        view.drawsBackground = false
        view.allowsUndo = true
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = false
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = false
        view.textColor = Annotation.color
        view.insertionPointColor = Annotation.color
        view.string = string
        view.delegate = self
        editor = view
        addSubview(view)
        layoutEditor()
        window?.makeFirstResponder(view)
        view.setSelectedRange(NSRange(location: (string as NSString).length, length: 0))
        needsDisplay = true
    }

    /// Grows the editor with its text; long lines wrap instead of scrolling off the image.
    private func layoutEditor() {
        guard let editor, let container = editor.textContainer, let layout = editor.layoutManager else { return }
        editor.font = Annotation.textAttributes(zoom: zoom)[.font] as? NSFont
        container.containerSize = CGSize(width: editingWidth * zoom, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        let lineHeight = layout.defaultLineHeight(for: editor.font ?? .systemFont(ofSize: 22))
        editor.frame = CGRect(x: editingOrigin.x * zoom, y: editingOrigin.y * zoom,
                              width: min(editingWidth * zoom, used.width + 4), height: max(lineHeight, used.height))
    }

    func textDidChange(_ notification: Notification) { layoutEditor() }

    /// Return finishes, Option-Return adds a line, Esc discards the edit.
    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(insertNewline(_:)) { commitText(); return true }
        if selector == #selector(cancelOperation(_:)) { closeEditor(); return true }
        return false
    }

    private func commitText() {
        guard let editor else { return }
        let string = editor.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let annotation = Annotation.text(string, origin: editingOrigin, width: editingWidth)
        if let index = editingIndex {
            if case .text(let old, _, _) = annotations[index], old != string {
                record()
                if string.isEmpty { annotations.remove(at: index) } else { annotations[index] = annotation }
            }
        } else if !string.isEmpty {
            record()
            annotations.append(annotation)
        }
        closeEditor()
    }

    private func closeEditor() {
        editor?.removeFromSuperview()
        editor = nil
        editingIndex = nil
        window?.makeFirstResponder(self)
        needsDisplay = true
    }

    // MARK: Keys

    override func cancelOperation(_ sender: Any?) { onCopyAndClose?() }

    override func keyDown(with event: NSEvent) {
        switch event.charactersIgnoringModifiers?.lowercased() {
        case _ where event.keyCode == 53: onCopyAndClose?()
        case _ where [51, 117].contains(event.keyCode):
            if let selected {
                record()
                annotations.remove(at: selected)
                self.selected = nil
                needsDisplay = true
            }
        case "v": setTool(.select)
        case "a": setTool(.arrow)
        case "r": setTool(.box)
        case "t": setTool(.text)
        default: super.keyDown(with: event)
        }
    }

    /// An agent app has no main menu, so the editor handles its own ⌘ shortcuts.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command else {
            return super.performKeyEquivalent(with: event)
        }
        let key = event.charactersIgnoringModifiers?.lowercased()
        if let editor {
            switch key {
            case "z": editor.undoManager?.undo(); return true
            case "v": editor.paste(nil); return true
            case "x": editor.cut(nil); return true
            case "a": editor.selectAll(nil); return true
            default: commitText()
            }
        }
        switch key {
        case "c": onCopy?()
        case "s": onSave?()
        case "w": onClose?()
        case "z":
            if let previous = history.popLast() {
                annotations = previous
                selected = nil
                needsDisplay = true
            }
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }
}
