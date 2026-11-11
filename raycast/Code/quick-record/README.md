# Quick Record

A native Swift menu-bar recorder for macOS 15+, using ScreenCaptureKit and AVAssetWriter. A resident
app makes window and region selection immediate; Raycast only sends a toggle command.

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

The installer also bundles `QuickRecordHAR` (the Chrome native messaging host for demo HARs) and
registers it with every Chromium-family browser it finds. Load the extension once per browser
profile: `chrome://extensions` → Developer mode → **Load unpacked** →
`~/.dotfiles/raycast/Code/quick-record/chrome-extension`. Its manifest key pins the ID to
`fgbibijbopkdcejhjmcpmleamodlfjpj`, which the host manifest allows. The toolbar icon shows
`off` until it reaches the host, and `REC` while it records.

## Record

- **Fn+Q:** with the dotfiles Hammerspoon configuration loaded, toggle recording
  from any app. It opens the same selector and stops the same recording as Raycast.
- **Fn+Shift+Q:** the same toggle, but this recording includes Microphone and
  System Audio (mixed into one track) regardless of the menu toggles
  (`quickrecord://toggle-audio`).
- **Toggle Recording:** hover over a window on any display to highlight it, then
  click to record its visible area. Hold the mouse button and drag to select a
  section instead. Releasing starts recording, without a countdown or another
  click. Run the same command to stop. Clicking empty desktop does nothing.
  Window selection records fixed display bounds; moving the window does not move
  the capture, and overlapping windows remain visible in the recording.
- **Record Last Region:** record your previous box immediately. Run again to stop.
  If that display is disconnected or the box no longer fits, select a new region.
- Hold **Shift** while dragging for a square, or **Option** for 16:9 (9:16 when you
  drag taller than wide). Pressing or releasing the key mid-drag reshapes the box in
  place. Sizes snap to exact multiples of the ratio, so a 16:9 box encodes at exactly
  16:9; the size label shows the lock.
- **F** while selecting records the whole display under the pointer.
- The selector opens with your last region pre-selected (dimmed around it, dashed
  while you hover a window). Press **Return** to record it; click or drag to pick
  something else.
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

## Demo mode

**Fn+Option+Q** (`quickrecord://toggle-demo`, or **Record Demo** in the menu) records a
demo: pick a window or region the same way, and recording starts with three additions.

- **Annotations, Excalidraw style.** A toolbar appears above the region (drag it by its grip).
  Its tools carry Excalidraw's keys: **1/V** Interact, **2/R** rectangle, **3/D** diamond,
  **4/O** ellipse, **5/A** arrow, **6/L** line, **7/P** draw, **8/T** text, **0/E** eraser,
  **K** laser pointer (a fading trail that never stays on the drawing). The second row is the
  properties panel: stroke colour, background, fill (hachure, cross-hatch, solid), width,
  dashed or dotted lines, and sloppiness (architect, artist, cartoonist). Text has a font
  (hand, normal, code) and size. Hold **Shift** for squares, circles and 15° lines.
  **⌘Z** / **⇧⌘Z** undo and redo, and **⌘⌫** clears. Style choices persist.
  Everything drawn, including the text caret, is in the recording. The toolbar and the dashed
  border marking the region are not.
- **Interact vs draw.** The demo starts in Interact, where clicks reach the app being recorded
  and the drawings stay on top. Picking any tool makes the region a drawing surface and gives
  the canvas the keyboard, for the shortcuts above and for typing (or dictating) labels.
  **Esc** or **1** goes back to Interact and hands the keyboard back to the app you were in. **Fn+Option+A** (`quickrecord://annotate`) toggles between Interact
  and the last tool from any app.
- **Narration.** The microphone is always on in demo mode. **M** or the mic button opens a text
  label at the pointer and starts Wispr Flow hands-free dictation
  (`wispr-flow://start-hands-free`). Press it again to stop, and Wispr types the transcript
  into the label. The label stays open, waiting for the text, until it arrives. You can also
  dictate into any open label with Wispr's own shortcut. `quickrecord://dictate` does the same
  from outside.
- **A HAR from Chrome.** When the extension is loaded, it saves `Demo … .har` beside
  `Demo … .mp4`. The toolbar's HAR dot turns green once Chrome confirms it is recording.
- **A timeline of the drawings.** `Demo … .excalidraw` beside the video records every annotation
  with when it appeared and when it went away, plus every laser stroke (see below). The saved
  panel's **Copy Files** puts the video, the drawings and the HAR on the clipboard together.

Stop with Fn+Option+Q again, the toolbar's stop button, or any other stop command.

### The drawings timeline

The point of the three files is to hand an agent a bug report it can act on: the video (with the
narration), what was pointed at and written on it, and the network traffic, all on one clock. `t`
everywhere is seconds from the video's first frame; HAR entries carry the same value in `_videoTime`.

`Demo … .excalidraw` is a real Excalidraw file: open it in Excalidraw to see the drawing as it stood
when the recording stopped. Its extra `quickRecord` key, which comes first, is for agents:

```json
"quickRecord": {
  "video": "Demo 2026-11-11 15.49.15 ABC123.mp4", "har": "Demo 2026-11-11 15.49.15 ABC123.har",
  "recordingStartedDateTime": "2026-11-11T20:49:15.112Z", "duration": 42.6, "width": 2880, "height": 1800,
  "timeline": [
    {"t": 12.41, "time": "…", "event": "add", "type": "ellipse", "cause": "draw", "id": "…", "color": "#e03131", "bounds": [880,410,520,140], "startedAt": 11.9},
    {"t": 15.02, "time": "…", "event": "add", "type": "text", "cause": "label", "text": "Total should be $40", "bounds": […]},
    {"t": 19.3, "time": "…", "event": "laser", "type": "laser", "bounds": […], "points": [[x, y, t], …], "until": 20.1},
    {"t": 23.7, "time": "…", "event": "remove", "type": "ellipse", "cause": "erase", "id": "…"}
  ]
}
```

- **Coordinates are video pixels** from the frame's top-left corner, so a `bounds` box crops straight
  out of a frame (`ffmpeg -ss 12.41 -i Demo….mp4 -frames:v 1 frame.png`). Arrows and lines also give
  their two ends in `points`, tail first.
- **`add` / `remove`** say when an annotation appeared and went away. `cause` says why: `draw`,
  `label` (a new text label; dictated ones too), `edit` (a label's text changed, which removes the
  old version and adds a new one with `-v2` on its id), `erase`, `undo`, `redo`, `clear`.
  `startedAt` is when the pointer went down or the label opened, if that was noticeably earlier.
- **`laser`** strokes never stay on the drawing, but they're the clearest "look here" there is, so
  they're kept with a point per video frame.
- **`elements`** is the Excalidraw scene. Annotations removed before the stop are kept with
  `isDeleted: true`. Each element's `customData.shown` lists its stretches on screen in video
  seconds (`to: null` means it stayed to the end).

The file is written once the video is saved and the overlay has closed, so a label still waiting
on Wispr's transcript at the stop makes it in. A demo with nothing drawn and no laser strokes
writes no file.

### The HAR

The HAR covers the tabs that were on camera: the active tab of every Chrome window that
overlapped the recorded region at some point during the recording, together with all of that
tab's traffic while the recording ran. Background tabs and extension traffic are left out. It
has every request's URL, method, status, request and response headers (cookies included),
request bodies, redirects, errors and total time. Response bodies come from the pages'
own `fetch`/`XMLHttpRequest` calls (text, JSON, XML, GraphQL; up to 1 MB each), so API
responses are there, but documents, scripts and images have headers only. Timings are coarse:
wait and receive only, no DNS/connect/SSL breakdown. `log._recordingStartedDateTime` is the video's
first frame, and each entry's `_videoTime` is how many seconds into the video it started, the same
`t` as the drawings timeline.

It doesn't use `chrome.debugger`, which would give full DevTools fidelity, because that puts
Chrome's "started debugging this browser" bar on screen, and in the recording.

Plumbing: Quick Record posts `com.acerom.quickrecord.har.command` (start/stop, with the HAR path
and region) as a distributed notification. `QuickRecordHAR`, which Chrome keeps running while
the extension is connected, relays it over native messaging. The extension streams the HAR back
in chunks, and the host writes it, only as a new `.har` directly inside `~/Movies/Quick Record`,
then answers with `com.acerom.quickrecord.har.event`. Host log:
`~/Library/Application Support/Quick Record/har-host.log`.

## Permissions

On first recording, macOS requires **Screen & System Audio Recording** permission
for Quick Record. Enable it in System Settings → Privacy & Security. Follow any
macOS quit/reopen prompt, then run the command again. Microphone permission is
requested only if you turn it on or start a demo. Denied permission produces an explanation.

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
`quickrecord://last`, `quickrecord://toggle-demo`, `quickrecord://annotate`, `quickrecord://dictate`
and `quickrecord://stop` URLs. `quickrecord://quit` only exits
when idle, for safe reinstalls. A second toggle during capture startup queues a
stop, and a new recording cannot start while the previous MP4 is finalizing.
The writer repeats the final frame at stop time so pauses on static screens are
preserved. When both audio sources are enabled, they are mixed into one AAC track
without reencoding the video.

Local diagnostics are in
`~/Library/Application Support/Quick Record/status.json`, including state, the
last successful file, the last error, and release-to-record latency. Additional
events use the macOS log subsystem `com.acerom.quickrecord`.

Tests cover window hover ordering, click-versus-drag selection, ratio-locked drags, display clipping,
saved-region validation, display bounds changes, Retina dimensions,
encoder size limits, the annotation geometry (seeded sloppiness, Shift constraints,
arrowheads, eraser hit-testing, fills, shortcuts, persisted style), and the drawings timeline
(a canvas driven with mouse events: draw, erase, undo/redo, clear, label edits, laser, the
Excalidraw file). Verify the real selection/start/stop flow and the resulting
MP4 after granting screen permission; pure geometry tests cannot verify macOS
capture or audio behavior.
