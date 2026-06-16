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

// Placeholder shown in the popup's auth-probe textarea — documents the format and
// gives a copy-pasteable starting point for a better-auth app (e.g. porio).
export const AUTH_PROBE_EXAMPLE = `GET /api/auth/get-session
name: user.name
userId: user.id
orgId: session.activeOrganizationId`;

export interface Config {
  serverUrl: string;
  // Reachable when Chrome isn't on the diffshub host (e.g. a tailscale HTTPS URL);
  // the content script probes serverUrl first and falls back to this.
  fallbackServerUrl?: string;
  // origin (scheme://host[:port]) → directory id
  mappings: Record<string, number>;
  // origin → context preamble prepended to prompts ({url} → the page URL)
  contexts?: Record<string, string>;
  // origin → auth-probe config: a same-origin endpoint + key:json.path mappings the
  // content script fetches (with cookies) to read the logged-in user. See parseAuthProbe.
  auths?: Record<string, string>;
}

export async function getConfig(): Promise<Config> {
  const s = await chrome.storage.local.get([
    "serverUrl",
    "fallbackServerUrl",
    "mappings",
    "contexts",
    "auths",
  ]);
  return {
    serverUrl: (s.serverUrl as string) || DEFAULT_SERVER,
    fallbackServerUrl: (s.fallbackServerUrl as string) || "",
    mappings: (s.mappings as Record<string, number>) || {},
    contexts: (s.contexts as Record<string, string>) || {},
    auths: (s.auths as Record<string, string>) || {},
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

export async function setAuth(origin: string, probe: string): Promise<void> {
  const { auths } = await getConfig();
  const map = auths ?? {};
  if (probe.trim()) map[origin] = probe;
  else delete map[origin];
  await chrome.storage.local.set({ auths: map });
}

// ---- Auth probe ----
// A per-origin recipe for reading the logged-in user straight from the page. MV3
// content scripts can't eval arbitrary JS, so instead of a code snippet the probe
// is a tiny declarative format: a `[METHOD] url` line, then `key: json.path` lines.
// The content script fetches the URL same-origin (so the app's session cookie —
// httpOnly or not — rides along) and pulls each path out of the JSON response.
//
//   GET /api/auth/get-session
//   name: user.name
//   userId: user.id
//   orgId: session.activeOrganizationId
//
// → fetch("/api/auth/get-session") → { name, userId, orgId }. Lines starting with
// # are comments. The fields are arbitrary — whatever keys you map become the keys
// in the <auth> block sent with the prompt and the source of the "Logged in as …" pill.
export interface AuthProbe {
  method: string;
  url: string;
  fields: { key: string; path: string }[];
}

export function parseAuthProbe(text: string): AuthProbe | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return null;
  const m = lines[0].match(/^([A-Z]+)\s+(\S.*)$/);
  const method = m ? m[1] : "GET";
  const url = (m ? m[2] : lines[0]).trim();
  const fields = lines.slice(1).flatMap((l) => {
    const i = l.indexOf(":");
    if (i < 0) return [];
    const key = l.slice(0, i).trim();
    const path = l.slice(i + 1).trim();
    return key && path ? [{ key, path }] : [];
  });
  if (!url || !fields.length) return null;
  return { method, url, fields };
}

// Read a dot-path ("session.activeOrganizationId") out of a parsed JSON value.
function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc != null && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

// Run a probe against the current page (relative URL → same origin, cookies sent).
// Returns the resolved field map, or null when the request fails or nothing
// resolves (e.g. get-session returns null for a logged-out user).
export async function runAuthProbe(probe: AuthProbe): Promise<Record<string, string> | null> {
  let res: Response;
  try {
    res = await fetch(probe.url, {
      method: probe.method,
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data == null) return null;
  const out: Record<string, string> = {};
  for (const f of probe.fields) {
    const v = readPath(data, f.path);
    if (v != null && v !== "") out[f.key] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

// The <auth> preamble block folded into the prompt on send — one `key: value` line
// per resolved field, in the order they were mapped.
export function authBlock(values: Record<string, string>): string {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `<auth>\n${body}\n</auth>`;
}

// ---- Resolved-identity cache (stale-while-revalidate) ----
// Persisted per origin so the "Logged in as …" pill paints instantly on load while
// the content script revalidates in the background.
export interface AuthCacheEntry {
  values: Record<string, string>;
  ts: number;
}

export async function getAuthCache(origin: string): Promise<AuthCacheEntry | null> {
  const s = await chrome.storage.local.get(["authCache"]);
  const map = (s.authCache as Record<string, AuthCacheEntry>) || {};
  return map[origin] ?? null;
}

export async function setAuthCache(origin: string, entry: AuthCacheEntry | null): Promise<void> {
  const s = await chrome.storage.local.get(["authCache"]);
  const map = (s.authCache as Record<string, AuthCacheEntry>) || {};
  if (entry) map[origin] = entry;
  else delete map[origin];
  await chrome.storage.local.set({ authCache: map });
}
