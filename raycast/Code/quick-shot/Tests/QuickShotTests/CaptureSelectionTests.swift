import XCTest
@testable import QuickShot

final class CaptureSelectionTests: XCTestCase {
    private let bounds = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let windows = [CGRect(x: 100, y: 100, width: 300, height: 200), CGRect(x: 0, y: 0, width: 900, height: 700)]

    func testAreaDragReturnsRegion() {
        var selection = CaptureSelection(bounds: bounds, windowRects: windows, allowsDrag: true)
        selection.press(at: CGPoint(x: 500, y: 400))
        selection.drag(to: CGPoint(x: 450, y: 300))
        XCTAssertEqual(selection.release(at: CGPoint(x: 420, y: 350)), .region(CGRect(x: 420, y: 350, width: 80, height: 50)))
    }

    func testAreaClickTakesFrontmostWindowRegion() {
        var selection = CaptureSelection(bounds: bounds, windowRects: windows, allowsDrag: true)
        selection.press(at: CGPoint(x: 150, y: 150))
        XCTAssertEqual(selection.release(at: CGPoint(x: 151, y: 151)), .region(windows[0]))
    }

    func testWindowModeIgnoresDragAndReturnsIndex() {
        var selection = CaptureSelection(bounds: bounds, windowRects: windows, allowsDrag: false)
        selection.press(at: CGPoint(x: 600, y: 600))
        selection.drag(to: CGPoint(x: 700, y: 650))
        XCTAssertEqual(selection.release(at: CGPoint(x: 700, y: 650)), .window(1))
    }

    func testClippedAwayWindowsKeepOriginalIndices() {
        let offscreen = CGRect(x: -500, y: -500, width: 100, height: 100)
        var selection = CaptureSelection(bounds: bounds, windowRects: [offscreen] + windows, allowsDrag: false)
        selection.press(at: CGPoint(x: 150, y: 150))
        XCTAssertEqual(selection.release(at: CGPoint(x: 150, y: 150)), .window(1))
    }

    func testClickOnEmptyDesktopDoesNothing() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [], allowsDrag: true)
        selection.press(at: CGPoint(x: 10, y: 10))
        XCTAssertNil(selection.release(at: CGPoint(x: 10, y: 10)))
    }
}
