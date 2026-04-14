function pm() {
  awk -v q="$1" '
    BEGIN { IGNORECASE=1; printing=0 }
    /^(model|enum|type|view) / { printing = ($2 ~ q) }
    printing { print }
    /^}/ && printing { print ""; printing=0 }
  ' prisma/schema.prisma
}

function tm() {
  local file="$1"

  if [[ -z "$file" ]]; then
    echo "usage: tm prisma/migrations/<timestamp_name>/migration.sql"
    return 1
  fi

  local dir="${file:h}"
  local parent="${dir:h}"
  local base="${dir:t}"

  if [[ ! -d "$dir" ]]; then
    echo "directory not found: $dir"
    return 1
  fi

  if [[ "$parent:t" != "migrations" ]]; then
    echo "expected file inside prisma/migrations/<timestamp_name>/"
    return 1
  fi

  if [[ "$base" != <->* ]]; then
    echo "expected migration directory to start with a timestamp: $base"
    return 1
  fi

  local now suffix new_base new_dir
  now="$(date +%Y%m%d%H%M%S)"
  suffix="${base#<->}"
  new_base="${now}${suffix}"
  new_dir="${parent}/${new_base}"

  if [[ -e "$new_dir" ]]; then
    echo "target already exists: $new_dir"
    return 1
  fi

  mv "$dir" "$new_dir"
}
