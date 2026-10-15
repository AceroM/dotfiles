import XCTest
@testable import QuickRecord

final class CaptureSelectionTests: XCTestCase {
    private let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
    private let window = CGRect(x: 100, y: 100, width: 800, height: 600)

    func testHoverChoosesFrontmostWindowAndClearsOnDesktopOrExit() {
        let front = CGRect(x: 200, y: 200, width: 300, height: 200)
        var selection = CaptureSelection(bounds: bounds, windowRects: [front, window])
        selection.hover(at: CGPoint(x: 250, y: 250))
        XCTAssertEqual(selection.selection, front)
        selection.hover(at: CGPoint(x: 150, y: 150))
        XCTAssertEqual(selection.selection, window)
        selection.leave()
        XCTAssertNil(selection.selection)
        selection.hover(at: CGPoint(x: 1500, y: 900))
        XCTAssertNil(selection.selection)
    }

    func testClickWithSmallJitterRecordsHighlightedWindowOnRelease() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [window])
        selection.press(at: CGPoint(x: 200, y: 200))
        selection.drag(to: CGPoint(x: 202, y: 201))
        XCTAssertFalse(selection.isDragging)
        XCTAssertEqual(selection.selection, window)
        XCTAssertEqual(selection.release(at: CGPoint(x: 202, y: 201)), window)
        XCTAssertNil(selection.anchor)
    }

    func testDraggingInsideWindowRecordsRegionInstead() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [window])
        selection.press(at: CGPoint(x: 400, y: 400))
        selection.drag(to: CGPoint(x: 200, y: 150))
        XCTAssertTrue(selection.isDragging)
        XCTAssertEqual(selection.selection, CGRect(x: 200, y: 150, width: 200, height: 250))
        XCTAssertEqual(selection.release(at: CGPoint(x: 200, y: 150)),
                       CGRect(x: 200, y: 150, width: 200, height: 250))
    }

    func testInvalidDragNeverFallsBackToWindowEvenAfterReturningToAnchor() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [window])
        selection.press(at: CGPoint(x: 200, y: 200))
        selection.drag(to: CGPoint(x: 400, y: 205))
        XCTAssertNil(selection.release(at: CGPoint(x: 200, y: 200)))
        selection.press(at: CGPoint(x: 200, y: 200))
        XCTAssertNil(selection.release(at: CGPoint(x: 400, y: 205)))
        XCTAssertEqual(selection.selection, window)
    }

    func testDesktopClickDoesNothingButDesktopDragWorksAndClipsToDisplay() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [window])
        selection.press(at: CGPoint(x: 1800, y: 900))
        XCTAssertNil(selection.release(at: CGPoint(x: 1800, y: 900)))
        selection.press(at: CGPoint(x: 1800, y: 900))
        XCTAssertEqual(selection.release(at: CGPoint(x: 2000, y: 1200)),
                       CGRect(x: 1800, y: 900, width: 120, height: 180))
    }

    func testGlobalWindowCoordinatesClipOnDisplaysAboveAndLeftOfMain() {
        let display = CGRect(x: -1920, y: -1080, width: 1920, height: 1080)
        let globalWindow = CGRect(x: -2000, y: -1000, width: 600, height: 400)
        let localWindow = globalWindow.offsetBy(dx: -display.minX, dy: -display.minY)
        var selection = CaptureSelection(bounds: bounds, windowRects: [localWindow])
        selection.press(at: CGPoint(x: 10, y: 100))
        XCTAssertEqual(selection.release(at: CGPoint(x: 10, y: 100)),
                       CGRect(x: 0, y: 80, width: 520, height: 400))
    }

    func testInvalidAndOffDisplayWindowsAreIgnored() {
        let selection = CaptureSelection(bounds: bounds, windowRects: [
            CGRect(x: 2000, y: 0, width: 500, height: 400),
            CGRect(x: 0, y: 0, width: 10, height: 10),
            CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 100),
            window,
        ])
        XCTAssertEqual(selection.windowRects, [window])
    }
}
