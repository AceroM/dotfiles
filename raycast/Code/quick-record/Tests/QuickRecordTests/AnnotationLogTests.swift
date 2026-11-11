import AppKit
import XCTest
@testable import QuickRecord

/// Drives a real canvas (in an offscreen window) with mouse events and checks what the demo's
/// `.excalidraw` timeline says happened, and when.
@MainActor
final class AnnotationLogTests: XCTestCase {
    private var clock = 0.0
    private var canvas: AnnotationCanvasView!
    private var window: NSWindow!
    private var log: AnnotationLog!

    /// A 400×300 pt region recorded at 2× (800×600 px video), whose first frame arrives at host time 10.
    override func setUp() async throws {
        clock = 9
        log = AnnotationLog(canvasSize: CGSize(width: 400, height: 300), videoSize: CGSize(width: 800, height: 600),
                            clock: { [unowned self] in self.clock })
        canvas = AnnotationCanvasView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        var style = AnnotationStyle()
        style.sloppiness = .architect
        canvas.style = style
        canvas.log = log
        window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 400, height: 300), styleMask: .borderless,
                          backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentView = canvas
        log.videoStarted(hostTime: 10, date: Date(timeIntervalSince1970: 1_800_000_000))
    }

    override func tearDown() async throws {
        window.close()
        canvas = nil
        window = nil
        log = nil
    }

    // MARK: Helpers

    private func event(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
        // Window coordinates have a bottom-left origin; the canvas is flipped.
        NSEvent.mouseEvent(with: type, location: CGPoint(x: p.x, y: 300 - p.y), modifierFlags: [], timestamp: clock,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }

    /// Presses at the first point at the current time, drags through the rest a tenth of a second apart, releases.
    private func drag(_ tool: AnnotationTool, _ points: [CGPoint]) {
        canvas.tool = tool
        canvas.mouseDown(with: event(.leftMouseDown, points[0]))
        for point in points.dropFirst() {
            clock += 0.1
            canvas.mouseDragged(with: event(.leftMouseDragged, point))
        }
        canvas.mouseUp(with: event(.leftMouseUp, points.last!))
    }

    private func type(_ text: String) {
        let editor = canvas.subviews.compactMap { $0 as? NSTextView }.first
        XCTAssertNotNil(editor, "a label editor should be open")
        editor?.string = text
    }

    private func json() throws -> [String: Any] {
        log.video = URL(fileURLWithPath: "/tmp/Demo 2026-11-11 15.49.15 ABC123.mp4")
        let data = Data(try log.fileText().utf8)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func timeline() throws -> [[String: Any]] {
        let header = try XCTUnwrap(try json()["quickRecord"] as? [String: Any])
        return try XCTUnwrap(header["timeline"] as? [[String: Any]])
    }

    private func elements() throws -> [[String: Any]] {
        try XCTUnwrap(try json()["elements"] as? [[String: Any]])
    }

    private func summary(_ events: [[String: Any]]) -> [String] {
        events.map { "\($0["t"] as? Double ?? -1) \($0["event"] as? String ?? "") \($0["type"] as? String ?? "") \($0["cause"] as? String ?? "")" }
    }

    // MARK: Tests

    func testADrawnShapeIsTimedFromTheFirstFrameAndBoxedInVideoPixels() throws {
        clock = 12
        drag(.rectangle, [CGPoint(x: 50, y: 40), CGPoint(x: 120, y: 90), CGPoint(x: 150, y: 140)])

        let events = try timeline()
        XCTAssertEqual(summary(events), ["2.2 add rectangle draw"])
        XCTAssertEqual(events[0]["startedAt"] as? Double, 2, "the press, 0.2 s before the release")
        XCTAssertEqual(events[0]["bounds"] as? [Double], [100, 80, 200, 200])
        XCTAssertEqual(events[0]["color"] as? String, "#e03131")
        XCTAssertEqual(events[0]["time"] as? String, "2027-01-15T08:00:02.200Z")

        let header = try XCTUnwrap(try json()["quickRecord"] as? [String: Any])
        XCTAssertEqual(header["har"] as? String, "Demo 2026-11-11 15.49.15 ABC123.har")
        XCTAssertEqual(header["recordingStartedDateTime"] as? String, "2027-01-15T08:00:00.000Z")
        XCTAssertEqual(header["width"] as? Int, 800)
    }

    func testEraseUndoAndRedoSayWhatWentAwayAndWhatCameBack() throws {
        clock = 11
        drag(.line, [CGPoint(x: 20, y: 150), CGPoint(x: 380, y: 150)])
        clock = 13
        drag(.eraser, [CGPoint(x: 200, y: 100), CGPoint(x: 200, y: 200)])
        clock = 15
        canvas.undo()
        clock = 16
        canvas.redo()

        XCTAssertEqual(summary(try timeline()), [
            "1.1 add line draw", "3.1 remove line erase", "5.0 add line undo", "6.0 remove line redo",
        ])
        let line = try XCTUnwrap(try elements().first)
        XCTAssertEqual(line["isDeleted"] as? Bool, true, "gone when the recording stopped")
        let shown = try XCTUnwrap((line["customData"] as? [String: Any])?["shown"] as? [[String: Any]])
        XCTAssertEqual(shown.count, 2)
        XCTAssertEqual(shown[1]["from"] as? Double, 5)
        XCTAssertEqual(shown[1]["hiddenBy"] as? String, "redo")
    }

    func testClearRemovesEverythingAtOnce() throws {
        clock = 11
        drag(.ellipse, [CGPoint(x: 10, y: 10), CGPoint(x: 60, y: 60)])
        drag(.arrow, [CGPoint(x: 100, y: 100), CGPoint(x: 200, y: 120)])
        clock = 14
        canvas.clear()
        XCTAssertEqual(summary(try timeline()), [
            "1.1 add ellipse draw", "1.2 add arrow draw", "4.0 remove ellipse clear", "4.0 remove arrow clear",
        ])
    }

    func testLabelsCarryTheirTextAndAnEditIsANewVersion() throws {
        clock = 11
        canvas.tool = .text
        canvas.beginEditing(at: CGPoint(x: 30, y: 30))
        clock = 13
        type("Total should be $40")
        canvas.commitText()

        clock = 20
        let existing = try XCTUnwrap(canvas.elements.first)
        canvas.beginEditing(at: CGPoint(x: 30, y: 30), existing: existing)
        clock = 21
        type("Total should be $45")
        canvas.commitText()

        let events = try timeline()
        XCTAssertEqual(summary(events), ["3.0 add text label", "11.0 remove text edit", "11.0 add text edit"])
        XCTAssertEqual(events[0]["text"] as? String, "Total should be $40")
        XCTAssertEqual(events[0]["startedAt"] as? Double, 1, "when the label opened")
        XCTAssertEqual(events[2]["text"] as? String, "Total should be $45")
        XCTAssertEqual(events[2]["id"] as? String, "\(existing.id.uuidString)-v2")
        XCTAssertEqual(try elements().map { $0["isDeleted"] as? Bool }, [true, false])
    }

    func testOpeningALabelAndLeavingItEmptyLogsNothing() throws {
        canvas.tool = .text
        canvas.beginEditing(at: CGPoint(x: 30, y: 30))
        canvas.commitText()
        XCTAssertTrue(log.isEmpty)
    }

    func testEmptyingAnExistingLabelRemovesIt() throws {
        clock = 11
        canvas.tool = .text
        canvas.beginEditing(at: CGPoint(x: 30, y: 30))
        type("typo")
        canvas.commitText()
        clock = 12
        canvas.beginEditing(at: CGPoint(x: 30, y: 30), existing: try XCTUnwrap(canvas.elements.first))
        type("")
        canvas.commitText()
        XCTAssertEqual(summary(try timeline()), ["1.0 add text label", "2.0 remove text edit"])
    }

    func testTheLaserIsLoggedWithTimedPointsButNeverDrawn() throws {
        clock = 15
        drag(.laser, [CGPoint(x: 100, y: 100), CGPoint(x: 110, y: 100), CGPoint(x: 120, y: 105)])

        XCTAssertTrue(canvas.elements.isEmpty)
        let events = try timeline()
        XCTAssertEqual(summary(events), ["5.0 laser laser "])
        XCTAssertEqual(events[0]["until"] as? Double, 5.2)
        XCTAssertEqual(events[0]["points"] as? [[Double]], [[200, 200, 5], [220, 200, 5.1], [240, 210, 5.2]])
        XCTAssertEqual(events[0]["bounds"] as? [Double], [200, 200, 40, 10])
        XCTAssertEqual(try elements().count, 0, "the laser isn't part of the Excalidraw scene")
    }

    func testDrawingBeforeTheFirstFrameCountsFromZero() throws {
        clock = 9.5
        drag(.rectangle, [CGPoint(x: 10, y: 10), CGPoint(x: 50, y: 50)])
        XCTAssertEqual(summary(try timeline()), ["0.0 add rectangle draw"])
    }

    func testTheSceneIsAnExcalidrawFile() throws {
        clock = 11
        drag(.arrow, [CGPoint(x: 100, y: 100), CGPoint(x: 150, y: 80)])
        drag(.draw, [CGPoint(x: 10, y: 10), CGPoint(x: 20, y: 15), CGPoint(x: 30, y: 12)])
        canvas.tool = .text
        canvas.beginEditing(at: CGPoint(x: 40, y: 200))
        type("here")
        canvas.commitText()
        log.videoEnded(hostTime: 20)

        let document = try json()
        XCTAssertEqual(document["type"] as? String, "excalidraw")
        XCTAssertEqual(document["version"] as? Int, 2)
        XCTAssertEqual((document["quickRecord"] as? [String: Any])?["duration"] as? Double, 10)
        let elements = try XCTUnwrap(document["elements"] as? [[String: Any]])
        XCTAssertEqual(elements.map { $0["type"] as? String }, ["arrow", "freedraw", "text"])
        for element in elements {
            for key in ["id", "x", "y", "width", "height", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth",
                        "strokeStyle", "roughness", "opacity", "seed", "isDeleted", "updated", "customData"] {
                XCTAssertNotNil(element[key], "\(element["type"] ?? "?") is missing \(key)")
            }
        }

        let arrow = elements[0]
        XCTAssertEqual(arrow["x"] as? Double, 200)
        XCTAssertEqual(arrow["y"] as? Double, 200)
        XCTAssertEqual(arrow["points"] as? [[Double]], [[0, 0], [100, -40]], "relative to the element's origin")
        XCTAssertEqual(arrow["endArrowhead"] as? String, "arrow")
        XCTAssertTrue(arrow["startArrowhead"] is NSNull)
        XCTAssertEqual(arrow["strokeWidth"] as? Double, 8, "4 pt at 2×")

        let pen = elements[1]
        XCTAssertEqual((pen["points"] as? [[Double]])?.count, 3)
        XCTAssertEqual(pen["simulatePressure"] as? Bool, true)
        XCTAssertEqual(pen["strokeWidth"] as? Double, 1.9, "Excalidraw draws freehand 4.25× wider, so 8 px / 4.25")

        let label = elements[2]
        XCTAssertEqual(label["text"] as? String, "here")
        XCTAssertEqual(label["fontSize"] as? Double, 56, "28 pt at 2×")
        XCTAssertEqual(label["fontFamily"] as? Int, 1)
        let shown = try XCTUnwrap((label["customData"] as? [String: Any])?["shown"] as? [[String: Any]])
        XCTAssertTrue(shown[0]["to"] is NSNull, "still on screen at the end")
    }

    func testTheFileIsWrittenBesideTheVideo() throws {
        clock = 11
        drag(.rectangle, [CGPoint(x: 10, y: 10), CGPoint(x: 50, y: 50)])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("quick-record-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        log.video = directory.appendingPathComponent("Demo x.mp4")
        let url = directory.appendingPathComponent("Demo x.excalidraw")
        try log.write(to: url)
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("\"video\": \"Demo x.mp4\""))
        XCTAssertTrue(text.contains("\n      {\"t\": 1.1, \"time\": "), "one event per line, t first:\n\(text)")
        XCTAssertLessThan(try XCTUnwrap(text.range(of: "\"quickRecord\"")).lowerBound,
                          try XCTUnwrap(text.range(of: "\"elements\"")).lowerBound,
                          "the timeline comes first, ahead of long freehand point lists")
    }
}
