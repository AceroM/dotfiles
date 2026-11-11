import XCTest
@testable import QuickRecord

final class AnnotationTests: XCTestCase {
    private func element(_ kind: AnnotationElement.Kind, _ points: [CGPoint], sloppiness: Sloppiness = .artist,
                         seed: UInt64 = 42) -> AnnotationElement {
        var style = AnnotationStyle()
        style.sloppiness = sloppiness
        var element = AnnotationElement(kind: kind, points: points, style: style)
        element.seed = seed
        return element
    }

    func testSloppyShapesAreStableForTheirSeedSoRedrawsDontWobble() {
        let a = AnnotationRenderer.render(element(.rectangle, [CGPoint(x: 10, y: 10), CGPoint(x: 210, y: 110)]))
        let b = AnnotationRenderer.render(element(.rectangle, [CGPoint(x: 10, y: 10), CGPoint(x: 210, y: 110)]))
        let c = AnnotationRenderer.render(element(.rectangle, [CGPoint(x: 10, y: 10), CGPoint(x: 210, y: 110)], seed: 7))
        XCTAssertEqual(a.strokes.map(\.boundingBoxOfPath), b.strokes.map(\.boundingBoxOfPath))
        XCTAssertNotEqual(a.strokes.map(\.boundingBoxOfPath), c.strokes.map(\.boundingBoxOfPath))
    }

    func testSloppinessStaysCloseToTheShape() {
        let box = CGRect(x: 100, y: 100, width: 300, height: 200)
        for kind in [AnnotationElement.Kind.rectangle, .ellipse, .diamond] {
            let rendered = AnnotationRenderer.render(element(kind, [box.origin, CGPoint(x: box.maxX, y: box.maxY)], sloppiness: .cartoonist))
            let drawn = rendered.strokes.reduce(CGRect.null) { $0.union($1.boundingBoxOfPath) }
            XCTAssertLessThan(abs(drawn.minX - box.minX), 16, "\(kind)")
            XCTAssertLessThan(abs(drawn.maxY - box.maxY), 16, "\(kind)")
        }
    }

    func testArchitectDrawsCleanGeometry() {
        let rendered = AnnotationRenderer.render(element(.rectangle, [CGPoint(x: 210, y: 110), CGPoint(x: 10, y: 10)], sloppiness: .architect))
        XCTAssertEqual(rendered.strokes.first?.boundingBoxOfPath, CGRect(x: 10, y: 10, width: 200, height: 100))
    }

    func testArrowheadPointsBackFromTheTip() throws {
        let (left, right) = try XCTUnwrap(AnnotationRenderer.arrowhead(from: .zero, to: CGPoint(x: 100, y: 0), width: 4))
        XCTAssertLessThan(left.x, 100)
        XCTAssertLessThan(right.x, 100)
        XCTAssertEqual(left.y, -right.y, accuracy: 0.001)
        XCTAssertNil(AnnotationRenderer.arrowhead(from: .zero, to: .zero, width: 4))
    }

    func testShiftMakesSquaresAndFifteenDegreeLines() {
        let square = AnnotationRenderer.constrain(CGPoint(x: 80, y: -30), from: .zero, tool: .rectangle)
        XCTAssertEqual(square, CGPoint(x: 80, y: -80))
        let line = AnnotationRenderer.constrain(CGPoint(x: 100, y: 3), from: .zero, tool: .arrow)
        XCTAssertEqual(line.y, 0, accuracy: 0.001)
        XCTAssertEqual(line.x, (100 * 100 + 9 as CGFloat).squareRoot(), accuracy: 0.001)
    }

    func testEraserHitsStrokesFillsAndLabelsButNotEmptySpace() {
        let line = element(.line, [CGPoint(x: 0, y: 0), CGPoint(x: 200, y: 0)], sloppiness: .architect)
        let rendered = AnnotationRenderer.render(line)
        XCTAssertTrue(AnnotationRenderer.hits(line, rendered: rendered, point: CGPoint(x: 100, y: 5), radius: 8))
        XCTAssertFalse(AnnotationRenderer.hits(line, rendered: rendered, point: CGPoint(x: 100, y: 40), radius: 8))

        var filled = element(.rectangle, [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 100)])
        filled.style.background = Palette.backgrounds[0]
        XCTAssertTrue(AnnotationRenderer.hits(filled, rendered: AnnotationRenderer.render(filled), point: CGPoint(x: 50, y: 50), radius: 8))

        var label = element(.text, [CGPoint(x: 10, y: 10)])
        label.text = "Click here"
        XCTAssertTrue(AnnotationRenderer.hits(label, rendered: RenderedElement(), point: CGPoint(x: 20, y: 20), radius: 8))
        XCTAssertFalse(AnnotationRenderer.hits(label, rendered: RenderedElement(), point: CGPoint(x: 20, y: 300), radius: 8))
    }

    func testHachureOnlyWhenABackgroundIsSet() {
        var shape = element(.ellipse, [CGPoint(x: 0, y: 0), CGPoint(x: 120, y: 80)])
        XCTAssertTrue(AnnotationRenderer.render(shape).hachure.isEmpty)
        shape.style.background = Palette.backgrounds[2]
        XCTAssertFalse(AnnotationRenderer.render(shape).hachure.isEmpty)
        shape.style.fill = .solid
        let solid = AnnotationRenderer.render(shape)
        XCTAssertTrue(solid.hachure.isEmpty)
        XCTAssertNotNil(solid.fillOutline)
    }

    func testExcalidrawShortcuts() {
        XCTAssertEqual(AnnotationTool.forKey("1"), .interact)
        XCTAssertEqual(AnnotationTool.forKey("R"), .rectangle)
        XCTAssertEqual(AnnotationTool.forKey("5"), .arrow)
        XCTAssertEqual(AnnotationTool.forKey("p"), .draw)
        XCTAssertEqual(AnnotationTool.forKey("0"), .eraser)
        XCTAssertEqual(AnnotationTool.forKey("k"), .laser)
        XCTAssertNil(AnnotationTool.forKey("m"))
        for tool in AnnotationTool.allCases {
            XCTAssertEqual(AnnotationTool.forKey(tool.shortcut), tool, "toolbar badge for \(tool) must select it")
        }
    }

    func testStyleSurvivesARestart() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "AnnotationTests"))
        defaults.removePersistentDomain(forName: "AnnotationTests")
        var style = AnnotationStyle()
        style.strokeColor = "#1971c2"
        style.sloppiness = .cartoonist
        style.background = "#ffec99"
        style.save(to: defaults)
        XCTAssertEqual(AnnotationStyle.load(from: defaults), style)
    }
}
