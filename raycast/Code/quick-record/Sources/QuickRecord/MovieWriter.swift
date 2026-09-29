import AVFoundation
import ScreenCaptureKit

/// ScreenCaptureKit omits unchanged frames. Repeat the final frame at stop time
/// so a static recording retains its real elapsed duration.
// All mutable encoding state is confined to queue; callbacks are configured
// before SCStream can submit buffers.
final class MovieWriter: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.acerom.quickrecord.writer", qos: .userInitiated)
    var onStarted: (() -> Void)?
    var onFailure: ((Error) -> Void)?
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private let pixels: AVAssetWriterInputPixelBufferAdaptor
    private var audio: [SCStreamOutputType: AVAssetWriterInput] = [:]
    private var firstTime: CMTime?
    private var firstHostTime: CMTime?
    private var lastTime: CMTime?
    private var lastFrame: CVPixelBuffer?
    private var finishing = false
    private var failed = false

    init(url: URL, size: (width: Int, height: Int), microphone: Bool, systemAudio: Bool) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
            AVVideoCompressionPropertiesKey: [AVVideoExpectedSourceFrameRateKey: 30,
                                             AVVideoMaxKeyFrameIntervalKey: 60],
        ])
        video.expectsMediaDataInRealTime = true
        pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: size.width,
            kCVPixelBufferHeightKey as String: size.height,
        ])
        super.init()
        guard writer.canAdd(video) else { throw MovieError.unsupportedFormat }
        writer.add(video)
        for type in [SCStreamOutputType.audio, .microphone] {
            guard type == .audio ? systemAudio : microphone else { continue }
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw MovieError.unsupportedFormat }
            writer.add(input)
            audio[type] = input
        }
        guard writer.startWriting() else { throw writer.error ?? MovieError.writeFailed }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !finishing, !failed, sampleBuffer.isValid else { return }
        let time = sampleBuffer.presentationTimeStamp
        if type == .screen {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let rawStatus = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: rawStatus) == .complete,
                  let frame = sampleBuffer.imageBuffer else { return }
            appendVideoFrame(frame, at: time)
        } else if let input = audio[type], let firstTime, time >= firstTime, input.isReadyForMoreMediaData {
            if !input.append(sampleBuffer) { fail(writer.error ?? MovieError.writeFailed) }
        }
    }

    /// Called only on queue, by SCStream or the synthetic encoding regression test.
    func appendVideoFrame(_ frame: CVPixelBuffer, at time: CMTime) {
        guard !finishing, !failed else { return }
        if firstTime == nil {
            writer.startSession(atSourceTime: time)
            firstTime = time
            firstHostTime = CMClockGetTime(CMClockGetHostTimeClock())
        }
        guard video.isReadyForMoreMediaData else { return }
        guard pixels.append(frame, withPresentationTime: time) else { fail(writer.error ?? MovieError.writeFailed); return }
        let firstFrame = lastFrame == nil
        lastFrame = frame
        lastTime = time
        if firstFrame { onStarted?() }
    }

    private func fail(_ error: Error) {
        guard !failed else { return }
        failed = true
        onFailure?(error)
    }

    func finish(at stopHostTime: CMTime) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                self.finishing = true
                guard !self.failed, let firstTime = self.firstTime,
                      let firstHostTime = self.firstHostTime, let lastTime = self.lastTime,
                      let lastFrame = self.lastFrame else {
                    self.writer.cancelWriting()
                    continuation.resume(throwing: self.writer.error ?? MovieError.noFrames)
                    return
                }
                let endTime = max(firstTime + (stopHostTime - firstHostTime), lastTime + CMTime(value: 1, timescale: 30))
                self.appendFinalFrame(lastFrame, at: endTime, deadline: .now() + 5, continuation: continuation)
            }
        }
    }

    private func appendFinalFrame(_ frame: CVPixelBuffer, at endTime: CMTime, deadline: DispatchTime,
                                  continuation: CheckedContinuation<Void, Error>) {
        guard writer.status == .writing else {
            continuation.resume(throwing: writer.error ?? MovieError.writeFailed)
            return
        }
        guard video.isReadyForMoreMediaData else {
            guard DispatchTime.now() < deadline else {
                writer.cancelWriting()
                continuation.resume(throwing: MovieError.encoderTimeout)
                return
            }
            queue.asyncAfter(deadline: .now() + 0.01) {
                self.appendFinalFrame(frame, at: endTime, deadline: deadline, continuation: continuation)
            }
            return
        }
        guard pixels.append(frame, withPresentationTime: endTime) else {
            continuation.resume(throwing: writer.error ?? MovieError.writeFailed)
            return
        }
        writer.endSession(atSourceTime: endTime)
        video.markAsFinished()
        audio.values.forEach { $0.markAsFinished() }
        lastFrame = nil
        writer.finishWriting {
            if self.writer.status == .completed { continuation.resume() }
            else { continuation.resume(throwing: self.writer.error ?? MovieError.writeFailed) }
        }
    }

    func cancel() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.finishing = true
                self.writer.cancelWriting()
                self.lastFrame = nil
                continuation.resume()
            }
        }
    }
}

enum MovieError: LocalizedError {
    case unsupportedFormat, writeFailed, noFrames, encoderTimeout
    var errorDescription: String? {
        switch self {
        case .unsupportedFormat: return "The video or audio format is not supported on this Mac."
        case .writeFailed: return "macOS couldn’t encode the recording."
        case .noFrames: return "No screen frames were captured. Try recording again."
        case .encoderTimeout: return "The video encoder didn’t finish in time."
        }
    }
}
