import Foundation

/// Window rectangles are display-local, top-left coordinates, ordered front to back.
struct CaptureSelection {
    let bounds: CGRect
    let windowRects: [CGRect]
    private(set) var anchor: CGPoint?
    private(set) var selection: CGRect?
    private(set) var isDragging = false
    private var pressedWindow: CGRect?

    init(bounds: CGRect, windowRects: [CGRect]) {
        self.bounds = bounds
        self.windowRects = windowRects.compactMap { Self.clippedWindow($0, to: bounds) }
    }

    static func clippedWindow(_ rect: CGRect, to bounds: CGRect) -> CGRect? {
        guard [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy(\.isFinite),
              rect.width > 0, rect.height > 0 else { return nil }
        let clipped = rect.integral.intersection(bounds)
        return isUsable(clipped) ? clipped : nil
    }

    mutating func hover(at point: CGPoint) {
        guard anchor == nil else { return }
        selection = windowRects.first { $0.contains(point) }
    }

    mutating func leave() {
        guard anchor == nil else { return }
        selection = nil
    }

    mutating func press(at point: CGPoint) {
        hover(at: point)
        pressedWindow = selection
        anchor = point
        isDragging = false
    }

    mutating func drag(to point: CGPoint) {
        guard let anchor else { return }
        // Allow small click jitter. Once a drag starts, never fall back to a window.
        if hypot(point.x - anchor.x, point.y - anchor.y) >= 4 { isDragging = true }
        guard isDragging else { return }
        selection = CGRect(x: min(anchor.x, point.x), y: min(anchor.y, point.y),
                           width: abs(point.x - anchor.x), height: abs(point.y - anchor.y))
            .integral.intersection(bounds)
    }

    mutating func release(at point: CGPoint) -> CGRect? {
        guard anchor != nil else { return nil }
        drag(to: point)
        let result = isDragging ? selection : pressedWindow
        anchor = nil
        isDragging = false
        pressedWindow = nil
        hover(at: point)
        return result.flatMap { Self.isUsable($0) ? $0 : nil }
    }

    private static func isUsable(_ rect: CGRect) -> Bool {
        !rect.isNull && rect.width >= 16 && rect.height >= 16
    }
}
