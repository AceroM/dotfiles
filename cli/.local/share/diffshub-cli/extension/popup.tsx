// Toolbar popup: assign the active tab's site to a diffshub directory (or "none").
// The mapping lives in chrome.storage.local; the content script reacts to it.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  getConfig,
  setMapping,
  setServerUrl,
  setFallbackServerUrl,
  setContext,
  setAuth,
  DEFAULT_SERVER,
  DEFAULT_PROD_CONTEXT,
  AUTH_PROBE_EXAMPLE,
  type DirEntry,
} from "./api";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// A public https origin (not localhost / loopback / tailnet dev) — i.e. a real
// production site, where we seed the prod context template on first mapping.
function isProdish(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    if (u.hostname.endsWith(".ts.net")) return false;
    return !/^(localhost|127\.|0\.0\.0\.0$|\[?::1)/.test(u.hostname);
  } catch {
    return false;
  }
}

function Popup() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [serverUrl, setUrl] = useState(DEFAULT_SERVER);
  const [urlInput, setUrlInput] = useState(DEFAULT_SERVER);
  const [mapped, setMapped] = useState<number | null>(null);
  // All site→dir mappings, so we can show the other origins that already open the
  // same directory — that's how one app reachable at both localhost and a tailscale
  // URL "supports both": map each origin here once and they share everything else.
  const [mappings, setMappings] = useState<Record<string, number>>({});
  const [fallbackInput, setFallbackInput] = useState("");
  const [contextInput, setContextInput] = useState("");
  const [authInput, setAuthInput] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await getConfig();
      setUrl(cfg.serverUrl);
      setUrlInput(cfg.serverUrl);
      setFallbackInput(cfg.fallbackServerUrl ?? "");
      setMappings(cfg.mappings);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      let org: string | null = null;
      try {
        org = tabs[0]?.url ? new URL(tabs[0].url).origin : null;
      } catch {
        org = null;
      }
      setOrigin(org);
      setMapped(org && cfg.mappings[org] != null ? cfg.mappings[org] : null);
      setContextInput(org ? (cfg.contexts?.[org] ?? "") : "");
      setAuthInput(org ? (cfg.auths?.[org] ?? "") : "");
      setReady(true);
    })();
  }, []);

  const dirsQuery = useQuery({
    queryKey: ["dirs", serverUrl],
    queryFn: async () => {
      const res = await fetch(`${serverUrl}/api/dirs`);
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { dirs: DirEntry[]; defaultDirId: number };
    },
  });

  const mappable = !!origin && /^https?:/.test(origin);

  const onPick = async (val: string) => {
    if (!origin) return;
    const id = val === "" ? null : Number(val);
    setMapped(id);
    setMappings((m) => {
      const next = { ...m };
      if (id == null) delete next[origin];
      else next[origin] = id;
      return next;
    });
    await setMapping(origin, id);
    // First time mapping a production-looking origin, seed the prod context so
    // launched sessions know they're hitting the live deploy (and can wrangler tail).
    if (id != null && isProdish(origin) && !contextInput.trim()) {
      setContextInput(DEFAULT_PROD_CONTEXT);
      await setContext(origin, DEFAULT_PROD_CONTEXT);
    }
  };

  // Other origins already pointing at the selected directory.
  const alsoMapped =
    mapped == null
      ? []
      : Object.keys(mappings).filter((o) => o !== origin && mappings[o] === mapped);
  const mappedName = dirsQuery.data?.dirs.find((d) => d.id === mapped)?.name;

  const commitUrl = async () => {
    const clean = urlInput.replace(/\/+$/, "");
    setUrlInput(clean);
    setUrl(clean);
    await setServerUrl(clean);
  };

  const commitFallback = async () => {
    const clean = fallbackInput.replace(/\/+$/, "");
    setFallbackInput(clean);
    await setFallbackServerUrl(clean);
  };

  const commitContext = async () => {
    if (!origin) return;
    await setContext(origin, contextInput);
  };

  const commitAuth = async () => {
    if (!origin) return;
    await setAuth(origin, authInput);
  };

  return (
    <>
      <h1>diffshub</h1>
      <div className="origin">{origin ?? "no active tab"}</div>

      <label>Directory for this site</label>
      <select
        value={mapped == null ? "" : String(mapped)}
        disabled={!ready || !mappable || dirsQuery.isPending}
        onChange={(e) => void onPick(e.target.value)}
      >
        <option value="">none</option>
        {dirsQuery.data?.dirs.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      {!mappable && ready && <div className="note">This page can't be mapped (not http/https).</div>}
      {mapped != null &&
        (alsoMapped.length ? (
          <div className="note">
            <b>{mappedName}</b> also opens from:{"\n"}
            {alsoMapped.join("\n")}
          </div>
        ) : (
          <div className="note">
            Reach the same app from another URL (e.g. your tailscale host)? Open it and map it to{" "}
            <b>{mappedName}</b> here too — both URLs then share this directory.
          </div>
        ))}
      {mapped != null && (
        <>
          <label>Context injected into prompts</label>
          <textarea
            className="ctx"
            rows={5}
            placeholder="Optional preamble prepended to every prompt on this site. Use {url} for the page URL and {route} for the path."
            value={contextInput}
            onChange={(e) => setContextInput(e.target.value)}
            onBlur={() => void commitContext()}
          />

          <label>Logged-in user probe</label>
          <textarea
            className="ctx"
            rows={5}
            spellCheck={false}
            placeholder={AUTH_PROBE_EXAMPLE}
            value={authInput}
            onChange={(e) => setAuthInput(e.target.value)}
            onBlur={() => void commitAuth()}
          />
          <div className="note">
            Fetched same-origin with cookies to read the current user. First line is{" "}
            <b>[METHOD] url</b>, then <b>key: json.path</b> lines. Resolved fields ride along with
            each prompt as an <b>&lt;auth&gt;</b> block; <b>name</b> drives the “Logged in as …” pill.
          </div>
        </>
      )}

      {dirsQuery.isError && (
        <div className="err">
          Can't reach diffshub at {serverUrl}
          {"\n"}
          {String((dirsQuery.error as { message?: string })?.message ?? "")}
        </div>
      )}

      <label>diffshub server</label>
      <input
        value={urlInput}
        placeholder={DEFAULT_SERVER}
        onChange={(e) => setUrlInput(e.target.value)}
        onBlur={() => void commitUrl()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitUrl();
        }}
      />

      <label>Fallback server (remote / tailscale)</label>
      <input
        value={fallbackInput}
        placeholder="https://host.tail88635d.ts.net:8443"
        onChange={(e) => setFallbackInput(e.target.value)}
        onBlur={() => void commitFallback()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitFallback();
        }}
      />

      <div className="hint">
        On a mapped site a composer pins to the bottom — <kbd>'</kbd> focus · <kbd>v</kbd> point at an element
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Popup />
  </QueryClientProvider>,
);
