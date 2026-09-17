import AppKit
import SwiftUI

// Zed One Dark — the values `sn` uses in the terminal, so the two read as one
// tool.
enum Palette {
  static let accent = Color(hex: 0x74ADE8)
  static let danger = Color(hex: 0xE06C75)
  static let selection = Color(hex: 0x3A4B5F)
  static let text = Color(hex: 0xDCE0E5)
  static let dim = Color(hex: 0x8B93A0)
  // The trim on the box he dances on.
  static let sakura = Color(hex: 0xFF8AD8)
  static let lavender = Color(hex: 0xA78BFA)
  static let sky = Color(hex: 0x7DD3FC)
  static let card = Color(red: 0.15, green: 0.12, blue: 0.18)  // the lifted row: solid, nothing ghosts through
  static let badge = NSColor(red: 0xFF / 255, green: 0x8A / 255, blue: 0xD8 / 255, alpha: 1)
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }
}
