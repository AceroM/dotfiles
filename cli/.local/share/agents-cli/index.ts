#!/usr/bin/env bun

import { Glob } from "bun";
import { basename, relative } from "node:path";
import { watch } from "node:fs";

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
      return `<a href="/?file=${encodeURIComponent(entry.path)}" class="item flex items-center px-3.5 py-2 text-[13px] no-underline border-l-[3px] border-transparent transition-colors hover:bg-gray-100 ${isActive ? "bg-blue-50 !border-l-blue-600 text-blue-600 font-semibold active" : "text-gray-900"}" title="${entry.path}"><span class="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">${label}</span><span class="ml-2 text-[11px] text-gray-400 whitespace-nowrap shrink-0">${ago}</span></a>`;
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
  <iframe id="preview" src="/raw?file=${encodeURIComponent(active)}" class="w-full flex-1 border-none bg-white"></iframe>` : '<div class="flex items-center justify-center flex-1 text-gray-400 text-[15px]">Select a file from the sidebar</div>'}
</div>

<div id="toast" class="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-900 text-white text-[13px] rounded-lg shadow-lg opacity-0 transition-opacity duration-200 pointer-events-none z-50"></div>

<script>
  const search = document.getElementById("search");
  const list = document.getElementById("list");
  const burger = document.getElementById("burger");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const allItems = Array.from(list.querySelectorAll(".item"));
  let focusIdx = -1;

  function visibleItems() {
    return allItems.filter(el => el.style.display !== "none");
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
      el.style.display = match ? "" : "none";
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
    const isSearching = document.activeElement === search;

    if (e.key === "/" && !isSearching) {
      e.preventDefault();
      search.focus();
      return;
    }

    if (e.key === "Escape") {
      if (isSearching) search.blur();
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
  expandBtn.addEventListener("click", () => setCollapsed(false));

  // Navigate without full page reload
  function openItem(el) {
    const file = el.getAttribute("title");
    if (!file) return;
    const iframe = document.getElementById("preview");
    if (iframe) {
      iframe.src = "/raw?file=" + encodeURIComponent(file);
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
    if (document.activeElement === search) return;
    if (e.key === ";") { e.preventDefault(); copyPath(); }
    if (e.key === "r") { e.preventDefault(); location.reload(); }
    if (e.key === "b") { e.preventDefault(); setCollapsed(!document.documentElement.classList.contains("collapsed")); }
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
    previewFrame.addEventListener("load", attachIframeKeys);
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
  fetch(req) {
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

    if (url.pathname === "/raw") {
      const file = url.searchParams.get("file");
      if (!file || !file.startsWith("agents/")) {
        return new Response("Not found", { status: 404 });
      }
      const resolved = Bun.file(`${cwd}/${file}`);
      return new Response(resolved, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    cachedFiles = null;
    const files = findHtmlFiles();
    const active = url.searchParams.get("file");
    const html = buildPage(files, active);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`agents server running at http://localhost:${server.port}`);
