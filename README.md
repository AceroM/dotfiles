# Dotfiles

These are my dotfiles.

## Usage

In the root directory run [stow](https://www.gnu.org/software/stow/) against the desired dotfile directory.

i.e: if I wanted to copy my neovim configuration
```
stow nvim
```

For a fresh Linux VPS, run the interactive bootstrap:

```
./vps/setup.sh
```

## Structure

```
.
└── zsh # my zsh configuration
└── pi # my pi-agent configuration
└── vps # Linux VPS bootstrap
```

## Troubleshooting

### Raycast `option + [number]` types `¡™£` instead of switching apps

macOS "Secure Input" is stuck on, which disables global hotkeys system-wide
(Raycast, Alfred, etc.), so `option + [number]` falls through to the default
character layer.

Check who's holding it:

```
ioreg -l -w 0 | grep -o '"kCGSSessionSecureInputPID"=[0-9]*'
ps -p <pid>   # identify the process
```

In my case it's Ghostty — its automatic Secure Keyboard Entry (password prompt
detection) gets stuck and isn't released, even after quitting Ghostty (the flag
can keep pointing at the dead PID).

Fix, in order:

1. Quit the app holding Secure Input (tmux sessions survive a Ghostty restart,
   just `tmux attach` after).
2. If the flag is still set (even with a dead PID): lock the screen
   (`ctrl + cmd + q`) and unlock — this resets it.
3. Worst case: log out/in or reboot.

Verify it's cleared — this should print nothing:

```
ioreg -l -w 0 | grep kCGSSessionSecureInputPID
```
