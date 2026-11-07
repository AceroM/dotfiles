import Foundation

/// A shape a drag is held to while its modifier is down.
enum Aspect: Equatable {
    /// ⇧: 1:1.
    case square
    /// ⌥: 16:9, or 9:16 when the drag is taller than it is wide.
    case widescreen

    /// Whole-point units, so every locked size is an exact multiple and the ratio survives rounding.
    func units(landscape: Bool) -> (width: CGFloat, height: CGFloat) {
        switch self {
        case .square: (1, 1)
        case .widescreen: landscape ? (16, 9) : (9, 16)
        }
    }

    func label(for rect: CGRect) -> String {
        switch self {
        case .square: "1:1"
        case .widescreen: rect.width >= rect.height ? "16:9" : "9:16"
        }
    }
}

/// Window rectangles are display-local, top-left coordinates, ordered front to back.
struct CaptureSelection {
    let bounds: CGRect
    let windowRects: [CGRect]
    private(set) var anchor: CGPoint?
    private(set) var selection: CGRect?
    private(set) var isDragging = false
    private var pressedWindow: CGRect?
    private var dragPoint: CGPoint?
    /// Held while its modifier is down; changing it mid-drag reshapes the selection without a mouse move.
    var aspect: Aspect? {
        didSet { if aspect != oldValue, let dragPoint { drag(to: dragPoint) } }
    }

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
        dragPoint = nil
        isDragging = false
    }

    mutating func drag(to point: CGPoint) {
        guard let anchor else { return }
        dragPoint = point
        // Allow small click jitter. Once a drag starts, never fall back to a window.
        if hypot(point.x - anchor.x, point.y - anchor.y) >= 4 { isDragging = true }
        guard isDragging else { return }
        if let aspect {
            selection = Self.locked(from: anchor, to: point, aspect: aspect, in: bounds)
        } else {
            selection = CGRect(x: min(anchor.x, point.x), y: min(anchor.y, point.y),
                               width: abs(point.x - anchor.x), height: abs(point.y - anchor.y))
                .integral.intersection(bounds)
        }
    }

    /// Grows from the anchor toward the pointer until it covers it, shrinking instead of leaving the display.
    static func locked(from anchor: CGPoint, to point: CGPoint, aspect: Aspect, in bounds: CGRect) -> CGRect {
        let start = CGPoint(x: anchor.x.rounded(), y: anchor.y.rounded())
        let dx = point.x - start.x, dy = point.y - start.y
        let unit = aspect.units(landscape: abs(dx) >= abs(dy))
        let roomX = dx < 0 ? start.x - bounds.minX : bounds.maxX - start.x
        let roomY = dy < 0 ? start.y - bounds.minY : bounds.maxY - start.y
        let steps = max(0, min(max(abs(dx) / unit.width, abs(dy) / unit.height),
                               roomX / unit.width, roomY / unit.height).rounded(.down))
        let size = CGSize(width: steps * unit.width, height: steps * unit.height)
        return CGRect(x: dx < 0 ? start.x - size.width : start.x, y: dy < 0 ? start.y - size.height : start.y,
                      width: size.width, height: size.height)
    }

    mutating func release(at point: CGPoint) -> CGRect? {
        guard anchor != nil else { return nil }
        drag(to: point)
        let result = isDragging ? selection : pressedWindow
        anchor = nil
        dragPoint = nil
        isDragging = false
        pressedWindow = nil
        hover(at: point)
        return result.flatMap { Self.isUsable($0) ? $0 : nil }
    }

    private static func isUsable(_ rect: CGRect) -> Bool {
        !rect.isNull && rect.width >= 16 && rect.height >= 16
    }
}
