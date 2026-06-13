// Lazy-loaded React dialog (mounted into a shadow DOM so the host page's styles
// can't touch it). Mirrors diffshub's New-Claude-session dialog: a prompt
// textarea with @-file autocomplete, submitting to POST /api/claude. Fetches go
// to the diffshub server with TanStack Query.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

interface MountOpts {
  serverUrl: string;
  dirId: number;
  initialPrompt: string;
  caretAtEnd: boolean;
}

const HOST_ID = "diffshub-ext-host";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

let currentRoot: Root | null = null;
let currentHost: HTMLElement | null = null;

function unmount() {
  if (currentRoot) {
    currentRoot.unmount();
    currentRoot = null;
  }
  if (currentHost) {
    currentHost.remove();
    currentHost = null;
  }
}

export function mount(opts: MountOpts) {
  unmount(); // single instance
  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  document.documentElement.appendChild(host);
  currentHost = host;
  currentRoot = createRoot(mountPoint);
  currentRoot.render(
    <QueryClientProvider client={queryClient}>
      <Dialog {...opts} onClose={unmount} />
    </QueryClientProvider>,
  );
}

function Dialog({ serverUrl, dirId, initialPrompt, caretAtEnd, onClose }: MountOpts & { onClose: () => void }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const [fileToken, setFileToken] = useState<{ query: string; start: number; caret: number } | null>(
    null,
  );
  const [fileMenuIndex, setFileMenuIndex] = useState(0);

  const filesQuery = useQuery({
    queryKey: ["files", serverUrl, dirId],
    queryFn: async () => {
      const res = await fetch(`${serverUrl}/api/files?dir=${dirId}`);
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { files: string[] };
    },
  });

  // Focus on mount; for the `v` capture, drop the caret two lines below the HTML.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    if (caretAtEnd) {
      const p = el.value.length;
      el.setSelectionRange(p, p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const submit = useCallback(async () => {
    const p = prompt.trim();
    if (!p) return;
    setLaunching(true);
    try {
      const res = await fetch(`${serverUrl}/api/claude?dir=${dirId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p }),
      });
      const body = (await res.json().catch(() => ({}))) as { session?: string; error?: string };
      if (!res.ok) {
        alert(`launch failed: ${body.error ?? res.statusText}`);
        return;
      }
      setLaunched(typeof body.session === "string" ? body.session : "session");
      setTimeout(onClose, 3000);
    } finally {
      setLaunching(false);
    }
  }, [prompt, serverUrl, dirId, onClose]);

  return (
    <div
      className="ov"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !launching) onClose();
      }}
    >
      <div className="modal">
        <h3>New Claude session</h3>
        {launched ? (
          <div className="ok">
            Launched <code>{launched}</code>
            <div className="ok-sub">
              attach: <code>tmux attach -t {launched}</code>
            </div>
          </div>
        ) : (
          <>
            <div className="wrap">
              <textarea
                autoFocus
                ref={taRef}
                className="ta"
                placeholder="Prompt for a new Claude Code session…  (type @ to reference a file)"
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
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setFileToken(null);
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                  }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.altKey)) {
                    e.preventDefault();
                    submit();
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
            <div className="actions">
              <button className="btn" disabled={launching} onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={launching || !prompt.trim()} onClick={submit}>
                {launching ? "Launching…" : "Launch"}
              </button>
            </div>
            <div className="hint">
              <kbd>⌘↵</kbd> launch · <kbd>esc</kbd> cancel · <kbd>@</kbd> file
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.ov {
  position: fixed; inset: 0; z-index: 2147483647;
  background: rgba(0,0,0,.35);
  display: flex; align-items: flex-start; justify-content: center;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #18181b;
}
.modal {
  margin-top: 12vh; width: 520px; max-width: calc(100vw - 40px);
  background: #fff; border: 1px solid #e4e4e7; border-radius: 10px;
  padding: 16px; box-shadow: 0 12px 44px rgba(0,0,0,.28);
}
.modal h3 { margin: 0 0 10px; font-size: 14px; }
.wrap { position: relative; }
.ta {
  width: 100%; min-height: 120px; resize: vertical;
  background: #fff; color: inherit; font: inherit; line-height: 1.5;
  border: 1px solid #d4d4d8; border-radius: 6px; padding: 8px 10px; outline: none;
}
.ta:focus { border-color: #6e56cf; }
.menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 5;
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
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.btn {
  padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer;
  background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 6px; color: #52525b;
}
.btn:hover:not(:disabled) { color: #18181b; border-color: #6e56cf; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: #6e56cf; border-color: #6e56cf; color: #fff; }
.btn.primary:hover:not(:disabled) { background: #7d68d6; border-color: #7d68d6; }
.hint { margin-top: 10px; font-size: 11px; color: #a1a1aa; display: flex; gap: 8px; }
.hint kbd { background: #e4e4e7; border-radius: 3px; padding: 1px 4px; }
.ok { font-size: 13px; padding: 6px 2px; }
.ok code { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #f4f4f5; padding: 1px 5px; border-radius: 4px; }
.ok-sub { margin-top: 8px; color: #71717a; font-size: 12px; }
`;
