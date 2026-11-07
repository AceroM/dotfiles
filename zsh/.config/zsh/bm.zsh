# bm — directory bookmarks
#
#   bm set 1        bookmark the current dir as slot "1" (any name works: bm set work)
#   bm 1            cd to bookmark "1"
#   bm              list bookmarks
#   bm list         list bookmarks
#   bm rm 1         remove bookmark "1"
#   bm path 1       print the path for "1" (no cd)
#
# Bookmarks live in $BM_FILE, one per line as: <name>\t<path>

: ${BM_FILE:=${XDG_DATA_HOME:-$HOME/.local/share}/bm/bookmarks}

_bm_ensure() {
  [[ -f $BM_FILE ]] && return
  mkdir -p "${BM_FILE:h}"
  : > "$BM_FILE"
}

_bm_get() {
  # $1 = name -> prints path (empty if missing)
  _bm_ensure
  awk -F'\t' -v k="$1" '$1 == k { print $2; exit }' "$BM_FILE"
}

bm() {
  _bm_ensure
  local cmd=$1

  case $cmd in
    ""|list|ls)
      if [[ ! -s $BM_FILE ]]; then
        echo "no bookmarks — try: bm set <name>"
        return 0
      fi
      awk -F'\t' '{ printf "  %-12s %s\n", $1, $2 }' "$BM_FILE" | sort
      ;;

    set|add)
      local name=$2
      local dir=${3:-$PWD}
      if [[ -z $name ]]; then
        echo "usage: bm set <name> [path]" >&2
        return 1
      fi
      dir=${dir:A}  # absolute, resolved
      if [[ ! -d $dir ]]; then
        echo "bm: not a directory: $dir" >&2
        return 1
      fi
      # drop any existing entry with this name, then append
      local tmp=${BM_FILE}.tmp
      awk -F'\t' -v k="$name" '$1 != k' "$BM_FILE" > "$tmp"
      printf '%s\t%s\n' "$name" "$dir" >> "$tmp"
      mv "$tmp" "$BM_FILE"
      echo "bookmarked $name -> $dir"
      ;;

    rm|del|delete|unset)
      local name=$2
      if [[ -z $name ]]; then
        echo "usage: bm rm <name>" >&2
        return 1
      fi
      local tmp=${BM_FILE}.tmp
      awk -F'\t' -v k="$name" '$1 != k' "$BM_FILE" > "$tmp"
      mv "$tmp" "$BM_FILE"
      echo "removed $name"
      ;;

    path)
      local dir=$(_bm_get "$2")
      [[ -n $dir ]] && { echo "$dir"; return 0; }
      echo "bm: no bookmark: $2" >&2
      return 1
      ;;

    *)
      # bm <name> -> cd to it
      local dir=$(_bm_get "$cmd")
      if [[ -z $dir ]]; then
        echo "bm: no bookmark: $cmd" >&2
        return 1
      fi
      if [[ ! -d $dir ]]; then
        echo "bm: bookmarked dir gone: $dir" >&2
        return 1
      fi
      cd "$dir"
      ;;
  esac
}

# completion: subcommands, plus bookmark names for jump/rm/path
_bm_complete() {
  _bm_ensure
  local -a names
  names=("${(@f)$(awk -F'\t' '{ print $1 }' "$BM_FILE" 2>/dev/null)}")
  names=(${names:#})
  if (( CURRENT == 2 )); then
    compadd set add rm del path list ls
    (( ${#names} )) && compadd -X 'bookmarks' $names
  elif (( CURRENT == 3 )); then
    case ${words[2]} in
      rm|del|delete|unset|path) (( ${#names} )) && compadd $names ;;
    esac
  fi
}
if (( $+functions[compdef] )); then
  compdef _bm_complete bm
fi
