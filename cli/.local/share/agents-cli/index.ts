#!/usr/bin/env bun

import { Glob } from "bun";
import { basename, relative } from "node:path";

const cwd = process.cwd();
const port = parseInt(process.argv[2] || "3333", 10);

function findHtmlFiles(): string[] {
  const glob = new Glob("agents/**/*.html");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd, absolute: false })) {
    files.push(path);
  }
  return files.sort();
}

function buildPage(files: string[], active: string | null): string {
  const items = files
    .map((f) => {
      const name = basename(f, ".html");
      const isActive = f === active;
      return `<a href="/?file=${encodeURIComponent(f)}" class="item${isActive ? " active" : ""}" title="${f}">${name}</a>`;
    })
    .join("\n");

  const activeLabel = active ? basename(active, ".html") : "agents";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${activeLabel} — agents</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --sidebar-w: 280px;
    --topbar-h: 48px;
    --bg: #ffffff;
    --sidebar-bg: #f8f8f8;
    --border: #e2e2e2;
    --text: #1a1a1a;
    --text-muted: #888;
    --accent: #2563eb;
    --hover: #f0f0f0;
    --active: #e8edfb;
  }

  html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }

  /* -- topbar (mobile only) -- */
  .topbar {
    display: none;
    position: fixed; top: 0; left: 0; right: 0;
    height: var(--topbar-h);
    background: var(--sidebar-bg);
    border-bottom: 1px solid var(--border);
    align-items: center;
    padding: 0 12px;
    z-index: 20;
  }
  .topbar .burger {
    background: none; border: none; color: var(--text); font-size: 22px; cursor: pointer; padding: 4px 8px;
  }
  .topbar .title {
    margin-left: auto;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* -- sidebar -- */
  .sidebar {
    position: fixed; top: 0; left: 0; bottom: 0;
    width: var(--sidebar-w);
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    z-index: 30;
  }
  .sidebar-header {
    padding: 16px 14px 12px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-header h1 { font-size: 15px; font-weight: 700; margin-bottom: 10px; }
  .sidebar-header input {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  .sidebar-header input:focus { border-color: var(--accent); }
  .sidebar-header input::placeholder { color: var(--text-muted); }

  .sidebar-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }
  .sidebar-list .item {
    display: block;
    padding: 8px 14px;
    font-size: 13px;
    color: var(--text);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-left: 3px solid transparent;
  }
  .sidebar-list .item:hover { background: var(--hover); }
  .sidebar-list .item.active {
    background: var(--active);
    border-left-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .sidebar-list .empty {
    padding: 20px 14px;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* -- main content -- */
  .main {
    margin-left: var(--sidebar-w);
    height: 100%;
  }
  .main iframe {
    width: 100%; height: 100%; border: none; background: #fff;
  }
  .main .placeholder {
    display: flex; align-items: center; justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 15px;
  }

  /* -- overlay (mobile) -- */
  .overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,.5);
    z-index: 25;
  }

  /* -- mobile -- */
  @media (max-width: 768px) {
    .topbar { display: flex; }
    .sidebar {
      transform: translateX(-100%);
      transition: transform .2s ease;
    }
    .sidebar.open { transform: translateX(0); }
    .overlay.open { display: block; }
    .main { margin-left: 0; padding-top: var(--topbar-h); }
  }
</style>
</head>
<body>

<div class="topbar">
  <button class="burger" id="burger">&#9776;</button>
  <span class="title">${activeLabel}</span>
</div>

<div class="overlay" id="overlay"></div>

<nav class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <h1>agents</h1>
    <input type="text" id="search" placeholder="Search files…" autocomplete="off" />
  </div>
  <div class="sidebar-list" id="list">
    ${items}
  </div>
</nav>

<div class="main">
  ${active ? `<iframe src="/raw?file=${encodeURIComponent(active)}"></iframe>` : '<div class="placeholder">Select a file from the sidebar</div>'}
</div>

<script>
  const search = document.getElementById("search");
  const list = document.getElementById("list");
  const burger = document.getElementById("burger");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const items = Array.from(list.querySelectorAll(".item"));

  search.addEventListener("input", () => {
    const q = search.value.toLowerCase();
    let visible = 0;
    for (const el of items) {
      const match = el.textContent.toLowerCase().includes(q) || el.getAttribute("title").toLowerCase().includes(q);
      el.style.display = match ? "" : "none";
      if (match) visible++;
    }
    const empty = list.querySelector(".empty");
    if (visible === 0 && !empty) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = "No matches";
      list.appendChild(d);
    } else if (visible > 0 && empty) {
      empty.remove();
    }
  });

  function toggleMenu() {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("open");
  }
  burger.addEventListener("click", toggleMenu);
  overlay.addEventListener("click", toggleMenu);
</script>
</body>
</html>`;
}

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

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

    const files = findHtmlFiles();
    const active = url.searchParams.get("file");
    const html = buildPage(files, active);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`agents server running at http://localhost:${server.port}`);
