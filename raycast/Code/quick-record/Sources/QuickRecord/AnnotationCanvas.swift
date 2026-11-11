import AppKit
import QuartzCore

/// The drawing surface over the recorded region. Its window is the one Quick Record window the
/// recording keeps, so whatever is painted here (and the text caret while typing) is in the video.
@MainActor
final class AnnotationCanvasView: NSView, NSTextViewDelegate {
    var tool = AnnotationTool.interact {
        didSet {
            guard tool != oldValue else { return }
            if oldValue == .text { requestCommit() }
            if oldValue == .laser { flushLaser() }
            currentCursor.set()
            window?.invalidateCursorRects(for: self)
        }
    }
    var style = AnnotationStyle()
    /// Typing needs Quick Record active, so dictation tools see the label as the focused field.
    var onBeginTyping: (() -> Void)?
    var onShortcut: ((AnnotationTool) -> Void)?
    var onEscape: (() -> Void)?
    var onDictate: (() -> Void)?
    var onChange: (() -> Void)?
    /// Asked before a label is committed (Escape, a click elsewhere, a tool change); false keeps
    /// it open, which is how a label waiting on dictation survives.
    var shouldCommit: (() -> Bool)?
    var onTextChange: (() -> Void)?
    /// The demo's timeline of what was drawn when; saved beside the video.
    var log: AnnotationLog?

    private(set) var elements: [AnnotationElement] = [] { didSet { logChange(); onChange?() } }
    /// Why `elements` is about to change, and when that drawing began, for the log.
    private var change: (cause: AnnotationCause, startedAt: CFTimeInterval?) = (.draw, nil)
    private var draftStartedAt: CFTimeInterval?
    private var editorStartedAt: CFTimeInterval?
    private var laserStroke: [AnnotationLog.LaserPoint] = []
    private var cache: [UUID: RenderedElement] = [:]
    private var draft: AnnotationElement?
    private var undoStack: [[AnnotationElement]] = []
    private var redoStack: [[AnnotationElement]] = []
    private var eraseSnapshot: [AnnotationElement]?
    private var erasing: Set<UUID> = []
    private var lastErasePoint: CGPoint?
    private struct LaserPoint { var point: CGPoint; var time: CFTimeInterval }
    private var laser: [[LaserPoint]] = []
    private var laserDown = false
    private var laserTimer: Timer?
    private let laserDecay: CFTimeInterval = 1.0
    private var editor: LabelTextView?
    private var editorOrigin = CGPoint.zero
    private var editorStyle = AnnotationStyle()
    private var editingElement: AnnotationElement?
    private var snapshotBeforeEdit: [AnnotationElement]?
    private var tracking: NSTrackingArea?
    private(set) var lastPointer: CGPoint?

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var isEditing: Bool { editor != nil }
    var editorText: String { editor?.string ?? "" }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityLabel("Quick Record annotations")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Cursor

    private var currentCursor: NSCursor {
        switch tool {
        case .interact: .arrow
        case .text: .iBeam
        case .eraser: Self.eraserCursor
        case .laser: Self.laserCursor
        default: .crosshair
        }
    }

    private static let eraserCursor: NSCursor = {
        let size = NSSize(width: 20, height: 20)
        let image = NSImage(size: size, flipped: false) { rect in
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2))
            NSColor.white.withAlphaComponent(0.85).setFill()
            ring.fill()
            NSColor.black.withAlphaComponent(0.8).setStroke()
            ring.lineWidth = 1.5
            ring.stroke()
            return true
        }
        return NSCursor(image: image, hotSpot: NSPoint(x: 10, y: 10))
    }()

    private static let laserCursor: NSCursor = {
        let size = NSSize(width: 14, height: 14)
        let image = NSImage(size: size, flipped: false) { rect in
            Palette.color(Palette.laser).setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 3, dy: 3)).fill()
            return true
        }
        return NSCursor(image: image, hotSpot: NSPoint(x: 7, y: 7))
    }()

    override func resetCursorRects() { addCursorRect(bounds, cursor: currentCursor) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.activeAlways, .inVisibleRect, .mouseMoved, .cursorUpdate],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func cursorUpdate(with event: NSEvent) { currentCursor.set() }
    override func mouseMoved(with event: NSEvent) { lastPointer = point(event) }

    // MARK: Editing the drawing

    private func pushUndo(_ snapshot: [AnnotationElement]? = nil) {
        undoStack.append(snapshot ?? elements)
        if undoStack.count > 200 { undoStack.removeFirst() }
        redoStack.removeAll()
    }

    func undo() {
        requestCommit()
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(elements)
        change = (.undo, nil)
        elements = previous
        needsDisplay = true
    }

    func redo() {
        requestCommit()
        guard let next = redoStack.popLast() else { return }
        undoStack.append(elements)
        change = (.redo, nil)
        elements = next
        needsDisplay = true
    }

    func clear() {
        requestCommit()
        guard !elements.isEmpty else { return }
        pushUndo()
        change = (.clear, nil)
        elements.removeAll()
        cache.removeAll()
        needsDisplay = true
    }

    private func rendered(_ element: AnnotationElement) -> RenderedElement {
        if let hit = cache[element.id] { return hit }
        let result = AnnotationRenderer.render(element)
        cache[element.id] = result
        return result
    }

    private func kind(for tool: AnnotationTool) -> AnnotationElement.Kind? {
        switch tool {
        case .rectangle: .rectangle
        case .diamond: .diamond
        case .ellipse: .ellipse
        case .arrow: .arrow
        case .line: .line
        case .draw: .draw
        default: nil
        }
    }

    // MARK: Mouse

    override func mouseDown(with event: NSEvent) {
        let p = point(event)
        lastPointer = p
        if tool != .text, editor != nil { requestCommit() }
        switch tool {
        case .interact:
            return
        case .text:
            if editor != nil {
                // A click away from the label finishes it, as in Excalidraw.
                if editor?.frame.insetBy(dx: -4, dy: -4).contains(p) == true { return }
                requestCommit()
                return
            }
            if let existing = elements.last(where: { $0.kind == .text && $0.bounds.insetBy(dx: -4, dy: -4).contains(p) }) {
                beginEditing(at: existing.points.first ?? p, existing: existing)
            } else {
                beginEditing(at: CGPoint(x: p.x, y: p.y - editorLineHeight / 2))
            }
        case .eraser:
            eraseSnapshot = elements
            erasing.removeAll()
            lastErasePoint = p
            erase(at: p)
        case .laser:
            laserDown = true
            let now = CACurrentMediaTime()
            laser.append([LaserPoint(point: p, time: now)])
            flushLaser()
            laserStroke = [AnnotationLog.LaserPoint(point: p, time: logTime)]
            startLaserTimer()
        default:
            guard let kind = kind(for: tool) else { return }
            draft = AnnotationElement(kind: kind, points: kind == .draw ? [p] : [p, p], style: style)
            draftStartedAt = logTime
        }
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        let p = point(event)
        lastPointer = p
        switch tool {
        case .eraser:
            // Sample along fast drags so thin strokes aren't skipped.
            let from = lastErasePoint ?? p
            let distance = hypot(p.x - from.x, p.y - from.y)
            let steps = max(1, Int(distance / 4))
            for step in 1...steps {
                let t = CGFloat(step) / CGFloat(steps)
                erase(at: CGPoint(x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t))
            }
            lastErasePoint = p
        case .laser:
            let now = CACurrentMediaTime()
            if laser.isEmpty { laser.append([]) }
            laser[laser.count - 1].append(LaserPoint(point: p, time: now))
            laserStroke.append(AnnotationLog.LaserPoint(point: p, time: logTime))
        default:
            guard var draft else { return }
            if draft.kind == .draw {
                if let last = draft.points.last, hypot(last.x - p.x, last.y - p.y) < 1 { return }
                draft.points.append(p)
            } else {
                let start = draft.points[0]
                draft.points[1] = event.modifierFlags.contains(.shift)
                    ? AnnotationRenderer.constrain(p, from: start, tool: tool) : p
            }
            self.draft = draft
        }
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        switch tool {
        case .eraser:
            if !erasing.isEmpty, let snapshot = eraseSnapshot {
                pushUndo(snapshot)
                change = (.erase, nil)
                elements.removeAll { erasing.contains($0.id) }
            }
            erasing.removeAll()
            eraseSnapshot = nil
            lastErasePoint = nil
        case .laser:
            laserDown = false
            flushLaser()
        default:
            guard let draft else { return }
            self.draft = nil
            let box = draft.bounds
            // A plain click draws nothing, except a dot with the pen.
            if draft.kind == .draw || max(box.width, box.height) >= 3 {
                pushUndo()
                change = (.draw, draftStartedAt)
                elements.append(draft)
            }
            draftStartedAt = nil
        }
        needsDisplay = true
    }

    private func erase(at p: CGPoint) {
        for element in elements where !erasing.contains(element.id) {
            if AnnotationRenderer.hits(element, rendered: rendered(element), point: p, radius: 8) {
                erasing.insert(element.id)
            }
        }
    }

    private func point(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: min(max(0, p.x), bounds.width), y: min(max(0, p.y), bounds.height))
    }

    // MARK: Log

    private var logTime: CFTimeInterval { log?.now() ?? CACurrentMediaTime() }

    /// What's on screen goes to the log: the elements, plus a label being edited (its editor shows it).
    private func logChange() {
        defer { change = (.draw, nil) }
        guard let log else { return }
        var showing = elements
        if let editingElement, !showing.contains(where: { $0.id == editingElement.id }) { showing.append(editingElement) }
        log.update(showing, cause: change.cause, startedAt: change.startedAt)
    }

    /// The laser never stays on the drawing, but where it pointed, and when, goes in the log.
    func flushLaser() {
        guard !laserStroke.isEmpty else { return }
        log?.laser(laserStroke)
        laserStroke = []
    }

    // MARK: Laser

    private func startLaserTimer() {
        guard laserTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tickLaser() }
        }
        laserTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func tickLaser() {
        let now = CACurrentMediaTime()
        for index in laser.indices {
            // Keep the head of a held pointer so it reads as a dot.
            let head = laserDown && index == laser.count - 1 ? laser[index].last?.time : nil
            laser[index].removeAll { now - $0.time > laserDecay && $0.time != head }
        }
        laser.removeAll { $0.isEmpty }
        if laser.isEmpty && !laserDown {
            laserTimer?.invalidate()
            laserTimer = nil
        }
        needsDisplay = true
    }

    // MARK: Keyboard

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        if flags.contains(.command) {
            if key == "z" { flags.contains(.shift) ? redo() : undo(); return }
            if event.keyCode == 51 { clear(); return }
            super.keyDown(with: event)
            return
        }
        // In Interact the keyboard belongs to the app; don't turn its typing into tool changes.
        guard tool != .interact else { super.keyDown(with: event); return }
        if event.keyCode == 53 { onEscape?(); return }
        guard flags.isDisjoint(with: [.control, .option]) else { super.keyDown(with: event); return }
        if key == "m" { onDictate?(); return }
        if let tool = AnnotationTool.forKey(key) { onShortcut?(tool); return }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // No main menu in an accessory app, so ⌘Z arrives here first.
        if editor == nil, event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "z" {
            event.modifierFlags.contains(.shift) ? redo() : undo()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    // MARK: Labels

    private var editorLineHeight: CGFloat {
        let font = style.font
        return ceil(font.ascender - font.descender + font.leading)
    }

    /// Somewhere sensible for a dictated label: the pointer if it's over the canvas, else the top left.
    var defaultLabelPoint: CGPoint {
        if let window {
            let local = convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
            if bounds.insetBy(dx: 8, dy: 8).contains(local) { return CGPoint(x: local.x, y: local.y - editorLineHeight / 2) }
        }
        return CGPoint(x: 32, y: 32)
    }

    func beginEditing(at origin: CGPoint, existing: AnnotationElement? = nil) {
        if editor != nil { requestCommit() }
        guard editor == nil else { return }
        onBeginTyping?()
        let style = existing?.style ?? self.style
        snapshotBeforeEdit = elements
        if let existing {
            editingElement = existing
            elements.removeAll { $0.id == existing.id }
        }
        editorStyle = style
        editorOrigin = origin
        editorStartedAt = logTime
        let view = LabelTextView(frame: CGRect(origin: origin, size: CGSize(width: 40, height: editorLineHeight)))
        view.font = style.font
        view.textColor = Palette.color(style.strokeColor)
        view.insertionPointColor = Palette.color(style.strokeColor)
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.isHorizontallyResizable = true
        view.isVerticallyResizable = true
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.heightTracksTextView = false
        view.textContainer?.containerSize = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.typingAttributes = [.font: style.font, .foregroundColor: Palette.color(style.strokeColor)]
        view.string = existing?.text ?? ""
        view.delegate = self
        view.onCommit = { [weak self] in self?.requestCommit() }
        addSubview(view)
        editor = view
        sizeEditor()
        window?.makeFirstResponder(view)
        view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
        needsDisplay = true
    }

    func textDidChange(_ notification: Notification) {
        sizeEditor()
        onTextChange?()
    }

    private func sizeEditor() {
        guard let editor, let manager = editor.layoutManager, let container = editor.textContainer else { return }
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        editor.frame = CGRect(origin: editorOrigin,
                              size: CGSize(width: max(40, ceil(used.width) + 8), height: max(editorLineHeight, ceil(used.height))))
    }

    /// Finish the open label, unless something (pending dictation) wants it kept.
    func requestCommit() {
        guard editor != nil else { return }
        if shouldCommit?() == false { return }
        commitText()
    }

    /// Finish the open label regardless.
    func commitText() {
        guard let editor else { return }
        let text = editor.string.trimmingCharacters(in: .whitespacesAndNewlines)
        editor.delegate = nil
        editor.removeFromSuperview()
        self.editor = nil
        let before = snapshotBeforeEdit ?? elements
        let cause: AnnotationCause = editingElement == nil ? .label : .edit
        if !text.isEmpty {
            var element = editingElement ?? AnnotationElement(kind: .text, points: [editorOrigin], style: editorStyle)
            element.text = text
            element.points = [editorOrigin]
            if element != editingElement { pushUndo(before) }
            change = (cause, editorStartedAt)
            elements.append(element)
        } else if editingElement != nil {
            pushUndo(before)
        }
        editingElement = nil
        snapshotBeforeEdit = nil
        editorStartedAt = nil
        // A label emptied out is gone now that it's no longer held open.
        change = (.edit, nil)
        logChange()
        window?.makeFirstResponder(self)
        needsDisplay = true
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        for element in elements {
            context.setAlpha(erasing.contains(element.id) ? 0.25 : 1)
            paint(element, rendered: rendered(element), in: context)
        }
        context.setAlpha(1)
        if let draft { paint(draft, rendered: AnnotationRenderer.render(draft), in: context) }
        paintLaser(in: context)
    }

    private func paint(_ element: AnnotationElement, rendered: RenderedElement, in context: CGContext) {
        let style = element.style
        if element.kind == .text {
            let attributes: [NSAttributedString.Key: Any] = [.font: style.font, .foregroundColor: Palette.color(style.strokeColor)]
            (element.text as NSString).draw(at: element.points.first ?? .zero, withAttributes: attributes)
            return
        }
        context.saveGState()
        defer { context.restoreGState() }
        if let outline = rendered.fillOutline, let background = style.background {
            let color = Palette.color(background).cgColor
            if style.fill == .solid {
                context.addPath(outline)
                context.setFillColor(color)
                context.fillPath()
            } else {
                context.saveGState()
                context.addPath(outline)
                context.clip()
                context.setStrokeColor(color)
                context.setLineWidth(max(1, style.width.points / 2))
                context.setLineCap(.round)
                for line in rendered.hachure { context.addPath(line) }
                context.strokePath()
                context.restoreGState()
            }
        }
        context.setStrokeColor(Palette.color(style.strokeColor).cgColor)
        context.setLineWidth(rendered.lineWidth)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        if element.kind != .draw {
            let w = rendered.lineWidth
            switch style.pattern {
            case .solid: break
            case .dashed: context.setLineDash(phase: 0, lengths: [w * 3 + 4, w * 2 + 6])
            case .dotted: context.setLineDash(phase: 0, lengths: [0.01, w * 2 + 4])
            }
        }
        for stroke in rendered.strokes { context.addPath(stroke) }
        context.strokePath()
    }

    private func paintLaser(in context: CGContext) {
        let now = CACurrentMediaTime()
        let color = Palette.color(Palette.laser)
        context.saveGState()
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for (glow, scale) in [(true, CGFloat(2.4)), (false, CGFloat(1))] {
            for stroke in laser {
                if stroke.count == 1, let head = stroke.first {
                    let life = max(0, 1 - (now - head.time) / laserDecay)
                    let radius = (laserDown ? 4 : 4 * life) * scale
                    context.setFillColor(color.withAlphaComponent(glow ? 0.25 : 1).cgColor)
                    context.fillEllipse(in: CGRect(x: head.point.x - radius, y: head.point.y - radius, width: radius * 2, height: radius * 2))
                    continue
                }
                for i in stride(from: 1, to: stroke.count, by: 1) {
                    let life = max(0, 1 - (now - stroke[i].time) / laserDecay)
                    guard life > 0 else { continue }
                    context.setStrokeColor(color.withAlphaComponent((glow ? 0.25 : 1) * life).cgColor)
                    context.setLineWidth((1.5 + 5 * life) * scale)
                    context.move(to: stroke[i - 1].point)
                    context.addLine(to: stroke[i].point)
                    context.strokePath()
                }
            }
        }
        context.restoreGState()
    }
}

/// A label being typed. The app has no main menu, so the editing key equivalents that would
/// normally come from its Edit menu (⌘V matters most: dictation apps paste) are handled here.
final class LabelTextView: NSTextView {
    var onCommit: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), window?.firstResponder === self else { return super.performKeyEquivalent(with: event) }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "v": paste(nil)
        case "c": copy(nil)
        case "x": cut(nil)
        case "a": selectAll(nil)
        case "z": flags.contains(.shift) ? undoManager?.redo() : undoManager?.undo()
        case "\r": onCommit?()
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    override func cancelOperation(_ sender: Any?) { onCommit?() }
}
