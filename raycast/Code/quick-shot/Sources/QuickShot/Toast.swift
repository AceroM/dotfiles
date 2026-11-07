import AppKit

/// A brief HUD under the pointer that never takes focus, for captures that skip the editor.
@MainActor
enum Toast {
    private static var panel: NSPanel?
    private static var generation = 0

    static func show(_ text: String) {
        panel?.orderOut(nil)
        generation += 1
        let current = generation

        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .white
        label.sizeToFit()
        let size = CGSize(width: label.frame.width + 28, height: 34)
        label.frame.origin = CGPoint(x: 14, y: (size.height - label.frame.height) / 2)

        let content = NSView(frame: CGRect(origin: .zero, size: size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(white: 0.10, alpha: 0.94).cgColor
        content.layer?.cornerRadius = 8
        content.addSubview(label)

        let mouse = NSEvent.mouseLocation
        let visible = (NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main)?.visibleFrame ?? .zero
        let origin = CGPoint(x: min(max(visible.minX + 8, mouse.x - size.width / 2), visible.maxX - size.width - 8),
                             y: max(visible.minY + 8, mouse.y - size.height - 28))
        let panel = NSPanel(contentRect: CGRect(origin: origin, size: size), styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = content
        panel.orderFrontRegardless()
        self.panel = panel

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            guard current == generation else { return }
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; panel.animator().alphaValue = 0 }) {
                MainActor.assumeIsolated { if current == generation { panel.orderOut(nil) } }
            }
        }
    }
}
