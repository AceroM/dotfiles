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

    func testShiftDragIsSquareCoveringThePointer() {
        var selection = CaptureSelection(bounds: bounds, windowRects: windows, allowsDrag: true)
        selection.aspect = .square
        selection.press(at: CGPoint(x: 100, y: 100))
        XCTAssertEqual(selection.release(at: CGPoint(x: 300, y: 180)), .region(CGRect(x: 100, y: 100, width: 200, height: 200)))
    }

    func testSquareDragUpAndLeftEndsAtTheAnchor() {
        var selection = CaptureSelection(bounds: bounds, windowRects: windows, allowsDrag: true)
        selection.aspect = .square
        selection.press(at: CGPoint(x: 500, y: 400))
        XCTAssertEqual(selection.release(at: CGPoint(x: 450, y: 300)), .region(CGRect(x: 400, y: 300, width: 100, height: 100)))
    }

    func testSquareShrinksInsteadOfLeavingTheDisplay() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [], allowsDrag: true)
        selection.aspect = .square
        selection.press(at: CGPoint(x: 950, y: 500))
        XCTAssertEqual(selection.release(at: CGPoint(x: 1000, y: 700)), .region(CGRect(x: 950, y: 500, width: 50, height: 50)))
    }

    func testOptionDragIsWidescreenOrPortraitByDirection() {
        var wide = CaptureSelection(bounds: bounds, windowRects: [], allowsDrag: true)
        wide.aspect = .widescreen
        wide.press(at: CGPoint(x: 10, y: 10))
        XCTAssertEqual(wide.release(at: CGPoint(x: 330, y: 110)), .region(CGRect(x: 10, y: 10, width: 320, height: 180)))

        var tall = CaptureSelection(bounds: bounds, windowRects: [], allowsDrag: true)
        tall.aspect = .widescreen
        tall.press(at: CGPoint(x: 10, y: 10))
        XCTAssertEqual(tall.release(at: CGPoint(x: 110, y: 330)), .region(CGRect(x: 10, y: 10, width: 180, height: 320)))
    }

    func testLockedSizesAreExactMultiplesOfTheRatio() {
        let rect = CaptureSelection.locked(from: CGPoint(x: 0.5, y: 0.5), to: CGPoint(x: 333.7, y: 20),
                                           aspect: .widescreen, in: bounds)
        XCTAssertEqual(rect.width * 9, rect.height * 16)
        XCTAssertEqual(rect.width, rect.width.rounded())
        XCTAssertEqual(rect.minX, rect.minX.rounded())
    }

    func testTogglingTheModifierMidDragReshapesWithoutMoving() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [], allowsDrag: true)
        selection.press(at: CGPoint(x: 100, y: 100))
        selection.drag(to: CGPoint(x: 300, y: 180))
        XCTAssertEqual(selection.selection, CGRect(x: 100, y: 100, width: 200, height: 80))
        selection.aspect = .square
        XCTAssertEqual(selection.selection, CGRect(x: 100, y: 100, width: 200, height: 200))
        selection.aspect = nil
        XCTAssertEqual(selection.selection, CGRect(x: 100, y: 100, width: 200, height: 80))
    }

    func testModifierBeforeADragLeavesTheHoveredWindowAlone() {
        var selection = CaptureSelection(bounds: bounds, windowRects: windows, allowsDrag: true)
        selection.hover(at: CGPoint(x: 150, y: 150))
        selection.aspect = .square
        XCTAssertEqual(selection.selection, windows[0])
    }
}
