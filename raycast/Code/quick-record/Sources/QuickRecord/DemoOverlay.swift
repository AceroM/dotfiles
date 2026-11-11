import AppKit
import OSLog
import SwiftUI

/// Wispr Flow's deep links. Opened without activating Wispr, so its transcript lands in the
/// focused field, which during a demo is the label on the canvas.
enum Wispr {
    static func send(_ action: String, completion: ((Error?) -> Void)? = nil) {
        guard let url = URL(string: "wispr-flow://\(action)") else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        NSWorkspace.shared.open(url, configuration: configuration) { _, error in
            DispatchQueue.main.async { completion?(error) }
        }
    }
}

enum DictationState: Equatable { case off, listening, transcribing }
enum HARStatus: Equatable { case waiting, recording(String), saving, saved(Int), unavailable }

@MainActor
final class DemoState: ObservableObject {
    @Published var tool = AnnotationTool.interact
    @Published var lastDrawingTool = AnnotationTool.draw
    @Published var style = AnnotationStyle.load() { didSet { if style != oldValue { style.save(); onStyle?(style) } } }
    @Published var elapsed = "Starting…"
    @Published var dictation = DictationState.off
    @Published var dictationError: String?
    @Published var har = HARStatus.waiting
    @Published var canUndo = false
    @Published var canRedo = false
    @Published var hasElements = false
    var onStyle: ((AnnotationStyle) -> Void)?
}

/// The demo-mode windows: a canvas over the recorded region (captured), a toolbar and a border
/// (both left out of the recording because Quick Record excludes its own windows).
@MainActor
final class DemoOverlay {
    let state = DemoState()
    var onStop: (() -> Void)?
    /// After the last label is committed, which may be a while after the stop if Wispr is still typing.
    var onClosed: (() -> Void)?
    var canvasWindowID: CGWindowID { CGWindowID(canvasWindow.windowNumber) }

    private let canvasWindow: OverlayPanel
    private let canvas: AnnotationCanvasView
    private let toolbar: OverlayPanel
    private let border: NSWindow
    private let regionFrame: CGRect
    private let screen: NSScreen
    private let targetApp: NSRunningApplication?
    private var returnApp: NSRunningApplication?
    private var pendingTool: AnnotationTool?
    private var dictationTimer: Timer?
    private var settleTimer: Timer?
    private var closing = false
    /// Held while a close waits on Wispr, after the recorder has let go of this overlay.
    private var keepAlive: DemoOverlay?
    private let logger = Logger(subsystem: "com.acerom.quickrecord", category: "demo")

    /// `region` is display-local, top-left; the windows need AppKit's global, bottom-left frame.
    init(region: CaptureRegion, screen: NSScreen, targetApp: NSRunningApplication?, log: AnnotationLog? = nil) {
        self.screen = screen
        self.targetApp = targetApp
        regionFrame = CGRect(x: screen.frame.minX + region.x, y: screen.frame.maxY - region.y - region.height,
                             width: region.width, height: region.height)
        let level = NSWindow.Level.statusBar

        canvasWindow = OverlayPanel(contentRect: regionFrame, styleMask: [.borderless, .nonactivatingPanel],
                                    backing: .buffered, defer: false)
        canvasWindow.allowsKey = true
        canvasWindow.title = "Quick Record — Annotations"
        canvas = AnnotationCanvasView(frame: CGRect(origin: .zero, size: regionFrame.size))
        canvas.log = log
        canvasWindow.contentView = canvas
        canvasWindow.level = level

        border = OverlayPanel(contentRect: regionFrame.insetBy(dx: -4, dy: -4), styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        border.contentView = RegionBorderView(frame: CGRect(origin: .zero, size: border.frame.size))
        border.ignoresMouseEvents = true
        border.level = level

        toolbar = OverlayPanel(contentRect: CGRect(x: 0, y: 0, width: 640, height: 80), styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        toolbar.title = "Quick Record — Demo Toolbar"
        toolbar.level = NSWindow.Level(rawValue: level.rawValue + 1)

        for window in [canvasWindow, border, toolbar] {
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            window.hidesOnDeactivate = false
            window.isReleasedWhenClosed = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        }
        toolbar.hasShadow = true
        // Starts in Interact. Drawing sets this explicitly false, which makes a clear window take
        // clicks everywhere rather than only where something is painted.
        canvasWindow.ignoresMouseEvents = true

        let actions = DemoActions(
            select: { [weak self] in self?.select($0) },
            undo: { [weak self] in self?.canvas.undo() },
            redo: { [weak self] in self?.canvas.redo() },
            clear: { [weak self] in self?.canvas.clear() },
            dictate: { [weak self] in self?.toggleDictation() },
            stop: { [weak self] in self?.onStop?() })
        let host = FirstMouseHostingView(rootView: DemoToolbar(state: state, actions: actions))
        host.sizingOptions = [.intrinsicContentSize]
        toolbar.contentView = host
        host.onResize = { [weak self] in self?.fitToolbar() }

        canvas.style = state.style
        state.onStyle = { [weak self] in self?.canvas.style = $0 }
        canvas.onChange = { [weak self] in self?.syncHistory() }
        canvas.onShortcut = { [weak self] in self?.select($0) }
        canvas.onEscape = { [weak self] in self?.select(.interact) }
        canvas.onDictate = { [weak self] in self?.toggleDictation() }
        canvas.onBeginTyping = { [weak self] in self?.activateForTyping() }
        canvas.shouldCommit = { [weak self] in
            guard let self else { return true }
            switch self.state.dictation {
            case .off: return true
            case .listening: self.toggleDictation(); return false
            case .transcribing: return false
            }
        }
        canvas.onTextChange = { [weak self] in self?.dictatedTextArrived() }
    }

    func show() {
        border.orderFrontRegardless()
        canvasWindow.orderFrontRegardless()
        fitToolbar(initial: true)
        toolbar.orderFrontRegardless()
    }

    func setElapsed(_ text: String) { state.elapsed = text }

    // MARK: Tools and focus

    func select(_ tool: AnnotationTool) {
        guard !closing else { return }
        if state.dictation != .off, tool != .text {
            // Keep the label focused until Wispr has typed into it.
            pendingTool = tool
            if state.dictation == .listening { toggleDictation() }
            return
        }
        state.tool = tool
        canvas.tool = tool
        if tool == .interact {
            canvasWindow.ignoresMouseEvents = true
            giveFocusBack()
        } else {
            state.lastDrawingTool = tool
            canvasWindow.ignoresMouseEvents = false
            // The canvas takes the keyboard so Excalidraw's shortcuts work; Interact hands it back.
            rememberReturnApp()
            canvasWindow.makeKey()
            canvasWindow.makeFirstResponder(canvas.isEditing ? canvasWindow.firstResponder : canvas)
        }
    }

    /// The global toggle (fn+⌥A): draw with the last tool, or hand the pointer back to the app.
    func toggleDrawing() {
        select(state.tool == .interact ? state.lastDrawingTool : .interact)
    }

    private func activateForTyping() {
        rememberReturnApp()
        NSApp.activate(ignoringOtherApps: true)
        canvasWindow.makeKeyAndOrderFront(nil)
    }

    /// The app in use before the canvas took the keyboard (usually the one being recorded).
    private func rememberReturnApp() {
        guard !NSApp.isActive, !canvasWindow.isKeyWindow, let front = NSWorkspace.shared.frontmostApplication,
              front.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        returnApp = front
    }

    /// Only if the canvas has the keyboard: otherwise the user is already somewhere else.
    private func giveFocusBack() {
        let app = returnApp ?? targetApp
        returnApp = nil
        guard NSApp.isActive || canvasWindow.isKeyWindow else { return }
        guard let app, app.processIdentifier != ProcessInfo.processInfo.processIdentifier, !app.isTerminated else { return }
        app.activate(options: [])
    }

    private func syncHistory() {
        state.canUndo = canvas.canUndo
        state.canRedo = canvas.canRedo
        state.hasElements = !canvas.elements.isEmpty
    }

    // MARK: Dictation

    /// M or the mic button: open a label (at the pointer if it's over the canvas) and start Wispr
    /// Flow's hands-free dictation; again to stop, after which Wispr types the transcript into it.
    func toggleDictation() {
        if closing && state.dictation == .off { return }
        switch state.dictation {
        case .off:
            state.dictationError = nil
            if state.tool != .text { select(.text) }
            if !canvas.isEditing { canvas.beginEditing(at: canvas.defaultLabelPoint) }
            state.dictation = .listening
            Wispr.send("start-hands-free") { [weak self] error in
                guard let self, let error else { return }
                self.logger.error("Wispr start failed: \(error.localizedDescription, privacy: .public)")
                self.state.dictationError = "Couldn’t reach Wispr Flow"
                self.finishDictation()
            }
        case .listening:
            state.dictation = .transcribing
            Wispr.send("stop-hands-free")
            dictationTimer?.invalidate()
            // Wispr usually types within a second or two; don't hold the label hostage if it never does.
            dictationTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.finishDictation() }
            }
        case .transcribing:
            finishDictation()
        }
    }

    private func dictatedTextArrived() {
        guard state.dictation == .transcribing else { return }
        // Wispr may type in pieces; settle before letting the label be committed.
        settleTimer?.invalidate()
        settleTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.finishDictation() }
        }
    }

    private func finishDictation() {
        dictationTimer?.invalidate()
        settleTimer?.invalidate()
        dictationTimer = nil
        settleTimer = nil
        state.dictation = .off
        if closing { teardown(); return }
        if let tool = pendingTool {
            pendingTool = nil
            canvas.commitText()
            select(tool)
        }
    }

    // MARK: Status from the recorder

    func setHAR(_ status: HARStatus) { state.har = status }

    /// Called once capture has stopped. A label still waiting on Wispr keeps the (now unrecorded)
    /// canvas focused until the transcript lands, so it isn't typed into the app underneath.
    func close() {
        guard !closing else { return }
        closing = true
        toolbar.orderOut(nil)
        border.orderOut(nil)
        switch state.dictation {
        case .off: teardown()
        case .listening:
            keepAlive = self
            canvasWindow.alphaValue = 0
            toggleDictation()
        case .transcribing:
            keepAlive = self
            canvasWindow.alphaValue = 0
        }
    }

    private func teardown() {
        canvas.commitText()
        canvas.flushLaser()
        giveFocusBack()
        canvasWindow.orderOut(nil)
        canvasWindow.close()
        toolbar.close()
        border.close()
        let closed = onClosed
        onClosed = nil
        closed?()
        keepAlive = nil
    }

    // MARK: Layout

    /// Above the region if there's room, else below it, else just inside its top edge.
    private func fitToolbar(initial: Bool = false) {
        guard !closing, let host = toolbar.contentView else { return }
        let size = host.fittingSize
        guard size.width > 0, size.height > 0 else { return }
        let visible = screen.visibleFrame
        var origin: CGPoint
        if initial {
            let x = min(max(visible.minX + 8, regionFrame.midX - size.width / 2), visible.maxX - size.width - 8)
            if regionFrame.maxY + 10 + size.height <= visible.maxY {
                origin = CGPoint(x: x, y: regionFrame.maxY + 10)
            } else if regionFrame.minY - 10 - size.height >= visible.minY {
                origin = CGPoint(x: x, y: regionFrame.minY - 10 - size.height)
            } else {
                origin = CGPoint(x: x, y: regionFrame.maxY - size.height - 10)
            }
        } else {
            // Keep the top-left corner where the user left it as the toolbar grows and shrinks.
            origin = CGPoint(x: toolbar.frame.minX, y: toolbar.frame.maxY - size.height)
        }
        toolbar.setFrame(CGRect(origin: origin, size: size), display: true)
    }
}

final class OverlayPanel: NSPanel {
    var allowsKey = false
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
}

final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    /// SwiftUI invalidates the intrinsic size when the toolbar's content changes; the panel follows.
    var onResize: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        DispatchQueue.main.async { [weak self] in self?.onResize?() }
    }
}

/// Marks the recorded area. Drawn outside it, and not captured anyway.
private final class RegionBorderView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(rect: bounds.insetBy(dx: 2, dy: 2))
        path.lineWidth = 2
        NSColor.black.withAlphaComponent(0.35).setStroke()
        path.stroke()
        path.setLineDash([8, 6], count: 2, phase: 0)
        NSColor.systemRed.withAlphaComponent(0.9).setStroke()
        path.stroke()
    }
}

// MARK: - Toolbar

struct DemoActions {
    var select: (AnnotationTool) -> Void
    var undo: () -> Void
    var redo: () -> Void
    var clear: () -> Void
    var dictate: () -> Void
    var stop: () -> Void
}

struct DemoToolbar: View {
    @ObservedObject var state: DemoState
    let actions: DemoActions

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 2) {
                DragHandle()
                Button(action: actions.stop) {
                    HStack(spacing: 6) {
                        Circle().fill(Color.red).frame(width: 8, height: 8)
                        Text(state.elapsed).monospacedDigit().font(.system(size: 12, weight: .medium))
                        Image(systemName: "stop.fill").font(.system(size: 10))
                    }
                    .padding(.horizontal, 8).frame(height: 28)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color.red.opacity(0.14)))
                }
                .buttonStyle(.plain)
                .help("Stop and save the demo (fn+⌥Q)")
                ToolbarDivider()
                ForEach(AnnotationTool.allCases, id: \.self) { tool in
                    ToolButton(symbol: tool.symbol, badge: tool.shortcut, selected: state.tool == tool,
                               help: "\(tool.title) — \(tool.shortcut)") { actions.select(tool) }
                }
                ToolbarDivider()
                ToolButton(symbol: state.dictation == .off ? "mic" : "mic.fill", badge: "M",
                           selected: state.dictation != .off, tint: state.dictation == .off ? nil : .red,
                           help: dictationHelp, action: actions.dictate)
                ToolbarDivider()
                ToolButton(symbol: "arrow.uturn.backward", help: "Undo — ⌘Z", action: actions.undo).disabled(!state.canUndo)
                ToolButton(symbol: "arrow.uturn.forward", help: "Redo — ⇧⌘Z", action: actions.redo).disabled(!state.canRedo)
                ToolButton(symbol: "trash", help: "Clear all annotations — ⌘⌫", action: actions.clear).disabled(!state.hasElements)
                ToolbarDivider()
                HARBadge(status: state.har)
            }
            PropertiesRow(state: state)
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 11).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(Color.primary.opacity(0.12)))
        .fixedSize()
    }

    private var dictationHelp: String {
        switch state.dictation {
        case .off: state.dictationError ?? "Dictate a label with Wispr Flow — M"
        case .listening: "Listening… click (or M) to stop; Wispr types the label"
        case .transcribing: "Waiting for Wispr’s transcript…"
        }
    }
}

private struct ToolbarDivider: View {
    var body: some View {
        Rectangle().fill(Color.primary.opacity(0.15)).frame(width: 1, height: 20).padding(.horizontal, 4)
    }
}

private struct ToolButton: View {
    let symbol: String
    var badge: String?
    var selected = false
    var tint: Color?
    let help: String
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: symbol)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(tint ?? (selected ? Color.accentColor : Color.primary))
                    .frame(width: 30, height: 28)
                if let badge {
                    Text(badge).font(.system(size: 7.5, weight: .semibold)).foregroundStyle(.secondary).padding(1.5)
                }
            }
            .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Color.accentColor.opacity(0.2) : Color.clear))
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.35)
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private struct HARBadge: View {
    let status: HARStatus

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text("HAR").font(.system(size: 10, weight: .semibold))
        }
        .padding(.horizontal, 7).frame(height: 22)
        .background(Capsule().fill(Color.primary.opacity(0.07)))
        .help(help)
        .padding(.trailing, 2)
    }

    private var color: Color {
        switch status {
        case .recording, .saved: .green
        case .saving: .orange
        case .waiting, .unavailable: .gray
        }
    }

    private var help: String {
        switch status {
        case .waiting: "Waiting for the Quick Record HAR Chrome extension…"
        case .recording(let browser): "\(browser) is recording a HAR of this demo"
        case .saving: "Saving the HAR…"
        case .saved(let count): "HAR saved (\(count) requests)"
        case .unavailable: "No HAR: the Quick Record HAR extension isn’t connected in Chrome"
        }
    }
}

/// Drags the toolbar panel, which has no title bar.
private struct DragHandle: NSViewRepresentable {
    final class Handle: NSView {
        override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.secondaryLabelColor.withAlphaComponent(0.6).setFill()
            for row in 0..<3 {
                for column in 0..<2 {
                    let dot = CGRect(x: bounds.midX - 3.5 + CGFloat(column) * 5, y: bounds.midY - 6 + CGFloat(row) * 5, width: 2, height: 2)
                    NSBezierPath(ovalIn: dot).fill()
                }
            }
        }
    }
    func makeNSView(context: Context) -> Handle { Handle() }
    func updateNSView(_ nsView: Handle, context: Context) {}
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: Handle, context: Context) -> CGSize? { CGSize(width: 14, height: 28) }
}

// MARK: - Properties (Excalidraw's left panel, as a second row)

private struct PropertiesRow: View {
    @ObservedObject var state: DemoState

    var body: some View {
        let tool = state.tool
        HStack(spacing: 10) {
            if tool == .interact {
                hint("Clicks go to the app. Pick a tool to draw; Esc or 1 comes back here; fn+⌥A toggles.")
            } else if tool == .eraser {
                hint("Drag across annotations to erase them. ⌘⌫ clears everything.")
            } else if tool == .laser {
                hint("Hold and drag: a fading red trail, never saved as a drawing.")
            } else {
                group("Stroke") {
                    ForEach(Palette.strokes, id: \.self) { hex in
                        Swatch(hex: hex, selected: state.style.strokeColor == hex) { state.style.strokeColor = hex }
                    }
                }
                if tool.isShape {
                    group("Background") {
                        Swatch(hex: nil, selected: state.style.background == nil) { state.style.background = nil }
                        ForEach(Palette.backgrounds, id: \.self) { hex in
                            Swatch(hex: hex, selected: state.style.background == hex) { state.style.background = hex }
                        }
                    }
                    if state.style.background != nil {
                        group("Fill") {
                            ForEach(FillStyle.allCases, id: \.self) { fill in
                                Option(selected: state.style.fill == fill, help: fill.rawValue) { state.style.fill = fill } label: {
                                    FillIcon(fill: fill)
                                }
                            }
                        }
                    }
                }
                if tool == .text {
                    group("Font") {
                        ForEach(FontFamily.allCases, id: \.self) { family in
                            Option(selected: state.style.fontFamily == family, help: family.rawValue) { state.style.fontFamily = family } label: {
                                Text("Aa").font(Font(family.font(size: 13) as CTFont))
                            }
                        }
                    }
                    group("Size") {
                        ForEach(FontSize.allCases, id: \.self) { size in
                            Option(selected: state.style.fontSize == size, help: "\(Int(size.points)) pt") { state.style.fontSize = size } label: {
                                Text(size.label).font(.system(size: 11, weight: .semibold))
                            }
                        }
                    }
                } else {
                    group("Width") {
                        ForEach(StrokeWidth.allCases, id: \.self) { width in
                            Option(selected: state.style.width == width, help: width.rawValue) { state.style.width = width } label: {
                                Capsule().frame(width: 16, height: width.points / 1.6 + 0.5)
                            }
                        }
                    }
                }
                if tool.isShape || tool.isLinear {
                    group("Style") {
                        ForEach(StrokePattern.allCases, id: \.self) { pattern in
                            Option(selected: state.style.pattern == pattern, help: pattern.rawValue) { state.style.pattern = pattern } label: {
                                PatternIcon(pattern: pattern)
                            }
                        }
                    }
                    group("Sloppiness") {
                        ForEach(Sloppiness.allCases, id: \.self) { level in
                            Option(selected: state.style.sloppiness == level, help: level.rawValue) { state.style.sloppiness = level } label: {
                                SloppinessIcon(level: level)
                            }
                        }
                    }
                }
            }
        }
        .padding(.leading, 18)
        .frame(height: 26)
        .fixedSize()
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(.secondary)
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 3) {
            Text(title).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).padding(.trailing, 2)
            content()
        }
        .fixedSize()
    }
}

private struct Swatch: View {
    let hex: String?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(hex.map { Color(nsColor: Palette.color($0)) } ?? Color.clear)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.primary.opacity(0.25)))
                if hex == nil {
                    Path { path in
                        path.move(to: CGPoint(x: 3, y: 15))
                        path.addLine(to: CGPoint(x: 15, y: 3))
                    }
                    .stroke(Color.red.opacity(0.8), lineWidth: 1.2)
                }
            }
            .frame(width: 18, height: 18)
            .padding(2)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .help(hex ?? "transparent")
    }
}

private struct Option<Label: View>: View {
    let selected: Bool
    let help: String
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button(action: action) {
            label()
                .foregroundStyle(selected ? Color.accentColor : Color.primary)
                .frame(width: 24, height: 22)
                .background(RoundedRectangle(cornerRadius: 5).fill(selected ? Color.accentColor.opacity(0.2) : Color.primary.opacity(0.05)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private struct FillIcon: View {
    let fill: FillStyle
    var body: some View {
        Canvas { context, size in
            let box = CGRect(origin: .zero, size: size).insetBy(dx: 1, dy: 1)
            let outline = Path(roundedRect: box, cornerRadius: 2)
            if fill == .solid {
                context.fill(outline, with: .foreground)
                return
            }
            var lines = Path()
            for offset in stride(from: -box.height, through: box.width, by: 3.5) {
                lines.move(to: CGPoint(x: box.minX + offset, y: box.maxY))
                lines.addLine(to: CGPoint(x: box.minX + offset + box.height, y: box.minY))
                if fill == .crossHatch {
                    lines.move(to: CGPoint(x: box.minX + offset, y: box.minY))
                    lines.addLine(to: CGPoint(x: box.minX + offset + box.height, y: box.maxY))
                }
            }
            context.clip(to: outline)
            context.stroke(lines, with: .foreground, lineWidth: 0.8)
            context.stroke(outline, with: .foreground, lineWidth: 1)
        }
        .frame(width: 14, height: 14)
    }
}

private struct PatternIcon: View {
    let pattern: StrokePattern
    var body: some View {
        Path { path in
            path.move(to: CGPoint(x: 1, y: 7))
            path.addLine(to: CGPoint(x: 17, y: 7))
        }
        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: pattern == .dotted ? .round : .butt,
                                   dash: pattern == .solid ? [] : (pattern == .dashed ? [4, 3] : [0.1, 3.5])))
        .frame(width: 18, height: 14)
    }
}

private struct SloppinessIcon: View {
    let level: Sloppiness
    var body: some View {
        Path { path in
            let amplitude: CGFloat = level == .architect ? 0 : (level == .artist ? 1.8 : 3.5)
            path.move(to: CGPoint(x: 1, y: 7))
            path.addCurve(to: CGPoint(x: 17, y: 7),
                          control1: CGPoint(x: 6, y: 7 - amplitude * 2), control2: CGPoint(x: 12, y: 7 + amplitude * 2))
        }
        .stroke(lineWidth: 1.6)
        .frame(width: 18, height: 14)
    }
}
