import Foundation

enum SelectionResult: Equatable {
    /// Display-local points, top-left origin.
    case region(CGRect)
    /// Index into the window list the selection was built with.
    case window(Int)
}

/// Window rectangles are display-local, top-left coordinates, ordered front to back.
/// Area mode drags a region (a click takes the window's visible area); window mode only clicks.
struct CaptureSelection {
    let bounds: CGRect
    let allowsDrag: Bool
    private let windows: [(index: Int, rect: CGRect)]
    private(set) var anchor: CGPoint?
    private(set) var selection: CGRect?
    private(set) var isDragging = false
    private var hovered: (index: Int, rect: CGRect)?
    private var pressed: (index: Int, rect: CGRect)?

    init(bounds: CGRect, windowRects: [CGRect], allowsDrag: Bool) {
        self.bounds = bounds
        self.allowsDrag = allowsDrag
        windows = windowRects.enumerated().compactMap { index, rect in
            Self.clippedWindow(rect, to: bounds).map { (index, $0) }
        }
    }

    static func clippedWindow(_ rect: CGRect, to bounds: CGRect) -> CGRect? {
        guard [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy(\.isFinite),
              rect.width > 0, rect.height > 0 else { return nil }
        let clipped = rect.integral.intersection(bounds)
        return isUsable(clipped) ? clipped : nil
    }

    mutating func hover(at point: CGPoint) {
        guard anchor == nil else { return }
        hovered = windows.first { $0.rect.contains(point) }
        selection = hovered?.rect
    }

    mutating func leave() {
        guard anchor == nil else { return }
        hovered = nil
        selection = nil
    }

    mutating func press(at point: CGPoint) {
        hover(at: point)
        pressed = hovered
        anchor = point
        isDragging = false
    }

    mutating func drag(to point: CGPoint) {
        guard allowsDrag, let anchor else { return }
        // Allow small click jitter. Once a drag starts, never fall back to a window.
        if hypot(point.x - anchor.x, point.y - anchor.y) >= 4 { isDragging = true }
        guard isDragging else { return }
        selection = CGRect(x: min(anchor.x, point.x), y: min(anchor.y, point.y),
                           width: abs(point.x - anchor.x), height: abs(point.y - anchor.y))
            .integral.intersection(bounds)
    }

    mutating func release(at point: CGPoint) -> SelectionResult? {
        guard anchor != nil else { return nil }
        drag(to: point)
        let result: SelectionResult?
        if isDragging {
            result = selection.flatMap { Self.isUsable($0) ? .region($0) : nil }
        } else if let pressed {
            result = allowsDrag ? .region(pressed.rect) : .window(pressed.index)
        } else {
            result = nil
        }
        anchor = nil
        isDragging = false
        pressed = nil
        hover(at: point)
        return result
    }

    private static func isUsable(_ rect: CGRect) -> Bool {
        !rect.isNull && rect.width >= 4 && rect.height >= 4
    }
}
