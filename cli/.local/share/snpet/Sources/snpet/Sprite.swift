import AppKit
import ImageIO

/// The GIF, frame by frame, so the pet can hold a pose or dance on cue rather
/// than loop forever the way NSImageView would.
final class Sprite {
  let frames: [CGImage]
  let delays: [TimeInterval]

  init?(url: URL) {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    var frames: [CGImage] = []
    var delays: [TimeInterval] = []
    for i in 0..<CGImageSourceGetCount(src) {
      guard let img = CGImageSourceCreateImageAtIndex(src, i, nil) else { continue }
      let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]
      let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
      let delay =
        (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
        ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
      frames.append(img)
      delays.append(max(delay, 0.02))
    }
    guard !frames.isEmpty else { return nil }
    self.frames = frames
    self.delays = delays
  }
}

/// Draws the sprite, dances it, badges it, and tells a click from a drag.
final class SpriteView: NSView {
  var sprite: Sprite? { didSet { needsDisplay = true } }
  var inset: CGFloat = 0  // room around the sprite for the badge to hang off the corner
  var badge = 0 { didSet { if oldValue != badge { needsDisplay = true } } }
  /// Setting this false lets the current loop finish, so he comes to rest on
  /// the first pose instead of snapping to it mid-step.
  var dancing = false { didSet { if dancing && timer == nil { scheduleNext() } } }
  var onClick: (() -> Void)?
  var contextMenu: (() -> NSMenu)?

  private var frameIndex = 0
  private var timer: Timer?
  private var pressedAt: NSPoint?
  private var dragged = false

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  private var spriteRect: NSRect { bounds.insetBy(dx: inset, dy: inset) }

  private func scheduleNext() {
    guard let s = sprite else { return }
    let t = Timer(timeInterval: s.delays[frameIndex], repeats: false) { [weak self] _ in
      guard let self, let s = self.sprite else { return }
      self.timer = nil
      self.frameIndex = (self.frameIndex + 1) % s.frames.count
      self.needsDisplay = true
      if self.frameIndex == 0 && !self.dancing { return }  // came to rest
      self.scheduleNext()
    }
    RunLoop.main.add(t, forMode: .common)  // keeps dancing while being dragged
    timer = t
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let s = sprite, let ctx = NSGraphicsContext.current?.cgContext else { return }
    ctx.interpolationQuality = .none  // pixel art stays crisp when scaled
    ctx.draw(s.frames[frameIndex], in: spriteRect)

    guard badge > 0 else { return }
    let label = badge > 99 ? "99+" : String(badge)
    let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold)
    let text = NSAttributedString(
      string: label, attributes: [.font: font, .foregroundColor: NSColor.white])
    let size = text.size()
    let d: CGFloat = 22
    let w = max(d, size.width + 12)
    let pill = NSRect(x: spriteRect.maxX - w + 6, y: spriteRect.maxY - d + 4, width: w, height: d)
    Palette.badge.setFill()
    NSBezierPath(roundedRect: pill, xRadius: d / 2, yRadius: d / 2).fill()
    text.draw(at: NSPoint(x: pill.midX - size.width / 2, y: pill.midY - size.height / 2))
  }

  // MARK: mouse — a press that moves is a drag of the window; one that does not is a click

  override func mouseDown(with event: NSEvent) {
    pressedAt = event.locationInWindow
    dragged = false
  }

  override func mouseDragged(with event: NSEvent) {
    guard let p = pressedAt, !dragged else { return }
    if hypot(event.locationInWindow.x - p.x, event.locationInWindow.y - p.y) > 3 {
      dragged = true
      window?.performDrag(with: event)
    }
  }

  override func mouseUp(with event: NSEvent) {
    if !dragged { onClick?() }
    pressedAt = nil
  }

  override func rightMouseDown(with event: NSEvent) {
    guard let menu = contextMenu?() else { return }
    NSMenu.popUpContextMenu(menu, with: event, for: self)
  }
}
