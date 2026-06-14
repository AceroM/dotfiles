// Always-on content script (no React — kept tiny). On a site mapped to a diffshub
// directory it lazy-loads bar.js and mounts the persistent bottom-center composer;
// when the mapping is removed it tears it down. Everything else — the composer,
// @-file autocomplete, visual-select, and the ' / v shortcuts — lives in bar.tsx.

import { getConfig } from "./api";

type BarModule = typeof import("./bar");

let barMod: BarModule | null = null;
let unmount: (() => void) | null = null;

async function sync() {
  const cfg = await getConfig();
  const mapped = cfg.mappings[location.origin] != null;
  if (mapped && !unmount) {
    barMod ??= (await import(chrome.runtime.getURL("bar.js"))) as BarModule;
    unmount = barMod.mount();
  } else if (!mapped && unmount) {
    unmount();
    unmount = null;
  }
}

void sync();
chrome.storage.onChanged.addListener(() => void sync());
