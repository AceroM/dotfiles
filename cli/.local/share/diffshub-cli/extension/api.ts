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

export interface DirEntry {
  id: number;
  path: string;
  name: string;
  repos: string[];
}

export interface Config {
  serverUrl: string;
  // origin (scheme://host[:port]) → directory id
  mappings: Record<string, number>;
}

export async function getConfig(): Promise<Config> {
  const s = await chrome.storage.local.get(["serverUrl", "mappings"]);
  return {
    serverUrl: (s.serverUrl as string) || DEFAULT_SERVER,
    mappings: (s.mappings as Record<string, number>) || {},
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
