#!/usr/bin/env bun

import { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const rootDir = import.meta.dir;
const templateDir = join(rootDir, "templates");
const cwd = process.cwd();
const ideaDir = join(cwd, ".idea");
const projectName = basename(cwd);
const moduleName = projectName.replace(/[^A-Za-z0-9._-]/g, "-") || "project";

type FileSpec = {
  template: string;
  target: string;
  transform?: (content: string) => string;
};

type Preset = {
  id: string;
  label: string;
  description: string;
  files: FileSpec[];
};

const presets: Preset[] = [
  {
    id: "oxfmt",
    label: "Oxfmt",
    description: "Adds Oxfmt save actions and TypeScript compiler settings.",
    files: [
      { template: "OxfmtSettings.xml", target: ".idea/OxfmtSettings.xml" },
      { template: "compiler.xml", target: ".idea/compiler.xml" },
    ],
  },
  {
    id: "tailwind",
    label: "Tailwind CSS",
    description: "Adds JetBrains Tailwind language server configuration.",
    files: [{ template: "tailwindcss.xml", target: ".idea/tailwindcss.xml" }],
  },
  {
    id: "git-vcs",
    label: "Git VCS",
    description: "Maps the project root to Git inside JetBrains settings.",
    files: [{ template: "vcs.xml", target: ".idea/vcs.xml" }],
  },
  {
    id: "project-inspections",
    label: "Project inspections",
    description: "Writes a default inspection profile.",
    files: [
      {
        template: "inspectionProfiles/Project_Default.xml",
        target: ".idea/inspectionProfiles/Project_Default.xml",
      },
    ],
  },
  {
    id: "module-files",
    label: "Module files",
    description: "Creates modules.xml and a project .iml using the current folder name.",
    files: [
      {
        template: "modules.xml",
        target: ".idea/modules.xml",
        transform: (content) => content.replaceAll("{moduleName}", moduleName),
      },
      {
        template: "module.iml",
        target: `.idea/${moduleName}.iml`,
      },
    ],
  },
];

const state = {
  query: "",
  cursor: 0,
  selected: new Set<string>(),
};

function render() {
  process.stdout.write("\x1Bc");
  const filtered = getFilteredPresets();
  if (state.cursor >= filtered.length) state.cursor = Math.max(filtered.length - 1, 0);

  console.log("jb — JetBrains project config writer\n");
  console.log(`Project: ${cwd}`);
  console.log(`Module:  ${moduleName}`);
  console.log(`Target:  ${ideaDir}\n`);
  console.log("Type to filter. ↑/↓ move. Space toggles. Enter writes files. Ctrl+C exits.\n");
  console.log(`Filter: ${state.query || "(all)"}\n`);

  if (filtered.length === 0) {
    console.log("  No matching settings.");
    return;
  }

  for (const [index, preset] of filtered.entries()) {
    const active = index === state.cursor ? ">" : " ";
    const checked = state.selected.has(preset.id) ? "[x]" : "[ ]";
    console.log(`${active} ${checked} ${preset.label}`);
    console.log(`    ${preset.description}`);
    for (const file of preset.files) {
      console.log(`    - ${file.target}`);
    }
    console.log("");
  }
}

function getFilteredPresets() {
  const query = state.query.trim().toLowerCase();
  if (!query) return presets;
  return presets.filter((preset) => {
    const haystack = `${preset.label} ${preset.description} ${preset.id}`.toLowerCase();
    return haystack.includes(query);
  });
}

function toggleCurrent() {
  const current = getFilteredPresets()[state.cursor];
  if (!current) return;
  if (state.selected.has(current.id)) state.selected.delete(current.id);
  else state.selected.add(current.id);
}

function ensureParentDir(path: string) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });
}

function writeSelected() {
  const chosen = presets.filter((preset) => state.selected.has(preset.id));
  process.stdout.write("\x1Bc");

  if (chosen.length === 0) {
    console.log("No settings selected. Nothing written.");
    process.exit(0);
  }

  mkdirSync(ideaDir, { recursive: true });
  const written: string[] = [];

  for (const preset of chosen) {
    for (const file of preset.files) {
      const templatePath = join(templateDir, file.template);
      const targetPath = join(cwd, file.target);
      let content = readFileSync(templatePath, "utf8");
      if (file.transform) content = file.transform(content);
      ensureParentDir(targetPath);
      writeFileSync(targetPath, content, "utf8");
      written.push(file.target);
    }
  }

  console.log("Wrote JetBrains config files:\n");
  for (const file of written) {
    console.log(`- ${file}`);
  }
}

function handleKey(data: Buffer) {
  const key = data.toString("utf8");

  if (key === "\u0003") {
    process.stdout.write("\n");
    process.exit(0);
  }

  if (key === "\r") {
    writeSelected();
    process.exit(0);
  }

  if (key === " ") {
    toggleCurrent();
    render();
    return;
  }

  if (key === "\u007f") {
    state.query = state.query.slice(0, -1);
    state.cursor = 0;
    render();
    return;
  }

  if (key === "\u001b[A") {
    state.cursor = Math.max(0, state.cursor - 1);
    render();
    return;
  }

  if (key === "\u001b[B") {
    state.cursor = Math.min(getFilteredPresets().length - 1, state.cursor + 1);
    render();
    return;
  }

  if (/^[\x20-\x7E]$/.test(key)) {
    state.query += key;
    state.cursor = 0;
    render();
  }
}

function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("jb requires an interactive terminal.");
    process.exit(1);
  }

  if (!existsSync(templateDir) || readdirSync(templateDir).length === 0) {
    console.error(`Template directory is missing: ${templateDir}`);
    process.exit(1);
  }

  render();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleKey);
}

main();
