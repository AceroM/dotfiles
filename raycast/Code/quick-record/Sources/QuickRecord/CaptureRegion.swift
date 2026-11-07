import AppKit

/// Coordinates are display-local points, with the origin at the top left.
/// Persist the display UUID rather than relying on IDs surviving a reconnect.
struct CaptureRegion: Codable, Equatable {
    let displayUUID: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    init(displayUUID: String, rect: CGRect) {
        self.displayUUID = displayUUID
        x = rect.minX
        y = rect.minY
        width = rect.width
        height = rect.height
    }

    func fits(in size: CGSize) -> Bool {
        [x, y, width, height].allSatisfy(\.isFinite)
            && width >= 16 && height >= 16
            && x >= 0 && y >= 0
            && rect.maxX <= size.width && rect.maxY <= size.height
    }

    /// H.264 needs even dimensions. Bound Retina output to 4K for fast, shareable files.
    func outputSize(scale: CGFloat) -> (width: Int, height: Int) {
        let factor = min(scale, 3840 / rect.width, 2160 / rect.height)
        return (
            max(2, Int((rect.width * factor / 2).rounded(.down)) * 2),
            max(2, Int((rect.height * factor / 2).rounded(.down)) * 2)
        )
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    var displayUUID: String {
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else {
            return String(displayID)
        }
        return CFUUIDCreateString(nil, uuid) as String
    }
}
