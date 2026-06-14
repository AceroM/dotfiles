// Persistent on-page composer (replaces the old modal dialog). A pill pinned to
// the bottom-center of any mapped site expands into a chat composer: a prompt
// textarea with @-file autocomplete, a cursor button that toggles visual-select,
// and a send button. Submitting POSTs to the diffshub server's /api/claude
// (resolving localhost vs the tailscale fallback first), exactly as before — only
// the surface changed. Visual-select no longer opens its own popup; the picked
// element's source ref (dev `data-loc`) or locator (prod) drops into the composer.
//
// Mounted into a shadow DOM so the host page's styles can't reach it. The
// page-highlight overlay used during visual-select lives in the light DOM (it has
// to wrap real page elements), guarded so it never selects our own UI.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { getConfig, DEFAULT_SERVER } from "./api";

const HOST_ID = "diffshub-ext-host";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Kept at module scope so the visual-select handlers can ask "is this on our own
// UI?" via composedPath, and so unmount() can tear both down.
let hostEl: HTMLElement | null = null;
let overlayEl: HTMLDivElement | null = null;

export function mount(): () => void {
  if (hostEl) return () => {}; // single instance
  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  document.documentElement.appendChild(host);
  hostEl = host;
  const root = createRoot(mountPoint);
  root.render(
    <QueryClientProvider client={queryClient}>
      <Bar />
    </QueryClientProvider>,
  );
  return () => {
    root.unmount();
    host.remove();
    overlayEl?.remove();
    hostEl = null;
    overlayEl = null;
  };
}

function Bar() {
  // ---- config (live) ----
  const [dirId, setDirId] = useState<number | null>(null);
  const [primary, setPrimary] = useState(DEFAULT_SERVER);
  const [fallback, setFallback] = useState("");
  const [contextTemplate, setContextTemplate] = useState("");
  const [server, setServer] = useState<string | null>(null);

  // ---- composer ----
  const [expanded, setExpanded] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState<string | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [fileToken, setFileToken] = useState<{ query: string; start: number; caret: number } | null>(
    null,
  );
  const [fileMenuIndex, setFileMenuIndex] = useState(0);

  // ---- config load + live updates ----
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const cfg = await getConfig();
      if (!alive) return;
      setDirId(cfg.mappings[location.origin] ?? null);
      setPrimary(cfg.serverUrl);
      setFallback(cfg.fallbackServerUrl ?? "");
      setContextTemplate(cfg.contexts?.[location.origin] ?? "");
    };
    void load();
    chrome.storage.onChanged.addListener(() => void load());
    return () => {
      alive = false;
    };
  }, []);

  // Prefer the primary (localhost) server; fall back to the tailscale URL when a
  // no-cors probe can't connect (i.e. Chrome isn't on the diffshub host).
  const pickServer = useCallback(async (): Promise<string> => {
    if (!fallback || fallback === primary) return primary;
    try {
      await fetch(primary, { mode: "no-cors", signal: AbortSignal.timeout(500) });
      return primary;
    } catch {
      return fallback;
    }
  }, [primary, fallback]);

  useEffect(() => {
    let alive = true;
    void pickServer().then((s) => {
      if (alive) setServer(s);
    });
    return () => {
      alive = false;
    };
  }, [pickServer]);

  // ---- @-file autocomplete (loaded lazily once the composer is open) ----
  const filesQuery = useQuery({
    queryKey: ["files", server, dirId],
    enabled: expanded && !!server && dirId != null,
    queryFn: async () => {
      const res = await fetch(`${server}/api/files?dir=${dirId}`);
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { files: string[] };
    },
  });

  const syncFileToken = useCallback((el: HTMLTextAreaElement) => {
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    let i = caret - 1;
    let token: { query: string; start: number; caret: number } | null = null;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i > 0 ? value[i - 1] : " ";
        if (i === 0 || /\s/.test(prev)) token = { query: value.slice(i + 1, caret), start: i, caret };
        break;
      }
      if (/\s/.test(ch)) break;
      i--;
    }
    setFileToken(token);
    setFileMenuIndex(0);
  }, []);

  const fileSuggestions = useMemo(() => {
    if (!fileToken) return [];
    const all = filesQuery.data?.files ?? [];
    const q = fileToken.query.toLowerCase();
    const matched = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
    return [...matched].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, 20);
  }, [fileToken, filesQuery.data]);

  const acceptFile = useCallback(
    (path: string) => {
      const tok = fileToken;
      if (!tok) return;
      setPrompt((prev) => {
        const inserted = `@${path} `;
        const next = prev.slice(0, tok.start) + inserted + prev.slice(tok.caret);
        const pos = tok.start + inserted.length;
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(pos, pos);
          }
        });
        return next;
      });
      setFileToken(null);
    },
    [fileToken],
  );

  const fileMenuOpen = !!fileToken && fileSuggestions.length > 0;

  // ---- open / inject ----
  const open = useCallback(() => {
    setExpanded(true);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  // Drop a picked element's reference into the composer and focus it, caret at end.
  const injectRef = useCallback((text: string) => {
    setPrompt((prev) => (prev.trim() ? `${prev.replace(/\s*$/, "")}\n${text}` : text));
    setExpanded(true);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }, []);

  // ---- submit ----
  const submit = useCallback(async () => {
    const p = prompt.trim();
    if (!p || dirId == null) return;
    const srv = server ?? (await pickServer());
    setLaunching(true);
    try {
      const preamble = contextTemplate.trim()
        ? `${contextTemplate.replace(/\{url\}/g, location.href).trim()}\n\n`
        : "";
      const res = await fetch(`${srv}/api/claude?dir=${dirId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: preamble + p }),
      });
      const body = (await res.json().catch(() => ({}))) as { session?: string; error?: string };
      if (!res.ok) {
        alert(`launch failed: ${body.error ?? res.statusText}`);
        return;
      }
      setLaunched(typeof body.session === "string" ? body.session : "session");
      setPrompt("");
      setTimeout(() => setLaunched(null), 4000);
    } finally {
      setLaunching(false);
    }
  }, [prompt, dirId, server, pickServer, contextTemplate]);

  // ---- visual select (cursor button / `v`) ----
  useEffect(() => {
    if (!selecting) return;
    const overlay = ensureOverlay();
    overlay.style.display = "block";
    const inHost = (e: Event) => e.composedPath().some((n) => n === hostEl);

    const onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el === overlay || inHost(e)) return;
      const r = el.getBoundingClientRect();
      overlay.style.top = `${r.top}px`;
      overlay.style.left = `${r.left}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
    };
    const onClick = (e: MouseEvent) => {
      if (inHost(e)) return; // never pick our own UI
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const el = e.target as HTMLElement | null;
      setSelecting(false);
      if (el) injectRef(computeRef(el));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSelecting(false);
      }
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      overlay.style.display = "none";
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [selecting, injectRef]);

  // ---- page shortcuts: ; (or ') opens & focuses, v starts select (ignored while
  // typing); Escape collapses it back to the pill (handled on the textarea). ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dirId == null || selecting) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e)) return;
      if (e.key === ";" || e.key === "'") {
        e.preventDefault();
        open();
      } else if (e.key === "v") {
        e.preventDefault();
        setSelecting(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dirId, selecting, open]);

  if (dirId == null) return null;

  if (!expanded) {
    return (
      <button className="pill" title="Ask diffshub  ( ; )" onClick={open}>
        <SparkIcon />
        <span>Ask diffshub</span>
      </button>
    );
  }

  return (
    <div className={`bar${selecting ? " selecting" : ""}`}>
      {launched && (
        <div className="ok">
          Launched <code>{launched}</code> · <span>tmux attach -t {launched}</span>
        </div>
      )}
      <div className="wrap">
        <textarea
          autoFocus
          ref={taRef}
          className="ta"
          rows={3}
          placeholder="Ask for a change…  (@ a file · v to point at an element)"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            syncFileToken(e.target);
          }}
          onClick={(e) => syncFileToken(e.currentTarget)}
          onKeyUp={(e) => {
            if (fileMenuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
            syncFileToken(e.currentTarget);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (fileMenuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setFileMenuIndex((i) => (i + 1) % fileSuggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setFileMenuIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                acceptFile(fileSuggestions[fileMenuIndex] ?? fileSuggestions[0]);
                return;
              }
            }
            if (e.key === "Escape") {
              e.preventDefault();
              // A live @-token means you wanted the literal "@…" — cancel just the
              // mention. Otherwise Escape collapses the composer back to the pill.
              if (fileToken) setFileToken(null);
              else setExpanded(false);
            }
            // Enter sends; Shift+Enter inserts a newline. (Cmd/Ctrl+Enter also
            // sends, for muscle memory.) The file-menu Enter above wins first.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {fileToken && (
          <div className="menu">
            {fileSuggestions.length ? (
              fileSuggestions.map((f, i) => (
                <button
                  key={f}
                  className={`opt${i === fileMenuIndex ? " on" : ""}`}
                  title={f}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptFile(f);
                  }}
                  onMouseEnter={() => setFileMenuIndex(i)}
                >
                  {f}
                </button>
              ))
            ) : (
              <div className="menu-empty">
                {filesQuery.isPending ? "Loading files…" : "No matching files"}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="toolbar">
        <button
          className={`tool${selecting ? " on" : ""}`}
          title="Point at an element to fix  ( v )"
          onClick={() => setSelecting((s) => !s)}
        >
          <CursorIcon />
        </button>
        <span className="status">
          {selecting ? (
            "Click an element · Esc to cancel"
          ) : (
            <>
              <kbd>v</kbd> select · <kbd>⌘↵</kbd> send
            </>
          )}
        </span>
        <button className="collapse" title="Collapse" onClick={() => setExpanded(false)}>
          ▾
        </button>
        <button className="send" disabled={launching || !prompt.trim()} onClick={() => void submit()}>
          {launching ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// "src/components/Buy.tsx:42:6" → "@src/components/Buy.tsx#42" (a Claude @-file
// reference). Returns null if the attribute isn't path:line:col shaped.
function locToRef(loc: string | null): string | null {
  if (!loc) return null;
  const m = loc.match(/^(.*):(\d+):(\d+)$/);
  return m ? `@${m[1]}#${m[2]}` : null;
}

// A picked element's reference: the dev `data-loc` source ref when present,
// otherwise a greppable locator for source-less (production) pages.
function computeRef(el: HTMLElement): string {
  const srcEl = el.closest("[data-loc]");
  const ref = srcEl && locToRef(srcEl.getAttribute("data-loc"));
  if (ref) return `${ref} `;
  return describeElement(el);
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

// True when the key event targets an editable field (or our own composer) — so the
// page shortcuts don't fire while you're typing.
function isTyping(e: KeyboardEvent): boolean {
  for (const n of e.composedPath()) {
    if (n instanceof HTMLElement) {
      const tag = n.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || n.isContentEditable) return true;
      if (n.id === HOST_ID) return true;
    }
  }
  return false;
}

function ensureOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl;
  const o = document.createElement("div");
  o.id = "diffshub-ext-overlay";
  Object.assign(o.style, {
    position: "fixed",
    zIndex: "2147483646",
    background: "rgba(110, 86, 207, 0.18)",
    border: "2px solid #6e56cf",
    borderRadius: "3px",
    pointerEvents: "none",
    display: "none",
    transition: "all .04s ease-out",
  } as Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(o);
  overlayEl = o;
  return o;
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0l1.7 5.1a2 2 0 0 0 1.2 1.2L16 8l-5.1 1.7a2 2 0 0 0-1.2 1.2L8 16l-1.7-5.1a2 2 0 0 0-1.2-1.2L0 8l5.1-1.7a2 2 0 0 0 1.2-1.2L8 0z" />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M4 3l13 5.4-5.3 1.6a1 1 0 0 0-.66.66L9.4 16 4 3z" />
    </svg>
  );
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.pill, .bar {
  position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px;
  z-index: 2147483647;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18181b;
}
.pill {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 500;
  background: #18181b; color: #fff; border: none; border-radius: 999px; padding: 9px 16px;
  box-shadow: 0 6px 24px rgba(0,0,0,.28);
}
.pill:hover { background: #27272a; }
.pill svg { width: 14px; height: 14px; color: #c4b5fd; }
.bar {
  width: 560px; max-width: calc(100vw - 32px);
  background: #fff; border: 1px solid #e4e4e7; border-radius: 14px; padding: 10px;
  box-shadow: 0 14px 50px rgba(0,0,0,.3);
}
.bar.selecting { pointer-events: none; opacity: .55; }
.wrap { position: relative; }
.ta {
  width: 100%; min-height: 60px; max-height: 40vh; resize: none; display: block;
  background: #fff; color: inherit; font: inherit; line-height: 1.5;
  border: none; border-radius: 8px; padding: 6px 8px 2px; outline: none;
}
.menu {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); z-index: 5;
  background: #fff; border: 1px solid #e4e4e7; border-radius: 8px;
  box-shadow: 0 10px 34px rgba(0,0,0,.18); padding: 4px;
  max-height: 240px; overflow-y: auto;
}
.opt {
  display: block; width: 100%; text-align: left; cursor: pointer;
  padding: 5px 9px; background: none; border: none; border-radius: 6px; color: #18181b;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl;
}
.opt:hover, .opt.on { background: #efe9fb; }
.menu-empty { padding: 8px 9px; color: #a1a1aa; font-size: 12px; }
.toolbar { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 0 2px; }
.tool {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 30px; height: 30px; cursor: pointer; padding: 0;
  background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 8px; color: #52525b;
}
.tool:hover { color: #18181b; border-color: #6e56cf; }
.tool.on { background: #6e56cf; border-color: #6e56cf; color: #fff; }
.tool svg { width: 16px; height: 16px; }
.status {
  flex: 1; min-width: 0; font-size: 11px; color: #a1a1aa;
  display: flex; align-items: center; gap: 6px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.status kbd { background: #e4e4e7; border-radius: 3px; padding: 1px 4px; font-size: 10px; }
.collapse {
  flex-shrink: 0; width: 28px; height: 28px; cursor: pointer; padding: 0;
  background: none; border: 1px solid transparent; border-radius: 8px; color: #a1a1aa;
}
.collapse:hover { color: #18181b; background: #f4f4f5; }
.send {
  flex-shrink: 0; padding: 6px 16px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
  background: #6e56cf; border: 1px solid #6e56cf; border-radius: 8px; color: #fff;
}
.send:hover:not(:disabled) { background: #7d68d6; border-color: #7d68d6; }
.send:disabled { opacity: .45; cursor: default; }
.ok { font-size: 12px; padding: 2px 6px 8px; color: #16a34a; }
.ok code { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #f0fdf4; padding: 1px 5px; border-radius: 4px; color: #15803d; }
.ok span { color: #71717a; }
`;
