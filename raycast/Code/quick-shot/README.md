# Quick Shot

A native Swift menu-bar screenshot tool for macOS 15+, replacing Shottr's area/window
capture. It uses ScreenCaptureKit and the same selector as Quick Record.

## Install

```sh
~/.dotfiles/raycast/Code/quick-shot/install.sh
```

The installer builds a release app, signs it ad hoc with a stable identity, installs
`~/Applications/Quick Shot.app`, and launches it. Quit Shottr first; it registers the
same shortcuts. Use **Open at Login** in the menu-bar menu to keep the hotkeys available.

## Capture

- **⌘⇧2: Capture Area.** The screen freezes, so menus and hover states stay. Drag an
  area, or click a highlighted window to take its visible area. **F** takes the full
  display under the pointer.
  - Hold **Shift** while dragging for a square, or **Option** for 16:9 (9:16 when you drag
    taller than wide). Pressing or releasing the key mid-drag reshapes the box in place;
    sizes snap to exact multiples of the ratio, and the size label shows the lock.
  - **Return** takes the same area as the last shot again, for before/after pairs. It's
    drawn as a dashed outline until you start dragging. The area is remembered across
    relaunches; only shots that open the editor set it, so a Copy Text in between doesn't move it.
- **⌘⇧1: Capture Active Window.** Instantly captures the frontmost app's front window, whole
  even where it's covered, and opens the editor. Falls back to the full screen when the app
  has no window.
- **⌘⇧3: Capture Full Screen.** Instantly captures the display under the pointer and
  opens the editor, no selection step. Turn off macOS's own ⌘⇧3 under System Settings →
  Keyboard → Keyboard Shortcuts → Screenshots, or it keeps the combo.
- **⌘⇧0: Copy Text.** The same frozen selector as Capture Area (drag, click a window, or **F**),
  but instead of opening the editor it runs on-device OCR (Vision) and puts the text on the
  clipboard as plain text, one recognized line per line. A brief HUD under the pointer says how
  many lines it copied; when there's no text it says so and leaves the clipboard alone.
- **Capture Last Area** (menu bar or `quickshot://last`): instantly re-captures the last
  area live, with no selector, and opens the editor. Bind it in Raycast for one-key "after" shots.
- **Capture Window** (menu bar or `quickshot://window`): click a window to capture it
  alone, including covered parts, without its shadow.
- Pressing the same shortcut, **Escape**, or a right click cancels a selection.

The shot opens in an editor, as in Shottr:

- **Esc** copies to the clipboard and closes. **⌘W** closes without copying.
- **⌘C** also copies and closes. **⌘S** saves a PNG to `~/Documents` and closes.
- Drag to annotate: **A** draws an arrow (default), **R** draws a box, and **T** types text: click to place it, Return to finish, Option-Return for a new line. Text wraps at the image edge. Clicking text with **T**, or double-clicking it, edits it.
- **J** starts a scrolling capture of the same area (area, full-screen, and active-window shots): the editor hides, and each
  **J** scrolls the app under the area down 100 points and captures it again (**Shift-J** scrolls
  500, or three quarters of the area if it's shorter, so frames still overlap). **Return** stitches the frames,
  matching their overlap and keeping sticky headers and footers once, and opens the tall shot in a new editor.
  **Esc** returns to the original shot. Sending scroll events needs **Accessibility** permission, asked for on
  first use.
- **V** selects: click an annotation to select it, drag to move it, and Delete removes it. **⌘Z** undoes drawing, moves, edits, and deletes.

Output keeps Retina resolution, and the PNG/TIFF DPI is set so pasted images keep their
on-screen size. Hotkeys use Carbon `RegisterEventHotKey`, so only scrolling capture needs
Accessibility permission. The first capture asks for **Screen & System Audio Recording** permission.

`quickshot://area`, `quickshot://full`, `quickshot://app`, `quickshot://last`, `quickshot://window`, `quickshot://text`, and `quickshot://quit` drive the app from
Raycast or Hammerspoon. Logs use the subsystem `com.acerom.quickshot`.

## Development

```sh
cd ~/.dotfiles/raycast/Code/quick-shot
swift test
./install.sh
```
