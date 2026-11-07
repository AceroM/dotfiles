import Carbon

/// A global shortcut through Carbon's RegisterEventHotKey, which needs no
/// Accessibility permission (an event tap would). One handler serves the app
/// and dispatches by hot key id.
final class HotKey {
  private static var registry: [UInt32: HotKey] = [:]
  private static var handlerInstalled = false
  private static var nextID: UInt32 = 1

  private let id: UInt32
  private var ref: EventHotKeyRef?
  let action: () -> Void

  init?(keyCode: Int, modifiers: Int, action: @escaping () -> Void) {
    self.action = action
    id = HotKey.nextID
    HotKey.nextID += 1
    HotKey.installHandler()
    let hotKeyID = EventHotKeyID(signature: 0x534E_5054, id: id)  // 'SNPT'
    let status = RegisterEventHotKey(
      UInt32(keyCode), UInt32(modifiers), hotKeyID, GetApplicationEventTarget(), 0, &ref)
    guard status == noErr else { return nil }
    HotKey.registry[id] = self
  }

  deinit {
    if let ref { UnregisterEventHotKey(ref) }
  }

  private static func installHandler() {
    guard !handlerInstalled else { return }
    handlerInstalled = true
    var spec = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, _ in
        var pressed = EventHotKeyID()
        GetEventParameter(
          event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
          nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
        HotKey.registry[pressed.id]?.action()
        return noErr
      }, 1, &spec, nil, nil)
  }
}
