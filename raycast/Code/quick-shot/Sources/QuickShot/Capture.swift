import AppKit
import ScreenCaptureKit

/// A captured image plus its pixels-per-point, so output keeps Retina detail at the right size.
struct Shot {
    let image: CGImage
    let scale: CGFloat
    /// Where on screen it came from, so a scrolling capture can recapture the same area.
    var region: ScreenRegion? = nil
}

/// Display-local points, top-left origin.
struct ScreenRegion {
    let displayID: CGDirectDisplayID
    let rect: CGRect
}

enum Capture {
    /// Freezes every display before the selector appears, so menus and hover states survive.
    static func displays() async throws -> [CGDirectDisplayID: Shot] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let ownApp = content.applications.filter { $0.processID == getpid() }
        var shots: [CGDirectDisplayID: Shot] = [:]
        for display in content.displays {
            let filter = SCContentFilter(display: display, excludingApplications: ownApp, exceptingWindows: [])
            shots[display.displayID] = try await shot(filter, size: filter.contentRect.size)
        }
        return shots
    }

    /// One display, straight to the editor with no selector.
    static func display(id: CGDirectDisplayID) async throws -> Shot {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == id }) else {
            throw CaptureError.displayGone
        }
        let ownApp = content.applications.filter { $0.processID == getpid() }
        let filter = SCContentFilter(display: display, excludingApplications: ownApp, exceptingWindows: [])
        var shot = try await shot(filter, size: filter.contentRect.size)
        shot.region = ScreenRegion(displayID: id, rect: CGRect(origin: .zero, size: filter.contentRect.size))
        return shot
    }

    /// A live area of one display, without Quick Shot's own windows.
    static func region(_ region: ScreenRegion) async throws -> Shot {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == region.displayID }) else {
            throw CaptureError.displayGone
        }
        let ownApp = content.applications.filter { $0.processID == getpid() }
        let filter = SCContentFilter(display: display, excludingApplications: ownApp, exceptingWindows: [])
        var shot = try await shot(filter, size: region.rect.size, sourceRect: region.rect)
        shot.region = region
        return shot
    }

    /// The window alone, including parts hidden behind other windows.
    static func window(id: CGWindowID) async throws -> Shot {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            throw CaptureError.windowGone
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        return try await shot(filter, size: window.frame.size)
    }

    /// The app's frontmost normal window, plus its area when it sits on one display (for scrolling capture).
    static func frontWindow(of pid: pid_t) -> (id: CGWindowID, region: ScreenRegion?)? {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                   kCGNullWindowID) as? [[String: Any]] else { return nil }
        for window in info {
            guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber, owner.int32Value == pid,
                  let layer = window[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
                  let alpha = window[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue > 0,
                  let number = window[kCGWindowNumber as String] as? NSNumber,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 4, rect.height > 4 else { continue }
            let display = NSScreen.screens.map(\.displayID).first { CGDisplayBounds($0).contains(rect) }
            let region = display.map { ScreenRegion(displayID: $0, rect: rect.offsetBy(dx: -CGDisplayBounds($0).minX,
                                                                                       dy: -CGDisplayBounds($0).minY)) }
            return (number.uint32Value, region)
        }
        return nil
    }

    private static func shot(_ filter: SCContentFilter, size: CGSize, sourceRect: CGRect? = nil) async throws -> Shot {
        let scale = CGFloat(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int((size.width * scale).rounded())
        config.height = Int((size.height * scale).rounded())
        config.showsCursor = false
        config.captureResolution = .best
        if let sourceRect { config.sourceRect = sourceRect }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return Shot(image: image, scale: scale)
    }
}

enum CaptureError: LocalizedError {
    case windowGone
    case displayGone

    var errorDescription: String? {
        switch self {
        case .windowGone: "That window closed before it could be captured."
        case .displayGone: "That display disconnected before it could be captured."
        }
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }
}
