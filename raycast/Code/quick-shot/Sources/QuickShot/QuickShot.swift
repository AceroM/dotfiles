import AppKit

@main
enum QuickShot {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let controller = AppController()
        app.delegate = controller
        withExtendedLifetime(controller) { app.run() }
    }
}
