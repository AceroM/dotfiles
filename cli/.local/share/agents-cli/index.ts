#!/usr/bin/env bun

import { Glob, $ } from "bun";
import { basename, relative, dirname } from "node:path";
import { watch } from "node:fs";
import { unlink } from "node:fs/promises";

const cwd = process.cwd();
const port = parseInt(process.argv[2] || "3333", 10);

interface FileEntry {
  path: string;
  mtime: number;
}

function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

let cachedFiles: FileEntry[] | null = null;

// Encode a relative file path for use under /raw/ (keep the slashes)
function rawHref(path: string): string {
  return "/raw/" + path.split("/").map(encodeURIComponent).join("/");
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A path is only safe to mv/rm if it stays inside the agents/ tree.
function safePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.startsWith("agents/") &&
    !p.endsWith("/") &&
    !p.split("/").includes("..")
  );
}

function findHtmlFiles(): FileEntry[] {
  if (cachedFiles) return cachedFiles;
  const glob = new Glob("agents/**/*.html");
  const entries: FileEntry[] = [];
  for (const path of glob.scanSync({ cwd, absolute: false })) {
    const stat = Bun.file(`${cwd}/${path}`);
    entries.push({ path, mtime: stat.lastModified });
  }
  cachedFiles = entries.sort((a, b) => b.mtime - a.mtime);
  return cachedFiles;
}

function buildPage(files: FileEntry[], active: string | null): string {
  const items = files
    .map((entry) => {
      const label = "./" + entry.path;
      const ago = timeAgo(entry.mtime);
      const isActive = entry.path === active;
      const attr = entry.path.replace(/"/g, "&quot;");
      return `<div class="item-row relative group" data-path="${attr}">` +
        `<a href="/?file=${encodeURIComponent(entry.path)}" class="item flex items-center pl-3.5 pr-9 py-2 text-[13px] no-underline border-l-[3px] border-transparent transition-colors group-hover:bg-gray-100 ${isActive ? "bg-blue-50 !border-l-blue-600 text-blue-600 font-semibold active" : "text-gray-900"}" title="${attr}"><span class="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">${label}</span><span class="ml-2 text-[11px] text-gray-400 whitespace-nowrap shrink-0 transition-opacity group-hover:opacity-0">${ago}</span></a>` +
        `<button type="button" class="menu-btn absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded text-gray-500 opacity-0 group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-900 cursor-pointer transition-opacity" aria-label="More actions" title="More actions"><svg viewBox="0 0 24 24" class="w-4 h-4 fill-current"><path d="M16,12A2,2 0 0,1 18,10A2,2 0 0,1 20,12A2,2 0 0,1 18,14A2,2 0 0,1 16,12M10,12A2,2 0 0,1 12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12M4,12A2,2 0 0,1 6,10A2,2 0 0,1 8,12A2,2 0 0,1 6,14A2,2 0 0,1 4,12Z"/></svg></button>` +
        `</div>`;
    })
    .join("\n");

  const activeLabel = active ? "./" + active : "agents (sorted by recent)";

  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${activeLabel} — agents</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  .item.kb-focus { background: #e5e7eb; }
  .item.active.kb-focus { background: #dbeafe; }

  #renameDialog::backdrop { background: rgba(0,0,0,.4); }

  @media (max-width: 767px) {
    .sidebar { transform: translateX(-100%); transition: transform .2s ease; }
    .sidebar.open { transform: translateX(0); }
    .overlay.open { display: block; }
  }

  @media (min-width: 768px) {
    .sidebar { transition: transform .2s ease; }
    .main { transition: margin-left .2s ease; }
    #expandBtn { display: none; }
    html.collapsed .sidebar { transform: translateX(-100%); }
    html.collapsed .main { margin-left: 0 !important; }
    html.collapsed #expandBtn { display: flex; }
  }
</style>
<script>try{if(localStorage.getItem("sidebarCollapsed")==="1")document.documentElement.classList.add("collapsed")}catch(e){}</script>
</head>
<body class="h-full font-sans bg-white text-gray-900">

<div class="flex md:hidden fixed top-0 left-0 right-0 h-12 bg-gray-50 border-b border-gray-200 items-center px-3 z-20">
  <button class="bg-transparent border-none text-gray-900 text-[22px] cursor-pointer px-2 py-1" id="burger">&#9776;</button>
  <span class="ml-auto text-sm font-semibold whitespace-nowrap overflow-hidden text-ellipsis">${activeLabel}</span>
</div>

<div class="overlay hidden fixed inset-0 bg-black/50 z-[25]" id="overlay"></div>

<button id="expandBtn" class="fixed top-3 left-3 z-40 items-center justify-center w-8 h-8 bg-white border border-gray-200 rounded-md shadow-sm text-gray-600 hover:bg-gray-100 cursor-pointer text-[16px] leading-none" title="Show sidebar (b)">&#187;</button>

<nav class="sidebar fixed top-0 left-0 bottom-0 w-[280px] bg-gray-50 border-r border-gray-200 flex flex-col z-30" id="sidebar">
  <div class="p-4 pb-3 border-b border-gray-200">
    <div class="flex items-center justify-between mb-2.5">
      <h1 class="text-[15px] font-bold">agents</h1>
      <button id="collapseBtn" class="hidden md:flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded cursor-pointer text-[15px] leading-none" title="Collapse sidebar (b)">&#171;</button>
    </div>
    <input type="text" id="search" placeholder="Search… (/ to focus)" autocomplete="off"
      class="w-full py-1.5 px-2.5 border border-gray-200 rounded-md bg-white text-gray-900 text-[13px] outline-none focus:border-blue-600 placeholder:text-gray-400" />
  </div>
  <div class="flex-1 overflow-y-auto py-1.5" id="list">
    ${items}
  </div>
  <div class="px-3.5 py-2 border-t border-gray-200 text-[11px] text-gray-400 select-none flex flex-wrap gap-y-1">
    <span><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">↑/↓</kbd> open</span>
    <span class="ml-1.5"><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">↵</kbd> open</span>
    <span class="ml-1.5"><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">;</kbd> copy path</span>
    <span class="ml-1.5"><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">r</kbd> refresh</span>
    <span class="ml-1.5"><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">/</kbd> search</span>
    <span class="ml-1.5"><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">b</kbd> sidebar</span>
  </div>
</nav>

<div class="main h-full ml-0 pt-12 md:ml-[280px] md:pt-0 flex flex-col">
  ${active ? `<div class="flex items-center px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-[12px] text-gray-500 shrink-0">
    <span class="flex-1 font-mono overflow-hidden text-ellipsis whitespace-nowrap">${active}</span>
    <button id="copyBtn" class="ml-2 px-2 py-0.5 text-[11px] bg-white border border-gray-200 rounded hover:bg-gray-100 cursor-pointer text-gray-600 shrink-0" title="Copy path (;)">copy path</button>
  </div>
  <iframe id="preview" src="${rawHref(active)}" class="w-full flex-1 border-none bg-white"></iframe>` : '<div class="flex items-center justify-center flex-1 text-gray-400 text-[15px]">Select a file from the sidebar</div>'}
</div>

<div id="itemMenu" class="hidden fixed z-[60] min-w-[150px] bg-white border border-gray-200 rounded-md shadow-lg py-1 text-[13px]">
  <button type="button" data-action="rename" class="w-full text-left px-3 py-1.5 text-gray-900 hover:bg-gray-100 cursor-pointer">Rename</button>
  <button type="button" data-action="delete" class="w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50 cursor-pointer">Delete</button>
</div>

<dialog id="renameDialog" class="rounded-lg border border-gray-200 shadow-xl p-0 w-[min(90vw,460px)]">
  <form id="renameForm" class="p-4">
    <h2 class="text-[15px] font-semibold text-gray-900 mb-1">Rename</h2>
    <p class="text-[12px] text-gray-500 mb-3">Edit the path below. This runs <code class="font-mono bg-gray-100 px-1 rounded">mv</code>.</p>
    <input type="text" id="renameInput" name="to" autocomplete="off" autocapitalize="off" spellcheck="false"
      class="w-full py-1.5 px-2.5 border border-gray-200 rounded-md bg-white text-gray-900 text-[13px] font-mono outline-none focus:border-blue-600" />
    <div class="flex justify-end gap-2 mt-4">
      <button type="button" id="renameCancel" class="px-3 py-1.5 text-[13px] rounded-md border border-gray-200 text-gray-700 hover:bg-gray-100 cursor-pointer">Cancel</button>
      <button type="submit" class="px-3 py-1.5 text-[13px] rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">Rename</button>
    </div>
  </form>
</dialog>

<div id="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-900 text-white text-[13px] rounded-lg shadow-lg opacity-0 transition-opacity duration-200 pointer-events-none z-50"></div>

<script>
  const search = document.getElementById("search");
  const list = document.getElementById("list");
  const burger = document.getElementById("burger");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const allItems = Array.from(list.querySelectorAll(".item"));
  let focusIdx = -1;

  const rowOf = (el) => el.closest(".item-row");

  function visibleItems() {
    return allItems.filter(el => rowOf(el).style.display !== "none");
  }

  // True when a shortcut should be ignored because the user is typing in the
  // rename field or a modal dialog is open (search is handled separately).
  function shortcutsBlocked() {
    if (document.activeElement && document.activeElement.id === "renameInput") return true;
    return !!document.querySelector("dialog[open]");
  }

  function setFocus(idx) {
    const visible = visibleItems();
    allItems.forEach(el => el.classList.remove("kb-focus"));
    if (idx < 0 || idx >= visible.length) { focusIdx = -1; return; }
    focusIdx = idx;
    visible[idx].classList.add("kb-focus");
    visible[idx].scrollIntoView({ block: "nearest" });
  }

  search.addEventListener("input", () => {
    const q = search.value.toLowerCase();
    let vis = 0;
    for (const el of allItems) {
      const match = el.textContent.toLowerCase().includes(q) || el.getAttribute("title").toLowerCase().includes(q);
      rowOf(el).style.display = match ? "" : "none";
      if (match) vis++;
    }
    const empty = list.querySelector(".empty");
    if (vis === 0 && !empty) {
      const d = document.createElement("div");
      d.className = "empty px-3.5 py-5 text-[13px] text-gray-400";
      d.textContent = "No matches";
      list.appendChild(d);
    } else if (vis > 0 && empty) {
      empty.remove();
    }
    if (q.length > 0 && vis > 0) setFocus(0);
    else setFocus(-1);
  });

  document.addEventListener("keydown", (e) => {
    if (shortcutsBlocked()) return;
    const isSearching = document.activeElement === search;

    if (e.key === "/" && !isSearching) {
      e.preventDefault();
      search.focus();
      return;
    }

    if (e.key === "Escape") {
      if (isSearching) search.blur();
      closeMenu();
      setFocus(-1);
      return;
    }

    const visible = visibleItems();
    if (!visible.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = focusIdx === -1 ? 0 : focusIdx < visible.length - 1 ? focusIdx + 1 : 0;
      setFocus(next);
      openItem(visible[next]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = focusIdx === -1 ? visible.length - 1 : focusIdx > 0 ? focusIdx - 1 : visible.length - 1;
      setFocus(prev);
      openItem(visible[prev]);
    } else if (e.key === "Enter" && focusIdx >= 0) {
      e.preventDefault();
      visible[focusIdx].click();
    }
  });

  function toggleMenu() {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("open");
  }
  burger.addEventListener("click", toggleMenu);
  overlay.addEventListener("click", toggleMenu);

  // Desktop sidebar collapse
  const collapseBtn = document.getElementById("collapseBtn");
  const expandBtn = document.getElementById("expandBtn");
  function setCollapsed(v) {
    document.documentElement.classList.toggle("collapsed", v);
    try { localStorage.setItem("sidebarCollapsed", v ? "1" : "0"); } catch {}
  }
  collapseBtn.addEventListener("click", () => setCollapsed(true));
  expandBtn.addEventListener("click", () => {
    // On mobile the chevron sits over the burger; toggle the slide-in sidebar
    // instead of the desktop-only collapsed state.
    if (window.matchMedia("(max-width: 767px)").matches) toggleMenu();
    else setCollapsed(false);
  });

  // Navigate without full page reload
  function openItem(el) {
    const file = el.getAttribute("title");
    if (!file) return;
    const iframe = document.getElementById("preview");
    if (iframe) {
      iframe.src = "/raw/" + file.split("/").map(encodeURIComponent).join("/");
    } else {
      // No iframe yet (nothing was selected) — need full navigation
      el.click();
      return;
    }
    allItems.forEach(a => a.classList.remove("active", "bg-blue-50", "!border-l-blue-600", "text-blue-600", "font-semibold"));
    el.classList.add("active", "bg-blue-50", "!border-l-blue-600", "text-blue-600", "font-semibold");
    activePath = file;
    const pathSpan = document.querySelector("#copyBtn")?.previousElementSibling;
    if (pathSpan) pathSpan.textContent = file;
    document.title = "./" + file + " — agents";
    history.replaceState(null, "", "/?file=" + encodeURIComponent(file));
  }

  const activeIdx = visibleItems().findIndex(el => el.classList.contains("active"));
  if (activeIdx >= 0) setFocus(activeIdx);

  // Toast
  const toast = document.getElementById("toast");
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = "0"; }, 1800);
  }

  // Copy path
  let activePath = ${active ? `"${active}"` : "null"};
  function copyPath() {
    if (!activePath) return;
    navigator.clipboard.writeText(activePath).then(() => showToast("Copied: " + activePath));
  }
  const copyBtn = document.getElementById("copyBtn");
  if (copyBtn) copyBtn.addEventListener("click", copyPath);

  document.addEventListener("keydown", (e) => {
    if (document.activeElement === search || shortcutsBlocked()) return;
    if (e.key === ";") { e.preventDefault(); copyPath(); }
    if (e.key === "r") { e.preventDefault(); location.reload(); }
    if (e.key === "b") { e.preventDefault(); setCollapsed(!document.documentElement.classList.contains("collapsed")); }
  });

  // Per-item action menu (rename / delete)
  const itemMenu = document.getElementById("itemMenu");
  const renameDialog = document.getElementById("renameDialog");
  const renameForm = document.getElementById("renameForm");
  const renameInput = document.getElementById("renameInput");
  let menuPath = null;

  function openMenu(btn) {
    menuPath = rowOf(btn).getAttribute("data-path");
    itemMenu.classList.remove("hidden");
    const r = btn.getBoundingClientRect();
    const mw = itemMenu.offsetWidth;
    const mh = itemMenu.offsetHeight;
    let left = Math.max(8, r.right - mw);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    itemMenu.style.left = left + "px";
    itemMenu.style.top = top + "px";
  }
  function closeMenu() {
    if (!itemMenu) return;
    itemMenu.classList.add("hidden");
    menuPath = null;
  }

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".menu-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const path = rowOf(btn).getAttribute("data-path");
    if (!itemMenu.classList.contains("hidden") && menuPath === path) closeMenu();
    else openMenu(btn);
  });

  document.addEventListener("click", (e) => {
    if (itemMenu.classList.contains("hidden")) return;
    if (!itemMenu.contains(e.target)) closeMenu();
  });
  list.addEventListener("scroll", closeMenu);
  window.addEventListener("resize", closeMenu);

  // Rename — opens a dialog, submits to /api/rename (which runs mv)
  document.getElementById("renameCancel").addEventListener("click", () => renameDialog.close());

  itemMenu.querySelector('[data-action="rename"]').addEventListener("click", () => {
    const from = menuPath;
    closeMenu();
    if (!from) return;
    renameForm.dataset.from = from;
    renameInput.value = from;
    renameDialog.showModal();
    renameInput.focus();
    renameInput.setSelectionRange(from.length, from.length);
  });

  renameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = renameForm.dataset.from;
    const to = renameInput.value.trim();
    if (!to || to === from) { renameDialog.close(); return; }
    try {
      const res = await fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      renameDialog.close();
      if (from === activePath) location.href = "/?file=" + encodeURIComponent(to);
      else location.reload();
    } catch (err) {
      showToast("Rename failed: " + err.message);
    }
  });

  // Delete — removes the file immediately
  itemMenu.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    const path = menuPath;
    closeMenu();
    if (!path) return;
    try {
      const res = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (path === activePath) location.href = "/";
      else location.reload();
    } catch (err) {
      showToast("Delete failed: " + err.message);
    }
  });

  // Live reload via SSE
  const evtSource = new EventSource("/events");
  evtSource.onmessage = (e) => {
    if (e.data === "connected") return;
    const iframe = document.getElementById("preview");
    if (iframe) iframe.src = iframe.src;
  };

  // Forward keyboard shortcuts from iframe to parent
  const previewFrame = document.getElementById("preview");
  if (previewFrame) {
    function attachIframeKeys() {
      try {
        previewFrame.contentWindow.addEventListener("keydown", (e) => {
          if (["j", "k", ";", "b", "/", "Escape", "ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true }));
          }
        });
      } catch {}
    }
    previewFrame.addEventListener("load", () => {
      attachIframeKeys();
      try { previewFrame.contentWindow.focus(); } catch {}
    });
    try { previewFrame.contentWindow.focus(); } catch {}
  }
</script>
</body>
</html>`;
}

const sseClients = new Set<ReadableStreamDirectController>();

watch(`${cwd}/agents`, { recursive: true }, (_event, filename) => {
  cachedFiles = null;
  if (!filename?.endsWith(".html")) return;
  for (const controller of sseClients) {
    try {
      controller.write(`data: ${filename}\n\n`);
    } catch {
      sseClients.delete(controller);
    }
  }
});

const server = Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/events") {
      return new Response(
        new ReadableStream({
          type: "direct",
          pull(controller) {
            sseClients.add(controller);
            controller.write("data: connected\n\n");
            return new Promise(() => {});
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }
      );
    }

    // Rename a file (mv) — { from, to }, both relative paths under agents/
    if (req.method === "POST" && url.pathname === "/api/rename") {
      let body: { from?: unknown; to?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const { from, to } = body;
      if (!safePath(from) || !safePath(to)) return json({ error: "Invalid path" }, 400);
      const absFrom = `${cwd}/${from}`;
      const absTo = `${cwd}/${to}`;
      if (!(await Bun.file(absFrom).exists())) return json({ error: "Source not found" }, 404);
      if (await Bun.file(absTo).exists()) return json({ error: "Target already exists" }, 409);
      try {
        await $`mkdir -p ${dirname(absTo)}`.quiet();
        await $`mv ${absFrom} ${absTo}`.quiet();
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
      cachedFiles = null;
      return json({ ok: true });
    }

    // Delete a file immediately — { path }, relative path under agents/
    if (req.method === "POST" && url.pathname === "/api/delete") {
      let body: { path?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!safePath(body.path)) return json({ error: "Invalid path" }, 400);
      const abs = `${cwd}/${body.path}`;
      if (!(await Bun.file(abs).exists())) return json({ error: "Not found" }, 404);
      try {
        await unlink(abs);
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 500);
      }
      cachedFiles = null;
      return json({ ok: true });
    }

    // Path-based serving: the iframe loads /raw/agents/<dir>/<file>.html, so
    // relative asset srcs in the report (sibling screenshots) resolve to
    // /raw/agents/<dir>/<asset> and get served here too.
    if (url.pathname.startsWith("/raw/")) {
      const rel = decodeURIComponent(url.pathname.slice("/raw/".length));
      if (!rel.startsWith("agents/") || rel.split("/").includes("..")) {
        return new Response("Not found", { status: 404 });
      }
      const resolved = Bun.file(`${cwd}/${rel}`);
      if (!(await resolved.exists())) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(resolved); // Content-Type inferred from extension
    }

    // Legacy query form (old bookmarks) — redirect to the path form
    if (url.pathname === "/raw") {
      const file = url.searchParams.get("file");
      if (!file || !file.startsWith("agents/")) {
        return new Response("Not found", { status: 404 });
      }
      return Response.redirect(rawHref(file), 302);
    }

    cachedFiles = null;
    const files = findHtmlFiles();
    const active = url.searchParams.get("file") ?? files[0]?.path ?? null;
    const html = buildPage(files, active);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`agents server running at http://localhost:${server.port}`);
