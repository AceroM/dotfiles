import AppKit

/// Excalidraw's tools, keyed the same way (V/1 … E/0, K), plus Interact: the canvas lets clicks
/// through to the app being recorded, which is what Excalidraw's selection tool becomes here.
enum AnnotationTool: String, CaseIterable, Codable {
    case interact, rectangle, diamond, ellipse, arrow, line, draw, text, eraser, laser

    var title: String {
        switch self {
        case .interact: "Interact with the app"
        case .rectangle: "Rectangle"
        case .diamond: "Diamond"
        case .ellipse: "Ellipse"
        case .arrow: "Arrow"
        case .line: "Line"
        case .draw: "Draw"
        case .text: "Text"
        case .eraser: "Eraser"
        case .laser: "Laser pointer"
        }
    }

    var symbol: String {
        switch self {
        case .interact: "cursorarrow"
        case .rectangle: "square"
        case .diamond: "diamond"
        case .ellipse: "circle"
        case .arrow: "arrow.right"
        case .line: "line.diagonal"
        case .draw: "pencil"
        case .text: "textformat"
        case .eraser: "eraser"
        case .laser: "cursorarrow.rays"
        }
    }

    /// Key shown on the toolbar and accepted while the canvas has the keyboard.
    var shortcut: String {
        switch self {
        case .interact: "1"
        case .rectangle: "2"
        case .diamond: "3"
        case .ellipse: "4"
        case .arrow: "5"
        case .line: "6"
        case .draw: "7"
        case .text: "8"
        case .eraser: "0"
        case .laser: "K"
        }
    }

    static func forKey(_ key: String) -> AnnotationTool? {
        switch key.lowercased() {
        case "v", "1": .interact
        case "r", "2": .rectangle
        case "d", "3": .diamond
        case "o", "4": .ellipse
        case "a", "5": .arrow
        case "l", "6": .line
        case "p", "x", "7": .draw
        case "t", "8": .text
        case "e", "0": .eraser
        case "k": .laser
        default: nil
        }
    }

    var isShape: Bool { [.rectangle, .diamond, .ellipse].contains(self) }
    var isLinear: Bool { [.arrow, .line].contains(self) }
}

enum FillStyle: String, CaseIterable, Codable { case hachure, crossHatch, solid }
enum StrokeWidth: String, CaseIterable, Codable {
    case thin, bold, extraBold
    /// Thicker than Excalidraw's 1/2/4: these strokes sit on a live screen, often scaled down.
    var points: CGFloat {
        switch self {
        case .thin: 2
        case .bold: 4
        case .extraBold: 7
        }
    }
}
enum StrokePattern: String, CaseIterable, Codable { case solid, dashed, dotted }
enum Sloppiness: String, CaseIterable, Codable {
    case architect, artist, cartoonist
    var roughness: Double {
        switch self {
        case .architect: 0
        case .artist: 1
        case .cartoonist: 2
        }
    }
}
enum FontSize: String, CaseIterable, Codable {
    case small, medium, large, extraLarge
    var points: CGFloat {
        switch self {
        case .small: 16
        case .medium: 20
        case .large: 28
        case .extraLarge: 36
        }
    }
    var label: String {
        switch self {
        case .small: "S"
        case .medium: "M"
        case .large: "L"
        case .extraLarge: "XL"
        }
    }
}
enum FontFamily: String, CaseIterable, Codable {
    case hand, normal, code
    func font(size: CGFloat) -> NSFont {
        switch self {
        case .hand: NSFont(name: "ChalkboardSE-Regular", size: size) ?? .systemFont(ofSize: size)
        case .normal: .systemFont(ofSize: size, weight: .medium)
        case .code: .monospacedSystemFont(ofSize: size, weight: .regular)
        }
    }
}

/// Excalidraw's default stroke and background palettes, plus white for dark apps.
enum Palette {
    static let strokes = ["#1e1e1e", "#ffffff", "#e03131", "#2f9e44", "#1971c2", "#f08c00"]
    static let backgrounds = ["#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"]
    static let laser = "#ff2d2d"

    static func color(_ hex: String, alpha: CGFloat = 1) -> NSColor {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
        return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                       blue: CGFloat(value & 0xff) / 255, alpha: alpha)
    }
}

/// The properties panel. Persisted, so the next recording starts where this one left off.
struct AnnotationStyle: Codable, Equatable {
    var strokeColor = "#e03131"
    var background: String?
    var fill = FillStyle.hachure
    var width = StrokeWidth.bold
    var pattern = StrokePattern.solid
    var sloppiness = Sloppiness.artist
    var fontSize = FontSize.large
    var fontFamily = FontFamily.hand

    var font: NSFont { fontFamily.font(size: fontSize.points) }

    static let defaultsKey = "annotationStyle"
    static func load(from defaults: UserDefaults = .standard) -> AnnotationStyle {
        guard let data = defaults.data(forKey: defaultsKey),
              let style = try? JSONDecoder().decode(AnnotationStyle.self, from: data) else { return AnnotationStyle() }
        return style
    }
    func save(to defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.defaultsKey) }
    }
}

/// One drawn thing. Points are canvas coordinates with a top-left origin: shapes keep their two
/// drag corners, lines and arrows their ends, freehand strokes every sample, text its origin.
struct AnnotationElement: Identifiable, Equatable {
    enum Kind: Equatable { case rectangle, diamond, ellipse, arrow, line, draw, text }
    let id = UUID()
    var kind: Kind
    var points: [CGPoint]
    var style: AnnotationStyle
    var text = ""
    /// Fixed per element so its hand-drawn wobble doesn't change on every redraw.
    var seed = UInt64.random(in: 1...UInt64.max)

    var bounds: CGRect {
        if kind == .text {
            let size = (text as NSString).size(withAttributes: [.font: style.font])
            return CGRect(origin: points.first ?? .zero, size: size)
        }
        guard let first = points.first else { return .null }
        return points.dropFirst().reduce(CGRect(origin: first, size: .zero)) { $0.union(CGRect(origin: $1, size: .zero)) }
    }
}

/// What to paint for an element, built once and cached by the canvas.
struct RenderedElement {
    var strokes: [CGPath] = []
    var fillOutline: CGPath?
    var hachure: [CGPath] = []
    var lineWidth: CGFloat = 2
}

/// Deterministic xorshift, so an element's sloppiness is stable for its seed.
struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed == 0 ? 0x9E37_79B9_7F4A_7C15 : seed }
    mutating func next() -> Double {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return Double(state >> 11) / Double(1 << 53)
    }
}

/// A Swift take on rough.js, which Excalidraw draws with: every edge is a bowed bezier drawn twice
/// with jittered ends, ellipses are jittered point loops. Roughness 0 gives clean geometry.
struct RoughGenerator {
    let roughness: Double
    var random: SeededRandom
    var bowing = 1.0
    var maxOffset = 2.0

    init(roughness: Double, seed: UInt64) {
        self.roughness = roughness
        random = SeededRandom(seed: seed)
    }

    private mutating func offset(_ range: Double, gain: Double = 1) -> Double {
        roughness * gain * (random.next() * 2 * range - range)
    }

    /// One edge, as rough.js's _doubleLine: a full-offset pass and a half-offset overlay.
    mutating func line(_ a: CGPoint, _ b: CGPoint, double: Bool = true) -> CGPath {
        let path = CGMutablePath()
        guard roughness > 0 else {
            path.move(to: a)
            path.addLine(to: b)
            return path
        }
        addRoughLine(a, b, overlay: false, to: path)
        if double { addRoughLine(a, b, overlay: true, to: path) }
        return path
    }

    private mutating func addRoughLine(_ a: CGPoint, _ b: CGPoint, overlay: Bool, to path: CGMutablePath) {
        let (x1, y1, x2, y2) = (Double(a.x), Double(a.y), Double(b.x), Double(b.y))
        let lengthSquared = (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2)
        let length = lengthSquared.squareRoot()
        let gain = length < 200 ? 1 : (length > 500 ? 0.4 : -0.0016668 * length + 1.233334)
        var range = maxOffset
        if range * range * 100 > lengthSquared { range = length / 10 }
        let half = range / 2
        let diverge = 0.2 + random.next() * 0.2
        let midX = offset(bowing * maxOffset * (y2 - y1) / 200, gain: gain)
        let midY = offset(bowing * maxOffset * (x1 - x2) / 200, gain: gain)
        func jitter(_ value: Double) -> Double { value + offset(overlay ? half : range, gain: gain) }
        path.move(to: CGPoint(x: jitter(x1), y: jitter(y1)))
        path.addCurve(to: CGPoint(x: jitter(x2), y: jitter(y2)),
                      control1: CGPoint(x: jitter(midX + x1 + (x2 - x1) * diverge), y: jitter(midY + y1 + (y2 - y1) * diverge)),
                      control2: CGPoint(x: jitter(midX + x1 + 2 * (x2 - x1) * diverge), y: jitter(midY + y1 + 2 * (y2 - y1) * diverge)))
    }

    mutating func polygon(_ points: [CGPoint]) -> CGPath {
        let path = CGMutablePath()
        guard roughness > 0 else {
            path.addLines(between: points)
            path.closeSubpath()
            return path
        }
        for (index, point) in points.enumerated() {
            path.addPath(line(point, points[(index + 1) % points.count]))
        }
        return path
    }

    mutating func ellipse(in rect: CGRect) -> CGPath {
        guard roughness > 0 else { return CGPath(ellipseIn: rect, transform: nil) }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        var rx = Double(rect.width / 2), ry = Double(rect.height / 2)
        let perimeter = (Double.pi * 2 * ((rx * rx + ry * ry) / 2).squareRoot()).squareRoot()
        let steps = max(9, (9 / 200.0.squareRoot() * perimeter).rounded(.up))
        let increment = Double.pi * 2 / steps
        rx += offset(rx * 0.05)
        ry += offset(ry * 0.05)
        let overlap = increment * (0.1 + random.next() * 0.3)
        let path = CGMutablePath()
        addCurve(through: ellipsePoints(center: center, rx: rx, ry: ry, increment: increment, jitter: 1, overlap: overlap), to: path)
        addCurve(through: ellipsePoints(center: center, rx: rx, ry: ry, increment: increment, jitter: 1.5, overlap: 0), to: path)
        return path
    }

    private mutating func ellipsePoints(center: CGPoint, rx: Double, ry: Double, increment: Double,
                                        jitter: Double, overlap: Double) -> [CGPoint] {
        let start = offset(0.5) - Double.pi / 2
        func point(_ angle: Double, _ scale: Double = 1) -> CGPoint {
            CGPoint(x: offset(jitter) + Double(center.x) + scale * rx * cos(angle),
                    y: offset(jitter) + Double(center.y) + scale * ry * sin(angle))
        }
        var points = [point(start - increment, 0.9)]
        var angle = start
        while angle < Double.pi * 2 + start - 0.01 {
            points.append(point(angle))
            angle += increment
        }
        points.append(point(start + Double.pi * 2 + overlap * 0.5))
        points.append(point(start + overlap, 0.98))
        points.append(point(start + overlap * 0.5, 0.9))
        return points
    }

    /// Catmull-Rom through the points, as rough.js's _curve.
    private func addCurve(through points: [CGPoint], to path: CGMutablePath) {
        guard points.count > 3 else { return }
        path.move(to: points[1])
        for i in 1..<(points.count - 2) {
            let p0 = points[i - 1], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2]
            path.addCurve(to: p2,
                          control1: CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                          control2: CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6))
        }
    }

    /// Parallel strokes across `outline` at `angle` degrees, clipped later by the caller.
    mutating func hachure(_ outline: CGPath, gap: CGFloat, angle: Double) -> [CGPath] {
        let box = outline.boundingBoxOfPath
        guard box.width > 1, box.height > 1, gap > 0 else { return [] }
        let radians = angle * Double.pi / 180
        let direction = CGPoint(x: cos(radians), y: sin(radians))
        let normal = CGPoint(x: -direction.y, y: direction.x)
        let center = CGPoint(x: box.midX, y: box.midY)
        let reach = (box.width * box.width + box.height * box.height).squareRoot() / 2
        var lines: [CGPath] = []
        var distance = -reach + gap / 2
        while distance < reach {
            let base = CGPoint(x: center.x + normal.x * distance, y: center.y + normal.y * distance)
            let a = CGPoint(x: base.x - direction.x * reach, y: base.y - direction.y * reach)
            let b = CGPoint(x: base.x + direction.x * reach, y: base.y + direction.y * reach)
            lines.append(line(a, b, double: false))
            distance += gap
        }
        return lines
    }
}

enum AnnotationRenderer {
    /// Excalidraw's arrowhead: two short strokes back from the tip.
    static func arrowhead(from start: CGPoint, to end: CGPoint, width: CGFloat) -> (CGPoint, CGPoint)? {
        let dx = end.x - start.x, dy = end.y - start.y
        let length = (dx * dx + dy * dy).squareRoot()
        guard length > 1 else { return nil }
        let size = min(max(14, width * 5), length * 0.45)
        let angle = atan2(dy, dx)
        let spread = CGFloat.pi / 7
        return (CGPoint(x: end.x - size * cos(angle - spread), y: end.y - size * sin(angle - spread)),
                CGPoint(x: end.x - size * cos(angle + spread), y: end.y - size * sin(angle + spread)))
    }

    /// Smooth a freehand stroke through the midpoints of its samples.
    static func freehand(_ points: [CGPoint]) -> CGPath {
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        path.move(to: first)
        if points.count == 1 {
            path.addLine(to: CGPoint(x: first.x + 0.1, y: first.y))
            return path
        }
        for i in 1..<points.count {
            let mid = CGPoint(x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2)
            path.addQuadCurve(to: mid, control: points[i - 1])
        }
        path.addLine(to: points[points.count - 1])
        return path
    }

    static func rect(_ element: AnnotationElement) -> CGRect {
        guard element.points.count >= 2 else { return .null }
        return CGRect(x: min(element.points[0].x, element.points[1].x), y: min(element.points[0].y, element.points[1].y),
                      width: abs(element.points[0].x - element.points[1].x), height: abs(element.points[0].y - element.points[1].y))
    }

    static func render(_ element: AnnotationElement) -> RenderedElement {
        var rough = RoughGenerator(roughness: element.style.sloppiness.roughness, seed: element.seed)
        var result = RenderedElement(lineWidth: element.style.width.points)
        switch element.kind {
        case .rectangle, .diamond, .ellipse:
            let box = rect(element)
            guard box.width > 0 || box.height > 0 else { return result }
            let outline: CGPath
            switch element.kind {
            case .rectangle:
                outline = CGPath(rect: box, transform: nil)
                result.strokes = [rough.polygon([CGPoint(x: box.minX, y: box.minY), CGPoint(x: box.maxX, y: box.minY),
                                                 CGPoint(x: box.maxX, y: box.maxY), CGPoint(x: box.minX, y: box.maxY)])]
            case .diamond:
                let corners = [CGPoint(x: box.midX, y: box.minY), CGPoint(x: box.maxX, y: box.midY),
                               CGPoint(x: box.midX, y: box.maxY), CGPoint(x: box.minX, y: box.midY)]
                let clean = CGMutablePath()
                clean.addLines(between: corners)
                clean.closeSubpath()
                outline = clean
                result.strokes = [rough.polygon(corners)]
            default:
                outline = CGPath(ellipseIn: box, transform: nil)
                result.strokes = [rough.ellipse(in: box)]
            }
            if element.style.background != nil {
                result.fillOutline = outline
                if element.style.fill != .solid {
                    let gap = max(8, element.style.width.points * 4)
                    result.hachure = rough.hachure(outline, gap: gap, angle: -41)
                    if element.style.fill == .crossHatch { result.hachure += rough.hachure(outline, gap: gap, angle: 49) }
                }
            }
        case .arrow, .line:
            guard element.points.count >= 2 else { return result }
            let start = element.points[0], end = element.points[1]
            var strokes = [rough.line(start, end)]
            if element.kind == .arrow, let (left, right) = arrowhead(from: start, to: end, width: element.style.width.points) {
                strokes.append(rough.line(end, left))
                strokes.append(rough.line(end, right))
            }
            result.strokes = strokes
        case .draw:
            result.strokes = [freehand(element.points)]
        case .text:
            break
        }
        return result
    }

    /// Whether an eraser at `point` with `radius` touches the element.
    static func hits(_ element: AnnotationElement, rendered: RenderedElement, point: CGPoint, radius: CGFloat) -> Bool {
        if element.kind == .text { return element.bounds.insetBy(dx: -radius, dy: -radius).contains(point) }
        if let fill = rendered.fillOutline, fill.contains(point) { return true }
        let reach = rendered.lineWidth + radius * 2
        return rendered.strokes.contains { stroke in
            stroke.copy(strokingWithWidth: reach, lineCap: .round, lineJoin: .round, miterLimit: 1).contains(point)
        }
    }

    /// ⇧ while dragging: squares and circles, and lines held to 15° steps.
    static func constrain(_ end: CGPoint, from start: CGPoint, tool: AnnotationTool) -> CGPoint {
        let dx = end.x - start.x, dy = end.y - start.y
        if tool.isShape {
            let side = max(abs(dx), abs(dy))
            return CGPoint(x: start.x + (dx < 0 ? -side : side), y: start.y + (dy < 0 ? -side : side))
        }
        let length = (dx * dx + dy * dy).squareRoot()
        let step = CGFloat.pi / 12
        let angle = (atan2(dy, dx) / step).rounded() * step
        return CGPoint(x: start.x + length * cos(angle), y: start.y + length * sin(angle))
    }
}
