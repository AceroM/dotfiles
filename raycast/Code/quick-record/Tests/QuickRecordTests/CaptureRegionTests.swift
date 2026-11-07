import XCTest
@testable import QuickRecord

final class CaptureRegionTests: XCTestCase {
    func testRetinaOutputIsEvenAndPreservesRegionAspectRatio() {
        let region = CaptureRegion(displayUUID: "external", rect: CGRect(x: 120, y: 80, width: 801, height: 451))
        let size = region.outputSize(scale: 2)
        XCTAssertEqual(size.width, 1602)
        XCTAssertEqual(size.height, 902)
        XCTAssertEqual(Double(size.width) / Double(size.height), 801.0 / 451.0, accuracy: 0.001)
    }

    func testLargeRetinaRecordingIsBoundedTo4K() {
        let region = CaptureRegion(displayUUID: "main", rect: CGRect(x: 0, y: 0, width: 3024, height: 1964))
        let size = region.outputSize(scale: 2)
        XCTAssertLessThanOrEqual(size.width, 3840)
        XCTAssertLessThanOrEqual(size.height, 2160)
        XCTAssertEqual(size.width % 2, 0)
        XCTAssertEqual(size.height % 2, 0)
        XCTAssertEqual(Double(size.width) / Double(size.height), 3024.0 / 1964.0, accuracy: 0.002)
    }

    func testRememberedRegionRefusesChangedDisplayBounds() {
        let region = CaptureRegion(displayUUID: "external", rect: CGRect(x: 1400, y: 400, width: 500, height: 300))
        XCTAssertTrue(region.fits(in: CGSize(width: 1920, height: 1080)))
        XCTAssertFalse(region.fits(in: CGSize(width: 1440, height: 900)))
    }

    func testRejectsInvalidOrTooSmallRegions() {
        let bounds = CGSize(width: 1920, height: 1080)
        for rect in [CGRect(x: -1, y: 0, width: 100, height: 100),
                     CGRect(x: 0, y: 0, width: 15, height: 100),
                     CGRect(x: 0, y: 0, width: 100, height: 15),
                     CGRect(x: 0, y: 0, width: 100, height: CGFloat.infinity)] {
            XCTAssertFalse(CaptureRegion(displayUUID: "main", rect: rect).fits(in: bounds))
        }
    }

    func testRememberedRegionRetainsDisplayAndTopLeftCoordinates() throws {
        let original = CaptureRegion(displayUUID: "display-uuid", rect: CGRect(x: 350, y: 120, width: 640, height: 360))
        let restored = try JSONDecoder().decode(CaptureRegion.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.rect.minY, 120)
    }
}
