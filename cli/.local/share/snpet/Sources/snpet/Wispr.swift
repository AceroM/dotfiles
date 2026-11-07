import AppKit

/// Wispr Flow's hands-free mode, driven through the URL scheme its bundle
/// registers (`strings app.asar` lists start-hands-free, stop-hands-free, open,
/// switch-mic). Hands-free listens until told to stop, then types the
/// transcript into whatever text field has focus — so the reply box takes focus
/// before it starts, and the URL is opened without activating Wispr, or the
/// transcript would land in the wrong app.
enum Wispr {
  static let bundleID = "com.electron.wispr-flow"

  static var isInstalled: Bool {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
  }

  static func startHandsFree() { open("start-hands-free") }
  static func stopHandsFree() { open("stop-hands-free") }

  private static func open(_ route: String) {
    guard let url = URL(string: "wispr-flow://\(route)") else { return }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    NSWorkspace.shared.open(url, configuration: config) { _, error in
      if let error { NSLog("snpet: wispr-flow://\(route) — \(error.localizedDescription)") }
    }
  }
}
