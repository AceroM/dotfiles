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

    func testShiftDragIsSquareCoveringThePointer() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [window])
        selection.aspect = .square
        selection.press(at: CGPoint(x: 100, y: 100))
        XCTAssertEqual(selection.release(at: CGPoint(x: 300, y: 180)), CGRect(x: 100, y: 100, width: 200, height: 200))
    }

    func testSquareDragUpAndLeftEndsAtTheAnchor() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [])
        selection.aspect = .square
        selection.press(at: CGPoint(x: 500, y: 400))
        XCTAssertEqual(selection.release(at: CGPoint(x: 450, y: 300)), CGRect(x: 400, y: 300, width: 100, height: 100))
    }

    func testSquareShrinksInsteadOfLeavingTheDisplay() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [])
        selection.aspect = .square
        selection.press(at: CGPoint(x: 1870, y: 500))
        XCTAssertEqual(selection.release(at: CGPoint(x: 1920, y: 700)), CGRect(x: 1870, y: 500, width: 50, height: 50))
    }

    func testOptionDragIsWidescreenOrPortraitByDirection() {
        var wide = CaptureSelection(bounds: bounds, windowRects: [])
        wide.aspect = .widescreen
        wide.press(at: CGPoint(x: 10, y: 10))
        XCTAssertEqual(wide.release(at: CGPoint(x: 330, y: 110)), CGRect(x: 10, y: 10, width: 320, height: 180))

        var tall = CaptureSelection(bounds: bounds, windowRects: [])
        tall.aspect = .widescreen
        tall.press(at: CGPoint(x: 10, y: 10))
        XCTAssertEqual(tall.release(at: CGPoint(x: 110, y: 330)), CGRect(x: 10, y: 10, width: 180, height: 320))
    }

    func testWidescreenRecordingEncodesAtExactly16By9() {
        let rect = CaptureSelection.locked(from: CGPoint(x: 0.5, y: 0.5), to: CGPoint(x: 1333.7, y: 20),
                                           aspect: .widescreen, in: bounds)
        XCTAssertEqual(rect.width * 9, rect.height * 16)
        let output = CaptureRegion(displayUUID: "d", rect: rect).outputSize(scale: 2)
        XCTAssertEqual(output.width * 9, output.height * 16)
    }

    func testTogglingTheModifierMidDragReshapesWithoutMoving() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [])
        selection.press(at: CGPoint(x: 100, y: 100))
        selection.drag(to: CGPoint(x: 300, y: 180))
        XCTAssertEqual(selection.selection, CGRect(x: 100, y: 100, width: 200, height: 80))
        selection.aspect = .square
        XCTAssertEqual(selection.selection, CGRect(x: 100, y: 100, width: 200, height: 200))
        selection.aspect = nil
        XCTAssertEqual(selection.selection, CGRect(x: 100, y: 100, width: 200, height: 80))
    }

    func testModifierBeforeADragLeavesTheHoveredWindowAlone() {
        var selection = CaptureSelection(bounds: bounds, windowRects: [window])
        selection.hover(at: CGPoint(x: 150, y: 150))
        selection.aspect = .square
        XCTAssertEqual(selection.selection, window)
    }
}
