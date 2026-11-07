import Carbon.HIToolbox

/// Carbon hotkeys are system-wide and need no Accessibility permission.
@MainActor
final class HotKeys {
    struct Binding {
        let keyCode: Int
        let modifiers: Int
        let action: () -> Void
    }

    private var bindings: [UInt32: Binding] = [:]
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var handler: EventHandlerRef?

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            var hotKeyID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            guard let userData else { return OSStatus(eventNotHandledErr) }
            let hotKeys = Unmanaged<HotKeys>.fromOpaque(userData).takeUnretainedValue()
            MainActor.assumeIsolated { hotKeys.bindings[hotKeyID.id]?.action() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    func add(_ id: UInt32, keyCode: Int, modifiers: Int, action: @escaping () -> Void) {
        bindings[id] = Binding(keyCode: keyCode, modifiers: modifiers, action: action)
    }

    /// Registers any binding not yet held. Another app (e.g. Shottr) owning the combo makes it fail.
    @discardableResult
    func registerMissing() -> [UInt32] {
        for (id, binding) in bindings where refs[id] == nil {
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(UInt32(binding.keyCode), UInt32(binding.modifiers),
                                             EventHotKeyID(signature: OSType(0x5153_4854), id: id),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs[id] = ref }
        }
        return bindings.keys.filter { refs[$0] == nil }.sorted()
    }
}
