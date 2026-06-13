// Always-on content script (no React — kept tiny). On a site that's been mapped
// to a diffshub directory it wires up two shortcuts:
//   '  → open the New-Claude-session dialog
//   v  → visual-select a DOM element, then open the dialog seeded with its HTML
// The heavy React dialog is lazy-loaded (dialog.js) only on first use.

import { getConfig, DEFAULT_SERVER } from "./api";

type DialogModule = typeof import("./dialog");

let dirId: number | null = null;
let serverUrl = DEFAULT_SERVER;
let dialogMod: DialogModule | null = null;

async function refresh() {
  const cfg = await getConfig();
  serverUrl = cfg.serverUrl;
  dirId = cfg.mappings[location.origin] ?? null;
}
void refresh();
chrome.storage.onChanged.addListener(() => void refresh());

async function openDialog(initialPrompt: string, caretAtEnd: boolean) {
  if (dirId == null) return;
  if (!dialogMod) {
    dialogMod = (await import(chrome.runtime.getURL("dialog.js"))) as DialogModule;
  }
  dialogMod.mount({ serverUrl, dirId, initialPrompt, caretAtEnd });
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
  let html = formatHtml(el);
  const MAX = 16000;
  if (html.length > MAX) html = `${html.slice(0, MAX)}\n<!-- …truncated… -->`;
  void openDialog("```html\n" + html + "\n```\n\n", true);
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
