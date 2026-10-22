import XCTest
@testable import QuickShot

final class StitchTests: XCTestCase {
    private let width = 40, height = 120, header = 10, footer = 6

    /// A page of distinct rows, seen through a window with a sticky header and footer.
    private func page(rows: Int) -> [UInt32] {
        (0..<rows).map { UInt32(truncatingIfNeeded: $0 &* 2_654_435_761) | 0xFF00_0000 }
    }

    private func frame(_ page: [UInt32], scrolledBy offset: Int) -> CGImage {
        let rows = (0..<height).map { y -> UInt32 in
            if y < header { return 0xFF11_2233 &+ UInt32(y) }
            if y >= height - footer { return 0xFF44_5566 &+ UInt32(y) }
            return page[offset + y - header]
        }
        return image(rows)
    }

    private func image(_ rows: [UInt32]) -> CGImage {
        // Vary pixels within each row so no row counts as flat.
        var pixels = rows.flatMap { row in (0..<width).map { row ^ UInt32($0) } }
        let context = pixels.withUnsafeMutableBytes { buffer in
            CGContext(data: buffer.baseAddress, width: width, height: rows.count, bitsPerComponent: 8,
                      bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
        }
        return context
    }

    private func pixels(_ image: CGImage) -> [UInt32] {
        var data = [UInt32](repeating: 0, count: image.width * image.height)
        data.withUnsafeMutableBytes { buffer in
            CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                      bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                .draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return data
    }

    func testStitchesFramesAroundStickyHeaderAndFooter() {
        let content = page(rows: 400)
        // The last scroll is short, as at the end of a page, and the last frame didn't move at all.
        let offsets = [0, 30, 60, 75, 75]
        let stitched = Stitch.frames(offsets.map { frame(content, scrolledBy: $0) }, expectedOffsets: [0, 30, 30, 30, 30])!
        let visible = height - header - footer
        let top: [UInt32] = (0..<header).map { 0xFF11_2233 &+ UInt32($0) }
        let bottom: [UInt32] = (height - footer..<height).map { 0xFF44_5566 &+ UInt32($0) }
        let expected = image(top + Array(content[0..<(75 + visible)]) + bottom)
        XCTAssertEqual(stitched.height, expected.height)
        XCTAssertEqual(pixels(stitched), pixels(expected))
    }

    func testMixedStepSizes() {
        let content = page(rows: 400)
        let offsets = [0, 20, 80, 100]
        let stitched = Stitch.frames(offsets.map { frame(content, scrolledBy: $0) }, expectedOffsets: [0, 20, 60, 20])!
        XCTAssertEqual(stitched.height, height + 100)
    }

    func testIdenticalFramesDontGrow() {
        let still = frame(page(rows: 200), scrolledBy: 0)
        XCTAssertEqual(Stitch.frames([still, still], expectedOffsets: [0, 30])?.height, height)
    }
}
