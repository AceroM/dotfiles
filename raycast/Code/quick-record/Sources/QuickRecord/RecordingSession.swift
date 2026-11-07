import AVFoundation
import ScreenCaptureKit

/// A toggle during startup queues a stop. Ownership lasts through MP4 finalization.
@MainActor
final class RecordingSession: NSObject, SCStreamDelegate {
    let url: URL
    var onStarted: (() -> Void)?
    var onFinished: ((Result<URL, Error>) -> Void)?
    private var stream: SCStream?
    private var movie: MovieWriter?
    private var starting = true
    private var stopping = false
    private var stopRequested = false
    private var finished = false
    private var mixAudio = false

    init(url: URL) { self.url = url }

    func start(display: SCDisplay, region: CaptureRegion, scale: CGFloat,
               applications: [SCRunningApplication], microphone: Bool, systemAudio: Bool) async {
        let ownApplications = applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: ownApplications, exceptingWindows: [])
        let config = SCStreamConfiguration()
        let size = region.outputSize(scale: scale)
        config.sourceRect = region.rect
        config.width = size.width
        config.height = size.height
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 3
        config.showsCursor = true
        config.capturesAudio = systemAudio
        config.sampleRate = 48_000
        config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        config.captureMicrophone = microphone
        config.streamName = "Quick Record"
        mixAudio = microphone && systemAudio

        do {
            let movie = try MovieWriter(url: url, size: size, microphone: microphone, systemAudio: systemAudio)
            movie.onStarted = { [weak self] in
                Task { @MainActor in
                    guard let self, !self.finished else { return }
                    self.onStarted?()
                }
            }
            movie.onFailure = { [weak self] error in
                Task { @MainActor in await self?.abort(error) }
            }
            self.movie = movie
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            self.stream = stream
            try stream.addStreamOutput(movie, type: .screen, sampleHandlerQueue: movie.queue)
            if systemAudio { try stream.addStreamOutput(movie, type: .audio, sampleHandlerQueue: movie.queue) }
            if microphone { try stream.addStreamOutput(movie, type: .microphone, sampleHandlerQueue: movie.queue) }
            try await stream.startCapture()
            starting = false
            if stopRequested { await stop() }
        } catch {
            starting = false
            await abort(error)
        }
    }

    func stop() async {
        stopRequested = true
        guard !starting, !stopping, !finished, let stream, let movie else { return }
        stopping = true
        let endTime = CMClockGetTime(CMClockGetHostTimeClock())
        do {
            try await stream.stopCapture()
            try await movie.finish(at: endTime)
            if mixAudio { try await mixAudioTracks() }
            guard !finished else { return }
            finished = true
            onFinished?(.success(url))
            self.stream = nil
            self.movie = nil
        } catch { await abort(error) }
    }

    private func abort(_ error: Error) async {
        guard !finished else { return }
        finished = true
        if let stream { try? await stream.stopCapture() }
        await movie?.cancel()
        onFinished?(.failure(error))
        self.stream = nil
        movie = nil
    }

    /// Most players treat two AAC tracks as alternatives. Mix them into one,
    /// then remux the original video without reencoding it.
    private func mixAudioTracks() async throws {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        guard tracks.count > 1 else { return }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("quick-record-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let audioURL = temporary.appendingPathComponent("mixed.m4a")
        let movieURL = temporary.appendingPathComponent("mixed.mp4")
        guard let audioExport = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw MovieError.unsupportedFormat
        }
        let mix = AVMutableAudioMix()
        mix.inputParameters = tracks.map {
            let parameters = AVMutableAudioMixInputParameters(track: $0)
            parameters.setVolume(0.7, at: .zero)
            return parameters
        }
        audioExport.audioMix = mix
        try await audioExport.export(to: audioURL, as: .m4a)
        let duration = try await asset.load(.duration)
        let composition = AVMutableComposition()
        for track in try await asset.loadTracks(withMediaType: .video) {
            let range = try await track.load(.timeRange)
            guard let target = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw MovieError.unsupportedFormat
            }
            try target.insertTimeRange(range, of: track, at: .zero)
        }
        let mixedAsset = AVURLAsset(url: audioURL)
        for track in try await mixedAsset.loadTracks(withMediaType: .audio) {
            let range = try await track.load(.timeRange)
            guard let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw MovieError.unsupportedFormat
            }
            try target.insertTimeRange(CMTimeRange(start: .zero, duration: min(range.duration, duration)), of: track, at: .zero)
        }
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw MovieError.unsupportedFormat
        }
        try await export.export(to: movieURL, as: .mp4)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: movieURL)
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak self] in await self?.abort(error) }
    }
}
