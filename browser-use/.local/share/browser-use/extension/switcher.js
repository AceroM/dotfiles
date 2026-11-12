// The human's tab switcher (`ctab`): every tab in the browser, not just the Agents group.
//
// None of these touch chrome.debugger, so browsing tabs with ctab never puts up Chrome's
// "started debugging this browser" bar, and they don't take tabs over the way the agent commands
// in background.js do. The browser-use CLI doesn't expose them; agents keep to the gated commands.

// Cached thumbnails are at most this wide (pixels); one per tab, for this many tabs. Wide enough
// for ctab to draw them as real pictures (Kitty graphics) across most of a terminal.
const THUMB_W = 1600;
const THUMB_CAP = 120;
// A tab showing in a window gets a fresh thumbnail when ctab peeks and the last is older than this.
const THUMB_FRESH_MS = 3000;

// tabId → { blob, at, rev, url }: `at` when it was taken, `rev` when the picture last changed (a
// re-take of an unchanged page keeps it, so ctab needn't resend the same image). Lives as long as
// the worker, which the native port keeps alive.
const thumbs = new Map();

// ---------------------------------------------------------------- thumbnails

// captureVisibleTab only sees the tab a window is showing, at most twice a second, so take one
// whenever a tab is the one on screen: when it's switched to, when it finishes loading, when its
// window comes forward. Debounced per window so tabbing through quickly takes one shot at the end.
const timers = new Map(); // windowId → timeout

function scheduleCapture(windowId, delay = 400) {
  clearTimeout(timers.get(windowId));
  timers.set(
    windowId,
    setTimeout(() => {
      timers.delete(windowId);
      capture(windowId);
    }, delay),
  );
}

async function capture(windowId) {
  try {
    const win = await chrome.windows.get(windowId);
    if (win.state === "minimized") return;
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (!tab || tab.status !== "complete") return;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 });
    // A switch during the capture would file this shot under the wrong tab.
    const [now] = await chrome.tabs.query({ windowId, active: true });
    if (now?.id !== tab.id) return;
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, THUMB_W / bmp.width);
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const prev = thumbs.get(tab.id);
    const same = prev && prev.url === tab.url && (await sameBytes(prev.blob, blob));
    const at = Date.now();
    thumbs.delete(tab.id);
    thumbs.set(tab.id, same ? { ...prev, at } : { blob, at, rev: at, url: tab.url });
    while (thumbs.size > THUMB_CAP) thumbs.delete(thumbs.keys().next().value);
  } catch {
    // chrome:// pages, the Web Store, a window that went away: no thumbnail, nothing to report.
  }
}

async function sameBytes(a, b) {
  if (a.size !== b.size) return false;
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]).then((bs) => bs.map((b) => new Uint8Array(b)));
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

chrome.tabs.onActivated.addListener(({ windowId }) => scheduleCapture(windowId));
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.active) scheduleCapture(tab.windowId, 600);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleCapture(windowId);
});
chrome.tabs.onRemoved.addListener((tabId) => thumbs.delete(tabId));

// The cached thumbnail scaled to fit w×h pixels, as raw RGB (base64), so ctab needs no image decoder.
async function thumbPixels(tabId, w, h) {
  const t = thumbs.get(tabId);
  if (!t || !(w > 0) || !(h > 0)) return null;
  const bmp = await createImageBitmap(t.blob);
  const s = Math.min(w / bmp.width, h / bmp.height);
  const tw = Math.max(1, Math.round(bmp.width * s));
  const th = Math.max(1, Math.round(bmp.height * s));
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, tw, th);
  const rgba = ctx.getImageData(0, 0, tw, th).data;
  const rgb = new Uint8Array(tw * th * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { w: tw, h: th, rgb: base64(rgb), at: t.at, url: t.url };
}

// The cached thumbnail as a PNG (base64) no bigger than w×h pixels, for a terminal that draws
// images: ctab passes it straight to the terminal (Kitty graphics, f=100). `have` is the `rev` of
// the copy ctab already holds; while the picture is unchanged, only that is said.
async function thumbPng(tabId, w, h, have) {
  const t = thumbs.get(tabId);
  if (!t || !(w > 0) || !(h > 0)) return null;
  if (have != null && Number(have) === t.rev) return { same: true, at: t.at, rev: t.rev };
  const bmp = await createImageBitmap(t.blob);
  const s = Math.min(1, w / bmp.width, h / bmp.height);
  const tw = Math.max(1, Math.round(bmp.width * s));
  const th = Math.max(1, Math.round(bmp.height * s));
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, tw, th);
  bmp.close();
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  return { w: tw, h: th, png: base64(png), at: t.at, rev: t.rev, url: t.url };
}

function base64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------------------------------------------------------- commands

export const SWITCHER = {
  // Every tab, with its window and group, in no particular order (ctab sorts).
  async "switcher.tabs"() {
    const [tabs, windows, groups, { owners = {} }] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll(),
      chrome.tabGroups.query({}),
      chrome.storage.local.get("owners"),
    ]);
    return {
      windows: windows.map((w) => ({ id: w.id, focused: w.focused, type: w.type, incognito: w.incognito, state: w.state })),
      groups: groups.map((g) => ({ id: g.id, title: g.title ?? "", color: g.color, collapsed: g.collapsed, windowId: g.windowId })),
      tabs: tabs.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        index: t.index,
        title: t.title ?? "",
        url: t.url || t.pendingUrl || "",
        active: t.active,
        pinned: t.pinned,
        audible: !!t.audible,
        muted: !!t.mutedInfo?.muted,
        discarded: !!t.discarded,
        status: t.status ?? "",
        groupId: t.groupId,
        lastAccessed: t.lastAccessed ?? 0,
        owner: owners[t.id] ?? null,
        thumbAt: thumbs.get(t.id)?.at ?? null,
      })),
    };
  },

  // What a tab shows: its thumbnail scaled to fit w×h, raw RGB for ctab's half blocks or a PNG
  // (fmt "png") when its terminal draws images. The page itself is never read.
  async "switcher.peek"(args) {
    const tab = await chrome.tabs.get(Number(args.tab));
    const t = thumbs.get(tab.id);
    if (tab.active && tab.status === "complete" && (!t || Date.now() - t.at > THUMB_FRESH_MS)) {
      await capture(tab.windowId);
    }
    const out = { id: tab.id, url: tab.url ?? "", error: null, thumb: null };
    const [w, h] = [Number(args.w), Number(args.h)];
    const shot = args.fmt === "png" ? thumbPng(tab.id, w, h, args.have) : thumbPixels(tab.id, w, h);
    out.thumb = await shot.catch(() => null);
    if (tab.discarded) out.error = "asleep: Chrome unloaded this tab to save memory · ⏎ wakes it";
    return out;
  },

  // Bring a tab and its window to the front.
  async "switcher.focus"(args) {
    const tab = await chrome.tabs.update(Number(args.tab), { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { focused: tab.id };
  },

  // Tabs that are already gone count as closed, so one stale id doesn't fail the whole batch.
  async "switcher.close"(args) {
    const ids = (Array.isArray(args.tabs) ? args.tabs : [args.tab]).map(Number);
    const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const closing = ids.filter((id) => open.has(id));
    if (closing.length) await chrome.tabs.remove(closing);
    return { closed: closing };
  },

  // tg: take tabs out of their groups. Ungrouping every tab of a saved group deletes the saved
  // group too (Chrome's own Ungroup does the same), while the tabs stay open. Tabs that are gone
  // or already loose are skipped.
  async "switcher.ungroup"(args) {
    const ids = (Array.isArray(args.tabs) ? args.tabs : [args.tab]).map(Number);
    const grouped = new Set((await chrome.tabs.query({})).filter((t) => t.groupId >= 0).map((t) => t.id));
    const ungrouping = ids.filter((id) => grouped.has(id));
    if (ungrouping.length) await chrome.tabs.ungroup(ungrouping);
    return { ungrouped: ungrouping };
  },

  // tg's undo: put tabs back into one new group with this title and color. The tabs have to be in
  // one window; any that are gone are skipped.
  async "switcher.group"(args) {
    const open = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
    const ids = (Array.isArray(args.tabs) ? args.tabs : [args.tab]).map(Number).filter((id) => open.has(id));
    if (!ids.length) throw new Error("none of those tabs are open");
    // Without a window, Chrome makes the group in the window in front and moves the tabs there.
    const windowId = open.get(ids[0]).windowId;
    const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
    const props = { collapsed: false };
    if (typeof args.title === "string") props.title = args.title;
    if (args.color) props.color = String(args.color);
    await chrome.tabGroups.update(groupId, props);
    return { groupId, tabs: ids };
  },

  // tg: a New Tab window of its own, so the bookmarks bar (where Chrome keeps saved tab groups)
  // shows: Chrome draws that bar only for a New Tab page. It opens behind, unfocused, as wide as
  // the window you used last, and `close` takes it away again. Only a window this command opened
  // can be closed with it.
  async "switcher.scratch"(args) {
    if (args.close != null) {
      const { scratch = [] } = await chrome.storage.session.get("scratch");
      const id = Number(args.close);
      if (!scratch.includes(id)) throw new Error(`window ${id} isn't a scratch window`);
      await chrome.windows.remove(id).catch(() => {});
      await chrome.storage.session.set({ scratch: scratch.filter((w) => w !== id) });
      return { closed: id };
    }
    let near;
    try {
      near = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    } catch {}
    const props = { url: "chrome://newtab/", focused: false, type: "normal" };
    if (near?.state === "normal") Object.assign(props, { left: near.left, top: near.top, width: Math.max(near.width, 1200), height: Math.max(Math.min(near.height, 600), 300) });
    const win = await chrome.windows.create(props);
    const { scratch = [] } = await chrome.storage.session.get("scratch");
    await chrome.storage.session.set({ scratch: [...scratch, win.id] });
    return { windowId: win.id, tabId: win.tabs?.[0]?.id ?? null };
  },

  // ct's undo: open closed tabs again where they were (window, position, group, pinned), in the
  // background. Each is a fresh tab at the same URL, so its back/forward history is gone. A window
  // that has since closed sends its tabs to the current window, ungrouped.
  async "switcher.reopen"(args) {
    const want = Array.isArray(args.tabs) ? args.tabs : [];
    const [windows, groups] = await Promise.all([chrome.windows.getAll(), chrome.tabGroups.query({})]);
    const wins = new Set(windows.filter((w) => w.type === "normal").map((w) => w.id));
    const grps = new Set(groups.map((g) => g.id));
    // Left to right in each window, so every tab lands back at its old index.
    const order = [...want].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    const opened = [];
    const failed = [];
    for (const t of order) {
      const props = { url: String(t.url), active: false, pinned: !!t.pinned };
      if (wins.has(t.windowId)) {
        props.windowId = t.windowId;
        if (t.index >= 0) props.index = t.index;
      }
      try {
        const tab = await chrome.tabs.create(props);
        if (t.groupId >= 0 && grps.has(t.groupId) && tab.windowId === t.windowId && !t.pinned) {
          await chrome.tabs.group({ groupId: t.groupId, tabIds: [tab.id] }).catch(() => {});
        }
        opened.push(tab.id);
      } catch (e) {
        failed.push({ url: t.url, error: String(e?.message ?? e) });
      }
    }
    return { opened, failed };
  },
};
