# Convert a video to a compact, 4x-speed GIF.
# Usage: mg <video> [output.gif]
mg() (
  if (( $# < 1 || $# > 2 )); then
    print -u2 -- "usage: mg <video> [output.gif]"
    return 2
  fi

  local input="$1"
  local output="${2:-${input:r}-fast.gif}"
  local tmp_root="${TMPDIR:-/tmp}"
  local tmp_dir palette duration

  if [[ ! -f "$input" ]]; then
    print -u2 -- "mg: input file not found: $input"
    return 1
  fi

  if ! (( $+commands[ffmpeg] )); then
    print -u2 -- "mg: ffmpeg is not installed"
    return 127
  fi

  tmp_dir=$(mktemp -d "${tmp_root%/}/mg.XXXXXX") || return 1
  palette="$tmp_dir/palette.png"
  trap 'rm -f -- "$palette"; rmdir -- "$tmp_dir" 2>/dev/null' EXIT HUP INT TERM

  ffmpeg -y -i "$input" \
    -vf "setpts=0.25*PTS,fps=15,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff" \
    -loglevel error "$palette" &&
    ffmpeg -y -i "$input" -i "$palette" \
      -lavfi "setpts=0.25*PTS,fps=15,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
      -loglevel error "$output" || return 1

  print -r -- "Created $output"
  ls -lh -- "$output"

  if (( $+commands[ffprobe] )); then
    duration=$(ffprobe -v error -show_entries format=duration \
      -of default=noprint_wrappers=1:nokey=1 "$output")
    [[ -n "$duration" ]] && print -r -- "Duration: ${duration}s"
  fi

  return 0
)
