// browser-use service worker.
//
// Bridges the local `browser-use` CLI to this browser: CLI → unix socket → native host (host.ts,
// launched by the browser through connectNative) → this worker → chrome.tabs / chrome.debugger.
// Agents work inside one shared tab group titled "Agents", so every Claude/Codex session (and the
// human) sees the same tabs.

const HOST = "dev.dotfiles.browser_use";
const GROUP_TITLE = "Agents";
const GROUP_COLOR = "purple";
const CONSOLE_CAP = 500;
const NETWORK_CAP = 400;

let port = null;
let reconnectTimer = null;

// ---------------------------------------------------------------- native host connection

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    port = null;
    setBadge(false);
    return scheduleReconnect();
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    // Reading lastError keeps Chrome from logging "Unchecked runtime.lastError".
    void chrome.runtime.lastError;
    port = null;
    setBadge(false);
    scheduleReconnect();
  });
  port.postMessage({ type: "hello", browser: browserName(), version: chrome.runtime.getManifest().version });
  setBadge(true);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "" : "off" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" }).catch(() => {});
  chrome.action.setTitle({ title: on ? "browser-use: connected" : "browser-use: native host not connected — run `browser-use install`" }).catch(() => {});
}

// Show a short result on the toolbar icon, then fall back to the connection badge.
function flashBadge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  setTimeout(() => setBadge(!!port), 1500);
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const known = brands.find((b) => !/Not.A.Brand|Chromium/i.test(b));
  return known ?? (brands.includes("Chromium") ? "Chromium" : "unknown");
}

async function onHostMessage(msg) {
  if (msg?.type === "clipboard") return flashBadge(msg.ok ? "✓" : "err", msg.ok ? "#15803d" : "#b91c1c");
  if (msg?.type !== "request") return;
  const { id, cmd, args = {}, owner = "shell" } = msg;
  try {
    const handler = COMMANDS[cmd];
    if (!handler) throw new Error(`unknown command: ${cmd}`);
    const result = await handler(args, owner);
    port?.postMessage({ type: "response", id, result });
  } catch (e) {
    port?.postMessage({ type: "response", id, error: e?.message ?? String(e) });
  }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.action.onClicked.addListener(() => connect());
connect();

// ---------------------------------------------------------------- ⌘⇧S: viewport → clipboard

// The human's shortcut, not an agent command: capture just the page viewport of the active tab and
// hand it to the native host, which puts the PNG on the system clipboard (a service worker can't
// write images to the clipboard itself). The host answers with a "clipboard" message.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "capture-viewport") return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: "png" });
    connect();
    if (!port) throw new Error("native host not connected — run `browser-use install`");
    port.postMessage({ type: "clipboard-image", data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
  } catch (e) {
    console.warn("capture-viewport:", e?.message ?? e);
    flashBadge("err", "#b91c1c");
  }
});

// ---------------------------------------------------------------- shared state (survives worker + extension reloads)

async function getState() {
  const { owners = {}, lastTab = {} } = await chrome.storage.local.get(["owners", "lastTab"]);
  return { owners, lastTab };
}

async function setOwner(tabId, owner) {
  const s = await getState();
  s.owners[tabId] = owner;
  s.lastTab[owner] = tabId;
  await chrome.storage.local.set(s);
}

async function touch(tabId, owner) {
  const s = await getState();
  s.lastTab[owner] = tabId;
  await chrome.storage.local.set({ lastTab: s.lastTab });
}

// Tab ids don't survive a browser restart; drop entries for tabs that no longer exist.
async function pruneState() {
  const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const s = await getState();
  for (const id of Object.keys(s.owners)) if (!live.has(Number(id))) delete s.owners[id];
  for (const [o, t] of Object.entries(s.lastTab)) if (!live.has(t)) delete s.lastTab[o];
  await chrome.storage.local.set(s);
}
chrome.runtime.onStartup.addListener(pruneState);
pruneState();

chrome.tabs.onRemoved.addListener(async (tabId) => {
  debuggees.delete(tabId);
  const s = await getState();
  delete s.owners[tabId];
  for (const [o, t] of Object.entries(s.lastTab)) if (t === tabId) delete s.lastTab[o];
  await chrome.storage.local.set(s);
});

// ---------------------------------------------------------------- the "Agents" group

// There is only ever one Agents group. If a second appears (a window was split off, a session
// was restored twice), fold its tabs back into the first.
async function findGroup() {
  const [group, ...extras] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  for (const extra of extras) {
    const tabs = await chrome.tabs.query({ groupId: extra.id });
    if (!tabs.length) continue;
    const ids = tabs.map((t) => t.id);
    await chrome.tabs.move(ids, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ tabIds: ids, groupId: group.id });
  }
  return group ?? null;
}

async function normalWindowId() {
  try {
    return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    const [win] = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return win?.id ?? (await chrome.windows.create({ focused: false })).id;
  }
}

async function addToGroup(tabId) {
  const group = await findGroup();
  const tab = await chrome.tabs.get(tabId);
  if (group) {
    if (tab.windowId !== group.windowId) await chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 });
    await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
    return group.id;
  }
  if ((await chrome.windows.get(tab.windowId)).type !== "normal") await chrome.tabs.move(tabId, { windowId: await normalWindowId(), index: -1 });
  let groupId;
  try {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  } catch (e) {
    if (!/not supported/i.test(e.message)) throw e;
    // Some windows refuse groups; give the Agents group a window of its own.
    const win = await chrome.windows.create({ tabId, focused: false });
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: win.id } });
  }
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
  return groupId;
}

async function groupTabs() {
  const group = await findGroup();
  return group ? chrome.tabs.query({ groupId: group.id }) : [];
}

// Resolve the tab a command acts on: explicit `tab`, else this owner's last-used tab.
async function resolveTab(args, owner, { requireGroup = true } = {}) {
  let tabId = args.tab != null ? Number(args.tab) : (await getState()).lastTab[owner];
  if (tabId == null || Number.isNaN(tabId)) throw new Error("no tab — pass -t <tabId> or `browser-use open <url>` first (see `browser-use tabs`)");
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`tab ${tabId} no longer exists (see \`browser-use tabs\`)`);
  }
  if (requireGroup) {
    const group = await findGroup();
    if (!group || tab.groupId !== group.id) {
      throw new Error(`tab ${tabId} is not in the "${GROUP_TITLE}" group — \`browser-use adopt -t ${tabId}\` to hand it to agents`);
    }
  }
  await touch(tabId, owner);
  // Attach on first touch so console/network capture covers whatever the agent does next.
  await ensureAttached(tabId).catch(() => {});
  return tab;
}

function describeTab(tab, owners) {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowId: tab.windowId,
    owner: owners[tab.id] ?? null,
  };
}

// ---------------------------------------------------------------- chrome.debugger plumbing

const debuggees = new Map(); // tabId → { console: [], network: [], networkById: Map, dialog }

async function ensureAttached(tabId) {
  if (debuggees.has(tabId)) return debuggees.get(tabId);
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw new Error(`cannot attach to tab ${tabId}: ${e.message}`);
  }
  const state = { console: [], network: [], networkById: new Map(), dialog: null };
  debuggees.set(tabId, state);
  await Promise.all([
    chrome.debugger.sendCommand(target, "Runtime.enable"),
    chrome.debugger.sendCommand(target, "Page.enable"),
    chrome.debugger.sendCommand(target, "Network.enable", { maxPostDataSize: 65536 }),
  ]);
  return state;
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) debuggees.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const st = debuggees.get(source.tabId);
  if (!st) return;
  switch (method) {
    case "Runtime.consoleAPICalled":
      pushCapped(st.console, {
        t: Date.now(),
        level: params.type,
        text: params.args.map(remoteToText).join(" "),
      }, CONSOLE_CAP);
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails;
      pushCapped(st.console, {
        t: Date.now(),
        level: "exception",
        text: d.exception?.description ?? d.text,
      }, CONSOLE_CAP);
      break;
    }
    case "Network.requestWillBeSent": {
      const entry = {
        id: params.requestId,
        t: Date.now(),
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        status: null,
      };
      st.networkById.set(params.requestId, entry);
      pushCapped(st.network, entry, NETWORK_CAP, (old) => st.networkById.delete(old.id));
      break;
    }
    case "Network.responseReceived": {
      const e = st.networkById.get(params.requestId);
      if (e) Object.assign(e, { status: params.response.status, mime: params.response.mimeType });
      break;
    }
    case "Network.loadingFailed": {
      const e = st.networkById.get(params.requestId);
      if (e) e.error = params.errorText;
      break;
    }
    case "Page.javascriptDialogOpening":
      st.dialog = { type: params.type, message: params.message };
      break;
    case "Page.javascriptDialogClosed":
      st.dialog = null;
      break;
  }
});

function pushCapped(arr, item, cap, onEvict) {
  arr.push(item);
  while (arr.length > cap) {
    const old = arr.shift();
    onEvict?.(old);
  }
}

function remoteToText(o) {
  if (o.type === "string") return o.value;
  if ("value" in o) return JSON.stringify(o.value);
  return o.description ?? o.type;
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  const st = debuggees.get(tabId);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(
      st?.dialog
        ? `${method} blocked by an open ${st.dialog.type} dialog ("${st.dialog.message}") — \`browser-use dialog accept|dismiss\``
        : `${method} timed out`,
    )), 30000),
  );
  return Promise.race([chrome.debugger.sendCommand({ tabId }, method, params), timeout]);
}

// Run `fn(...args)` in the page and return its JSON-serialisable result.
async function inPage(tabId, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const res = await cdp(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) {
    // Page helpers throw plain Errors; report the message, not the serialised stack.
    const d = res.exceptionDetails;
    throw new Error((d.exception?.description ?? d.text).split("\n")[0].replace(/^Error: /, ""));
  }
  return res.result.value;
}

// ---------------------------------------------------------------- in-page helpers (serialised into the page)

// Interactive-element snapshot. Tags elements with data-bu-ref so later commands can target "e12".
function pageSnapshot(opts) {
  const MAX_LINES = opts.max ?? 400;
  const INTERACTIVE = "a[href],button,input,select,textarea,summary,details,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])";
  const STRUCTURE = "h1,h2,h3,h4,h5,h6,dialog,[role=dialog],[role=alertdialog],[role=alert],nav,main,form,table,label,img[alt]";
  window.__buSeq ??= 0;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
  };
  const clip = (s, n = 80) => {
    s = (s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const role = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "input") return { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", range: "slider" }[el.type] ?? `textbox[${el.type}]`;
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "img") return "img";
    if (/^h[1-6]$/.test(t)) return `heading${t[1]}`;
    if (el.isContentEditable) return "textbox[editable]";
    return t;
  };
  const name = (el) => {
    if (el.type === "checkbox" || el.type === "radio") {
      const wrap = el.closest("label");
      if (wrap?.innerText.trim()) return clip(wrap.innerText);
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const txt = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ");
      if (txt.trim()) return clip(txt);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    if (el.id && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return clip(lbl.innerText);
    }
    if (el.tagName === "IMG") return clip(el.alt);
    if (el.tagName === "INPUT" && /^(submit|button)$/.test(el.type)) return clip(el.value);
    const text = el.innerText ?? el.textContent;
    if (text?.trim()) return clip(text);
    return clip(el.getAttribute("placeholder") ?? el.getAttribute("title") ?? el.getAttribute("name") ?? "");
  };
  const states = (el) => {
    const s = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    if (el.checked || el.getAttribute("aria-checked") === "true") s.push("checked");
    if (el.getAttribute("aria-selected") === "true") s.push("selected");
    const exp = el.getAttribute("aria-expanded");
    if (exp) s.push(exp === "true" ? "expanded" : "collapsed");
    if (document.activeElement === el) s.push("focused");
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|submit|button)$/.test(el.type)) {
      if (el.value) s.push(`value="${clip(el.type === "password" ? "••••" : el.value, 60)}"`);
      else if (el.placeholder) s.push(`placeholder="${clip(el.placeholder, 40)}"`);
    }
    if (el.tagName === "SELECT") s.push(`value="${clip(el.selectedOptions[0]?.text ?? "", 40)}"`);
    if (el.tagName === "A" && opts.urls) s.push(`href=${el.getAttribute("href")}`);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) s.push("offscreen");
    return s;
  };

  const root = opts.ref ? document.querySelector(`[data-bu-ref="${opts.ref}"]`) : document.body;
  if (!root) throw new Error(`ref ${opts.ref} not found — take a fresh snapshot`);
  const lines = [];
  let truncated = false;
  const walk = (el, depth) => {
    if (lines.length >= MAX_LINES) { truncated = true; return; }
    let next = depth;
    const interactive = el.matches(INTERACTIVE);
    const structural = el.matches(STRUCTURE);
    if ((interactive || structural) && (opts.all || visible(el))) {
      let ref = el.getAttribute("data-bu-ref");
      if (!ref) { ref = `e${++window.__buSeq}`; el.setAttribute("data-bu-ref", ref); }
      const st = states(el);
      lines.push(`${"  ".repeat(depth)}${ref} ${role(el)} "${name(el)}"${st.length ? " [" + st.join(", ") + "]" : ""}`);
      next = depth + 1;
      // Leaf controls: their children are just their label.
      if (interactive && !/^(form|dialog|details|nav|main|table)$/i.test(el.tagName) && el.getAttribute("role") !== "dialog") return;
    }
    for (const child of el.children) walk(child, next);
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, next);
  };
  walk(root, 0);
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight },
    lines,
    truncated,
  };
}

// Find a target ("e12", "text=Save", or a CSS selector), scroll it into view, return its centre.
function pageLocate(target) {
  let el;
  if (/^e\d+$/.test(target)) el = document.querySelector(`[data-bu-ref="${target}"]`);
  else if (target.startsWith("text=")) {
    const want = target.slice(5).trim().toLowerCase();
    const cands = [...document.querySelectorAll("a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],label,summary,input[type=submit],input[type=button]")];
    el = cands.find((e) => (e.innerText ?? e.value ?? "").trim().toLowerCase() === want)
      ?? cands.find((e) => (e.innerText ?? e.value ?? "").toLowerCase().includes(want));
  } else el = document.querySelector(target);
  if (!el) throw new Error(`target ${target} not found${/^e\d+$/.test(target) ? " — refs come from the latest `snap`; take a fresh one" : ""}`);
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
}

function pageFill(target, value) {
  const el = /^e\d+$/.test(target) ? document.querySelector(`[data-bu-ref="${target}"]`) : document.querySelector(target);
  if (!el) throw new Error(`target ${target} not found`);
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
  if (el.tagName === "SELECT") {
    const opt = [...el.options].find((o) => o.value === value) ?? [...el.options].find((o) => o.text.trim() === value)
      ?? [...el.options].find((o) => o.text.toLowerCase().includes(String(value).toLowerCase()));
    if (!opt) throw new Error(`no option matching "${value}" (options: ${[...el.options].map((o) => o.text.trim()).join(" | ")})`);
    el.value = opt.value;
    fire("input"); fire("change");
    return `selected "${opt.text.trim()}"`;
  }
  if (el.type === "checkbox" || el.type === "radio") {
    const want = !/^(false|0|off|no|unchecked)$/i.test(String(value));
    if (el.checked !== want) el.click();
    return `checked=${el.checked}`;
  }
  if (el.isContentEditable) return { needsInsert: true };
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  fire("input"); fire("change");
  return `value set (${String(value).length} chars)`;
}

function pageWait(opts) {
  const deadline = Date.now() + (opts.timeout ?? 10000);
  const check = () => {
    if (opts.selector) return !!document.querySelector(opts.selector);
    if (opts.text) return document.body.innerText.includes(opts.text);
    if (opts.gone) return !document.querySelector(opts.gone);
    if (opts.url) return location.href.includes(opts.url);
    return document.readyState === "complete";
  };
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() > deadline) return reject(new Error(`wait timed out after ${opts.timeout ?? 10000}ms`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---------------------------------------------------------------- input

const MODIFIER_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
// macOS editing shortcuts don't fire from synthetic key events; CDP needs the editor command.
const MAC_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

async function pressKey(tabId, combo) {
  const parts = combo.split("+");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const p of parts) {
    const bit = MODIFIER_BITS[p.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${p}" in ${combo}`);
    modifiers |= bit;
  }
  let def = NAMED_KEYS[keyName.toLowerCase()];
  if (!def && /^f\d{1,2}$/i.test(keyName)) def = { key: keyName.toUpperCase(), code: keyName.toUpperCase(), keyCode: 111 + Number(keyName.slice(1)) };
  if (!def && keyName.length === 1) {
    const ch = modifiers & 8 ? keyName.toUpperCase() : keyName;
    const upper = keyName.toUpperCase();
    def = {
      key: ch,
      code: /[a-z]/i.test(keyName) ? `Key${upper}` : /\d/.test(keyName) ? `Digit${keyName}` : undefined,
      keyCode: upper.charCodeAt(0),
      text: modifiers & (2 | 4) ? undefined : ch,
    };
  }
  if (!def) throw new Error(`unknown key "${keyName}"`);
  const commands = modifiers === 4 && MAC_COMMANDS[keyName.toLowerCase()] ? [MAC_COMMANDS[keyName.toLowerCase()]] : undefined;
  const base = { modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: def.text ? "keyDown" : "rawKeyDown", text: def.text, unmodifiedText: def.text, commands });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function mouseAt(tabId, x, y, { button = "left", clickCount = 1, move = true } = {}) {
  if (move) await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
  }
}

async function locate(tabId, target) {
  const m = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target);
  if (m) return { x: Number(m[1]), y: Number(m[2]) };
  return inPage(tabId, pageLocate, target);
}

// ---------------------------------------------------------------- commands

const COMMANDS = {
  async ping() {
    return { browser: browserName(), version: chrome.runtime.getManifest().version, group: (await findGroup())?.id ?? null };
  },

  // Pick up edits to this extension without visiting chrome://extensions.
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true };
  },

  async tabs(args) {
    const { owners } = await getState();
    const tabs = args.all ? await chrome.tabs.query({}) : await groupTabs();
    const windows = new Map((await chrome.windows.getAll()).map((w) => [w.id, w]));
    return tabs.map((t) => ({ ...describeTab(t, owners), windowType: windows.get(t.windowId)?.type, groupId: t.groupId, splitViewId: t.splitViewId }));
  },

  async open(args, owner) {
    const group = await findGroup();
    // Open blank, attach, then navigate, so console/network capture includes the first load.
    const createProps = { url: "about:blank", active: !args.background };
    // Only normal windows can hold tab groups (not app/popup windows), so pick one explicitly.
    createProps.windowId = group?.windowId ?? (await normalWindowId());
    const tab = await chrome.tabs.create(createProps);
    await addToGroup(tab.id);
    await setOwner(tab.id, owner);
    if (args.url) {
      await ensureAttached(tab.id).catch(() => {});
      const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
      const loaded = waitForLoad(tab.id, 15000, { fresh: true }).catch(() => {});
      await chrome.tabs.update(tab.id, { url });
      await loaded;
    }
    return describeTab(await chrome.tabs.get(tab.id), (await getState()).owners);
  },

  async adopt(args, owner) {
    const tab = await resolveTab(args, owner, { requireGroup: false });
    await addToGroup(tab.id);
    await setOwner(tab.id, owner);
    return describeTab(await chrome.tabs.get(tab.id), (await getState()).owners);
  },

  async release(args, owner) {
    const tab = await resolveTab(args, owner);
    await chrome.tabs.ungroup(tab.id);
    if (debuggees.has(tab.id)) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    debuggees.delete(tab.id);
    return { released: tab.id };
  },

  async use(args, owner) {
    const tab = await resolveTab(args, owner);
    return describeTab(tab, (await getState()).owners);
  },

  async close(args, owner) {
    const tab = await resolveTab(args, owner);
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id };
  },

  async focus(args, owner) {
    const tab = await resolveTab(args, owner);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { focused: tab.id };
  },

  async nav(args, owner) {
    const tab = await resolveTab(args, owner);
    const where = args.url;
    const loaded = waitForLoad(tab.id, args.timeout ?? 15000, { fresh: true }).catch(() => {});
    if (where === "back") await chrome.tabs.goBack(tab.id);
    else if (where === "forward") await chrome.tabs.goForward(tab.id);
    else if (where === "reload") await chrome.tabs.reload(tab.id);
    else {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(where) ? where : `https://${where}`;
      await chrome.tabs.update(tab.id, { url });
    }
    await loaded;
    const t = await chrome.tabs.get(tab.id);
    return { id: t.id, url: t.url, title: t.title, status: t.status };
  },

  async shot(args, owner) {
    const tab = await resolveTab(args, owner);
    // Background tabs don't paint; activate within its window (does not focus the window).
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    const metrics = await cdp(tab.id, "Page.getLayoutMetrics");
    const vv = metrics.cssVisualViewport;
    const dpr = await inPage(tab.id, () => window.devicePixelRatio);
    const scale = args.hires ? 1 : 1 / dpr;
    const params = { format: "png", captureBeyondViewport: !!args.full };
    if (args.full) {
      const size = metrics.cssContentSize;
      params.clip = { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16000), scale };
    } else {
      params.clip = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale };
    }
    const { data } = await cdp(tab.id, "Page.captureScreenshot", params);
    return {
      data,
      width: Math.round(params.clip.width * scale * dpr),
      height: Math.round(params.clip.height * scale * dpr),
      coords: args.hires ? `image px = CSS px × ${dpr}` : "image px = CSS px (click coordinates map 1:1)",
      url: tab.url,
    };
  },

  async snap(args, owner) {
    const tab = await resolveTab(args, owner);
    const res = await inPage(tab.id, pageSnapshot, { all: !!args.all, ref: args.ref, max: args.max, urls: !!args.urls });
    return { tab: tab.id, ...res };
  },

  async text(args, owner) {
    const tab = await resolveTab(args, owner);
    const max = args.max ?? 50000;
    const text = await inPage(tab.id, (sel) => {
      const root = sel ? document.querySelector(sel) : document.querySelector("main") ?? document.body;
      if (!root) throw new Error(`no element matches ${sel}`);
      return root.innerText;
    }, args.selector ?? null);
    return { tab: tab.id, url: tab.url, title: tab.title, text: text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text };
  },

  async click(args, owner) {
    const tab = await resolveTab(args, owner);
    const at = await locate(tab.id, args.target);
    await mouseAt(tab.id, at.x, at.y, { button: args.button ?? "left", clickCount: args.count ?? 1 });
    return { clicked: args.target, x: Math.round(at.x), y: Math.round(at.y) };
  },

  async hover(args, owner) {
    const tab = await resolveTab(args, owner);
    const at = await locate(tab.id, args.target);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    return { hovered: args.target, x: Math.round(at.x), y: Math.round(at.y) };
  },

  async type(args, owner) {
    const tab = await resolveTab(args, owner);
    if (args.target) {
      const at = await locate(tab.id, args.target);
      await mouseAt(tab.id, at.x, at.y);
    }
    if (args.clear) await pressKey(tab.id, "meta+a").then(() => pressKey(tab.id, "backspace"));
    await cdp(tab.id, "Input.insertText", { text: args.text });
    if (args.submit) await pressKey(tab.id, "enter");
    return { typed: args.text.length };
  },

  async fill(args, owner) {
    const tab = await resolveTab(args, owner);
    const res = await inPage(tab.id, pageFill, args.target, args.value);
    if (res?.needsInsert) {
      await pressKey(tab.id, "meta+a");
      await cdp(tab.id, "Input.insertText", { text: String(args.value) });
      return { filled: args.target, result: "inserted into contenteditable" };
    }
    return { filled: args.target, result: res };
  },

  async key(args, owner) {
    const tab = await resolveTab(args, owner);
    for (const combo of args.keys) {
      const n = args.repeat ?? 1;
      for (let i = 0; i < n; i++) await pressKey(tab.id, combo);
    }
    return { pressed: args.keys };
  },

  async scroll(args, owner) {
    const tab = await resolveTab(args, owner);
    let x, y;
    if (args.target) ({ x, y } = await locate(tab.id, args.target));
    else ({ x, y } = await inPage(tab.id, () => ({ x: innerWidth / 2, y: innerHeight / 2 })));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: args.dx ?? 0, deltaY: args.dy ?? 0 });
    await new Promise((r) => setTimeout(r, 150));
    return inPage(tab.id, () => ({ scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
  },

  async eval(args, owner) {
    const tab = await resolveTab(args, owner);
    const res = await cdp(tab.id, "Runtime.evaluate", {
      expression: args.js,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      replMode: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return { value: res.result.value ?? res.result.description ?? null, type: res.result.type };
  },

  async console(args, owner) {
    const tab = await resolveTab(args, owner);
    const st = await ensureAttached(tab.id);
    let items = st.console;
    if (args.errors) items = items.filter((m) => /error|exception|assert/.test(m.level));
    if (args.pattern) {
      const re = new RegExp(args.pattern, "i");
      items = items.filter((m) => re.test(m.text));
    }
    const out = items.slice(-(args.limit ?? 100));
    if (args.clear) st.console = [];
    return { tab: tab.id, capturing: true, messages: out };
  },

  async network(args, owner) {
    const tab = await resolveTab(args, owner);
    const st = await ensureAttached(tab.id);
    if (args.body) {
      const { body, base64Encoded } = await cdp(tab.id, "Network.getResponseBody", { requestId: args.body });
      const text = base64Encoded ? `[base64 ${body.length} chars]` : body;
      return { requestId: args.body, body: text.length > 200000 ? text.slice(0, 200000) + "\n…[truncated]" : text };
    }
    let items = st.network;
    if (args.pattern) {
      const re = new RegExp(args.pattern, "i");
      items = items.filter((r) => re.test(r.url));
    }
    if (args.failed) items = items.filter((r) => r.error || (r.status ?? 0) >= 400);
    const out = items.slice(-(args.limit ?? 100));
    if (args.clear) { st.network = []; st.networkById.clear(); }
    return { tab: tab.id, capturing: true, requests: out };
  },

  async wait(args, owner) {
    const tab = await resolveTab(args, owner);
    if (args.ms) {
      await new Promise((r) => setTimeout(r, args.ms));
      return { waited: args.ms };
    }
    if (!args.selector && !args.text && !args.gone && !args.url) {
      await waitForLoad(tab.id, args.timeout ?? 15000);
      return { loaded: true };
    }
    await inPage(tab.id, pageWait, args);
    return { ok: true };
  },

  async dialog(args, owner) {
    const tab = await resolveTab(args, owner);
    const st = await ensureAttached(tab.id);
    if (!st.dialog) return { dialog: null };
    const d = st.dialog;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.handleJavaScriptDialog", { accept: args.action !== "dismiss", promptText: args.text });
    return { handled: d, action: args.action ?? "accept" };
  },

  async resize(args, owner) {
    const tab = await resolveTab(args, owner);
    // Size the viewport, not the window: emulate so it doesn't fight other agents' tabs.
    if (args.reset) {
      await cdp(tab.id, "Emulation.clearDeviceMetricsOverride");
      await settle(tab.id);
      return { reset: true };
    }
    await cdp(tab.id, "Emulation.setDeviceMetricsOverride", { width: args.width, height: args.height, deviceScaleFactor: 0, mobile: !!args.mobile });
    await settle(tab.id);
    return { width: args.width, height: args.height };
  },
};

// Resolve when the tab finishes loading. `fresh` ignores the current state and waits for the next
// loading → complete cycle (a navigation that was just issued).
// Wait two animation frames so layout/paint catch up before the next screenshot.
function settle(tabId) {
  return inPage(tabId, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
}

function waitForLoad(tabId, timeout, { fresh = false } = {}) {
  return new Promise((resolve, reject) => {
    let sawLoading = !fresh;
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) { done(); resolve(); }
    };
    const timer = setTimeout(() => { done(); reject(new Error("load timeout")); }, timeout);
    chrome.tabs.onUpdated.addListener(listener);
    if (!fresh) chrome.tabs.get(tabId).then((t) => { if (t.status === "complete" && t.url !== "about:blank") { done(); resolve(); } }).catch(() => {});
  });
}
