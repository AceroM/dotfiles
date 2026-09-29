# Quick Record

A native Swift menu-bar recorder for macOS 15+, using ScreenCaptureKit and AVAssetWriter. A resident
app makes region selection immediate; Raycast only sends a toggle command.

## Install

```sh
~/.dotfiles/raycast/Code/quick-record/install.sh
```

Requires Xcode or the Swift command-line tools. The installer builds a release app,
signs it locally, installs `~/Applications/Quick Record.app`, and links two commands
into `~/Code/extensions` (the existing Raycast Script Commands directory). It leaves
unrelated files alone and refuses to replace the app during a recording.

If Raycast doesn't discover them, add `~/Code/extensions` in Raycast Settings →
Extensions → Script Commands. Assign a hotkey to **Toggle Recording** there.

## Record

- **Fn+Q:** with the dotfiles Hammerspoon configuration loaded, toggle recording
  from any app. It opens the same selector and stops the same recording as Raycast.
- **Toggle Recording:** drag a box on any display. Releasing the mouse starts
  recording, without a countdown or another click. Run the same command to stop.
- **Record Last Region:** record your previous box immediately. Run again to stop.
  If that display is disconnected or the box no longer fits, select a new region.
- **Escape**, right click, or the toggle command cancels an unfinished selection.
- The menu-bar icon turns red and shows a timer while recording. Its menu also
  provides a stop action and optional **Microphone** and **System Audio** toggles.
  Both audio sources default to off and settings persist.
- Files save automatically to `~/Movies/Quick Record` as H.264 MP4, at 30 fps,
  retaining Retina resolution up to 3840 × 2160. The cursor is included; the app's
  own UI is excluded. Each selection is confined to one display.
- A small saved panel offers **Copy File** and **Reveal in Finder**. These actions
  also remain in the menu after the panel dismisses. Copy File puts the actual file
  on the clipboard, suitable for pasting into another app.

On first recording, macOS requires **Screen & System Audio Recording** permission
for Quick Record. Enable it in System Settings → Privacy & Security. Follow any
macOS quit/reopen prompt, then run the command again. Microphone permission is
requested only if you turn it on. Denied permission produces an explanation.

The app stays resident after the first launch; no frames are captured until a
region is selected. It has no network dependencies. Add it to macOS Login Items
if you want it ready from login; otherwise the first Raycast command launches it.
The installer does not change your startup allowlist.

## Development

```sh
cd ~/.dotfiles/raycast/Code/quick-record
swift test
./install.sh
```

The local build uses ad-hoc signing with a stable bundle identifier and designated
requirement. macOS may still require reauthorization after a rebuild. For a signed
distribution, set `QUICK_RECORD_SIGN_IDENTITY` to your signing identity. Store
distribution/notarization is not part of this local installation.

Commands are delivered via the registered `quickrecord://toggle`,
`quickrecord://last`, and `quickrecord://stop` URLs. `quickrecord://quit` only exits
when idle, for safe reinstalls. A second toggle during capture startup queues a
stop, and a new recording cannot start while the previous MP4 is finalizing.
The writer repeats the final frame at stop time so pauses on static screens are
preserved. When both audio sources are enabled, they are mixed into one AAC track
without reencoding the video.

Local diagnostics are in
`~/Library/Application Support/Quick Record/status.json`, including state, the
last successful file, the last error, and release-to-record latency. Additional
events use the macOS log subsystem `com.acerom.quickrecord`.

Tests cover saved-region validation, display bounds changes, Retina dimensions,
and encoder size limits. Verify the real selection/start/stop flow and the resulting
MP4 after granting screen permission; pure geometry tests cannot verify macOS
capture or audio behavior.
