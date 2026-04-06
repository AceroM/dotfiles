# jb

Interactive Bun CLI for writing reusable JetBrains project config into the current folder.

## Install in dotfiles

This project is meant to be stowed from:

- `webstorm/.local/share/jb-cli`
- `bash/.local/bin/jb`

After stowing `webstorm` and `bash`, reload your shell and run:

```bash
jb
```

## Current presets

- Oxfmt
- Tailwind CSS
- Git VCS
- Project inspections
- Module files

All selected presets write into the current project's `.idea/` folder.

## How it works

- Type to filter presets
- Up/Down arrows move selection
- Space toggles a preset
- Enter writes the selected files
- Ctrl+C exits

## Adding a new preset

1. Add one or more template files under `templates/`
2. Register the preset in `index.ts`
3. Map each template to a target file in `.idea/`
4. If needed, add a `transform` for placeholders like `{moduleName}`
