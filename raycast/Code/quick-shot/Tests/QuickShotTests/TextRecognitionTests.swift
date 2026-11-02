import AppKit
import XCTest
@testable import QuickShot

final class TextRecognitionTests: XCTestCase {
    /// Black text on white at Retina scale, one string per line.
    private func render(_ lines: [String], width: Int = 900, height: Int = 240) -> CGImage {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(.white)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.black]
        for (index, line) in lines.enumerated() {
            (line as NSString).draw(at: CGPoint(x: 30, y: height - 80 - index * 80), withAttributes: attributes)
        }
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()!
    }

    func testReadsLinesInOrder() async throws {
        let text = try await TextRecognition.text(in: render(["Quick Shot copies text", "Second line 4620"]))
        XCTAssertEqual(text, "Quick Shot copies text\nSecond line 4620")
    }

    func testBlankImageIsEmpty() async throws {
        let text = try await TextRecognition.text(in: render([]))
        XCTAssertEqual(text, "")
    }
}
