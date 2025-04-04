source ~/.local/share/omakub/defaults/bash/rc
source ~/.bash_aliases
source ~/.bash_private
. "/home/miguel/.deno/env"
PS1='> '

export drop_schema="DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

x() {
  git add .
  git commit -m "changes"
  git push
}

# e.g: fv DB_PASSWORD .env
fv() {
  local key="$1"
  local env_file="${2:-.env}"

  if [ -f "$env_file" ]; then
    local value=$(grep "^${key}=" "$env_file" | cut -d '=' -f 2-)
    if [ -n "$value" ]; then
      echo $value
    else
      echo "Error: Key $key not found in $env_file" >&2
      exit 1
    fi
  else
    echo "Error: File $env_file not found" >&2
    exit 1
  fi
}

gree() {
  fd --type f --hidden --exclude .git | tree --fromfile
}

cpx() {
  xclip -selection clipboard "$@"
}

ppx() {
  local file_path="$1"
  xclip -selection clipboard -o > "$file_path"
}
