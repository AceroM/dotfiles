# VPS Bootstrap

Bootstrap a fresh Linux VPS from this dotfiles repo.

```sh
git clone https://github.com/miguelacero/.dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./vps/setup.sh
```

The setup is intentionally interactive. It installs system packages, GitHub CLI,
Node/npm through `fnm`, Bun, Codex, Claude Code, Wrangler, npm globals, selected
stow packages, then walks through account login checks.

A failing phase no longer aborts the whole run: each phase is isolated, and the
script ends with a summary reporting any phase that errored and any expected tool
that is missing from `PATH` (exiting non-zero if so). Re-running on a fully
provisioned host therefore doubles as a sanity check.

Useful flags:

```sh
./vps/setup.sh --dry-run
./vps/setup.sh --yes
./vps/setup.sh --only auth
./vps/setup.sh --only npm
./vps/setup.sh --skip-auth
./vps/setup.sh --smoke-test
```

## Editable Lists

- `packages/apt.txt`: Debian/Ubuntu packages.
- `packages/dnf.txt`: Fedora/RHEL packages.
- `npm-global.txt`: npm global packages, one per line.
- `stow.txt`: dotfile packages to stow into `$HOME`.

Blank lines and `#` comments are ignored.

## Auth Gates

The script checks for installed CLIs and cached credentials, then offers the
login flows:

- `gh auth login`
- `codex login --device-auth`
- `claude`
- `wrangler`

Codex subscription access requires signing in with a ChatGPT plan account.
Claude Code requires a Claude Pro, Max, Team, Enterprise, or Console account;
the free Claude.ai plan does not include Claude Code access.

Optional smoke tests may consume model quota, so they only run with
`--smoke-test` or if you opt in interactively.
