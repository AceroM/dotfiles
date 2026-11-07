import AppKit

/// The last area that went to the editor, for before/after shots of the same spot.
/// Stored in global top-left coordinates, so it survives relaunches and display ID changes.
enum LastArea {
    private static let key = "lastArea"

    static func save(_ region: ScreenRegion) {
        let global = region.rect.offsetBy(dx: CGDisplayBounds(region.displayID).minX,
                                          dy: CGDisplayBounds(region.displayID).minY)
        UserDefaults.standard.set([global.minX, global.minY, global.width, global.height].map(Double.init),
                                  forKey: key)
    }

    @MainActor
    static func load() -> ScreenRegion? {
        guard let values = UserDefaults.standard.array(forKey: key) as? [Double], values.count == 4 else { return nil }
        let displays = NSScreen.screens.map { (id: $0.displayID, frame: CGDisplayBounds($0.displayID)) }
        return resolve(CGRect(x: values[0], y: values[1], width: values[2], height: values[3]), on: displays)
    }

    /// The display holding the area's center, with the area clipped to it; nil once that spot is off every display.
    static func resolve(_ global: CGRect, on displays: [(id: CGDirectDisplayID, frame: CGRect)]) -> ScreenRegion? {
        guard let display = displays.first(where: { $0.frame.contains(CGPoint(x: global.midX, y: global.midY)) })
        else { return nil }
        let local = global.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            .intersection(CGRect(origin: .zero, size: display.frame.size))
        guard !local.isNull, local.width >= 4, local.height >= 4 else { return nil }
        return ScreenRegion(displayID: display.id, rect: local)
    }
}
