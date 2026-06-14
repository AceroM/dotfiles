// Always-on content script (no React — kept tiny). On a site that's been mapped
// to a diffshub directory it wires up two shortcuts:
//   '  → open the New-Claude-session dialog
//   v  → visual-select a DOM element, then open the dialog seeded with an
//        @-reference to the React source that rendered it (read from the
//        `data-loc` attribute the diffshub dev Babel plugin stamps on each DOM
//        node), falling back to the element's HTML on pages without the plugin.
// The heavy React dialog is lazy-loaded (dialog.js) only on first use.

import { getConfig, DEFAULT_SERVER } from "./api";

type DialogModule = typeof import("./dialog");

let dirId: number | null = null;
let serverUrl = DEFAULT_SERVER;
let fallbackServerUrl = "";
let contextTemplate = "";
let dialogMod: DialogModule | null = null;

async function refresh() {
  const cfg = await getConfig();
  serverUrl = cfg.serverUrl;
  fallbackServerUrl = cfg.fallbackServerUrl ?? "";
  contextTemplate = cfg.contexts?.[location.origin] ?? "";
  dirId = cfg.mappings[location.origin] ?? null;
}
void refresh();
chrome.storage.onChanged.addListener(() => void refresh());

// Pick the reachable diffshub server: prefer the primary (localhost when Chrome
// runs on the same Mac as diffshub), else the tailscale fallback. The no-cors
// probe only needs to *connect* — it resolves when localhost is actually up (you're
// on the Mac) and rejects on a remote device, where we use the .ts.net URL instead.
async function pickServer(): Promise<string> {
  if (!fallbackServerUrl || fallbackServerUrl === serverUrl) return serverUrl;
  try {
    await fetch(serverUrl, { mode: "no-cors", signal: AbortSignal.timeout(500) });
    return serverUrl;
  } catch {
    return fallbackServerUrl;
  }
}

async function openDialog(initialPrompt: string, caretAtEnd: boolean) {
  if (dirId == null) return;
  if (!dialogMod) {
    dialogMod = (await import(chrome.runtime.getURL("dialog.js"))) as DialogModule;
  }
  const server = await pickServer();
  dialogMod.mount({
    serverUrl: server,
    dirId,
    initialPrompt,
    caretAtEnd,
    pageUrl: location.href,
    context: contextTemplate,
  });
}

// ---- shortcut keys ----
function isTyping(e: KeyboardEvent): boolean {
  for (const n of e.composedPath()) {
    if (n instanceof HTMLElement) {
      const tag = n.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || n.isContentEditable) {
        return true;
      }
      if (n.id === "diffshub-ext-host") return true; // our own dialog
    }
  }
  return false;
}

document.addEventListener(
  "keydown",
  (e) => {
    if (dirId == null || selecting) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e)) return;
    if (e.key === "'") {
      e.preventDefault();
      void openDialog("", false);
    } else if (e.key === "v") {
      e.preventDefault();
      startVisualSelect();
    }
  },
  true,
);

// ---- visual select (`v`) ----
let selecting = false;
let overlay: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "diffshub-ext-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483646",
    background: "rgba(110, 86, 207, 0.18)",
    border: "2px solid #6e56cf",
    borderRadius: "3px",
    pointerEvents: "none",
    display: "none",
    transition: "all .04s ease-out",
  } as Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(overlay);
  return overlay;
}

function startVisualSelect() {
  if (selecting) return;
  selecting = true;
  ensureOverlay().style.display = "block";
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onPick, true);
  document.addEventListener("keydown", onSelectKey, true);
}

function stopVisualSelect() {
  selecting = false;
  if (overlay) overlay.style.display = "none";
  document.removeEventListener("mousemove", onMove, true);
  document.removeEventListener("click", onPick, true);
  document.removeEventListener("keydown", onSelectKey, true);
}

function onMove(e: MouseEvent) {
  const el = e.target as HTMLElement | null;
  if (!el || el === overlay) return;
  const r = el.getBoundingClientRect();
  const o = ensureOverlay();
  o.style.top = `${r.top}px`;
  o.style.left = `${r.left}px`;
  o.style.width = `${r.width}px`;
  o.style.height = `${r.height}px`;
}

function onPick(e: MouseEvent) {
  const el = e.target as HTMLElement | null;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  stopVisualSelect();
  if (!el) return;

  // Prefer a React source reference. `data-loc` ("<path>:<line>:<col>", rooted at
  // the app dir) is stamped on every dev DOM node by the diffshub Babel plugin —
  // walk up to the nearest annotated ancestor so a text-only leaf still resolves.
  const srcEl = el.closest("[data-loc]");
  const ref = srcEl && locToRef(srcEl.getAttribute("data-loc"));
  if (ref) {
    // The ref is relative to the mapped directory's cwd (the React app root), so
    // it lands as a Claude @-file reference. Caret after it, ready for the ask.
    void openDialog(`${ref} `, true);
    return;
  }

  // No dev plugin (e.g. a production build): hand Claude a locator it can grep for
  // in the repo — visible text, tag, id/classes, the nearest test/aria/link
  // attributes, and a short ancestor path. The injected context carries the URL.
  void openDialog(describeElement(el), true);
}

// Compact, greppable description of a DOM node for source-less (production) pages.
function describeElement(el: HTMLElement): string {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const attrs: string[] = [];
  for (const name of [
    "data-testid", "data-test", "data-test-id", "aria-label",
    "name", "placeholder", "alt", "title", "href", "type", "role",
  ]) {
    const v = el.getAttribute(name);
    if (v) attrs.push(`${name}="${v.slice(0, 120)}"`);
  }
  const classes = (el.getAttribute("class") ?? "").trim().slice(0, 300);
  const lines = [
    "Selected element on the live page (no source map — locate it in the repo by its text/classes):",
    `- tag: <${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ""}>`,
  ];
  if (text) lines.push(`- text: ${JSON.stringify(text)}`);
  if (classes) lines.push(`- class: ${JSON.stringify(classes)}`);
  if (attrs.length) lines.push(`- attrs: ${attrs.join(" ")}`);
  lines.push(`- path: ${domPath(el)}`);
  return lines.join("\n") + "\n\n";
}

// Short ancestor path like "main > div.card > button" (tag + first class), capped.
function domPath(el: HTMLElement): string {
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  let depth = 0;
  while (node && depth < 5 && node.tagName) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    const cls = node.classList[0] ? `.${node.classList[0]}` : "";
    parts.unshift(`${tag}${cls}`);
    node = node.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

// "src/components/Buy.tsx:42:6" → "@src/components/Buy.tsx#42" (a Claude-style
// @-file reference). Returns null if the attribute isn't path:line:col shaped.
function locToRef(loc: string | null): string | null {
  if (!loc) return null;
  const m = loc.match(/^(.*):(\d+):(\d+)$/);
  return m ? `@${m[1]}#${m[2]}` : null;
}

function onSelectKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    stopVisualSelect();
  }
}

// ---- HTML pretty-printer (walks the live node; no string parsing) ----
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

function formatHtml(node: Element, depth = 0): string {
  const pad = "  ".repeat(depth);
  const tag = node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes)
    .map((a) => ` ${a.name}="${a.value}"`)
    .join("");
  if (VOID.has(tag)) return `${pad}<${tag}${attrs}>`;
  const kids = Array.from(node.childNodes).filter(
    (n) => n.nodeType === 1 || (n.nodeType === 3 && (n.textContent ?? "").trim()),
  );
  if (kids.length === 0) return `${pad}<${tag}${attrs}></${tag}>`;
  if (kids.length === 1 && kids[0].nodeType === 3) {
    return `${pad}<${tag}${attrs}>${(kids[0].textContent ?? "").trim()}</${tag}>`;
  }
  const inner = kids
    .map((n) =>
      n.nodeType === 1
        ? formatHtml(n as Element, depth + 1)
        : `${"  ".repeat(depth + 1)}${(n.textContent ?? "").trim()}`,
    )
    .join("\n");
  return `${pad}<${tag}${attrs}>\n${inner}\n${pad}</${tag}>`;
}
