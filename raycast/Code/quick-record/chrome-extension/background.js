// Quick Record HAR: service worker.
//
// Quick Record's demo mode (fn+⌥Q) → distributed notification → QuickRecordHAR, the native host
// Chrome runs for this extension → here. While a demo records, this keeps every request made by
// the tabs on camera (webRequest: URLs, headers, status, timings, request bodies) plus the response
// bodies of the pages' own fetch/XHR calls (hook.js in the page, passed on by relay.js). On stop it
// streams a HAR 1.2 back to the host, which saves it beside the video.
//
// It deliberately doesn't use chrome.debugger: that puts Chrome's "started debugging this browser"
// bar across every window, which would be in the recording.

const HOST = "com.acerom.quickrecord.har";
const SCRIPT_IDS = ["quickrecord-har-hook", "quickrecord-har-relay"];
const PAGES = ["http://*/*", "https://*/*"];
const REQUEST_BODY_LIMIT = 1_000_000; // characters per request body
const BODY_TOTAL_LIMIT = 50_000_000; // characters of response bodies per recording
const CHUNK = 4_000_000; // characters per message to the host

let port = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
let session = null;

// ---------------------------------------------------------------- native host

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    return scheduleReconnect();
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // keeps Chrome from logging an unchecked error
    port = null;
    if (session) abandon();
    setBadge();
    scheduleReconnect();
  });
  port.postMessage({ type: "hello", browser: browserName(), version: chrome.runtime.getManifest().version });
  reconnectDelay = 2000;
  setBadge();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
}

function post(message) {
  try {
    port?.postMessage(message);
  } catch {}
}

function onHostMessage(msg) {
  if (msg?.type === "start") start(msg);
  else if (msg?.type === "stop") stop(msg.id);
}

function setBadge() {
  const text = session ? "REC" : port ? "" : "off";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: session ? "#c92a2a" : "#868e96" }).catch(() => {});
  const title = session
    ? "Quick Record HAR: recording the tabs on camera"
    : port
      ? "Quick Record HAR: ready (start a demo with fn+⌥Q)"
      : "Quick Record HAR: native host not connected — run quick-record/install.sh";
  chrome.action.setTitle({ title }).catch(() => {});
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? [];
  return brands.find((b) => !/Not.A.Brand|Chromium/i.test(b)) ?? (brands.includes("Chromium") ? "Chromium" : "Chrome");
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
connect();

// ---------------------------------------------------------------- which tabs are on camera

// The region is in global display points with a top-left origin, which is how Chrome reports
// window bounds on macOS. A tab counts if it was the active tab of a window over the region at any
// point while recording; its whole history during the recording goes in the HAR.
function onCamera(win) {
  if (!win || win.state === "minimized") return false;
  const r = session?.region;
  if (!r) return !!win.focused;
  return win.left < r.x + r.width && win.left + win.width > r.x && win.top < r.y + r.height && win.top + win.height > r.y;
}

async function considerWindow(windowId) {
  if (!session || windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
  if (!onCamera(win)) return;
  include(win.tabs?.find((t) => t.active));
}

function include(tab) {
  if (!session || !tab || tab.id == null || tab.id < 0 || session.tabs.has(tab.id)) return;
  session.tabs.add(tab.id);
  session.tabInfo.set(tab.id, { url: tab.url, title: tab.title });
  inject(tab.id);
}

// Pages already loaded when the recording started (or the tab came on camera) get the hooks now;
// pages loaded during the recording get them from the registered content scripts.
async function inject(tabId) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ["hook.js"], world: "MAIN", injectImmediately: true }).catch(() => {});
  await chrome.scripting.executeScript({ target, files: ["relay.js"], injectImmediately: true }).catch(() => {});
}

chrome.tabs.onActivated.addListener(({ windowId }) => considerWindow(windowId));
chrome.windows.onFocusChanged.addListener((windowId) => considerWindow(windowId));
chrome.windows.onBoundsChanged.addListener((win) => considerWindow(win.id));
chrome.tabs.onCreated.addListener((tab) => {
  if (session && tab.active && session.tabs.has(tab.openerTabId)) include(tab);
});

// ---------------------------------------------------------------- recording

async function start({ id, startedAt, x, y, width, height }) {
  if (session) abandon();
  session = {
    id,
    startedAt: startedAt ?? Date.now(),
    region: width > 0 && height > 0 ? { x, y, width, height } : null,
    tabs: new Set(),
    tabInfo: new Map(), // tabId → { url, title } when it came on camera
    inflight: new Map(), // requestId → entry; a redirect settles one and the next starts fresh
    entries: [],
    navigations: [],
    bodies: [],
    bodyChars: 0,
  };
  addListeners();
  setBadge();
  await chrome.scripting
    .registerContentScripts([
      { id: SCRIPT_IDS[0], js: ["hook.js"], matches: PAGES, runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: false },
      { id: SCRIPT_IDS[1], js: ["relay.js"], matches: PAGES, runAt: "document_start", allFrames: true, persistAcrossSessions: false },
    ])
    .catch(() => {}); // already registered after a worker restart
  const windows = await chrome.windows.getAll({ populate: true }).catch(() => []);
  for (const win of windows) {
    if (onCamera(win)) include(win.tabs?.find((t) => t.active));
  }
  if (!session?.region) {
    const last = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
    include(last?.tabs?.find((t) => t.active));
  }
  if (session?.id === id) post({ type: "started", id, tabs: session.tabs.size });
}

async function stop(id) {
  if (!session || session.id !== id) return;
  const s = session;
  session = null;
  await quiet();
  try {
    const har = await buildHar(s);
    const text = JSON.stringify(har);
    for (let i = 0; i < text.length; ) {
      let end = Math.min(text.length, i + CHUNK);
      // Don't split a surrogate pair across two messages.
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
      post({ type: "chunk", id, data: text.slice(i, end) });
      i = end;
    }
    post({ type: "done", id, entries: har.log.entries.length });
  } catch (e) {
    post({ type: "failed", id, message: e?.message ?? String(e) });
  }
  setBadge();
}

function abandon() {
  session = null;
  quiet();
  setBadge();
}

// Stop listening, and tell every page's hook to stop copying bodies.
async function quiet() {
  removeListeners();
  await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: PAGES }).catch(() => []);
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: "har-control", on: false }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "har-body" || !session || !sender.tab) return;
  const record = msg.record;
  if (!record || typeof record.text !== "string") return;
  if (session.bodyChars + record.text.length > BODY_TOTAL_LIMIT) return;
  session.bodyChars += record.text.length;
  session.bodies.push({ ...record, tabId: sender.tab.id });
});

// ---------------------------------------------------------------- webRequest

const LISTENERS = [
  ["onBeforeRequest", onBeforeRequest, ["requestBody"]],
  ["onSendHeaders", onSendHeaders, ["requestHeaders", "extraHeaders"]],
  ["onHeadersReceived", onHeadersReceived, ["responseHeaders", "extraHeaders"]],
  ["onBeforeRedirect", (d) => settle(d, { redirectURL: d.redirectUrl }), ["responseHeaders", "extraHeaders"]],
  ["onCompleted", (d) => settle(d), ["responseHeaders", "extraHeaders"]],
  ["onErrorOccurred", (d) => settle(d, { error: d.error }), undefined],
];

function addListeners() {
  for (const [event, fn, spec] of LISTENERS) {
    if (!chrome.webRequest[event].hasListener(fn)) chrome.webRequest[event].addListener(fn, { urls: ["<all_urls>"] }, spec);
  }
}

function removeListeners() {
  for (const [event, fn] of LISTENERS) chrome.webRequest[event].removeListener(fn);
}

function onBeforeRequest(d) {
  if (!session || d.tabId < 0) return;
  session.inflight.set(d.requestId, {
    tabId: d.tabId,
    type: d.type,
    url: d.url,
    method: d.method,
    start: d.timeStamp,
    initiator: d.initiator,
    postData: requestBody(d.requestBody),
  });
  if (d.type === "main_frame") session.navigations.push({ tabId: d.tabId, url: d.url, start: d.timeStamp });
}

function onSendHeaders(d) {
  const entry = session?.inflight.get(d.requestId);
  if (entry) entry.requestHeaders = d.requestHeaders;
}

function onHeadersReceived(d) {
  const entry = session?.inflight.get(d.requestId);
  if (!entry) return;
  entry.statusCode = d.statusCode;
  entry.statusLine = d.statusLine;
  entry.responseHeaders = d.responseHeaders;
  entry.headersAt = d.timeStamp;
}

function settle(d, extra = {}) {
  const entry = session?.inflight.get(d.requestId);
  if (!entry) return;
  session.inflight.delete(d.requestId);
  Object.assign(entry, {
    end: d.timeStamp,
    statusCode: d.statusCode ?? entry.statusCode,
    statusLine: d.statusLine ?? entry.statusLine,
    responseHeaders: d.responseHeaders ?? entry.responseHeaders,
    ip: d.ip,
    fromCache: d.fromCache,
    ...extra,
  });
  session.entries.push(entry);
}

function requestBody(body) {
  if (!body) return undefined;
  if (body.error) return { text: "", comment: body.error };
  if (body.formData) {
    const params = Object.entries(body.formData).flatMap(([name, values]) => values.map((value) => ({ name, value })));
    return { params, text: new URLSearchParams(params.map((p) => [p.name, p.value])).toString() };
  }
  if (body.raw) {
    const parts = body.raw.filter((p) => p.bytes).map((p) => new Uint8Array(p.bytes));
    const length = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(Math.min(length, REQUEST_BODY_LIMIT));
    let offset = 0;
    for (const part of parts) {
      if (offset >= bytes.length) break;
      const slice = part.subarray(0, bytes.length - offset);
      bytes.set(slice, offset);
      offset += slice.length;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const notes = [];
    if (length > REQUEST_BODY_LIMIT) notes.push("truncated by Quick Record HAR");
    if (body.raw.some((p) => p.file)) notes.push("includes file uploads, not saved");
    return { text, comment: notes.join("; ") || undefined };
  }
  return undefined;
}

// ---------------------------------------------------------------- HAR 1.2

const header = (list, name) => list?.find((h) => h.name.toLowerCase() === name)?.value;
const headers = (list) => (list ?? []).map((h) => ({ name: h.name, value: h.value ?? "" }));
const iso = (ms) => new Date(ms).toISOString();
const withoutHash = (url) => url.split("#")[0];

function query(url) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function cookies(value) {
  if (!value) return [];
  return value.split(/;\s*/).filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    return at < 0 ? { name: pair, value: "" } : { name: pair.slice(0, at), value: pair.slice(at + 1) };
  });
}

function httpVersion(statusLine) {
  const token = statusLine?.split(" ")[0] ?? "";
  return /^HTTP\//.test(token) ? token : "";
}

function statusText(statusLine, error) {
  if (error) return error;
  return statusLine?.split(" ").slice(2).join(" ") ?? "";
}

function resourceType(entry) {
  switch (entry.type) {
    case "main_frame":
    case "sub_frame":
      return "document";
    case "xmlhttprequest":
      return entry.body?.kind ?? "xhr";
    default:
      return entry.type;
  }
}

// Response bodies come from the page with a URL, method and start time; give each to the closest
// matching request from the same tab.
function attachBodies(entries, bodies) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.tabId} ${entry.method} ${withoutHash(entry.url)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }
  for (const body of bodies) {
    const candidates = byKey.get(`${body.tabId} ${body.method} ${withoutHash(body.url)}`) ?? [];
    let best = null;
    let bestDelta = 60_000;
    for (const entry of candidates) {
      const delta = Math.abs(entry.start - body.startedAt);
      if (!entry.body && delta < bestDelta) {
        best = entry;
        bestDelta = delta;
      }
    }
    if (best) best.body = body;
  }
}

async function buildHar(s) {
  const now = Date.now();
  const all = s.entries.concat([...s.inflight.values()].map((e) => ({ ...e, end: now, pending: true })));
  const entries = all.filter((e) => s.tabs.has(e.tabId)).sort((a, b) => a.start - b.start);
  attachBodies(entries, s.bodies.filter((b) => s.tabs.has(b.tabId)));

  // One page per tab for what it already showed when recording began, then one per navigation.
  const pages = [];
  const pagesByTab = new Map();
  const addPage = (tabId, url, start, title) => {
    const id = `page_${pages.length + 1}`;
    pages.push({ startedDateTime: iso(start), id, title: title || url, pageTimings: { onContentLoad: -1, onLoad: -1 } });
    if (!pagesByTab.has(tabId)) pagesByTab.set(tabId, []);
    pagesByTab.get(tabId).push({ id, start });
  };
  for (const tabId of s.tabs) {
    const now = await chrome.tabs.get(tabId).catch(() => null);
    const before = s.tabInfo.get(tabId);
    const navigations = s.navigations.filter((n) => n.tabId === tabId).sort((a, b) => a.start - b.start);
    const first = entries.find((e) => e.tabId === tabId);
    const shown = before?.url ?? first?.url;
    if (shown && (!navigations.length || (first && first.start < navigations[0].start))) {
      addPage(tabId, shown, s.startedAt, before?.title);
    }
    navigations.forEach((n, i) => addPage(tabId, n.url, n.start, i === navigations.length - 1 && now?.url === n.url ? now.title : ""));
  }
  const pageref = (entry) => {
    const list = pagesByTab.get(entry.tabId) ?? [];
    let ref = list[0]?.id;
    for (const page of list) if (page.start <= entry.start) ref = page.id;
    return ref;
  };

  return {
    log: {
      version: "1.2",
      creator: { name: "Quick Record HAR", version: chrome.runtime.getManifest().version },
      browser: { name: browserName(), version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "" },
      pages: pages.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime)),
      entries: entries.map((e) => harEntry(e, pageref(e), s.startedAt)),
      comment: `Recorded with a Quick Record demo that started at ${iso(s.startedAt)}. Response bodies cover the pages' fetch/XHR calls only.`,
      _recordingStartedDateTime: iso(s.startedAt),
    },
  };
}

// startedAt is the video's first frame (ms); _videoTime puts the request on the video's clock, the
// same t that the demo's .excalidraw timeline uses.
function harEntry(e, pageref, startedAt) {
  const time = Math.max(0, Math.round((e.end ?? e.start) - e.start));
  const wait = e.headersAt ? Math.min(time, Math.max(0, Math.round(e.headersAt - e.start))) : time;
  const version = httpVersion(e.statusLine);
  const length = Number(header(e.responseHeaders, "content-length") ?? -1);
  const content = {
    size: e.body ? e.body.text.length : Math.max(0, length),
    mimeType: header(e.responseHeaders, "content-type") ?? e.body?.mimeType ?? "",
  };
  if (e.body) {
    content.text = e.body.text;
    if (e.body.truncated) content.comment = "Truncated by Quick Record HAR";
  }
  const entry = {
    startedDateTime: iso(e.start),
    time,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: version,
      cookies: cookies(header(e.requestHeaders, "cookie")),
      headers: headers(e.requestHeaders),
      queryString: query(e.url),
      headersSize: -1,
      bodySize: e.postData ? e.postData.text.length : 0,
    },
    response: {
      status: e.statusCode ?? 0,
      statusText: statusText(e.statusLine, e.error),
      httpVersion: version,
      cookies: [],
      headers: headers(e.responseHeaders),
      content,
      redirectURL: e.redirectURL ?? "",
      headersSize: -1,
      bodySize: length,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, ssl: -1, connect: -1, send: 0, wait, receive: time - wait },
    _resourceType: resourceType(e),
  };
  if (pageref) entry.pageref = pageref;
  if (startedAt != null) entry._videoTime = Math.round(e.start - startedAt) / 1000;
  if (e.postData) {
    entry.request.postData = {
      mimeType: header(e.requestHeaders, "content-type") ?? (e.postData.params ? "application/x-www-form-urlencoded" : ""),
      text: e.postData.text,
    };
    if (e.postData.params) entry.request.postData.params = e.postData.params;
    if (e.postData.comment) entry.request.postData.comment = e.postData.comment;
  }
  if (e.ip) entry.serverIPAddress = e.ip;
  if (e.fromCache) entry._fromCache = "disk";
  if (e.error) entry._error = e.error;
  if (e.pending) entry.comment = "Still in flight when the recording stopped";
  if (e.initiator) entry._initiator = { type: "other", url: e.initiator };
  return entry;
}

// Exported for tests (Node imports this module with a stubbed `chrome`).
export { attachBodies, buildHar, harEntry, requestBody, onCamera, statusText, httpVersion, cookies };
export const _test = {
  get session() {
    return session;
  },
  set session(value) {
    session = value;
  },
};
