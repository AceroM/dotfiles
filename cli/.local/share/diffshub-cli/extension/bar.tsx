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

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  getConfig,
  DEFAULT_SERVER,
  parseAuthProbe,
  runAuthProbe,
  authBlock,
  getAuthCache,
  setAuthCache,
  detectEnvironment,
  environmentBlock,
  routeBlock,
} from "./api";

const HOST_ID = "diffshub-ext-host";
// How long a resolved identity stays "fresh" before we revalidate it (on tab focus,
// and right before a send). Re-fetching the session endpoint also slides the app's
// session expiry, so this doubles as a keep-alive.
const AUTH_FRESH_MS = 60_000;
// Min spacing between full-page scroll grabs — captureVisibleTab is rate-limited
// (~2/s), so we pace each frame to stay under quota (grabVisible also retries).
const CAPTURE_INTERVAL_MS = 350;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Kept at module scope so the visual-select handlers can ask "is this on our own
// UI?" via composedPath, and so unmount() can tear them down. shotLayerEl is the
// full-viewport drag surface for the `s` screenshot tool.
let hostEl: HTMLElement | null = null;
let overlayEl: HTMLDivElement | null = null;
let shotLayerEl: HTMLDivElement | null = null;

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
    shotLayerEl?.remove();
    hostEl = null;
    overlayEl = null;
    shotLayerEl = null;
  };
}

function Bar() {
  // ---- config (live) ----
  const [dirId, setDirId] = useState<number | null>(null);
  const [primary, setPrimary] = useState(DEFAULT_SERVER);
  const [fallback, setFallback] = useState("");
  const [contextTemplate, setContextTemplate] = useState("");
  const [server, setServer] = useState<string | null>(null);

  // ---- logged-in user (auth probe) ----
  // The per-origin probe config (see api.parseAuthProbe) and the identity it last
  // resolved to. `authValues` drives the "Logged in as …" pill and the <auth> block
  // folded into the prompt on send; authTs tracks freshness for revalidation.
  const [authProbe, setAuthProbe] = useState("");
  const [authValues, setAuthValues] = useState<Record<string, string> | null>(null);
  const authTsRef = useRef(0);

  // ---- composer ----
  // Restore any draft left in localStorage by a previous visit/reload, and open
  // straight to it so the persisted text is visible. The draft is cleared once a
  // prompt is sent (see the persist effect + setPrompt("") in submit).
  const initialDraft = useRef(loadDraft()).current;
  const [expanded, setExpanded] = useState(initialDraft.length > 0);
  // null = not picking. "inject" (v) drops the picked ref into the composer;
  // "editor" (V) opens its source file in the local $EDITOR instead.
  const [selectMode, setSelectMode] = useState<null | "inject" | "editor">(null);
  const selecting = selectMode !== null;
  const [prompt, setPrompt] = useState(initialDraft);
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState<string | null>(null);
  // Brief success tick shown on the collapsed pill right after a prompt is sent.
  const [justSent, setJustSent] = useState(false);
  const [uploading, setUploading] = useState(false);
  // `s` screenshot tool: shooting = dragging the region; capturing = grabbing +
  // cropping + uploading the shot afterwards.
  const [shooting, setShooting] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // Which deploy this origin is (development vs production). Constant for the page,
  // so resolved once. Shown as a chip and folded into the prompt as an <environment>
  // block on submit (dev grants license to poke the local DB; prod is read-only).
  const env = useMemo(() => detectEnvironment(location.origin), []);

  // Current SPA route (pathname), kept live across SPA navigations. It seeds the
  // editable "route" field below and the `{route}` token; once you edit that field
  // it stops tracking the page so a hand-typed route isn't clobbered on navigation.
  const liveRoute = useRoute();
  const [routeEdited, setRouteEdited] = useState(false);
  const [routeInput, setRouteInput] = useState(liveRoute);
  useEffect(() => {
    if (!routeEdited) setRouteInput(liveRoute);
  }, [liveRoute, routeEdited]);
  // The source file that renders the current route. Paired with the route in the
  // <route> block so the session edits the right file instead of hunting for it.
  // Auto-derived from the page's dev `data-loc` source locations (see
  // detectRouteFile + the effects below) — the same baked-in source mapping the
  // "open in editor" action uses — and editable so you can correct it. A manual
  // edit wins until the next navigation; `fileEdited` tracks that.
  const [routeFile, setRouteFile] = useState("");
  const [fileEdited, setFileEdited] = useState(false);

  // New screen → the previous route's file no longer applies: clear it and drop
  // any manual override so detection refills for the route just navigated to.
  useEffect(() => {
    setFileEdited(false);
    setRouteFile("");
  }, [liveRoute]);

  // Auto-fill the file from the page's source locations while the composer is open
  // (the field is only visible then, and a just-opened composer means the screen
  // has settled). The short retry lets a freshly-navigated SPA paint before we scan.
  // Only ever sets a value we actually found, so a source-less production page (or a
  // mid-navigation empty DOM) leaves whatever you typed alone.
  useEffect(() => {
    if (!expanded || fileEdited) return;
    let alive = true;
    const detect = () => {
      if (!alive || fileEdited) return;
      const f = detectRouteFile();
      if (f) setRouteFile(f);
    };
    detect();
    const id = setTimeout(detect, 60);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [expanded, fileEdited, liveRoute]);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [fileToken, setFileToken] = useState<{ query: string; start: number; caret: number } | null>(
    null,
  );
  const [fileMenuIndex, setFileMenuIndex] = useState(0);

  // ---- persist draft ----
  // Mirror the prompt to localStorage so an in-progress draft survives a reload or
  // navigation. The empty-string branch removes the key, so setPrompt("") on a
  // successful send (in submit) clears the stored draft here.
  useEffect(() => {
    saveDraft(prompt);
  }, [prompt]);

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
      setAuthProbe(cfg.auths?.[location.origin] ?? "");
    };
    void load();
    // Reload config whenever storage changes (mapping/context/auth edited in the
    // popup). Kept in a named handler so we can detach it on unmount — both to avoid
    // leaking a listener per mount and so it stops firing into a torn-down tree.
    const onChange = () => void load();
    try {
      chrome.storage.onChanged.addListener(onChange);
    } catch {
      // dead extension context (reloaded while this tab's old script lingers) — the
      // tab will reload and re-inject; nothing useful to listen for until then.
    }
    return () => {
      alive = false;
      try {
        chrome.storage.onChanged.removeListener(onChange);
      } catch {
        // context already gone — listener went with it
      }
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

  // ---- logged-in user (auth probe) ----
  // Paint the pill instantly from the last cached identity (it survives reloads),
  // then let the revalidation effect below confirm it's still current. The ts===0
  // guard keeps a slow cache read from clobbering a probe that already resolved.
  useEffect(() => {
    let alive = true;
    void getAuthCache(location.origin).then((e) => {
      if (alive && e && authTsRef.current === 0) {
        setAuthValues(e.values);
        authTsRef.current = e.ts;
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // Re-run the probe and cache the result. null (logged out / no probe / fetch
  // failed) clears the cached identity so the pill disappears.
  const refreshAuth = useCallback(async (): Promise<Record<string, string> | null> => {
    const probe = parseAuthProbe(authProbe);
    authTsRef.current = Date.now();
    if (!probe) {
      setAuthValues(null);
      void setAuthCache(location.origin, null);
      return null;
    }
    const values = await runAuthProbe(probe);
    authTsRef.current = Date.now();
    setAuthValues(values);
    void setAuthCache(location.origin, values ? { values, ts: authTsRef.current } : null);
    return values;
  }, [authProbe]);

  // Revalidate on load / whenever the probe config changes, and again on tab focus
  // once the cached identity goes stale. (The session fetch also slides the app's
  // session expiry, so this is the keep-it-fresh mechanism.)
  useEffect(() => {
    if (!authProbe.trim()) {
      setAuthValues(null);
      return;
    }
    void refreshAuth();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - authTsRef.current > AUTH_FRESH_MS)
        void refreshAuth();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authProbe, refreshAuth]);

  // Guarantee a reasonably fresh identity right before a send, so the <auth> block
  // folded into the prompt never carries a stale userId/orgId.
  const ensureFreshAuth = useCallback(async (): Promise<Record<string, string> | null> => {
    if (!parseAuthProbe(authProbe)) return null;
    if (Date.now() - authTsRef.current > AUTH_FRESH_MS) return refreshAuth();
    return authValues;
  }, [authProbe, authValues, refreshAuth]);

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

  // Drop a picked element's reference into the composer at the caret (replacing any
  // selection), then put the caret right after it. No newline prefix — the ref lands
  // inline where you were typing. Falls back to the end when the textarea isn't
  // mounted yet (visual-select started from the collapsed pill).
  const injectRef = useCallback((text: string) => {
    const el = taRef.current;
    setPrompt((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + text + prev.slice(end);
      const pos = start + text.length;
      requestAnimationFrame(() => {
        const e2 = taRef.current;
        if (e2) {
          e2.focus();
          e2.setSelectionRange(pos, pos);
        }
      });
      return next;
    });
    setExpanded(true);
  }, []);

  // Open a picked element's source file in the local $EDITOR (capital `V`). Needs a
  // dev `data-loc` (path:line:col) to map back to a file; production pages have no
  // source map, so we say so rather than guess. Hits the server's /api/open, which
  // spawns $VISUAL/$EDITOR (default zed) — same path as the diffshub "open" button.
  const openInEditor = useCallback(
    async (el: HTMLElement) => {
      const srcEl = el.closest("[data-loc]");
      const m = srcEl?.getAttribute("data-loc")?.match(/^(.*):(\d+):(\d+)$/);
      if (!m) {
        alert("No source location for this element (production page has no source map).");
        return;
      }
      const srv = server ?? (await pickServer());
      try {
        const res = await fetch(`${srv}/api/open?dir=${dirId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: m[1], line: Number(m[2]) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          alert(`open in editor failed: ${body.error ?? res.statusText}`);
        }
      } catch (err) {
        alert(`open in editor failed: ${String((err as { message?: string })?.message ?? err)}`);
      }
    },
    [server, pickServer, dirId],
  );

  // Insert text at the textarea's caret (replacing any selection), then restore
  // the caret after it. Used to drop an uploaded image's /tmp path into the prompt.
  const insertAtCaret = useCallback((text: string) => {
    const el = taRef.current;
    setPrompt((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + text + prev.slice(end);
      const pos = start + text.length;
      requestAnimationFrame(() => {
        const e2 = taRef.current;
        if (e2) {
          e2.focus();
          e2.setSelectionRange(pos, pos);
        }
      });
      return next;
    });
  }, []);

  // ---- image paste (⌃V): upload to the server's /tmp/images and drop the path in ----
  // Mirrors the New Claude session composer: the server saves the image under
  // /tmp/images/<random>.<ext> and we insert that absolute path, which claude's Read
  // tool can open (no permission prompt on /tmp) and render. No preview here.
  // Non-image pastes fall through to the textarea's normal text paste.
  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgItem = Array.from(items).find(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      );
      if (!imgItem) return; // not an image — let the normal text paste happen
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (!file) return;
      const srv = server ?? (await pickServer());
      setUploading(true);
      try {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        const res = await fetch(`${srv}/api/upload-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl }),
        });
        const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!res.ok) {
          alert(`image upload failed: ${body.error ?? res.statusText}`);
          return;
        }
        if (typeof body.path === "string") insertAtCaret(`${body.path} `);
      } catch (err) {
        alert(`image upload failed: ${String((err as { message?: string })?.message ?? err)}`);
      } finally {
        setUploading(false);
      }
    },
    [server, pickServer, insertAtCaret],
  );

  // POST a finished PNG (data URL) to the same image store as paste, then drop the
  // returned path into the composer. Shared by the region and full-page shots.
  const uploadShot = useCallback(
    async (srv: string, dataUrl: string) => {
      const res = await fetch(`${srv}/api/upload-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: dataUrl }),
      });
      const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok) {
        alert(`screenshot upload failed: ${body.error ?? res.statusText}`);
        return;
      }
      if (typeof body.path === "string") {
        setExpanded(true);
        insertAtCaret(`${body.path} `);
      }
    },
    [insertAtCaret],
  );

  // Drop our overlays + composer out of the frame so they aren't in the shot, run
  // `grab` to produce the PNG (cropped region / stitched page), bring the composer
  // back, and upload it. The pixels come from the background worker's
  // captureVisibleTab (content scripts can't call it). Stays `capturing` through
  // the upload; shared error handling for both screenshot tools.
  const runShot = useCallback(
    async (grab: () => Promise<string>) => {
      const srv = server ?? (await pickServer());
      setCapturing(true);
      if (hostEl) hostEl.style.visibility = "hidden";
      if (overlayEl) overlayEl.style.display = "none";
      if (shotLayerEl) shotLayerEl.style.display = "none";
      try {
        // Let the page repaint without our UI before the first capture lands.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const png = await grab();
        if (hostEl) hostEl.style.visibility = ""; // bring the composer back for the upload
        await uploadShot(srv, png);
      } catch (err) {
        alert(`screenshot failed: ${String((err as { message?: string })?.message ?? err)}`);
      } finally {
        if (hostEl) hostEl.style.visibility = "";
        setCapturing(false);
      }
    },
    [server, pickServer, uploadShot],
  );

  // ---- screenshot tool (`s`): capture the dragged viewport region ----
  // Crop the returned full-viewport shot to the region the user dragged (in device
  // pixels, via the image's true scale so dpr/zoom are exact). `rect` is in CSS
  // viewport coords.
  const captureRegion = useCallback(
    (rect: { left: number; top: number; width: number; height: number }) =>
      runShot(async () => cropToRegion(await grabVisible(), rect)),
    [runShot],
  );

  // ---- screenshot tool (`⇧S` / page button): capture the whole scrollable page ----
  // Scrolls the page viewport-by-viewport, stitching each grab onto one tall PNG.
  // No drag — a click grabs the full page.
  const captureFullPage = useCallback(() => runShot(stitchFullPage), [runShot]);

  // ---- submit ----
  const submit = useCallback(async () => {
    const p = prompt.trim();
    if (!p || dirId == null) return;
    const srv = server ?? (await pickServer());
    setLaunching(true);
    try {
      // Prepend an <auth> block with the current user (if a probe resolved one),
      // then a <route> block (the route + the file that renders it), then an
      // <environment> block (dev vs prod, the page + route, and — in dev — license
      // to inspect the local DB), then the per-origin context template, all ahead
      // of the actual prompt.
      const auth = await ensureFreshAuth();
      const routeVal = routeInput.trim() || location.pathname;
      const fileVal = routeFile.trim();
      const parts: string[] = [];
      if (auth && Object.keys(auth).length) parts.push(authBlock(auth));
      parts.push(routeBlock(routeVal, fileVal));
      parts.push(environmentBlock(env, location.href, routeVal));
      if (contextTemplate.trim())
        parts.push(
          contextTemplate
            .replace(/\{url\}/g, location.href)
            .replace(/\{route\}/g, routeVal)
            .trim(),
        );
      const preamble = parts.length ? parts.join("\n\n") + "\n\n" : "";
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
      setExpanded(false);
      setJustSent(true);
      setTimeout(() => setJustSent(false), 1500);
      setTimeout(() => setLaunched(null), 4000);
    } finally {
      setLaunching(false);
    }
  }, [prompt, dirId, server, pickServer, contextTemplate, ensureFreshAuth, env, routeInput, routeFile]);

  // ---- visual select (cursor button / `v` inject · `V` open in $EDITOR) ----
  useEffect(() => {
    if (selectMode === null) return;
    const editorMode = selectMode === "editor";
    const overlay = ensureOverlay();
    // Tint the highlight by mode: purple drops the ref into the composer,
    // amber opens the picked element's source in $EDITOR.
    overlay.style.background = editorMode ? "rgba(245, 158, 11, 0.20)" : "rgba(110, 86, 207, 0.18)";
    overlay.style.borderColor = editorMode ? "#f59e0b" : "#6e56cf";
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
      setSelectMode(null);
      if (!el) return;
      if (editorMode) void openInEditor(el);
      else injectRef(computeRef(el));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSelectMode(null);
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
  }, [selectMode, injectRef, openInEditor]);

  // ---- screenshot drag (`s` / camera button): marquee a region, then capture ----
  // A full-viewport surface swallows the drag so the page underneath doesn't react.
  // mousedown anchors the rect, mousemove resizes it, mouseup fires the capture for
  // anything bigger than a stray click. Escape (or a tiny drag) cancels.
  useEffect(() => {
    if (!shooting) return;
    const layer = ensureShotLayer();
    const rectEl = layer.firstElementChild as HTMLDivElement;
    layer.style.display = "block";
    rectEl.style.display = "none";
    let start: { x: number; y: number } | null = null;

    const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    });
    const paint = (r: { left: number; top: number; width: number; height: number }) => {
      rectEl.style.display = "block";
      rectEl.style.left = `${r.left}px`;
      rectEl.style.top = `${r.top}px`;
      rectEl.style.width = `${r.width}px`;
      rectEl.style.height = `${r.height}px`;
    };

    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      paint(rectFrom(start, start));
    };
    const onMove = (e: MouseEvent) => {
      if (start) paint(rectFrom(start, { x: e.clientX, y: e.clientY }));
    };
    const onUp = (e: MouseEvent) => {
      if (!start) return;
      const r = rectFrom(start, { x: e.clientX, y: e.clientY });
      start = null;
      setShooting(false);
      if (r.width >= 4 && r.height >= 4) void captureRegion(r); // ignore a click, not a drag
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        start = null;
        setShooting(false);
      }
    };
    layer.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      layer.style.display = "none";
      rectEl.style.display = "none";
      layer.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [shooting, captureRegion]);

  // ---- page shortcuts: ; (or ') opens & focuses, v starts select, V starts select
  // that opens the picked element in $EDITOR, s drags a region shot, ⇧S grabs the
  // full page (all ignored while typing); Escape collapses it back to the pill
  // (handled on the textarea). ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dirId == null || selecting || shooting || capturing) return;
      // ctrl + ' also opens (mirrors the bare ' shortcut) — check before the
      // modifier guard below swallows it.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "'") {
        if (isTyping(e)) return;
        e.preventDefault();
        open();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e)) return;
      if (e.key === ";" || e.key === "'") {
        e.preventDefault();
        open();
      } else if (e.key === "v") {
        e.preventDefault();
        setSelectMode("inject");
      } else if (e.key === "V") {
        e.preventDefault();
        setSelectMode("editor");
      } else if (e.key === "s") {
        e.preventDefault();
        setShooting(true);
      } else if (e.key === "S") {
        e.preventDefault();
        void captureFullPage();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dirId, selecting, shooting, capturing, open, captureFullPage]);

  // First name for the "Logged in as …" pill (mirrors how the app first-names it),
  // falling back to the userId then a generic label. "" hides the pill.
  const loggedInName =
    authValues == null
      ? ""
      : authValues.name?.trim().split(/\s+/)[0] || authValues.userId || "user";

  if (dirId == null) return null;

  if (!expanded) {
    return (
      <button className="pill" title="Ask diffshub  ( ; )" onClick={open}>
        <SparkIcon />
        {justSent ? <CheckIcon /> : <span>Ask diffshub</span>}
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
          placeholder="Ask for a change…  (@ a file · ⌃V image · v point at an element · V open it in your editor · s screenshot a region · ⇧S full page)"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            syncFileToken(e.target);
          }}
          onPaste={(e) => void handlePaste(e)}
          onClick={(e) => syncFileToken(e.currentTarget)}
          onKeyUp={(e) => {
            if (fileMenuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
            syncFileToken(e.currentTarget);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            // ⌃; starts visual-select from inside the textarea (mirrors `v` on the page).
            if (e.key === ";" && e.ctrlKey) {
              e.preventDefault();
              setSelectMode("inject");
              return;
            }
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
      <div className="ctx">
        <span className="ctx-tag">route</span>
        <input
          className="cin route-in"
          value={routeInput}
          placeholder="/path"
          spellCheck={false}
          title="The SPA route this prompt is about — sent as the <route> path. Auto-fills from the page; edit to override."
          onChange={(e) => {
            setRouteEdited(true);
            setRouteInput(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <span className="ctx-tag">file</span>
        <input
          className="cin file-in"
          value={routeFile}
          placeholder="auto-detected from the page (or type the file that renders this route)"
          spellCheck={false}
          title="Source file that renders this route — sent as the <route> file so the session edits the right file. Auto-filled from the page's dev source locations (data-loc); edit to override."
          onChange={(e) => {
            setFileEdited(true);
            setRouteFile(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div className="toolbar">
        <button
          className={`tool${selecting ? " on" : ""}`}
          title="Point at an element  ( v insert ref · V open in editor )"
          onClick={() => setSelectMode((m) => (m ? null : "inject"))}
        >
          <CursorIcon />
        </button>
        <button
          className={`tool${shooting ? " on" : ""}`}
          title="Screenshot a region  ( s )"
          onClick={() => setShooting((v) => !v)}
        >
          <ShotIcon />
        </button>
        <button
          className="tool"
          title="Screenshot the full page  ( ⇧S )"
          disabled={capturing}
          onClick={() => void captureFullPage()}
        >
          <FullPageIcon />
        </button>
        <span className="status">
          {selecting ? (
            selectMode === "editor" ? (
              "Click an element to open in your editor · Esc to cancel"
            ) : (
              "Click an element · Esc to cancel"
            )
          ) : shooting ? (
            "Drag to screenshot a region · Esc to cancel"
          ) : capturing ? (
            "Capturing screenshot…"
          ) : uploading ? (
            "Uploading image…"
          ) : (
            <>
              {loggedInName && (
                <span
                  className="who"
                  title={
                    authValues?.name
                      ? `Logged in as ${authValues.name} — sent with your prompt`
                      : "Logged-in user is sent with your prompt"
                  }
                >
                  Logged in as {loggedInName}
                </span>
              )}
              <span
                className={`env env-${env}`}
                title={
                  env === "development"
                    ? "Development — Claude is told it may inspect the local dev database; sent with your prompt"
                    : "Production — Claude is told to treat the database as read-only; sent with your prompt"
                }
              >
                {env === "development" ? "dev" : "prod"}
              </span>
            </>
          )}
        </span>
        <button className="collapse" title="Collapse" onClick={() => setExpanded(false)}>
          ▾
        </button>
        <button
          className="send"
          disabled={launching || uploading || capturing || !prompt.trim()}
          onClick={() => void submit()}
        >
          {launching ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// The composer's prompt is mirrored to the host page's localStorage (so it's
// naturally scoped per origin) under this key, so an unsent draft survives a
// reload. Cleared on send. localStorage access is wrapped because it can throw
// in private mode / when storage is disabled — drafts are best-effort.
const DRAFT_KEY = "diffshub-ext:draft";

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore — private mode / quota / storage disabled
  }
}

// Best-guess source file for the current screen, read from the page's dev
// `data-loc` attributes (path:line:col) — the same baked-in source mapping the
// visual-select / "open in editor" actions rely on. A route's own JSX authors most
// of the screen's structure, so we tally the file (the path before :line:col)
// across every located element and return the most common one; shared leaf
// components point at their own files and fall away. Ties break toward the file
// seen first (shallowest) in the document. Returns null when the page carries no
// source locations (a production build), so the file field stays manual.
function detectRouteFile(): string | null {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const el of document.querySelectorAll("[data-loc]")) {
    const m = el.getAttribute("data-loc")?.match(/^(.*):\d+:\d+$/);
    if (!m) continue;
    const file = m[1];
    counts.set(file, (counts.get(file) ?? 0) + 1);
    if (!firstSeen.has(file)) firstSeen.set(file, order++);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [file, count] of counts) {
    if (count > bestCount || (count === bestCount && firstSeen.get(file)! < firstSeen.get(best!)!)) {
      best = file;
      bestCount = count;
    }
  }
  return best;
}

// The current route (location.pathname), kept live across SPA navigations. The
// host page may push history without a full load, so we patch pushState/replaceState
// (restored on unmount) and also listen for popstate/hashchange.
function useRoute(): string {
  const [route, setRoute] = useState(location.pathname);
  useEffect(() => {
    const update = () => setRoute(location.pathname);
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) {
      origPush.apply(this, args as Parameters<typeof origPush>);
      update();
    };
    history.replaceState = function (...args) {
      origReplace.apply(this, args as Parameters<typeof origReplace>);
      update();
    };
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  return route;
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

// The screenshot tool's drag surface: a full-viewport layer (cursor crosshair)
// that swallows the marquee drag, holding a single child rect that tracks it.
function ensureShotLayer(): HTMLDivElement {
  if (shotLayerEl) return shotLayerEl;
  const layer = document.createElement("div");
  layer.id = "diffshub-ext-shotlayer";
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    cursor: "crosshair",
    background: "rgba(24, 24, 27, 0.06)",
    display: "none",
  } as Partial<CSSStyleDeclaration>);
  const rect = document.createElement("div");
  Object.assign(rect.style, {
    position: "fixed",
    background: "rgba(110, 86, 207, 0.14)",
    border: "2px solid #6e56cf",
    borderRadius: "2px",
    boxShadow: "0 0 0 100vmax rgba(24, 24, 27, 0.12)",
    pointerEvents: "none",
    display: "none",
  } as Partial<CSSStyleDeclaration>);
  layer.appendChild(rect);
  document.documentElement.appendChild(layer);
  shotLayerEl = layer;
  return layer;
}

// Crop a full-viewport capture (data URL) to a CSS-pixel viewport region. The
// capture is at the tab's true pixel scale, so derive it from naturalWidth /
// innerWidth (handles devicePixelRatio and browser zoom exactly) rather than
// assuming a value. Returns a PNG data URL of just the region.
function cropToRegion(
  dataUrl: string,
  rect: { left: number; top: number; width: number; height: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.naturalWidth / window.innerWidth;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(rect.width * scale));
      canvas.height = Math.max(1, Math.round(rect.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(
        img,
        rect.left * scale,
        rect.top * scale,
        rect.width * scale,
        rect.height * scale,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("could not decode capture"));
    img.src = dataUrl;
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Grab the visible tab as a PNG data URL off the background worker, retrying a
// couple of times on a capture-quota error (captureVisibleTab is rate-limited).
async function grabVisible(): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const resp = (await chrome.runtime.sendMessage({ type: "diffshub-capture" })) as {
      dataUrl?: string;
      error?: string;
    };
    if (resp?.dataUrl) return resp.dataUrl;
    if (attempt >= 3) throw new Error(resp?.error ?? "no image returned");
    await sleep(700); // back off the captureVisibleTab quota, then retry
  }
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode capture"));
    img.src = dataUrl;
  });
}

// Capture the entire scrollable page: scroll it down a viewport at a time,
// grab each visible frame, and stitch them onto one tall canvas at the tab's
// true pixel scale (so dpr / browser-zoom stay exact, like cropToRegion).
// captureVisibleTab is rate-limited, so we pace the grabs; position:fixed /
// sticky elements paint into every frame, so they repeat down the stitched
// image — an inherent limit of scroll-and-stitch we accept here. The original
// scroll position is restored when done. Returns a PNG data URL.
async function stitchFullPage(): Promise<string> {
  const de = document.documentElement;
  const body = document.body;
  const viewportH = window.innerHeight;
  const fullH = Math.max(
    de.scrollHeight,
    de.offsetHeight,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
    viewportH,
  );
  const prevX = window.scrollX;
  const prevY = window.scrollY;
  const prevBehavior = de.style.scrollBehavior;
  de.style.scrollBehavior = "auto"; // no smooth-scroll animation between grabs

  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let scale = 1; // device-pixels per CSS-pixel, fixed from the first frame
  try {
    let target = 0;
    for (let guard = 0; guard < 200; guard++) {
      // Hard stop at 200 frames so a runaway/infinite-scroll page can't hang us.
      window.scrollTo(0, target);
      // Let the page paint at the new offset, then stay under the capture quota.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await sleep(CAPTURE_INTERVAL_MS);
      const y = window.scrollY; // real (clamped) offset
      const img = await decodeImage(await grabVisible());
      if (!canvas) {
        scale = img.naturalWidth / window.innerWidth;
        canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = Math.max(1, Math.round(fullH * scale));
        ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
      }
      ctx!.drawImage(img, 0, Math.round(y * scale));
      if (y + viewportH >= fullH - 1) break; // reached the bottom
      const next = y + viewportH;
      if (next <= target) break; // scroll didn't advance — bail rather than loop
      target = next;
    }
    if (!canvas) throw new Error("nothing captured");
    return canvas.toDataURL("image/png");
  } finally {
    de.style.scrollBehavior = prevBehavior;
    window.scrollTo(prevX, prevY);
  }
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0l1.7 5.1a2 2 0 0 0 1.2 1.2L16 8l-5.1 1.7a2 2 0 0 0-1.2 1.2L8 16l-1.7-5.1a2 2 0 0 0-1.2-1.2L0 8l5.1-1.7a2 2 0 0 0 1.2-1.2L8 0z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="check"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3.5 3.5L13 4.5" />
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

// A marquee / crop frame: dashed corners around an empty center.
function ShotIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6.5V4.5A1.5 1.5 0 0 1 4.5 3h2" />
      <path d="M13.5 3h2A1.5 1.5 0 0 1 17 4.5v2" />
      <path d="M17 13.5v2a1.5 1.5 0 0 1-1.5 1.5h-2" />
      <path d="M6.5 17h-2A1.5 1.5 0 0 1 3 15.5v-2" />
    </svg>
  );
}

// A page/document: a tall framed rectangle with content lines — "the whole page".
function FullPageIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="2.5" width="12" height="15" rx="1.6" />
      <path d="M7 6.5h6" />
      <path d="M7 10h6" />
      <path d="M7 13.5h3.5" />
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
.pill svg.check { width: 15px; height: 15px; color: #4ade80; }
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
.ctx { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 0 2px; }
.ctx-tag {
  flex-shrink: 0; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
  color: #a1a1aa;
}
.cin {
  min-width: 0; font: inherit; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px; color: #3f3f46;
  background: #f9f9fb; border: 1px solid #e4e4e7; border-radius: 6px; padding: 3px 7px; outline: none;
}
.cin::placeholder { color: #c4c4cc; }
.cin:focus { border-color: #6e56cf; background: #fff; }
.cin.route-in { flex: 1; }
.cin.file-in { flex: 2; }
.status .who {
  flex-shrink: 0; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; font-weight: 500; color: #15803d;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; padding: 1px 6px;
}
.status .env {
  flex-shrink: 0; text-transform: uppercase; letter-spacing: .04em;
  font-size: 9px; font-weight: 600; border-radius: 4px; padding: 1px 6px;
}
.status .env-development { color: #4338ca; background: #eef2ff; border: 1px solid #c7d2fe; }
.status .env-production { color: #b45309; background: #fffbeb; border: 1px solid #fde68a; }
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
