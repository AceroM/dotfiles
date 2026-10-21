import AppKit
import ScreenCaptureKit

/// A captured image plus its pixels-per-point, so output keeps Retina detail at the right size.
struct Shot {
    let image: CGImage
    let scale: CGFloat
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
        return try await shot(filter, size: filter.contentRect.size)
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

    private static func shot(_ filter: SCContentFilter, size: CGSize) async throws -> Shot {
        let scale = CGFloat(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int((size.width * scale).rounded())
        config.height = Int((size.height * scale).rounded())
        config.showsCursor = false
        config.captureResolution = .best
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
