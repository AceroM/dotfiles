// Shared types + chrome.storage helpers for the diffshub extension.
//
// The site→directory mapping and the diffshub server URL live in
// chrome.storage.local; the server itself stays untouched (it only adds CORS).

// Minimal ambient declaration for the slice of the Chrome API we use (a real
// browser global on every page) — avoids a dependency on @types/chrome.
declare global {
  const chrome: {
    storage: {
      local: {
        get(keys: string[] | string | null): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
      };
      onChanged: {
        addListener(cb: (changes: Record<string, unknown>, area: string) => void): void;
      };
    };
    runtime: { getURL(path: string): string };
    tabs: { query(q: { active: boolean; currentWindow: boolean }): Promise<{ url?: string }[]> };
  };
}

export const DEFAULT_SERVER = "http://localhost:3433";

// Seed preamble for a production origin — tells the launched session it's looking
// at the live deploy (not local dev) and can stream logs with `wrangler tail`.
// {url} is substituted with the page URL when the prompt is sent.
export const DEFAULT_PROD_CONTEXT = `<context>
This request comes from the PRODUCTION deploy (Cloudflare Workers), not local dev.
Live page: {url}
- Stream live logs with \`wrangler tail\` (run from the app dir).
- The source is this repo; edit here, then ship via the normal deploy.
</context>`;

export interface DirEntry {
  id: number;
  path: string;
  name: string;
  repos: string[];
}

export interface Config {
  serverUrl: string;
  // Reachable when Chrome isn't on the diffshub host (e.g. a tailscale HTTPS URL);
  // the content script probes serverUrl first and falls back to this.
  fallbackServerUrl?: string;
  // origin (scheme://host[:port]) → directory id
  mappings: Record<string, number>;
  // origin → context preamble prepended to prompts ({url} → the page URL)
  contexts?: Record<string, string>;
}

export async function getConfig(): Promise<Config> {
  const s = await chrome.storage.local.get([
    "serverUrl",
    "fallbackServerUrl",
    "mappings",
    "contexts",
  ]);
  return {
    serverUrl: (s.serverUrl as string) || DEFAULT_SERVER,
    fallbackServerUrl: (s.fallbackServerUrl as string) || "",
    mappings: (s.mappings as Record<string, number>) || {},
    contexts: (s.contexts as Record<string, string>) || {},
  };
}

export async function setMapping(origin: string, dirId: number | null): Promise<void> {
  const { mappings } = await getConfig();
  if (dirId == null) delete mappings[origin];
  else mappings[origin] = dirId;
  await chrome.storage.local.set({ mappings });
}

export async function setServerUrl(serverUrl: string): Promise<void> {
  await chrome.storage.local.set({ serverUrl: serverUrl.replace(/\/+$/, "") });
}

export async function setFallbackServerUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ fallbackServerUrl: url.replace(/\/+$/, "") });
}

export async function setContext(origin: string, template: string): Promise<void> {
  const { contexts } = await getConfig();
  const map = contexts ?? {};
  if (template.trim()) map[origin] = template;
  else delete map[origin];
  await chrome.storage.local.set({ contexts: map });
}
