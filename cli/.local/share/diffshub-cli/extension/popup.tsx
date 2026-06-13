// Toolbar popup: assign the active tab's site to a diffshub directory (or "none").
// The mapping lives in chrome.storage.local; the content script reacts to it.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { getConfig, setMapping, setServerUrl, DEFAULT_SERVER, type DirEntry } from "./api";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Popup() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [serverUrl, setUrl] = useState(DEFAULT_SERVER);
  const [urlInput, setUrlInput] = useState(DEFAULT_SERVER);
  const [mapped, setMapped] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await getConfig();
      setUrl(cfg.serverUrl);
      setUrlInput(cfg.serverUrl);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      let org: string | null = null;
      try {
        org = tabs[0]?.url ? new URL(tabs[0].url).origin : null;
      } catch {
        org = null;
      }
      setOrigin(org);
      setMapped(org && cfg.mappings[org] != null ? cfg.mappings[org] : null);
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
    await setMapping(origin, id);
  };

  const commitUrl = async () => {
    const clean = urlInput.replace(/\/+$/, "");
    setUrlInput(clean);
    setUrl(clean);
    await setServerUrl(clean);
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

      <div className="hint">
        On a mapped site: <kbd>'</kbd> new Claude session · <kbd>v</kbd> visual-select an element
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Popup />
  </QueryClientProvider>,
);
