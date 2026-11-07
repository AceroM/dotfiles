// Always-on content script (no React — kept tiny). On a site mapped to a diffshub
// directory it lazy-loads bar.js and mounts the persistent bottom-center composer;
// when the mapping is removed it tears it down. Everything else — the composer,
// @-file autocomplete, visual-select, and the ; / v shortcuts — lives in bar.tsx.

import { getConfig, isContextInvalidated } from "./api";

type BarModule = typeof import("./bar");

let barMod: BarModule | null = null;
let unmount: (() => void) | null = null;

async function sync() {
  try {
    const cfg = await getConfig();
    const mapped = cfg.mappings[location.origin] != null;
    if (mapped && !unmount) {
      barMod ??= (await import(chrome.runtime.getURL("bar.js"))) as BarModule;
      unmount = barMod.mount();
    } else if (!mapped && unmount) {
      unmount();
      unmount = null;
    }
  } catch (err) {
    // Reloaded the unpacked extension while this tab still ran the old script —
    // chrome.* is dead until the tab reloads. Ignore; anything else is a real bug.
    if (!isContextInvalidated(err)) throw err;
  }
}

void sync();
try {
  chrome.storage.onChanged.addListener(() => void sync());
} catch {
  // dead extension context — the tab will reload and re-inject a fresh script
}
