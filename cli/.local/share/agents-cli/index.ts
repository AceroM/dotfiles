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

// --- PWA assets -------------------------------------------------------------

// Self-contained app icon (blue rounded square + white robot head). Served as
// SVG so no binary blobs live in the repo; modern browsers accept SVG manifest
// icons for installability.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2563eb"/>
  <rect x="120" y="230" width="20" height="60" rx="10" fill="#fff"/>
  <rect x="372" y="230" width="20" height="60" rx="10" fill="#fff"/>
  <rect x="248" y="104" width="16" height="46" rx="8" fill="#fff"/>
  <circle cx="256" cy="96" r="20" fill="#fff"/>
  <rect x="136" y="150" width="240" height="200" rx="44" fill="#fff"/>
  <circle cx="206" cy="238" r="26" fill="#2563eb"/>
  <circle cx="306" cy="238" r="26" fill="#2563eb"/>
  <rect x="198" y="300" width="116" height="18" rx="9" fill="#2563eb"/>
</svg>`;

const MANIFEST = {
  name: "agents",
  short_name: "agents",
  description: "Browse agent HTML reports",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
};

const REPORT_THEME_SNIPPET = String.raw`<style id="agents-theme-vars">
  :root {
    color-scheme: light;
    --agents-bg: #ffffff;
    --agents-page: #f8fafc;
    --agents-surface: #ffffff;
    --agents-surface-2: #f1f5f9;
    --agents-text: #111827;
    --agents-muted: #64748b;
    --agents-border: #e2e8f0;
    --agents-soft: #eef2f7;
    --agents-code: #f8fafc;
    --agents-link: #2563eb;
    --agents-accent: #2563eb;
    --agents-ok: #16a34a;
    --agents-warn: #b45309;
    --agents-danger: #dc2626;
  }

  html[data-agents-theme="dark"] {
    color-scheme: dark;
    --agents-bg: #0b0f19;
    --agents-page: #0f1623;
    --agents-surface: #151d2b;
    --agents-surface-2: #1c2636;
    --agents-text: #e5e7eb;
    --agents-muted: #a3adbd;
    --agents-border: #334155;
    --agents-soft: #1e293b;
    --agents-code: #111827;
    --agents-link: #7dd3fc;
    --agents-accent: #60a5fa;
    --agents-ok: #4ade80;
    --agents-warn: #fbbf24;
    --agents-danger: #f87171;
    --bg: var(--agents-page);
    --panel: var(--agents-surface);
    --ink: var(--agents-text);
    --muted: var(--agents-muted);
    --line: var(--agents-border);
    --soft: var(--agents-soft);
    --code: var(--agents-code);
    --accent: var(--agents-accent);
    --accent-2: #5eead4;
    --ok: var(--agents-ok);
    --warn: var(--agents-warn);
    --danger: var(--agents-danger);
  }

  html[data-agents-theme="dark"] body {
    background: var(--agents-bg) !important;
    color: var(--agents-text) !important;
  }

  html[data-agents-theme="dark"] a { color: var(--agents-link); }
  html[data-agents-theme="dark"] code:not(pre code) {
    background: var(--agents-code) !important;
    color: var(--agents-text) !important;
    border-color: var(--agents-border) !important;
  }
  html[data-agents-theme="dark"] pre,
  html[data-agents-theme="dark"] pre code {
    background: #070b12 !important;
    color: #dbeafe !important;
  }
  html[data-agents-theme="dark"] table,
  html[data-agents-theme="dark"] .card,
  html[data-agents-theme="dark"] .stat,
  html[data-agents-theme="dark"] blockquote {
    background-color: var(--agents-surface) !important;
    border-color: var(--agents-border) !important;
  }
  html[data-agents-theme="dark"] th {
    background-color: var(--agents-surface-2) !important;
    color: var(--agents-text) !important;
  }
  html[data-agents-theme="dark"] td,
  html[data-agents-theme="dark"] th {
    border-color: var(--agents-border) !important;
  }
  html[data-agents-theme="dark"] img {
    border-color: var(--agents-border) !important;
  }

  html[data-agents-theme="dark"] .bg-white { background-color: var(--agents-surface) !important; }
  html[data-agents-theme="dark"] .bg-gray-50,
  html[data-agents-theme="dark"] .bg-slate-50,
  html[data-agents-theme="dark"] .bg-zinc-50,
  html[data-agents-theme="dark"] .bg-neutral-50 { background-color: var(--agents-page) !important; }
  html[data-agents-theme="dark"] .bg-gray-100,
  html[data-agents-theme="dark"] .bg-slate-100,
  html[data-agents-theme="dark"] .bg-zinc-100,
  html[data-agents-theme="dark"] .bg-neutral-100 { background-color: var(--agents-surface-2) !important; }
  html[data-agents-theme="dark"] .bg-gray-200,
  html[data-agents-theme="dark"] .bg-slate-200 { background-color: #243044 !important; }
  html[data-agents-theme="dark"] .bg-blue-50,
  html[data-agents-theme="dark"] .bg-indigo-50,
  html[data-agents-theme="dark"] .bg-sky-50 { background-color: rgba(96, 165, 250, 0.16) !important; }
  html[data-agents-theme="dark"] .bg-green-50,
  html[data-agents-theme="dark"] .bg-emerald-50 { background-color: rgba(74, 222, 128, 0.13) !important; }
  html[data-agents-theme="dark"] .bg-yellow-50,
  html[data-agents-theme="dark"] .bg-amber-50,
  html[data-agents-theme="dark"] .bg-orange-50 { background-color: rgba(251, 191, 36, 0.14) !important; }
  html[data-agents-theme="dark"] .bg-red-50,
  html[data-agents-theme="dark"] .bg-rose-50 { background-color: rgba(248, 113, 113, 0.14) !important; }
  html[data-agents-theme="dark"] .bg-purple-50,
  html[data-agents-theme="dark"] .bg-violet-50 { background-color: rgba(192, 132, 252, 0.14) !important; }

  html[data-agents-theme="dark"] .text-gray-950,
  html[data-agents-theme="dark"] .text-gray-900,
  html[data-agents-theme="dark"] .text-gray-800,
  html[data-agents-theme="dark"] .text-slate-950,
  html[data-agents-theme="dark"] .text-slate-900,
  html[data-agents-theme="dark"] .text-slate-800,
  html[data-agents-theme="dark"] .text-zinc-900,
  html[data-agents-theme="dark"] .text-neutral-900 { color: var(--agents-text) !important; }
  html[data-agents-theme="dark"] .text-gray-700,
  html[data-agents-theme="dark"] .text-gray-600,
  html[data-agents-theme="dark"] .text-gray-500,
  html[data-agents-theme="dark"] .text-gray-400,
  html[data-agents-theme="dark"] .text-slate-700,
  html[data-agents-theme="dark"] .text-slate-600,
  html[data-agents-theme="dark"] .text-slate-500,
  html[data-agents-theme="dark"] .text-slate-400,
  html[data-agents-theme="dark"] .text-zinc-600 { color: var(--agents-muted) !important; }
  html[data-agents-theme="dark"] .text-blue-700,
  html[data-agents-theme="dark"] .text-blue-600,
  html[data-agents-theme="dark"] .text-indigo-700,
  html[data-agents-theme="dark"] .text-indigo-600,
  html[data-agents-theme="dark"] .text-sky-700,
  html[data-agents-theme="dark"] .text-sky-600 { color: var(--agents-link) !important; }
  html[data-agents-theme="dark"] .text-green-700,
  html[data-agents-theme="dark"] .text-green-600,
  html[data-agents-theme="dark"] .text-emerald-700,
  html[data-agents-theme="dark"] .text-emerald-600 { color: var(--agents-ok) !important; }
  html[data-agents-theme="dark"] .text-yellow-700,
  html[data-agents-theme="dark"] .text-amber-700,
  html[data-agents-theme="dark"] .text-orange-700 { color: var(--agents-warn) !important; }
  html[data-agents-theme="dark"] .text-red-700,
  html[data-agents-theme="dark"] .text-red-600,
  html[data-agents-theme="dark"] .text-rose-700 { color: var(--agents-danger) !important; }

  html[data-agents-theme="dark"] .border-gray-100,
  html[data-agents-theme="dark"] .border-gray-200,
  html[data-agents-theme="dark"] .border-gray-300,
  html[data-agents-theme="dark"] .border-slate-100,
  html[data-agents-theme="dark"] .border-slate-200,
  html[data-agents-theme="dark"] .border-slate-300,
  html[data-agents-theme="dark"] .border-zinc-200,
  html[data-agents-theme="dark"] .border-neutral-200,
  html[data-agents-theme="dark"] .divide-gray-200 > :not([hidden]) ~ :not([hidden]) {
    border-color: var(--agents-border) !important;
  }
  html[data-agents-theme="dark"] .border-blue-200,
  html[data-agents-theme="dark"] .border-blue-600,
  html[data-agents-theme="dark"] .border-l-blue-600 { border-color: var(--agents-accent) !important; }
  html[data-agents-theme="dark"] .shadow,
  html[data-agents-theme="dark"] .shadow-sm,
  html[data-agents-theme="dark"] .shadow-md,
  html[data-agents-theme="dark"] .shadow-lg,
  html[data-agents-theme="dark"] .shadow-xl {
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28) !important;
  }
</style>
<script id="agents-theme-script">
(() => {
  const KEY = "agentsTheme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const readStored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const normalize = (value) => value === "dark" || value === "light" ? value : (media.matches ? "dark" : "light");
  const apply = (value) => {
    const theme = normalize(value);
    root.dataset.agentsTheme = theme;
    root.style.colorScheme = theme;
  };
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "agents-theme") apply(event.data.theme);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) apply(event.newValue);
  });
  media.addEventListener?.("change", () => {
    if (!readStored()) apply(null);
  });
  apply(readStored());
})();
</script>`;

function injectReportTheme(html: string): string {
  if (html.includes('id="agents-theme-vars"')) return html;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${REPORT_THEME_SNIPPET}\n</head>`);
  }
  return `${REPORT_THEME_SNIPPET}\n${html}`;
}

// Minimal service worker: satisfies installability (has a GET fetch handler) and
// caches just the static shell assets. Reports/API/SSE always hit the network,
// so nothing dynamic goes stale — the app only works with the server running.
const SERVICE_WORKER = `
const CACHE = "agents-shell-v1";
const SHELL = ["/icon.svg", "/manifest.webmanifest"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
`;

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
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/icon.svg" />
<meta name="theme-color" content="#ffffff" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="agents" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<script>
  (() => {
    const key = "agentsTheme";
    let stored = null;
    try { stored = localStorage.getItem(key); } catch {}
    const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = stored === "dark" || stored === "light" ? stored : system;
  })();
</script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root {
    color-scheme: light;
    --ui-bg: #ffffff;
    --ui-panel: #f9fafb;
    --ui-surface: #ffffff;
    --ui-elevated: #ffffff;
    --ui-text: #111827;
    --ui-muted: #6b7280;
    --ui-subtle: #9ca3af;
    --ui-border: #e5e7eb;
    --ui-hover: #f3f4f6;
    --ui-hover-strong: #e5e7eb;
    --ui-active: #eff6ff;
    --ui-active-focus: #dbeafe;
    --ui-accent: #2563eb;
    --ui-accent-soft: #dbeafe;
    --ui-danger: #dc2626;
    --ui-danger-soft: #fef2f2;
    --ui-code: #f3f4f6;
    --ui-toast: #111827;
    --ui-toast-text: #ffffff;
  }

  html[data-theme="dark"] {
    color-scheme: dark;
    --ui-bg: #0b0f19;
    --ui-panel: #101827;
    --ui-surface: #151d2b;
    --ui-elevated: #1a2434;
    --ui-text: #e5e7eb;
    --ui-muted: #a3adbd;
    --ui-subtle: #7f8da3;
    --ui-border: #334155;
    --ui-hover: #1e293b;
    --ui-hover-strong: #263348;
    --ui-active: rgba(96, 165, 250, 0.16);
    --ui-active-focus: rgba(96, 165, 250, 0.24);
    --ui-accent: #7dd3fc;
    --ui-accent-soft: rgba(96, 165, 250, 0.16);
    --ui-danger: #f87171;
    --ui-danger-soft: rgba(248, 113, 113, 0.14);
    --ui-code: #111827;
    --ui-toast: #e5e7eb;
    --ui-toast-text: #0b0f19;
  }

  body { background: var(--ui-bg); color: var(--ui-text); }
  dialog { background: var(--ui-elevated); color: var(--ui-text); }
  .item.kb-focus { background: var(--ui-hover-strong); }
  .item.active.kb-focus { background: var(--ui-active-focus); }
  .theme-sun { display: none; }
  html[data-theme="dark"] .theme-sun { display: block; }
  html[data-theme="dark"] .theme-moon { display: none; }

  html[data-theme="dark"] .bg-white { background-color: var(--ui-surface) !important; }
  html[data-theme="dark"] .bg-gray-50 { background-color: var(--ui-panel) !important; }
  html[data-theme="dark"] .bg-gray-100 { background-color: var(--ui-hover) !important; }
  html[data-theme="dark"] .bg-gray-200 { background-color: var(--ui-hover-strong) !important; }
  html[data-theme="dark"] .bg-blue-50 { background-color: var(--ui-active) !important; }
  html[data-theme="dark"] .bg-red-50 { background-color: var(--ui-danger-soft) !important; }
  html[data-theme="dark"] .bg-gray-900 { background-color: var(--ui-toast) !important; }
  html[data-theme="dark"] .text-white { color: var(--ui-toast-text) !important; }
  html[data-theme="dark"] .text-gray-900,
  html[data-theme="dark"] .text-gray-800,
  html[data-theme="dark"] .text-gray-700 { color: var(--ui-text) !important; }
  html[data-theme="dark"] .text-gray-600,
  html[data-theme="dark"] .text-gray-500,
  html[data-theme="dark"] .text-gray-400 { color: var(--ui-muted) !important; }
  html[data-theme="dark"] .text-blue-600 { color: var(--ui-accent) !important; }
  html[data-theme="dark"] .text-red-600 { color: var(--ui-danger) !important; }
  html[data-theme="dark"] .border-gray-200,
  html[data-theme="dark"] .border-blue-200 { border-color: var(--ui-border) !important; }
  html[data-theme="dark"] .border-l-blue-600,
  html[data-theme="dark"] .\\!border-l-blue-600 { border-left-color: var(--ui-accent) !important; }
  html[data-theme="dark"] .focus\\:border-blue-600:focus { border-color: var(--ui-accent) !important; }
  html[data-theme="dark"] .placeholder\\:text-gray-400::placeholder { color: var(--ui-subtle) !important; }
  html[data-theme="dark"] .hover\\:bg-gray-100:hover,
  html[data-theme="dark"] .group:hover .group-hover\\:bg-gray-100 { background-color: var(--ui-hover) !important; }
  html[data-theme="dark"] .hover\\:bg-gray-200:hover { background-color: var(--ui-hover-strong) !important; }
  html[data-theme="dark"] .hover\\:bg-blue-100:hover { background-color: var(--ui-active-focus) !important; }
  html[data-theme="dark"] .hover\\:bg-red-50:hover { background-color: var(--ui-danger-soft) !important; }
  html[data-theme="dark"] .hover\\:text-gray-900:hover { color: var(--ui-text) !important; }
  html[data-theme="dark"] code:not(pre code) {
    background-color: var(--ui-code) !important;
    color: var(--ui-text) !important;
    border-color: var(--ui-border) !important;
  }

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
      <div class="flex items-center gap-1.5">
        <button id="installBtn" class="hidden px-2 py-0.5 text-[11px] rounded border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 cursor-pointer" title="Install as app">Install</button>
        <button id="themeBtn" class="flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded cursor-pointer" title="Toggle dark mode (t)" aria-label="Toggle dark mode" aria-pressed="false">
          <svg class="theme-moon w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z"/></svg>
          <svg class="theme-sun w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        </button>
        <button id="collapseBtn" class="hidden md:flex items-center justify-center w-6 h-6 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded cursor-pointer text-[15px] leading-none" title="Collapse sidebar (b)">&#171;</button>
      </div>
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
    <span class="ml-1.5"><kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">t</kbd> theme</span>
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

  const THEME_KEY = "agentsTheme";
  const themeBtn = document.getElementById("themeBtn");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const normalizeTheme = (value) => value === "dark" || value === "light" ? value : (themeMedia.matches ? "dark" : "light");

  function pushThemeToFrame(theme = document.documentElement.dataset.theme) {
    const frame = document.getElementById("preview");
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ type: "agents-theme", theme }, window.location.origin);
      frame.contentDocument.documentElement.dataset.agentsTheme = theme;
      frame.contentDocument.documentElement.style.colorScheme = theme;
    } catch {}
  }

  function setTheme(value, persist = true) {
    const theme = normalizeTheme(value);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (themeMeta) themeMeta.setAttribute("content", theme === "dark" ? "#0b0f19" : "#ffffff");
    if (themeBtn) themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
    try {
      if (persist) localStorage.setItem(THEME_KEY, theme);
    } catch {}
    pushThemeToFrame(theme);
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }
  themeMedia.addEventListener?.("change", () => {
    try {
      if (localStorage.getItem(THEME_KEY)) return;
    } catch {}
    setTheme(null, false);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) setTheme(event.newValue, false);
  });
  let storedTheme = null;
  try { storedTheme = localStorage.getItem(THEME_KEY); } catch {}
  setTheme(storedTheme, false);

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
    if (e.key === "t") { e.preventDefault(); setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }
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
          if (["j", "k", ";", "b", "t", "/", "Escape", "ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true }));
          }
        });
      } catch {}
    }
    previewFrame.addEventListener("load", () => {
      attachIframeKeys();
      pushThemeToFrame();
      try { previewFrame.contentWindow.focus(); } catch {}
    });
    try { previewFrame.contentWindow.focus(); } catch {}
  }

  // PWA: register the service worker and wire up the install button
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  let deferredPrompt = null;
  const installBtn = document.getElementById("installBtn");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.classList.remove("hidden");
  });
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add("hidden");
    });
  }
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    if (installBtn) installBtn.classList.add("hidden");
  });
</script>
</body>
</html>`;
}

type DirectSseController = { write(chunk: string): void };

const sseClients = new Set<DirectSseController>();

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

    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify(MANIFEST), {
        headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
      });
    }

    if (url.pathname === "/icon.svg") {
      return new Response(ICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    if (url.pathname === "/sw.js") {
      return new Response(SERVICE_WORKER, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "Service-Worker-Allowed": "/",
        },
      });
    }

    if (url.pathname === "/events") {
      return new Response(
        new ReadableStream({
          type: "direct",
          pull(controller: DirectSseController) {
            sseClients.add(controller);
            controller.write("data: connected\n\n");
            return new Promise(() => {});
          },
        } as any),
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
      if (rel.endsWith(".html")) {
        return new Response(injectReportTheme(await resolved.text()), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
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
