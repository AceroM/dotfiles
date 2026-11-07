@preconcurrency import AVFoundation
@preconcurrency import CoreVideo
import XCTest
@testable import QuickRecord

final class MovieWriterTests: XCTestCase {
    func testChangingFramesAndStaticTailKeepRealDuration() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("timeline.mp4")
        let movie = try MovieWriter(url: url, size: (64, 64), microphone: false, systemAudio: false)
        let firstTime = CMTime(seconds: 1000, preferredTimescale: 600)
        let red = try frame(blue: 0, red: 255)
        let blue = try frame(blue: 255, red: 0)
        await append(red, at: firstTime, to: movie)
        try await Task.sleep(nanoseconds: 250_000_000)
        await append(blue, at: firstTime + CMTime(seconds: 0.25, preferredTimescale: 600), to: movie)
        // No further frames: this is the exact idle-screen regression.
        try await Task.sleep(nanoseconds: 450_000_000)
        try await movie.finish(at: CMClockGetTime(CMClockGetHostTimeClock()))
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        XCTAssertGreaterThan(duration, 0.65, "The static tail must not end at the last changing frame")
        XCTAssertLessThan(duration, 1.2)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let first = try await generator.image(at: CMTime(seconds: 0, preferredTimescale: 600)).image
        let second = try await generator.image(at: CMTime(seconds: 0.25, preferredTimescale: 600)).image
        XCTAssertNotEqual(first.dataProvider?.data as Data?, second.dataProvider?.data as Data?, "A recording must contain changing frames")
    }

    private func append(_ frame: CVPixelBuffer, at time: CMTime, to movie: MovieWriter) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            movie.queue.async {
                movie.appendVideoFrame(frame, at: time)
                continuation.resume()
            }
        }
    }

    private func frame(blue: UInt8, red: UInt8) throws -> CVPixelBuffer {
        var result: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        let code = CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, attributes, &result)
        guard code == kCVReturnSuccess, let result else { throw MovieError.writeFailed }
        CVPixelBufferLockBaseAddress(result, [])
        let stride = CVPixelBufferGetBytesPerRow(result)
        let bytes = CVPixelBufferGetBaseAddress(result)!.assumingMemoryBound(to: UInt8.self)
        for y in 0..<64 {
            for x in 0..<64 {
                let offset = y * stride + x * 4
                bytes[offset] = blue
                bytes[offset + 1] = 0
                bytes[offset + 2] = red
                bytes[offset + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(result, [])
        return result
    }
}
