#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DOTFILES_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

ASSUME_YES=0
DRY_RUN=0
SKIP_AUTH=0
RUN_SMOKE=0
ONLY=""

FAILED_PHASES=()
EXPECTED_TOOLS=(git stow gh fnm node npm bun codex claude wrangler psql rg tmux zsh)

usage() {
  cat <<'EOF'
Usage: ./vps/setup.sh [options]

Options:
  -y, --yes          Accept default yes prompts.
  -n, --dry-run      Print commands without running them.
      --only PHASE   Run one phase: packages, gh, node, bun, ai, wrangler, npm, stow, auth, verify.
      --skip-auth    Skip gh/Codex/Claude login checks.
      --smoke-test   Run optional Codex/Claude smoke tests. May consume quota.
  -h, --help         Show this help.
EOF
}

while (($#)); do
  case "$1" in
    -y|--yes)
      ASSUME_YES=1
      ;;
    -n|--dry-run)
      DRY_RUN=1
      ;;
    --skip-auth)
      SKIP_AUTH=1
      ;;
    --smoke-test)
      RUN_SMOKE=1
      ;;
    --only)
      shift
      [[ $# -gt 0 ]] || { usage; exit 2; }
      ONLY="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'warn: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

quote_cmd() {
  printf '%q ' "$@"
}

run_cmd() {
  if ((DRY_RUN)); then
    printf '+ '
    quote_cmd "$@"
    printf '\n'
  else
    "$@"
  fi
}

run_shell() {
  local cmd="$1"
  if ((DRY_RUN)); then
    printf '+ %s\n' "$cmd"
  else
    bash -c "$cmd"
  fi
}

as_root() {
  if ((EUID == 0)); then
    run_cmd "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "sudo is required when not running as root"
    run_cmd sudo "$@"
  fi
}

write_root_file() {
  local path="$1"
  local content="$2"

  if ((DRY_RUN)); then
    printf '+ write %s\n' "$path"
    printf '%s\n' "$content"
  elif ((EUID == 0)); then
    printf '%s\n' "$content" > "$path"
  else
    printf '%s\n' "$content" | sudo tee "$path" >/dev/null
  fi
}

confirm() {
  local prompt="$1"
  local default="${2:-y}"
  local reply suffix

  if ((ASSUME_YES)); then
    [[ "$default" == "y" ]]
    return
  fi

  if [[ "$default" == "y" ]]; then
    suffix='[Y/n]'
  else
    suffix='[y/N]'
  fi

  if [[ ! -t 0 ]]; then
    [[ "$default" == "y" ]]
    return
  fi

  read -r -p "$prompt $suffix " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

phase_enabled() {
  local phase="$1"
  [[ -z "$ONLY" || "$ONLY" == "$phase" ]]
}

# Run one phase without letting a failure (or a `die`) abort the whole bootstrap.
# The phase runs in a subshell so its exit/`set -e` stays contained; installs
# persist to disk, and each phase re-derives its own PATH, so isolation is safe.
# We drop parent errexit around the call and re-enable it inside the subshell so
# the phase still stops at its first failing command and reports as failed.
run_phase() {
  local phase="$1" fn="$2" rc
  phase_enabled "$phase" || return 0

  set +e
  ( set -e; "$fn" )
  rc=$?
  set -e

  ((rc == 0)) && return 0

  warn "phase '$phase' did not complete successfully; continuing"
  FAILED_PHASES+=("$phase")
}

read_manifest() {
  local file="$1"
  local -n out="$2"
  out=()

  [[ -f "$file" ]] || return 0
  while IFS= read -r item; do
    out+=("$item")
  done < <(sed -E 's/[[:space:]]*#.*$//; /^[[:space:]]*$/d' "$file")
}

ensure_linux() {
  [[ "$(uname -s)" == "Linux" ]] || die "this bootstrap is intended for Linux VPS hosts"
}

install_system_packages() {
  local packages=()

  if command -v apt-get >/dev/null 2>&1; then
    read_manifest "$SCRIPT_DIR/packages/apt.txt" packages
    ((${#packages[@]})) || return 0
    log "Installing apt packages"
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    read_manifest "$SCRIPT_DIR/packages/dnf.txt" packages
    ((${#packages[@]})) || return 0
    log "Installing dnf packages"
    as_root dnf install -y "${packages[@]}"
  else
    warn "unsupported package manager; install packages from vps/packages manually"
  fi
}

install_gh_apt() {
  local arch list_content tmp_key

  log "Installing GitHub CLI from the official apt repository"
  as_root mkdir -p -m 755 /etc/apt/keyrings
  tmp_key="$(mktemp)"
  run_cmd wget -nv -O "$tmp_key" https://cli.github.com/packages/githubcli-archive-keyring.gpg
  as_root install -m 0644 "$tmp_key" /etc/apt/keyrings/githubcli-archive-keyring.gpg
  run_cmd rm -f "$tmp_key"

  as_root mkdir -p -m 755 /etc/apt/sources.list.d
  arch="$(dpkg --print-architecture)"
  list_content="deb [arch=$arch signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"
  write_root_file /etc/apt/sources.list.d/github-cli.list "$list_content"

  as_root apt-get update
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y gh
}

install_gh_dnf() {
  log "Installing GitHub CLI from the official rpm repository"
  if dnf --version | head -n 1 | grep -q '^5'; then
    as_root dnf install -y dnf5-plugins
    as_root dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo
  else
    as_root dnf install -y 'dnf-command(config-manager)'
    as_root dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
  fi
  as_root dnf install -y gh
}

install_gh_yum() {
  log "Installing GitHub CLI from the official yum repository"
  if ! command -v yum-config-manager >/dev/null 2>&1; then
    as_root yum install -y yum-utils
  fi
  as_root yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
  as_root yum install -y gh
}

ensure_gh() {
  if command -v gh >/dev/null 2>&1; then
    log "GitHub CLI already installed: $(gh --version | head -n 1)"
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    install_gh_apt
  elif command -v dnf >/dev/null 2>&1; then
    install_gh_dnf
  elif command -v yum >/dev/null 2>&1; then
    install_gh_yum
  elif command -v apk >/dev/null 2>&1; then
    log "Installing GitHub CLI from Alpine packages"
    as_root apk add github-cli
  elif command -v pacman >/dev/null 2>&1; then
    log "Installing GitHub CLI from Arch packages"
    as_root pacman -S --needed github-cli
  else
    warn "could not install gh automatically on this distribution"
  fi
}

add_user_bin_paths() {
  export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
}

add_fnm_to_path() {
  export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/fnm:$HOME/.fnm:$PATH"
}

load_fnm_env() {
  add_fnm_to_path
  command -v fnm >/dev/null 2>&1 || return 1
  eval "$(fnm env --use-on-cd --shell bash)"
}

load_tool_paths() {
  add_user_bin_paths
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  load_fnm_env || true
}

ensure_node() {
  add_user_bin_paths
  add_fnm_to_path

  if ! command -v fnm >/dev/null 2>&1; then
    log "Installing fnm"
    run_shell 'curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell'
  fi

  load_fnm_env || die "fnm was installed but is not available on PATH"

  log "Installing latest Node.js LTS through fnm"
  run_cmd fnm install --lts --use

  if ! ((DRY_RUN)); then
    local current_node
    current_node="$(fnm current)"
    if [[ -n "$current_node" && "$current_node" != "none" ]]; then
      run_cmd fnm default "$current_node"
    fi
    run_cmd node --version
    run_cmd npm --version
  fi
}

ensure_bun() {
  add_user_bin_paths
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun >/dev/null 2>&1; then
    log "Bun already installed: $(bun --version)"
    return 0
  fi

  log "Installing Bun"
  run_shell 'curl -fsSL https://bun.com/install | bash'
  export PATH="$HOME/.bun/bin:$PATH"
}

ensure_codex() {
  add_user_bin_paths
  if command -v codex >/dev/null 2>&1; then
    log "Codex already installed: $(codex --version 2>/dev/null || printf installed)"
    return 0
  fi

  log "Installing Codex CLI"
  run_shell 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
}

ensure_claude() {
  add_user_bin_paths
  if command -v claude >/dev/null 2>&1; then
    log "Claude Code already installed: $(claude --version 2>/dev/null || printf installed)"
    return 0
  fi

  log "Installing Claude Code"
  run_shell 'curl -fsSL https://claude.ai/install.sh | bash'
}

ensure_ai_clis() {
  ensure_codex
  ensure_claude
}

ensure_wrangler() {
  add_user_bin_paths
  load_fnm_env || true

  if command -v wrangler >/dev/null 2>&1; then
    log "Wrangler already installed: $(wrangler --version 2>/dev/null | head -n 1 || printf installed)"
    return 0
  fi

  if ! ((DRY_RUN)); then
    command -v npm >/dev/null 2>&1 || die "npm is not available; run ./vps/setup.sh --only node first"
  fi

  log "Installing Wrangler"
  run_cmd npm install -g wrangler
}

install_npm_globals() {
  local packages=()

  load_fnm_env || true
  if ! ((DRY_RUN)); then
    command -v npm >/dev/null 2>&1 || die "npm is not available; run ./vps/setup.sh --only node first"
  fi

  read_manifest "$SCRIPT_DIR/npm-global.txt" packages
  if ((${#packages[@]} == 0)); then
    log "No npm globals listed in vps/npm-global.txt"
    return 0
  fi

  log "Installing npm globals"
  run_cmd npm install -g "${packages[@]}"
}

run_stow() {
  local packages=()

  command -v stow >/dev/null 2>&1 || die "stow is not installed"
  read_manifest "$SCRIPT_DIR/stow.txt" packages
  if ((${#packages[@]} == 0)); then
    log "No stow packages listed in vps/stow.txt"
    return 0
  fi

  log "Stowing selected dotfile packages"
  (
    cd "$DOTFILES_ROOT"
    for package in "${packages[@]}"; do
      if [[ -d "$package" ]]; then
        run_cmd stow -v -t "$HOME" "$package"
      else
        warn "stow package not found: $package"
      fi
    done
  )
}

gh_auth_gate() {
  command -v gh >/dev/null 2>&1 || {
    warn "gh is not installed; skipping GitHub auth"
    return 0
  }

  if gh auth status >/dev/null 2>&1; then
    log "GitHub CLI is authenticated"
  elif confirm "Run gh auth login now?" y; then
    run_cmd gh auth login
  else
    warn "GitHub CLI is not authenticated"
  fi
}

codex_auth_gate() {
  command -v codex >/dev/null 2>&1 || {
    warn "codex is not installed; skipping Codex auth"
    return 0
  }

  if [[ -n "${CODEX_ACCESS_TOKEN:-}" || -f "$HOME/.codex/auth.json" ]]; then
    log "Codex has local credentials or CODEX_ACCESS_TOKEN"
  else
    warn "Codex subscription access uses ChatGPT login; API-key auth uses API billing instead."
    if confirm "Run codex login --device-auth now?" y; then
      run_cmd codex login --device-auth
    else
      warn "Codex is not authenticated"
    fi
  fi

  if confirm "Run codex doctor for install/auth diagnostics?" y; then
    run_cmd codex doctor || warn "codex doctor reported an issue"
  fi
}

claude_auth_gate() {
  command -v claude >/dev/null 2>&1 || {
    warn "claude is not installed; skipping Claude auth"
    return 0
  }

  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY is set and may take precedence over Claude subscription login."
  fi

  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" || -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]]; then
    log "Claude Code has local credentials or CLAUDE_CODE_OAUTH_TOKEN"
  else
    warn "Claude Code requires Pro, Max, Team, Enterprise, or Console access; the free Claude.ai plan is not enough."
    if confirm "Run claude now to complete login? Exit Claude to return to setup." y; then
      run_cmd claude
    else
      warn "Claude Code is not authenticated"
    fi
  fi

  if confirm "Run claude doctor for install/auth diagnostics?" y; then
    run_cmd claude doctor || warn "claude doctor reported an issue"
  fi
}

run_smoke_tests() {
  if ! ((RUN_SMOKE)); then
    confirm "Run optional Codex/Claude smoke tests? This may consume quota." n || return 0
  fi

  if command -v codex >/dev/null 2>&1; then
    log "Running Codex smoke test"
    run_cmd codex exec "Reply exactly: codex-ok"
  fi

  if command -v claude >/dev/null 2>&1; then
    log "Running Claude smoke test"
    run_cmd claude -p "Reply exactly: claude-ok"
  fi
}

auth_gates() {
  ((SKIP_AUTH)) && {
    log "Skipping auth checks"
    return 0
  }

  gh_auth_gate
  codex_auth_gate
  claude_auth_gate
  run_smoke_tests
}

verify_install() {
  local cmd
  load_tool_paths
  log "Version checks"
  for cmd in "${EXPECTED_TOOLS[@]}"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf '%-9s %s\n' "$cmd" "$($cmd --version 2>/dev/null | head -n 1 || printf installed)"
    else
      printf '%-9s missing\n' "$cmd"
    fi
  done
}

# Final sanity check: report any phase that errored and any expected tool that is
# not on PATH. Returns non-zero when something is wrong so the exit code is usable.
report_results() {
  local -a issues=()

  log "Setup summary"

  if ((${#FAILED_PHASES[@]})); then
    printf 'phases with errors: %s\n' "${FAILED_PHASES[*]}"
    issues+=("${FAILED_PHASES[@]}")
  fi

  if ((DRY_RUN)); then
    printf 'dry-run: skipped installed-tool checks\n'
  elif [[ -n "$ONLY" ]]; then
    printf 'ran single phase "%s"; skipping full tool check\n' "$ONLY"
  else
    load_tool_paths
    local -a missing=()
    local cmd
    for cmd in "${EXPECTED_TOOLS[@]}"; do
      command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    if ((${#missing[@]})); then
      printf 'tools not found on PATH: %s\n' "${missing[*]}"
      issues+=("${missing[@]}")
    else
      printf 'all expected tools are installed\n'
    fi
  fi

  ((${#issues[@]} == 0))
}

main() {
  ensure_linux
  add_user_bin_paths

  run_phase packages install_system_packages
  run_phase gh ensure_gh
  run_phase node ensure_node
  run_phase bun ensure_bun
  run_phase ai ensure_ai_clis
  run_phase wrangler ensure_wrangler
  run_phase npm install_npm_globals
  run_phase stow run_stow
  run_phase auth auth_gates
  run_phase verify verify_install

  if report_results; then
    log "VPS bootstrap complete"
  else
    warn "VPS bootstrap finished with issues (see summary above)"
    return 1
  fi
}

main "$@"
