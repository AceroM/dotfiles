function _cxs_usage() {
  cat <<'EOF'
usage: cxs [options] [path ...]

Sync repo-local Claude and Codex extension files without symlinks.

By default cxs syncs these portable subtrees when they exist on either side:
  skills commands agents hooks rules scripts

Examples:
  cxs
  cxs skills commands
  cxs .claude/skills/ui
  cxs --root ~/src/my-repo --prefer newer
  cxs --dry-run --all

Options:
  --root DIR        repo root to sync; defaults to the current git root or $PWD
  --all            sync all top-level .claude/.codex entries except volatile ones
  --prefer SIDE    resolve conflicts automatically: claude, codex, newer, older
  -n, --dry-run    show what would change
  -y, --yes        do not prompt; conflicts are skipped unless --prefer is set
  -h, --help       show this help

Conflict prompt:
  c  keep .claude version and copy it into .codex
  x  keep .codex version and copy it into .claude
  d  show diff
  s  skip this path
  q  quit
EOF
}

function _cxs_repo_root() {
  local root
  if root="$(command git rev-parse --show-toplevel 2>/dev/null)"; then
    print -r -- "$root"
  else
    print -r -- "$PWD"
  fi
}

function _cxs_exists() {
  [[ -e "$1" || -L "$1" ]]
}

function _cxs_kind() {
  local target="$1"
  if [[ -L "$target" ]]; then
    if [[ -d "$target" ]]; then
      print -r -- "symlink-dir"
    elif [[ -f "$target" ]]; then
      print -r -- "symlink-file"
    else
      print -r -- "symlink"
    fi
  elif [[ -d "$target" ]]; then
    print -r -- "dir"
  elif [[ -f "$target" ]]; then
    print -r -- "file"
  elif _cxs_exists "$target"; then
    print -r -- "other"
  else
    print -r -- "missing"
  fi
}

function _cxs_stat_line() {
  local target="$1"
  local kind="$(_cxs_kind "$target")"
  local mtime size

  if mtime="$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$target" 2>/dev/null)"; then
    size="$(stat -f "%z" "$target" 2>/dev/null)"
  elif mtime="$(stat -c "%y" "$target" 2>/dev/null)"; then
    mtime="${mtime%%.*}"
    size="$(stat -c "%s" "$target" 2>/dev/null)"
  else
    mtime="unknown"
    size="unknown"
  fi

  print -r -- "$kind, ${size} bytes, modified $mtime"
}

function _cxs_clean_rel() {
  local rel="$1"
  rel="${rel#./}"
  rel="${rel#.claude/}"
  rel="${rel#.codex/}"
  rel="${rel%/}"

  if [[ -z "$rel" || "$rel" == "." ]]; then
    return 1
  fi

  if [[ "$rel" == /* || "$rel" == ".." || "$rel" == ../* || "$rel" == */.. || "$rel" == */../* ]]; then
    print -u2 -r -- "cxs: refusing unsafe path: $1"
    return 1
  fi

  print -r -- "$rel"
}

function _cxs_looks_like_root_arg() {
  local target="$1"

  [[ -d "$target" ]] || return 1
  [[ "$target" == "." || "$target" == ".." || "$target" == /* ]] && return 0
  [[ -d "$target/.git" || -d "$target/.claude" || -d "$target/.codex" ]] && return 0

  return 1
}

function _cxs_copy_path() {
  local src="$1" dst="$2" label="$3"
  local tmp copy_status

  if (( _cxs_dry_run )); then
    print -r -- "would copy $label"
    (( _cxs_copied++ ))
    return 0
  fi

  mkdir -p "${dst:h}" || return 1
  tmp="${dst:h}/.cxs-tmp-${$}-${RANDOM}-${dst:t}"
  rm -rf "$tmp" || return 1

  if [[ -d "$src" ]]; then
    cp -R -p -L "$src" "$tmp"
  else
    cp -p -L "$src" "$tmp"
  fi
  copy_status=$?
  if (( copy_status != 0 )); then
    rm -rf "$tmp"
    return $copy_status
  fi

  if _cxs_exists "$dst"; then
    rm -rf "$dst" || {
      rm -rf "$tmp"
      return 1
    }
  fi

  mv "$tmp" "$dst"
  copy_status=$?
  (( copy_status == 0 )) && (( _cxs_copied++ ))
  (( copy_status != 0 )) && rm -rf "$tmp"
  return $copy_status
}

function _cxs_keep_claude() {
  local rel="$1" claude="$2" codex="$3"

  _cxs_copy_path "$claude" "$codex" ".claude/$rel -> .codex/$rel" || return $?
  if [[ -L "$claude" ]]; then
    print -r -- "materialize chosen symlink: .claude/$rel"
    _cxs_copy_path "$codex" "$claude" ".codex/$rel -> .claude/$rel" || return $?
  fi
}

function _cxs_keep_codex() {
  local rel="$1" claude="$2" codex="$3"

  _cxs_copy_path "$codex" "$claude" ".codex/$rel -> .claude/$rel" || return $?
  if [[ -L "$codex" ]]; then
    print -r -- "materialize chosen symlink: .codex/$rel"
    _cxs_copy_path "$claude" "$codex" ".claude/$rel -> .codex/$rel" || return $?
  fi
}

function _cxs_show_diff() {
  local claude="$1" codex="$2"

  if command -v git >/dev/null 2>&1; then
    command git diff --no-index -- "$claude" "$codex"
  elif [[ -d "$claude" || -d "$codex" ]]; then
    diff -ru "$claude" "$codex"
  else
    diff -u "$claude" "$codex"
  fi
  return 0
}

function _cxs_pick_side() {
  local claude="$1" codex="$2"

  case "$_cxs_prefer" in
    claude|c)
      print -r -- "claude"
      return 0
      ;;
    codex|x)
      print -r -- "codex"
      return 0
      ;;
    newer)
      if [[ "$claude" -nt "$codex" ]]; then
        print -r -- "claude"
      else
        print -r -- "codex"
      fi
      return 0
      ;;
    older)
      if [[ "$claude" -ot "$codex" ]]; then
        print -r -- "claude"
      else
        print -r -- "codex"
      fi
      return 0
      ;;
  esac

  return 1
}

function _cxs_read_choice() {
  local prompt="$1"
  local choice

  printf "%s" "$prompt" >&2
  IFS= read -r choice

  print -r -- "$choice"
}

function _cxs_resolve_conflict() {
  local rel="$1" claude="$2" codex="$3"
  local side choice

  (( _cxs_conflicts++ ))

  if side="$(_cxs_pick_side "$claude" "$codex")"; then
    case "$side" in
      claude)
        print -r -- "keep .claude: $rel"
        _cxs_keep_claude "$rel" "$claude" "$codex"
        return
        ;;
      codex)
        print -r -- "keep .codex: $rel"
        _cxs_keep_codex "$rel" "$claude" "$codex"
        return
        ;;
    esac
  fi

  if (( _cxs_dry_run || _cxs_yes )); then
    print -r -- "conflict skipped: $rel"
    (( _cxs_skipped++ ))
    return 0
  fi

  while true; do
    print -u2 -r -- ""
    print -u2 -r -- "conflict: $rel"
    print -u2 -r -- "  .claude: $(_cxs_stat_line "$claude")"
    print -u2 -r -- "  .codex:  $(_cxs_stat_line "$codex")"
    choice="$(_cxs_read_choice "keep [c]laude, code[x], show [d]iff, [s]kip, [q]uit? ")"

    case "$choice" in
      c|C|claude|Claude)
        _cxs_keep_claude "$rel" "$claude" "$codex"
        return
        ;;
      x|X|codex|Codex)
        _cxs_keep_codex "$rel" "$claude" "$codex"
        return
        ;;
      d|D|diff|Diff)
        _cxs_show_diff "$claude" "$codex"
        ;;
      s|S|skip|Skip|"")
        print -r -- "skip: $rel"
        (( _cxs_skipped++ ))
        return
        ;;
      q|Q|quit|Quit)
        return 130
        ;;
      *)
        print -u2 -r -- "cxs: enter c, x, d, s, or q"
        ;;
    esac
  done
}

function _cxs_child_names() {
  local dir="$1"
  local child

  [[ -d "$dir" ]] || return 0

  for child in "$dir"/*(N) "$dir"/.[!.]*(N) "$dir"/..?*(N); do
    [[ "${child:t}" == ".DS_Store" ]] && continue
    print -r -- "${child:t}"
  done
}

function _cxs_sync_item() {
  local rel="$1"
  local claude="$_cxs_claude_root/$rel"
  local codex="$_cxs_codex_root/$rel"
  local -a names claude_names codex_names
  local name
  local -A seen

  [[ "${rel:t}" == ".DS_Store" ]] && return 0

  if ! _cxs_exists "$claude" && ! _cxs_exists "$codex"; then
    return 0
  fi

  if _cxs_exists "$claude" && ! _cxs_exists "$codex"; then
    print -r -- "copy: .claude/$rel -> .codex/$rel"
    _cxs_copy_path "$claude" "$codex" ".claude/$rel -> .codex/$rel"
    return
  fi

  if ! _cxs_exists "$claude" && _cxs_exists "$codex"; then
    print -r -- "copy: .codex/$rel -> .claude/$rel"
    _cxs_copy_path "$codex" "$claude" ".codex/$rel -> .claude/$rel"
    return
  fi

  if [[ -L "$claude" || -L "$codex" ]]; then
    if [[ -d "$claude" && -d "$codex" ]] && diff -qr "$claude" "$codex" >/dev/null 2>&1; then
      if [[ -L "$claude" && ! -L "$codex" ]]; then
        print -r -- "materialize symlink: .codex/$rel -> .claude/$rel"
        _cxs_copy_path "$codex" "$claude" ".codex/$rel -> .claude/$rel"
      elif [[ -L "$codex" && ! -L "$claude" ]]; then
        print -r -- "materialize symlink: .claude/$rel -> .codex/$rel"
        _cxs_copy_path "$claude" "$codex" ".claude/$rel -> .codex/$rel"
      else
        print -r -- "materialize symlinks: $rel"
        _cxs_keep_claude "$rel" "$claude" "$codex" || return $?
      fi
      return
    elif [[ -f "$claude" && -f "$codex" ]] && cmp -s "$claude" "$codex"; then
      if [[ -L "$claude" && ! -L "$codex" ]]; then
        print -r -- "materialize symlink: .codex/$rel -> .claude/$rel"
        _cxs_copy_path "$codex" "$claude" ".codex/$rel -> .claude/$rel"
      elif [[ -L "$codex" && ! -L "$claude" ]]; then
        print -r -- "materialize symlink: .claude/$rel -> .codex/$rel"
        _cxs_copy_path "$claude" "$codex" ".claude/$rel -> .codex/$rel"
      else
        print -r -- "materialize symlinks: $rel"
        _cxs_keep_claude "$rel" "$claude" "$codex" || return $?
      fi
      return
    else
      _cxs_resolve_conflict "$rel" "$claude" "$codex" || return $?
      return
    fi
  fi

  if [[ -d "$claude" && -d "$codex" ]]; then
    claude_names=("${(@f)$(_cxs_child_names "$claude")}")
    codex_names=("${(@f)$(_cxs_child_names "$codex")}")
    names=()
    seen=()

    for name in "${claude_names[@]}" "${codex_names[@]}"; do
      [[ -z "$name" || -n "${seen[$name]}" ]] && continue
      seen[$name]=1
      names+=("$name")
    done

    for name in "${names[@]}"; do
      _cxs_sync_item "$rel/$name" || return $?
    done
    return
  fi

  if [[ -f "$claude" && -f "$codex" ]]; then
    if cmp -s "$claude" "$codex"; then
      (( _cxs_same++ ))
    else
      _cxs_resolve_conflict "$rel" "$claude" "$codex" || return $?
    fi
    return
  fi

  _cxs_resolve_conflict "$rel" "$claude" "$codex" || return $?
}

function _cxs_auto_paths() {
  local mode="$1"
  local -a defaults all_names
  local name clean
  local -A seen

  defaults=(skills commands agents hooks rules scripts)

  if [[ "$mode" == "all" ]]; then
    all_names=("${(@f)$(_cxs_child_names "$_cxs_claude_root")}" "${(@f)$(_cxs_child_names "$_cxs_codex_root")}")
    for name in "${all_names[@]}"; do
      case "$name" in
        ""|.DS_Store|settings.local.json|tasks|cache|ide|image-cache|worktrees|sessions|shell_snapshots|log|auth.json|version.json|models_cache.json)
          continue
          ;;
      esac
      [[ -n "${seen[$name]}" ]] && continue
      seen[$name]=1
      print -r -- "$name"
    done
    return
  fi

  for name in "${defaults[@]}"; do
    if _cxs_exists "$_cxs_claude_root/$name" || _cxs_exists "$_cxs_codex_root/$name"; then
      print -r -- "$name"
    fi
  done
}

function cxs() {
  emulate -L zsh
  setopt localoptions pipe_fail

  local root=""
  local all=0
  local arg rel mode
  local _cxs_root _cxs_claude_root _cxs_codex_root _cxs_prefer=""
  local -i _cxs_dry_run=0 _cxs_yes=0 _cxs_copied=0 _cxs_conflicts=0 _cxs_skipped=0 _cxs_same=0
  local -a requested paths auto_paths
  local -A seen_paths

  while (( $# )); do
    case "$1" in
      -h|--help)
        _cxs_usage
        return 0
        ;;
      -n|--dry-run)
        _cxs_dry_run=1
        ;;
      -y|--yes)
        _cxs_yes=1
        ;;
      --all)
        all=1
        ;;
      --root)
        shift
        if (( ! $# )); then
          print -u2 -r -- "cxs: --root needs a directory"
          return 2
        fi
        root="$1"
        ;;
      --root=*)
        root="${1#--root=}"
        ;;
      --prefer)
        shift
        if (( ! $# )); then
          print -u2 -r -- "cxs: --prefer needs claude, codex, newer, or older"
          return 2
        fi
        _cxs_prefer="$1"
        ;;
      --prefer=*)
        _cxs_prefer="${1#--prefer=}"
        ;;
      --)
        shift
        requested+=("$@")
        break
        ;;
      -*)
        print -u2 -r -- "cxs: unknown option: $1"
        return 2
        ;;
      *)
        if [[ -z "$root" ]] && _cxs_looks_like_root_arg "$1"; then
          root="$1"
        else
          requested+=("$1")
        fi
        ;;
    esac
    shift
  done

  case "$_cxs_prefer" in
    ""|claude|c|codex|x|newer|older) ;;
    *)
      print -u2 -r -- "cxs: --prefer must be claude, codex, newer, or older"
      return 2
      ;;
  esac

  if [[ -z "$root" ]]; then
    root="$(_cxs_repo_root)"
  fi

  root="${root:A}"
  if [[ ! -d "$root" ]]; then
    print -u2 -r -- "cxs: root does not exist: $root"
    return 2
  fi

  _cxs_root="$root"
  _cxs_claude_root="$root/.claude"
  _cxs_codex_root="$root/.codex"

  if (( all )); then
    mode="all"
  else
    mode="default"
  fi

  paths=()
  seen_paths=()

  if (( ${#requested[@]} )); then
    for arg in "${requested[@]}"; do
      if rel="$(_cxs_clean_rel "$arg")"; then
        [[ -n "${seen_paths[$rel]}" ]] && continue
        seen_paths[$rel]=1
        paths+=("$rel")
      else
        return 2
      fi
    done
  else
    auto_paths=("${(@f)$(_cxs_auto_paths "$mode")}")
    for rel in "${auto_paths[@]}"; do
      [[ -z "$rel" || -n "${seen_paths[$rel]}" ]] && continue
      seen_paths[$rel]=1
      paths+=("$rel")
    done
  fi

  if (( ! ${#paths[@]} )); then
    print -r -- "cxs: no syncable .claude/.codex paths found under $root"
    print -r -- "cxs: create .claude/skills, .codex/skills, .claude/commands, or pass paths explicitly"
    return 0
  fi

  print -r -- "cxs: root $root"
  (( _cxs_dry_run )) && print -r -- "cxs: dry run"
  [[ -n "$_cxs_prefer" ]] && print -r -- "cxs: prefer $_cxs_prefer"
  print -r -- "cxs: syncing ${paths[*]}"

  if (( ! _cxs_dry_run )); then
    mkdir -p "$_cxs_claude_root" "$_cxs_codex_root" || return 1
  fi

  for rel in "${paths[@]}"; do
    _cxs_sync_item "$rel" || return $?
  done

  print -r -- "cxs: copied $_cxs_copied, conflicts $_cxs_conflicts, skipped $_cxs_skipped, unchanged $_cxs_same"
}
