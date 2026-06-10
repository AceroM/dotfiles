#!/usr/bin/env bun
/** @jsx h */
// Bun JSX server backing `ho`. Homepage lists .html files in --root sorted by
// mtime; clicking one serves the file with a thin header injected (chevron
// back on the left, filename on the right). Patterns in `.hoignore` (one per
// line, glob-style) are excluded from the listing and refused on direct hits.

import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, basename, resolve, relative, extname } from "node:path";

// ---- JSX runtime (string-emitting) -----------------------------------------

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

type Html = { __html: string };
type Child = Html | string | number | null | undefined | false | Child[];

const escText = (s: string) =>
  s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const escAttr = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function h(tag: any, props: any, ...children: Child[]): Html {
  if (typeof tag === "function") return tag({ ...(props || {}), children });
  const parts: string[] = [];
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      const key = k === "className" ? "class" : k === "htmlFor" ? "for" : k;
      if (v === true) parts.push(key);
      else parts.push(`${key}="${escAttr(String(v))}"`);
    }
  }
  const attrs = parts.length ? " " + parts.join(" ") : "";
  if (VOID.has(tag)) return { __html: `<${tag}${attrs}>` };
  const buf: string[] = [];
  const walk = (c: Child) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(walk); return; }
    if (typeof c === "object" && "__html" in c) { buf.push(c.__html); return; }
    buf.push(escText(String(c)));
  };
  walk(children);
  return { __html: `<${tag}${attrs}>${buf.join("")}</${tag}>` };
}

const raw = (s: string): Html => ({ __html: s });
const renderDoc = (el: Html) => "<!doctype html>\n" + el.__html;

// ---- args ------------------------------------------------------------------

const argv = Bun.argv.slice(2);
let port = Number(process.env.HO_PORT || 7878);
let root = process.cwd();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
  else if (argv[i] === "--root") root = argv[++i];
  else if (!argv[i].startsWith("--")) root = argv[i];
}
root = resolve(root);

// ---- ignore file -----------------------------------------------------------

const IGNORE_FILE = ".hoignore";

function loadIgnore(): string[] {
  const p = join(root, IGNORE_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
}

function isIgnored(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (new Bun.Glob(p).match(name)) return true;
  }
  return false;
}

// ---- pages -----------------------------------------------------------------

type FileInfo = { name: string; mtime: number };

const HOME_CSS = `
  :root { color-scheme: light dark; }
  body { font: 15px -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2.5rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1 { font-size: 1.05rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: #888; margin: 0 0 1rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.6rem 0; border-bottom: 1px solid #eee; }
  a { color: #0a66dc; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a:hover { text-decoration: underline; }
  .meta { color: #999; font-size: 0.8em; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .empty { color: #888; font-style: italic; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    li { border-color: #222; }
    a { color: #58a6ff; }
    h1, .meta, .empty { color: #888; }
  }
`;

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function Home({ files }: { files: FileInfo[] }) {
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>ho</title>
        {raw(`<style>${HOME_CSS}</style>`)}
      </head>
      <body>
        <h1>html files</h1>
        {files.length === 0 ? (
          <p class="empty">No .html files here.</p>
        ) : (
          <ul>
            {files.map(f => (
              <li>
                <a href={encodeURIComponent(f.name)}>{f.name}</a>
                <span class="meta">{timeAgo(f.mtime)}</span>
              </li>
            ))}
          </ul>
        )}
      </body>
    </html>
  );
}

// ---- header injection ------------------------------------------------------

function injectHeader(html: string, filename: string): string {
  // Build snippet outside the template literal so we can safely embed.
  const nameJson = JSON.stringify(filename);
  const snippet = `<style id="__ho_header_css">
  #__ho_header { position: fixed; top: 0; left: 0; right: 0; height: 36px;
    background: rgba(255,255,255,0.96); backdrop-filter: saturate(180%) blur(8px);
    border-bottom: 1px solid #e5e5e5; display: flex; align-items: center;
    justify-content: space-between; padding: 0 14px; z-index: 2147483647;
    font: 13px -apple-system, system-ui, sans-serif; color: #222; }
  #__ho_header a { color: #0a66dc; text-decoration: none; font-size: 20px;
    line-height: 1; padding: 4px 6px; margin-left: -6px; border-radius: 4px; }
  #__ho_header a:hover { background: rgba(0,0,0,0.05); }
  #__ho_header .title { font-weight: 500; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; margin-left: 12px; }
  @media (prefers-color-scheme: dark) {
    #__ho_header { background: rgba(20,20,20,0.96); border-color: #333; color: #eee; }
    #__ho_header a { color: #58a6ff; }
    #__ho_header a:hover { background: rgba(255,255,255,0.08); }
  }
</style>
<script>
(function () {
  var name = ${nameJson};
  function mount() {
    if (document.getElementById('__ho_header')) return;
    var bar = document.createElement('div');
    bar.id = '__ho_header';
    var back = document.createElement('a');
    back.href = './';
    back.setAttribute('aria-label', 'back');
    back.textContent = '‹';
    var title = document.createElement('span');
    title.className = 'title';
    title.textContent = name;
    bar.appendChild(back);
    bar.appendChild(title);
    document.body.insertBefore(bar, document.body.firstChild);
    var pad = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    document.body.style.paddingTop = (pad + 36) + 'px';
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
</script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, snippet + "</body>");
  }
  return html + snippet;
}

// ---- request handler -------------------------------------------------------

async function listHtml(): Promise<FileInfo[]> {
  const patterns = loadIgnore();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: FileInfo[] = [];
  await Promise.all(entries.map(async (e) => {
    if (extname(e).toLowerCase() !== ".html") return;
    if (isIgnored(e, patterns)) return;
    try {
      const s = await stat(join(root, e));
      if (s.isFile()) out.push({ name: e, mtime: s.mtimeMs });
    } catch {}
  }));
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function safeResolve(rel: string): string | null {
  const abs = resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
  const r = relative(root, abs);
  if (r === "" || r === "." ) return root;
  if (r.startsWith("..") || r.startsWith("/")) return null;
  return abs;
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let path: string;
    try { path = decodeURIComponent(url.pathname); }
    catch { return new Response("bad path", { status: 400 }); }

    if (path === "/" || path === "") {
      const files = await listHtml();
      return new Response(renderDoc(<Home files={files} />), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const abs = safeResolve(path);
    if (!abs) return new Response("forbidden", { status: 403 });
    if (!existsSync(abs)) return new Response("not found", { status: 404 });

    let s;
    try { s = await stat(abs); } catch { return new Response("not found", { status: 404 }); }
    if (s.isDirectory()) return new Response("not found", { status: 404 });

    const name = basename(abs);
    const ext = extname(name).toLowerCase();

    if (ext === ".html") {
      if (isIgnored(name, loadIgnore())) {
        return new Response("ignored", { status: 404 });
      }
      const html = await readFile(abs, "utf8");
      return new Response(injectHeader(html, name), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Pass-through for sibling assets (css/js/images/etc).
    return new Response(Bun.file(abs));
  },
});

console.log(`ho-server: http://${server.hostname}:${server.port}  root=${root}`);
