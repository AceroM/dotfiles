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
      const label = "./" + f;
      const isActive = f === active;
      return `<a href="/?file=${encodeURIComponent(f)}" class="item block px-3.5 py-2 text-[13px] no-underline whitespace-nowrap overflow-hidden text-ellipsis border-l-[3px] border-transparent transition-colors hover:bg-gray-100 ${isActive ? "bg-blue-50 !border-l-blue-600 text-blue-600 font-semibold active" : "text-gray-900"}" title="${f}">${label}</a>`;
    })
    .join("\n");

  const activeLabel = active ? "./" + active : "agents";

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
</style>
</head>
<body class="h-full font-sans bg-white text-gray-900">

<div class="flex md:hidden fixed top-0 left-0 right-0 h-12 bg-gray-50 border-b border-gray-200 items-center px-3 z-20">
  <button class="bg-transparent border-none text-gray-900 text-[22px] cursor-pointer px-2 py-1" id="burger">&#9776;</button>
  <span class="ml-auto text-sm font-semibold whitespace-nowrap overflow-hidden text-ellipsis">${activeLabel}</span>
</div>

<div class="overlay hidden fixed inset-0 bg-black/50 z-[25]" id="overlay"></div>

<nav class="sidebar fixed top-0 left-0 bottom-0 w-[280px] bg-gray-50 border-r border-gray-200 flex flex-col z-30" id="sidebar">
  <div class="p-4 pb-3 border-b border-gray-200">
    <h1 class="text-[15px] font-bold mb-2.5">agents</h1>
    <input type="text" id="search" placeholder="Search… (/ to focus)" autocomplete="off"
      class="w-full py-1.5 px-2.5 border border-gray-200 rounded-md bg-white text-gray-900 text-[13px] outline-none focus:border-blue-600 placeholder:text-gray-400" />
  </div>
  <div class="flex-1 overflow-y-auto py-1.5" id="list">
    ${items}
  </div>
  <div class="px-3.5 py-2 border-t border-gray-200 text-[11px] text-gray-400 select-none">
    <kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px]">↑↓</kbd> navigate
    <kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px] ml-1.5">↵</kbd> open
    <kbd class="px-1 py-0.5 bg-gray-200 rounded text-[10px] ml-1.5">/</kbd> search
  </div>
</nav>

<div class="h-full ml-0 pt-12 md:ml-[280px] md:pt-0">
  ${active ? `<iframe src="/raw?file=${encodeURIComponent(active)}" class="w-full h-full border-none bg-white"></iframe>` : '<div class="flex items-center justify-center h-full text-gray-400 text-[15px]">Select a file from the sidebar</div>'}
</div>

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

    if (e.key === "ArrowDown" || (!isSearching && e.key === "j")) {
      e.preventDefault();
      setFocus(focusIdx < visible.length - 1 ? focusIdx + 1 : 0);
    } else if (e.key === "ArrowUp" || (!isSearching && e.key === "k")) {
      e.preventDefault();
      setFocus(focusIdx > 0 ? focusIdx - 1 : visible.length - 1);
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

  const activeIdx = visibleItems().findIndex(el => el.classList.contains("active"));
  if (activeIdx >= 0) setFocus(activeIdx);
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
