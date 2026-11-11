import AppKit
import QuartzCore

/// What changed the drawing, so the timeline can say why something appeared or went away.
enum AnnotationCause: String, Encodable {
    case draw, label, edit, erase, undo, redo, clear
}

/// Everything drawn during a demo, with times, saved beside the video as `Demo ….excalidraw`.
///
/// It's a real Excalidraw scene (open it in Excalidraw to see the drawing as it stood when the
/// recording stopped) plus a `quickRecord.timeline` for agents: every annotation appearing and going
/// away, and every laser-pointer stroke, in seconds from the video's first frame and in video pixels.
/// The HAR saved beside it carries the same clock in each entry's `_videoTime`.
///
/// Times are host-clock seconds (`CACurrentMediaTime`, the clock ScreenCaptureKit stamps frames with)
/// while recording, and only become video time when the file is written, so anything drawn before the
/// first frame arrives still lands at 0.
@MainActor
final class AnnotationLog {
    struct Interval {
        var from: CFTimeInterval
        var shownBy: AnnotationCause
        var to: CFTimeInterval?
        var hiddenBy: AnnotationCause?
    }

    /// One version of an element. Editing a label's text makes a new version with the same element id.
    struct Shape {
        var element: AnnotationElement
        var version: Int
        var startedAt: CFTimeInterval
        var intervals: [Interval]

        var id: String { version == 1 ? element.id.uuidString : "\(element.id.uuidString)-v\(version)" }
        var isVisible: Bool { intervals.last?.to == nil }
    }

    struct LaserPoint {
        var point: CGPoint
        var time: CFTimeInterval
    }

    /// The overlay's points (top-left origin) and the video's pixels: the file is written in pixels,
    /// so a box in the timeline crops straight out of a frame.
    let canvasSize: CGSize
    let videoSize: CGSize
    private let clock: () -> CFTimeInterval
    private(set) var shapes: [Shape] = []
    private(set) var laserStrokes: [[LaserPoint]] = []
    private var visible: [UUID: Int] = [:]
    private var versions: [UUID: Int] = [:]
    private(set) var videoStart: CFTimeInterval?
    private(set) var videoStartDate: Date?
    private(set) var videoEnd: CFTimeInterval?

    /// The recorder's bookkeeping: the file is written once the video is saved and the overlay
    /// has closed (a label still waiting on Wispr's transcript keeps it open past the stop).
    var video: URL?
    var overlayClosed = false
    var saved = false

    var isEmpty: Bool { shapes.isEmpty && laserStrokes.isEmpty }

    init(canvasSize: CGSize, videoSize: CGSize, clock: @escaping () -> CFTimeInterval = { CACurrentMediaTime() }) {
        self.canvasSize = canvasSize
        self.videoSize = videoSize
        self.clock = clock
    }

    func now() -> CFTimeInterval { clock() }

    func videoStarted(hostTime: CFTimeInterval, date: Date) {
        videoStart = hostTime
        videoStartDate = date
    }

    func videoEnded(hostTime: CFTimeInterval? = nil) {
        if videoEnd == nil { videoEnd = hostTime ?? clock() }
    }

    // MARK: Recording

    /// Called with everything on the canvas after each change (a label being edited counts as still
    /// showing). Diffs against what was showing before.
    func update(_ showing: [AnnotationElement], cause: AnnotationCause, startedAt: CFTimeInterval? = nil) {
        let time = clock()
        var current: [UUID: AnnotationElement] = [:]
        for element in showing where current[element.id] == nil { current[element.id] = element }

        for (id, index) in visible {
            let replacement = current[id]
            if replacement == shapes[index].element { continue }
            // Still there but different is an edit, unless undo/redo swapped the versions.
            let by: AnnotationCause = replacement == nil || cause == .undo || cause == .redo ? cause : .edit
            let last = shapes[index].intervals.count - 1
            shapes[index].intervals[last].to = time
            shapes[index].intervals[last].hiddenBy = by
            visible[id] = nil
        }

        for element in showing where visible[element.id] == nil {
            if let index = shapes.lastIndex(where: { $0.element == element }) {
                // Back again, after an undo or redo.
                shapes[index].intervals.append(Interval(from: time, shownBy: cause))
                visible[element.id] = index
            } else {
                let version = (versions[element.id] ?? 0) + 1
                versions[element.id] = version
                shapes.append(Shape(element: element, version: version, startedAt: min(startedAt ?? time, time),
                                    intervals: [Interval(from: time, shownBy: cause)]))
                visible[element.id] = shapes.count - 1
            }
        }
    }

    func laser(_ stroke: [LaserPoint]) {
        guard !stroke.isEmpty else { return }
        laserStrokes.append(stroke)
    }

    // MARK: Writing

    func write(to url: URL) throws {
        try Data(fileText().utf8).write(to: url, options: .atomic)
    }

    /// Written by hand rather than by JSONEncoder, which doesn't keep key order: the header and its
    /// timeline (one event per line, `t` first) come ahead of the elements and their long point lists.
    func fileText() throws -> String {
        let document = document(videoName: video?.lastPathComponent ?? "")
        let header = document.quickRecord
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        func json(_ value: any Encodable) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }
        func object(_ pairs: [(String, (any Encodable)?)]) throws -> String {
            "{" + (try pairs.compactMap { key, value in try value.map { "\(try json(key)): \(try json($0))" } })
                .joined(separator: ", ") + "}"
        }
        func list(_ lines: [String], indent: String) -> String {
            lines.isEmpty ? "[]" : "[\n" + lines.map { indent + "  " + $0 }.joined(separator: ",\n") + "\n\(indent)]"
        }
        let events = try header.timeline.map { event in
            try object([("t", event.t), ("time", event.time), ("event", event.event), ("type", event.type),
                        ("cause", event.cause), ("id", event.id), ("text", event.text), ("color", event.color),
                        ("bounds", event.bounds), ("points", event.points), ("startedAt", event.startedAt),
                        ("until", event.until)])
        }
        let fields: [(String, any Encodable)] = [
            ("about", header.about), ("video", header.video), ("har", header.har),
            ("recordingStartedDateTime", header.recordingStartedDateTime), ("duration", header.duration),
            ("width", header.width), ("height", header.height),
        ]
        var text = "{\n"
        text += "  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"Quick Record\",\n"
        text += "  \"quickRecord\": {\n"
        for (key, value) in fields { text += "    \(try json(key)): \(try json(value)),\n" }
        text += "    \"timeline\": \(list(events, indent: "    "))\n  },\n"
        text += "  \"elements\": \(list(try document.elements.map { try json($0) }, indent: "  ")),\n"
        text += "  \"appState\": {\"viewBackgroundColor\": \"#ffffff\"},\n  \"files\": {}\n}\n"
        return text
    }

    func document(videoName: String) -> ExcalidrawDocument {
        let start = videoStart ?? shapes.first?.intervals.first?.from ?? laserStrokes.first?.first?.time ?? clock()
        let startDate = videoStartDate ?? Date()
        let duration = videoEnd.map { Self.seconds($0 - start) }
        func t(_ host: CFTimeInterval) -> Double { Self.seconds(max(0, host - start)) }
        func iso(_ host: CFTimeInterval) -> String {
            Self.isoFormatter.string(from: startDate.addingTimeInterval(max(0, host - start)))
        }
        let sx = videoSize.width / max(1, canvasSize.width), sy = videoSize.height / max(1, canvasSize.height)
        func px(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * sx, y: p.y * sy) }

        var timeline: [TimelineEvent] = []
        var elements: [ExcalidrawElement] = []
        for shape in shapes {
            let element = shape.element
            let bounds = Self.box(element.bounds, sx: sx, sy: sy)
            let ends = element.kind == .arrow || element.kind == .line ? element.points.prefix(2).map { Self.pair(px($0)) } : nil
            for (index, interval) in shape.intervals.enumerated() {
                timeline.append(TimelineEvent(
                    t: t(interval.from), time: iso(interval.from), event: "add", type: Self.type(element.kind),
                    cause: interval.shownBy, id: shape.id, text: element.kind == .text ? element.text : nil,
                    color: element.style.strokeColor, bounds: bounds, points: ends,
                    startedAt: index == 0 && interval.from - shape.startedAt >= 0.05 ? t(shape.startedAt) : nil))
                if let to = interval.to {
                    timeline.append(TimelineEvent(t: t(to), time: iso(to), event: "remove", type: Self.type(element.kind),
                                                  cause: interval.hiddenBy, id: shape.id,
                                                  text: element.kind == .text ? element.text : nil))
                }
            }
            elements.append(excalidraw(shape, sx: sx, sy: sy, t: t, startDate: startDate, start: start))
        }
        for stroke in laserStrokes {
            guard let first = stroke.first, let last = stroke.last else { continue }
            var kept: [LaserPoint] = []
            // About one point per video frame is plenty to see where it went.
            for point in stroke where kept.last.map({ point.time - $0.time >= 1.0 / 30 }) ?? true { kept.append(point) }
            if let tail = kept.last, tail.time != last.time { kept.append(last) }
            let box = stroke.dropFirst().reduce(CGRect(origin: first.point, size: .zero)) {
                $0.union(CGRect(origin: $1.point, size: .zero))
            }
            timeline.append(TimelineEvent(
                t: t(first.time), time: iso(first.time), event: "laser", type: "laser",
                bounds: Self.box(box, sx: sx, sy: sy),
                points: kept.map { let p = px($0.point); return [Self.round(p.x), Self.round(p.y), t($0.time)] },
                until: t(last.time)))
        }
        // Stable for equal times, so an edit's remove stays ahead of its add.
        timeline = timeline.enumerated().sorted { ($0.element.t, $0.offset) < ($1.element.t, $1.offset) }.map(\.element)

        let header = QuickRecordHeader(
            video: videoName,
            har: videoName.isEmpty ? "" : (videoName as NSString).deletingPathExtension + ".har",
            recordingStartedDateTime: Self.isoFormatter.string(from: startDate),
            duration: duration,
            width: Int(videoSize.width), height: Int(videoSize.height),
            timeline: timeline)
        return ExcalidrawDocument(quickRecord: header, elements: elements)
    }

    private func excalidraw(_ shape: Shape, sx: CGFloat, sy: CGFloat, t: (CFTimeInterval) -> Double,
                            startDate: Date, start: CFTimeInterval) -> ExcalidrawElement {
        let element = shape.element
        let style = element.style
        let lastChange = shape.intervals.last.map { $0.to ?? $0.from } ?? start
        var result = ExcalidrawElement(
            id: shape.id, type: Self.type(element.kind), x: 0, y: 0, width: 0, height: 0,
            strokeColor: style.strokeColor, backgroundColor: style.background ?? "transparent",
            fillStyle: style.fill == .crossHatch ? "cross-hatch" : style.fill.rawValue,
            strokeWidth: Self.round(style.width.points * sx), strokeStyle: style.pattern.rawValue,
            roughness: Int(style.sloppiness.roughness), seed: Int(element.seed % 2_147_483_647) + 1,
            isDeleted: !shape.isVisible,
            updated: Int64((startDate.timeIntervalSince1970 + max(0, lastChange - start)) * 1000),
            customData: .init(startedAt: t(shape.startedAt),
                              shown: shape.intervals.map { .init(from: t($0.from), by: $0.shownBy, to: $0.to.map(t), hiddenBy: $0.hiddenBy) }))
        let points = element.points.map { CGPoint(x: $0.x * sx, y: $0.y * sy) }
        switch element.kind {
        case .rectangle, .diamond, .ellipse:
            let box = AnnotationRenderer.rect(element)
            result.x = Self.round(box.minX * sx)
            result.y = Self.round(box.minY * sy)
            result.width = Self.round(box.width * sx)
            result.height = Self.round(box.height * sy)
        case .arrow, .line, .draw:
            guard let origin = points.first else { break }
            let box = Self.box(element.bounds, sx: sx, sy: sy)
            result.x = Self.round(origin.x)
            result.y = Self.round(origin.y)
            result.width = box[2]
            result.height = box[3]
            result.points = points.map { [Self.round($0.x - origin.x), Self.round($0.y - origin.y)] }
            if element.kind == .draw {
                // Excalidraw paints a freehand stroke about 4.25 × strokeWidth wide.
                result.strokeWidth = Self.round(style.width.points * sx / 4.25)
                result.pressures = []
                result.simulatePressure = true
            } else {
                result.startArrowhead = .null
                result.endArrowhead = element.kind == .arrow ? .value("arrow") : .null
            }
        case .text:
            let box = Self.box(element.bounds, sx: sx, sy: sy)
            result.x = box[0]
            result.y = box[1]
            result.width = box[2]
            result.height = box[3]
            result.text = element.text
            result.originalText = element.text
            result.fontSize = Self.round(style.fontSize.points * sx)
            result.fontFamily = switch style.fontFamily {
            case .hand: 1 // Virgil
            case .normal: 2 // Helvetica
            case .code: 3 // Cascadia
            }
            result.textAlign = "left"
            result.verticalAlign = "top"
            result.lineHeight = 1.25
        }
        return result
    }

    private static func type(_ kind: AnnotationElement.Kind) -> String {
        switch kind {
        case .rectangle: "rectangle"
        case .diamond: "diamond"
        case .ellipse: "ellipse"
        case .arrow: "arrow"
        case .line: "line"
        case .draw: "freedraw"
        case .text: "text"
        }
    }

    private static func box(_ rect: CGRect, sx: CGFloat, sy: CGFloat) -> [Double] {
        guard !rect.isNull else { return [0, 0, 0, 0] }
        return [round(rect.minX * sx), round(rect.minY * sy), round(rect.width * sx), round(rect.height * sy)]
    }

    private static func pair(_ p: CGPoint) -> [Double] { [round(p.x), round(p.y)] }
    private static func round(_ value: CGFloat) -> Double { (Double(value) * 10).rounded() / 10 }
    static func seconds(_ value: CFTimeInterval) -> Double { (value * 1000).rounded() / 1000 }

    /// The same shape as the HAR's `startedDateTime` (JavaScript's toISOString).
    static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

// MARK: - File format

/// An Excalidraw file's contents (Excalidraw ignores the extra `quickRecord` key); `fileText` writes it.
struct ExcalidrawDocument {
    var quickRecord: QuickRecordHeader
    var elements: [ExcalidrawElement]
}

struct QuickRecordHeader {
    var about = "Annotations drawn on a Quick Record demo. t is seconds from the video's first frame; time is the same moment on the wall clock. bounds are [x, y, width, height] and points are [x, y] (laser: [x, y, t]) in video pixels from the frame's top-left corner, so they crop straight out of a frame. add/remove say when each annotation appeared and went away, and cause says why (draw, label, edit, erase, undo, redo, clear). The HAR beside the video carries the same clock in each entry's _videoTime. elements is the Excalidraw scene as it stood when the recording stopped; annotations removed earlier are kept with isDeleted."
    var video: String
    var har: String
    var recordingStartedDateTime: String
    var duration: Double?
    var width: Int
    var height: Int
    var timeline: [TimelineEvent]
}

struct TimelineEvent {
    var t: Double
    var time: String
    var event: String
    var type: String
    var cause: AnnotationCause?
    var id: String?
    var text: String?
    var color: String?
    var bounds: [Double]?
    var points: [[Double]]?
    /// When the pointer went down (or the label opened), if well before it appeared.
    var startedAt: Double?
    var until: Double?
}

/// A JSON value that's either present or an explicit null (Excalidraw's arrowheads).
enum NullableString: Encodable, Equatable {
    case null, value(String)
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .value(let value): try container.encode(value)
        }
    }
}

/// The subset of Excalidraw's element schema it needs to restore these; the rest it fills with defaults.
struct ExcalidrawElement: Encodable {
    var id: String
    var type: String
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var angle = 0
    var strokeColor: String
    var backgroundColor: String
    var fillStyle: String
    var strokeWidth: Double
    var strokeStyle: String
    var roughness: Int
    var opacity = 100
    var groupIds: [String] = []
    var seed: Int
    var version = 1
    var versionNonce = 0
    var isDeleted: Bool
    var updated: Int64
    var points: [[Double]]?
    var startArrowhead: NullableString?
    var endArrowhead: NullableString?
    var pressures: [Double]?
    var simulatePressure: Bool?
    var text: String?
    var originalText: String?
    var fontSize: Double?
    var fontFamily: Int?
    var textAlign: String?
    var verticalAlign: String?
    var lineHeight: Double?
    var customData: CustomData

    struct CustomData: Encodable {
        var startedAt: Double
        var shown: [Shown]
    }

    /// One stretch on screen, in video seconds; `to` is null when it stayed until the end.
    struct Shown: Encodable {
        var from: Double
        var by: AnnotationCause
        var to: Double?
        var hiddenBy: AnnotationCause?

        enum CodingKeys: String, CodingKey { case from, by, to, hiddenBy }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(from, forKey: .from)
            try container.encode(by, forKey: .by)
            try container.encode(to, forKey: .to)
            try container.encodeIfPresent(hiddenBy, forKey: .hiddenBy)
        }
    }
}
