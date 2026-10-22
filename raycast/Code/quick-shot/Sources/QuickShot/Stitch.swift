import CoreGraphics

/// Joins frames of one area scrolled downward into a single tall image, matching rows where each pair overlaps.
enum Stitch {
    struct Rows {
        let hashes: [Int]
        /// Single-color rows, which match anywhere, so they don't count toward an overlap.
        let flat: [Bool]
    }

    /// How far the second frame scrolled past the first, in pixel rows, plus the rows that stayed put at each
    /// edge (sticky headers and footers). An offset of 0 means nothing moved.
    struct Overlap: Equatable {
        let offset: Int
        let top: Int
        let bottom: Int
    }

    /// `expectedOffsets[i]` is how far frame `i` was scrolled past frame `i - 1`, in pixels. `margin` trailing
    /// columns are ignored, so an overlay scrollbar doesn't break every row.
    static func frames(_ frames: [CGImage], expectedOffsets: [Int], margin: Int = 0) -> CGImage? {
        guard let first = frames.first else { return nil }
        let width = first.width, height = first.height
        let sized = zip(frames, expectedOffsets).filter { $0.0.width == width && $0.0.height == height }
        let frames = sized.map(\.0), expectedOffsets = sized.map(\.1)
        let rows = frames.compactMap { Self.rows($0, margin: margin) }
        guard rows.count == frames.count else { return first }

        var steps: [(frame: CGImage, overlap: Overlap)] = []
        var previous = 0
        for index in frames.indices.dropFirst() {
            let overlap = Self.overlap(rows[previous], rows[index], expected: expectedOffsets[index])
            guard overlap.offset > 0 else { continue }
            steps.append((frames[index], overlap))
            previous = index
        }
        guard let last = steps.last else { return first }

        // (frame, first row, row count), top to bottom: the first frame down to its footer, each frame's
        // newly revealed rows, then the footer once.
        var pieces = [(first, 0, height - steps[0].overlap.bottom)]
        for step in steps {
            pieces.append((step.frame, height - step.overlap.bottom - step.overlap.offset, step.overlap.offset))
        }
        pieces.append((last.frame, height - last.overlap.bottom, last.overlap.bottom))

        let total = pieces.reduce(0) { $0 + $1.2 }
        let space = first.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
        guard let context = CGContext(data: nil, width: width, height: total, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return first
        }
        var y = 0
        for (frame, start, count) in pieces where count > 0 {
            guard let slice = frame.cropping(to: CGRect(x: 0, y: start, width: width, height: count)) else { continue }
            // CGContext's origin is bottom left.
            context.draw(slice, in: CGRect(x: 0, y: total - y - count, width: width, height: count))
            y += count
        }
        return context.makeImage()
    }

    static func rows(_ image: CGImage, margin: Int) -> Rows? {
        let width = image.width, height = image.height, bytesPerRow = width * 4
        var data = [UInt8](repeating: 0, count: bytesPerRow * height)
        let drawn = data.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: bytesPerRow, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        let used = max(1, width - margin) * 4
        var hashes: [Int] = [], flat: [Bool] = []
        hashes.reserveCapacity(height)
        flat.reserveCapacity(height)
        data.withUnsafeBytes { buffer in
            // The bitmap's first row is the image's top row.
            for y in 0..<height {
                let row = UnsafeRawBufferPointer(rebasing: buffer[(y * bytesPerRow)..<(y * bytesPerRow + used)])
                var hasher = Hasher()
                hasher.combine(bytes: row)
                hashes.append(hasher.finalize())
                let firstPixel = row.loadUnaligned(as: UInt32.self)
                flat.append(stride(from: 4, to: used, by: 4).allSatisfy {
                    row.loadUnaligned(fromByteOffset: $0, as: UInt32.self) == firstPixel
                })
            }
        }
        return Rows(hashes: hashes, flat: flat)
    }

    /// Tries every offset and keeps the one whose overlapping rows match best, preferring `expected` on ties.
    /// Falls back to `expected` when nothing matches well, e.g. content that changed while scrolling.
    static func overlap(_ a: Rows, _ b: Rows, expected: Int) -> Overlap {
        let height = min(a.hashes.count, b.hashes.count)
        var top = 0
        while top < height, a.hashes[top] == b.hashes[top] { top += 1 }
        guard top < height else { return Overlap(offset: 0, top: height, bottom: 0) }
        var bottom = 0
        while bottom < height - top, a.hashes[height - 1 - bottom] == b.hashes[height - 1 - bottom] { bottom += 1 }
        let middle = height - top - bottom

        var best: (offset: Int, score: Double)?
        for offset in 1..<max(1, middle) {
            var compared = 0, matched = 0
            for i in 0..<(middle - offset) where !b.flat[top + i] {
                compared += 1
                if a.hashes[top + offset + i] == b.hashes[top + i] { matched += 1 }
            }
            guard compared >= 8 else { continue }
            let score = Double(matched) / Double(compared)
            if let current = best, score < current.score - 0.001
                || (score <= current.score + 0.001 && abs(offset - expected) >= abs(current.offset - expected)) {
                continue
            }
            best = (offset, score)
        }
        let offset = best.flatMap { $0.score >= 0.9 ? $0.offset : nil } ?? min(max(1, expected), middle)
        return Overlap(offset: offset, top: top, bottom: bottom)
    }
}
