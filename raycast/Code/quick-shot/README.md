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
- **⌘⇧1: Capture Window.** Click a window to capture it alone, including covered parts,
  without its shadow.
- Pressing the same shortcut, **Escape**, or a right click cancels a selection.

The shot opens in an editor, as in Shottr:

- **Esc** copies to the clipboard and closes. **⌘W** closes without copying.
- **⌘C** also copies and closes. **⌘S** saves a PNG to `~/Documents`.
- Drag to annotate: **A** draws an arrow (default), **R** draws a box, and **⌘Z** undoes.

Output keeps Retina resolution, and the PNG/TIFF DPI is set so pasted images keep their
on-screen size. Hotkeys use Carbon `RegisterEventHotKey`, so no Accessibility permission
is required. The first capture asks for **Screen & System Audio Recording** permission.

`quickshot://area`, `quickshot://window`, and `quickshot://quit` drive the app from
Raycast or Hammerspoon. Logs use the subsystem `com.acerom.quickshot`.

## Development

```sh
cd ~/.dotfiles/raycast/Code/quick-shot
swift test
./install.sh
```
