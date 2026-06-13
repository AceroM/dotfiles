#!/usr/bin/env bun
// Bundle the diffshub Chrome extension into ./dist (load that as an unpacked
// extension). content.ts must be a classic script → iife; popup.tsx and
// dialog.tsx are ES modules (popup via <script type=module>, dialog via a
// dynamic import() of a web-accessible resource).

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  outdir: dist,
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
} as const;

function check(res: Awaited<ReturnType<typeof Bun.build>>, label: string) {
  if (!res.success) {
    console.error(`diffshub-ext: ${label} build failed`);
    for (const log of res.logs) console.error(log);
    process.exit(1);
  }
}

// Content script — classic script, no module syntax.
check(
  await Bun.build({ entrypoints: [join(here, "content.ts")], format: "iife", ...common }),
  "content",
);
// Popup + lazy dialog — ES modules.
check(
  await Bun.build({
    entrypoints: [join(here, "popup.tsx"), join(here, "dialog.tsx")],
    format: "esm",
    splitting: false,
    ...common,
  }),
  "popup+dialog",
);

copyFileSync(join(here, "manifest.json"), join(dist, "manifest.json"));
copyFileSync(join(here, "popup.html"), join(dist, "popup.html"));

console.log(`diffshub-ext: built → ${dist}`);
