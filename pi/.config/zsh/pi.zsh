# Pi CLI theme helpers
# Config file location: ~/.pi/agent/settings.json

function pi-theme() {
  local mode="$1"
  local f="$HOME/.pi/agent/settings.json"

  if [[ "$mode" != "light" && "$mode" != "dark" ]]; then
    echo "Usage: pi-theme <light|dark>"
    return 1
  fi

  if [[ ! -f "$f" ]]; then
    echo "Pi settings file not found: $f"
    return 1
  fi

  python3 - <<PY
import json, pathlib
p = pathlib.Path("$f")
data = json.loads(p.read_text())
data["theme"] = "$mode"
p.write_text(json.dumps(data, indent=2) + "\n")
print(f"Set Pi theme to: {data['theme']}")
PY
}
