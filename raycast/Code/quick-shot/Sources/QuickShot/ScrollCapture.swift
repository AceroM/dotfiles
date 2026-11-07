import AppKit
import OSLog

/// Scrolling capture: J scrolls the app under the area 100 points (Shift-J 500) and captures it again, Return stitches every
/// frame into one tall shot, Esc gives up. The overlay ignores the mouse, so scroll events reach the app below.
@MainActor
final class ScrollCapture {
    static let step: CGFloat = 100
    static let bigStep: CGFloat = 500
    private let logger = Logger(subsystem: "com.acerom.quickshot", category: "scroll")
    private let region: ScreenRegion
    private var completion: ((Shot?) -> Void)?
    private var frames: [CGImage] = []
    /// How far each frame scrolled past the one before, in pixels.
    private var offsets: [Int] = []
    private var scale: CGFloat = 2
    /// The latest queued step, so fast J presses scroll and capture one at a time.
    private var queue: Task<Void, Never>?
    private var window: NSWindow?
    private var view: ScrollOverlayView?

    init(region: ScreenRegion, completion: @escaping (Shot?) -> Void) {
        self.region = region
        self.completion = completion
    }

    /// Captures the area as it is now, which becomes the first frame, then shows the overlay.
    func start() async throws {
        let shot = try await Capture.region(region)
        frames = [shot.image]
        offsets = [0]
        scale = shot.scale
        guard let screen = NSScreen.screens.first(where: { $0.displayID == region.displayID }) else {
            throw CaptureError.displayGone
        }
        let window = ScrollOverlayWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered,
                                         defer: false)
        window.title = "Quick Shot — Scrolling Capture"
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .screenSaver
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = ScrollOverlayView(frame: CGRect(origin: .zero, size: screen.frame.size), region: region.rect)
        view.onStep = { [weak self] big in self?.enqueueStep(big: big) }
        view.onFinish = { [weak self] in self?.finish() }
        view.onCancel = { [weak self] in self?.close(with: nil) }
        window.contentView = view
        self.window = window
        self.view = view
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(view)
    }

    /// A big step stays within three quarters of the area, so consecutive frames still overlap enough to stitch.
    private func enqueueStep(big: Bool) {
        let points = big ? min(Self.bigStep, max(Self.step, (region.rect.height * 0.75).rounded())) : Self.step
        let previous = queue
        queue = Task {
            await previous?.value
            await step(points)
        }
    }

    private func step(_ points: CGFloat) async {
        guard completion != nil else { return }
        let display = CGDisplayBounds(region.displayID)
        let center = CGPoint(x: display.minX + region.rect.midX, y: display.minY + region.rect.midY)
        // Scroll events go to the window under the pointer, so park it on the area.
        CGWarpMouseCursorPosition(center)
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                            wheel1: -Int32(points), wheel2: 0, wheel3: 0)
        event?.location = center
        event?.post(tap: .cghidEventTap)
        // Let smooth scrolling and lazy rendering settle before capturing.
        try? await Task.sleep(for: .milliseconds(350))
        guard completion != nil else { return }
        do {
            frames.append(try await Capture.region(region).image)
            offsets.append(Int(points * scale))
            view?.frameCount = frames.count
        } catch {
            logger.error("Scroll frame failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func finish() {
        guard completion != nil, view?.isStitching == false else { return }
        view?.isStitching = true
        let pending = queue
        Task {
            await pending?.value
            let frames = frames, offsets = offsets, scale = scale
            let image = await Task.detached {
                Stitch.frames(frames, expectedOffsets: offsets, margin: Int(16 * scale))
            }.value
            close(with: image.map { Shot(image: $0, scale: scale) })
        }
    }

    private func close(with shot: Shot?) {
        guard let completion else { return }
        self.completion = nil
        queue?.cancel()
        window?.orderOut(nil)
        window?.close()
        window = nil
        view = nil
        completion(shot)
    }
}

private final class ScrollOverlayWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

private final class ScrollOverlayView: NSView {
    var onStep: ((_ big: Bool) -> Void)?
    var onFinish: (() -> Void)?
    var onCancel: (() -> Void)?
    var frameCount = 1 { didSet { needsDisplay = true } }
    var isStitching = false { didSet { needsDisplay = true } }
    private let region: CGRect
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(frame: NSRect, region: CGRect) {
        self.region = region
        super.init(frame: frame)
        setAccessibilityLabel("Scrolling capture. J scrolls and captures, Shift-J scrolls further, Return finishes, Escape cancels.")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func cancelOperation(_ sender: Any?) { onCancel?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onCancel?() }
        else if [36, 76].contains(event.keyCode) { onFinish?() }
        else if event.charactersIgnoringModifiers?.lowercased() == "j", !isStitching {
            onStep?(event.modifierFlags.contains(.shift))
        }
        else { super.keyDown(with: event) }
    }

    override func draw(_ dirtyRect: NSRect) {
        let mask = NSBezierPath(rect: bounds)
        mask.appendRect(region)
        mask.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.30).setFill()
        mask.fill()
        NSColor.white.setStroke()
        let outline = NSBezierPath(rect: region.insetBy(dx: -0.5, dy: -0.5))
        outline.lineWidth = 1
        outline.stroke()
        let frames = frameCount == 1 ? "1 frame" : "\(frameCount) frames"
        label(isStitching ? "Stitching \(frames)…" : "J scroll  ·  ⇧J scroll more  ·  Return finish  ·  Esc cancel  ·  \(frames)",
              at: CGPoint(x: region.midX, y: min(bounds.height - 44, region.maxY + 12)))
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
