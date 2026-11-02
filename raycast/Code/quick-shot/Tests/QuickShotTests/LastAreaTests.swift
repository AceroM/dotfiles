import XCTest
@testable import QuickShot

final class LastAreaTests: XCTestCase {
    private let displays: [(id: CGDirectDisplayID, frame: CGRect)] = [
        (1, CGRect(x: 0, y: 0, width: 1512, height: 982)),
        (2, CGRect(x: 1512, y: -200, width: 2560, height: 1440)),
    ]

    func testMapsBackToTheDisplayHoldingItsCenter() {
        let region = LastArea.resolve(CGRect(x: 1612, y: -100, width: 400, height: 300), on: displays)
        XCTAssertEqual(region?.displayID, 2)
        XCTAssertEqual(region?.rect, CGRect(x: 100, y: 100, width: 400, height: 300))
    }

    func testClipsToThatDisplay() {
        let region = LastArea.resolve(CGRect(x: 1400, y: 100, width: 300, height: 100), on: displays)
        XCTAssertEqual(region?.displayID, 2)
        XCTAssertEqual(region?.rect, CGRect(x: 0, y: 300, width: 188, height: 100))
    }

    func testForgetsAnAreaThatIsOffEveryDisplay() {
        XCTAssertNil(LastArea.resolve(CGRect(x: -900, y: 0, width: 300, height: 300), on: displays))
    }
}
