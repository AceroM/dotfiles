//! The two page shapes: the index of recent pages, and one page with its context bar.

use crate::context::Context;
use crate::db::{Artifact, Filter, ListItem};
use crate::render::{escape, is_full_document};

const STYLE: &str = r#"<style>
:root { --bg:#f7f7f5; --surface:#ffffff; --ink:#1d2126; --muted:#5d6670; --faint:#8a9299; --rule:#e3e5e3;
  --accent:#2f5d50; --accent-soft:#e6efeb; --warn:#8a4b2a; --warn-soft:#f6ece5;
  --mono:"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --sans:ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#121517; --surface:#1a1e22; --ink:#e7eaec;
  --muted:#9aa4ad; --faint:#6f7880; --rule:#2c3237; --accent:#7fc0aa; --accent-soft:#1f3530; --warn:#e0a07c; --warn-soft:#3a2a21; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#121517; --surface:#1a1e22; --ink:#e7eaec; --muted:#9aa4ad; --faint:#6f7880; --rule:#2c3237;
  --accent:#7fc0aa; --accent-soft:#1f3530; --warn:#e0a07c; --warn-soft:#3a2a21; color-scheme: dark; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
a { color: var(--accent); }
.top { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--rule); }
.top-in { max-width: 1120px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.brand { font-weight: 600; color: var(--ink); text-decoration: none; letter-spacing: -0.01em; }
.brand span { color: var(--faint); font-weight: 400; }
.live { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.live.on { background: var(--accent); }
form.filters { display: flex; gap: 8px; flex: 1; min-width: 0; flex-wrap: wrap; }
form.filters input, form.filters select { font: inherit; font-size: 14px; padding: 5px 10px; border: 1px solid var(--rule); border-radius: 6px;
  background: var(--surface); color: var(--ink); }
form.filters input[type=search] { flex: 1; min-width: 160px; }
main { max-width: 1120px; margin: 0 auto; padding: 20px 16px 80px; }
.empty { color: var(--muted); padding: 40px 0; }
.empty code { font-family: var(--mono); font-size: 0.85em; background: var(--surface); border: 1px solid var(--rule); padding: 1px 6px; border-radius: 4px; }
ul.list { list-style: none; margin: 0; padding: 0; }
ul.list li.day { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); font-weight: 600; padding: 18px 0 6px; }
ul.list li.day:first-child { padding-top: 0; }
ul.list li.row { display: grid; grid-template-columns: 4.6em minmax(0, 1fr) auto; gap: 4px 14px; align-items: baseline; padding: 9px 12px;
  border: 1px solid transparent; border-radius: 8px; }
ul.list li.row:hover { background: var(--surface); border-color: var(--rule); }
ul.list li.row.fresh { background: var(--accent-soft); }
.row time { font-family: var(--mono); font-size: 12px; color: var(--faint); }
.row .main { min-width: 0; }
.row .title { font-weight: 500; color: var(--ink); text-decoration: none; }
.row .title:hover { text-decoration: underline; }
.row .sum { color: var(--muted); font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.chip { font-family: var(--mono); font-size: 11.5px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--rule); color: var(--muted);
  background: var(--surface); white-space: nowrap; text-decoration: none; }
a.chip:hover { color: var(--accent); border-color: var(--accent); }
.chip.kind { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
.chip.warn { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.chip.btn { cursor: pointer; font-family: var(--mono); }
.chip.copied { color: var(--accent); border-color: var(--accent); }
@media (max-width: 720px) { ul.list li.row { grid-template-columns: minmax(0, 1fr); } .row time { order: 3; } .row .meta { justify-content: flex-start; } }
h1.page-title { font-size: 26px; line-height: 1.25; letter-spacing: -0.015em; margin: 4px 0 6px; }
p.page-sum { color: var(--muted); margin: 0 0 12px; font-size: 16px; }
.ctx { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 0 0 14px; }
.ctx .sep { color: var(--faint); }
.question { border-left: 3px solid var(--rule); padding: 4px 0 4px 12px; margin: 0 0 18px; color: var(--muted); white-space: pre-wrap; }
.banner { border: 1px solid var(--warn); background: var(--warn-soft); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin: 0 0 16px; }
.revs { margin-top: 40px; color: var(--muted); font-size: 13px; }
.revs a { margin-right: 10px; font-family: var(--mono); }
.doc-frame { width: 100%; border: 1px solid var(--rule); border-radius: 8px; background: #fff; min-height: 70vh; display: block; }
/* markdown */
.md { overflow-wrap: anywhere; }
.md h1, .md h2, .md h3 { letter-spacing: -0.01em; line-height: 1.3; margin: 1.6em 0 0.5em; }
.md h1 { font-size: 22px; } .md h2 { font-size: 19px; } .md h3 { font-size: 16px; }
.md > :first-child { margin-top: 0; }
.md p, .md ul, .md ol { margin: 0.6em 0; }
.md pre { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 12px 14px; overflow-x: auto;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.6; }
.md pre code { font-size: inherit; background: none; border: 0; padding: 0; overflow-wrap: normal; }
.md code { font-family: var(--mono); font-size: 0.86em; background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; padding: 0 4px; }
.md table { border-collapse: collapse; margin: 0.8em 0; font-size: 14px; display: block; overflow-x: auto; }
.md th, .md td { border: 1px solid var(--rule); padding: 5px 10px; text-align: left; vertical-align: top; }
.md th { background: var(--surface); }
.md blockquote { border-left: 3px solid var(--rule); margin: 0.8em 0; padding: 0 0 0 12px; color: var(--muted); }
.md img { max-width: 100%; border-radius: 6px; border: 1px solid var(--rule); }
.md pre.mermaid { background: var(--surface); text-align: center; }
.loc { font-family: var(--mono); color: var(--accent); border-bottom: 1px dotted var(--accent); cursor: copy; }
.loc:hover, .loc.copied { border-bottom-style: solid; }
/* detailed code path */
.dcp { display: flex; flex-direction: column; gap: 16px; }
.dcp h3 { margin: 18px 0 0; font-size: 17px; }
.dcp p { margin: 0; }
.dcp .dcp-capture { font-size: 13px; color: var(--muted); }
.dcp .dcp-controls { display: flex; gap: 8px; }
.dcp .dcp-controls button { font: inherit; font-size: 13px; padding: 3px 11px; border-radius: 6px; border: 1px solid var(--rule); background: var(--surface); color: var(--ink); cursor: pointer; }
.dcp .dcp-paths { display: flex; flex-direction: column; gap: 18px; }
.dcp .dcp-path { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.dcp .dcp-head { display: flex; align-items: center; gap: 10px; font-weight: 500; flex-wrap: wrap; }
.dcp .dcp-tag { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; padding: 1px 8px; border-radius: 4px; background: var(--rule); color: var(--muted); }
.dcp .dcp-tag:empty { display: none; }
.dcp .before .dcp-tag { background: var(--warn-soft); color: var(--warn); }
.dcp .after .dcp-tag { background: var(--accent-soft); color: var(--accent); }
.dcp .dcp-sha { font-family: var(--mono); font-size: 12px; font-weight: 400; color: var(--muted); margin-left: auto; text-decoration: none; }
.dcp a.dcp-sha:hover { color: var(--accent); }
.dcp .dcp-sha.off { color: var(--warn); }
.dcp ol.dcp-hops { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--rule); display: flex; flex-direction: column; gap: 8px; counter-reset: hop; }
.dcp .before ol.dcp-hops { border-left-color: var(--warn); }
.dcp .after ol.dcp-hops { border-left-color: var(--accent); }
.dcp ol.dcp-hops > li { counter-increment: hop; min-width: 0; }
.dcp details { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; min-width: 0; }
.dcp summary { cursor: pointer; padding: 8px 12px; display: flex; flex-wrap: nowrap; align-items: center; gap: 12px; list-style: none; min-width: 0; }
.dcp summary::-webkit-details-marker { display: none; }
.dcp summary::before { content: counter(hop); flex: none; font-family: var(--mono); font-size: 12px; color: var(--muted); min-width: 1.4em; }
.dcp .dcp-label { font-weight: 500; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcp .dcp-loc { font-family: var(--mono); font-size: 12px; color: var(--muted); flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: copy; }
.dcp .dcp-loc:hover, .dcp .dcp-loc.copied { color: var(--accent); }
.dcp .dcp-gh { flex: none; margin-left: auto; font-size: 12.5px; font-weight: 500; white-space: nowrap; text-decoration: none; padding: 1px 8px; border: 1px solid var(--rule); border-radius: 4px; color: var(--accent); }
.dcp details[open] summary { border-bottom: 1px solid var(--rule); }
.dcp pre.dcp-src { margin: 0; overflow-x: auto; padding: 8px 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
.dcp pre.dcp-src code > span { display: block; padding-right: 14px; white-space: pre; }
.dcp pre.dcp-src .ln { display: inline-block; width: 4.2em; padding-right: 1em; text-align: right; color: var(--muted); opacity: 0.7; user-select: none; }
.dcp pre.dcp-src .hit { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.dcp .before pre.dcp-src .hit { background: var(--warn-soft); box-shadow: inset 3px 0 0 var(--warn); }
.dcp .dcp-io { border-top: 1px solid var(--rule); display: grid; grid-template-columns: 1fr 1fr; }
.dcp .dcp-io > div { min-width: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.dcp .dcp-io > div + div { border-left: 1px solid var(--rule); }
.dcp .dcp-io-h { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: var(--muted); }
.dcp .dcp-io-out .dcp-io-h { color: var(--accent); }
.dcp .dcp-io dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.5; }
.dcp .dcp-io dt { color: var(--muted); }
.dcp .dcp-io dd { margin: 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dcp .dcp-io-note { grid-column: 1 / -1; border-top: 1px solid var(--rule); padding: 8px 12px; font-size: 13.5px; color: var(--muted); }
@media (max-width: 640px) { .dcp .dcp-io { grid-template-columns: 1fr; } .dcp .dcp-io > div + div { border-left: 0; border-top: 1px solid var(--rule); } }
/* lightbox */
.md img, .frag img { cursor: zoom-in; }
#lb { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; background: rgba(15,23,42,.92); padding: 24px; }
#lb.open { display: flex; }
#lb img { max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 8px; cursor: zoom-out; }
/* keyboard */
.keys-hint { margin-left: auto; font: 12px var(--mono); color: var(--faint); }
.keys-hint kbd { font: inherit; border: 1px solid var(--rule); border-radius: 4px; padding: 0 5px; background: var(--surface); color: var(--muted); }
ul.list li.row.sel { background: var(--surface); border-color: var(--accent); }
.more { color: var(--faint); font-size: 12.5px; padding: 16px 12px 0; }
#kb-hints { position: fixed; inset: 0; z-index: 60; pointer-events: none; display: none; }
#kb-hints.on { display: block; }
#kb-hints span { position: fixed; font: 700 11px/1 var(--mono); padding: 2px 4px; border-radius: 3px; background: #f6d860; color: #1d2126;
  border: 1px solid #b8961f; box-shadow: 0 1px 3px rgba(0,0,0,.3); text-transform: uppercase; letter-spacing: 0.02em; }
#kb-hints span b { opacity: 0.4; }
#kb-toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 6px 12px;
  border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity .15s; pointer-events: none; z-index: 70; }
#kb-toast.show { opacity: 1; }
#kb-cmd { position: fixed; right: 14px; bottom: 12px; font: 12px var(--mono); color: var(--muted); background: var(--surface); border: 1px solid var(--rule);
  padding: 2px 8px; border-radius: 4px; z-index: 70; display: none; }
#kb-cmd.show { display: block; }
#kb-find { position: fixed; left: 14px; bottom: 12px; z-index: 70; display: none; align-items: center; gap: 6px; font: 13px var(--mono); color: var(--ink);
  background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 4px 10px; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
#kb-find.show { display: flex; }
#kb-find > span:first-child { color: var(--accent); font-weight: 600; }
#kb-find input { font: inherit; color: inherit; background: transparent; border: 0; outline: 0; padding: 0; width: 28ch; }
#kb-find .n { color: var(--faint); font-size: 12px; }
#kb-find.miss .n { color: var(--warn); }
::highlight(kb-find) { background-color: rgba(246,216,96,.5); }
::highlight(kb-find-cur) { background-color: #f59e0b; color: #1d2126; }
#kb-help { position: fixed; inset: 0; z-index: 80; display: none; align-items: flex-start; justify-content: center; background: rgba(15,23,42,.55); padding: 56px 16px; overflow: auto; }
#kb-help.open { display: flex; }
#kb-help .panel { background: var(--surface); color: var(--ink); border: 1px solid var(--rule); border-radius: 10px; padding: 8px 22px 18px; max-width: 820px; width: 100%;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 28px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
#kb-help h4 { margin: 14px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
#kb-help dl { margin: 0; display: grid; grid-template-columns: 7.5em 1fr; gap: 4px 12px; font-size: 13.5px; }
#kb-help dt { font-family: var(--mono); font-size: 12.5px; color: var(--accent); white-space: pre; }
#kb-help dd { margin: 0; color: var(--muted); }
</style>"#;

const KEYS: &str = include_str!("keys.js");

/// Applies a saved theme before first paint, so `t` doesn't flash the other one on load.
const THEME: &str = r#"<script>try{const t=JSON.parse(localStorage.getItem('artifacts:theme'));if(t)document.documentElement.dataset.theme=t}catch(e){}</script>"#;

const SCRIPT: &str = r#"<script>
(() => {
  const SLUG = document.body.dataset.slug || null;
  const rel = (ts) => {
    const s = Date.now() / 1000 - ts;
    if (s < 45) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    if (s < 86400 * 7) return Math.round(s / 86400) + 'd';
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const stamp = (root) => {
    for (const t of root.querySelectorAll('time[data-ts]')) {
      const d = new Date(+t.dataset.ts * 1000);
      t.textContent = t.dataset.fmt === 'clock' ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : rel(+t.dataset.ts);
      t.title = d.toLocaleString();
    }
  };
  const dayLabel = (d) => {
    const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const group = (list) => {
    for (const h of list.querySelectorAll('li.day')) h.remove();
    let last = null;
    for (const li of list.querySelectorAll('li.row')) {
      const d = new Date(+li.dataset.ts * 1000);
      if (d.toDateString() !== last) {
        const h = document.createElement('li'); h.className = 'day'; h.textContent = dayLabel(d); li.before(h); last = d.toDateString();
      }
    }
  };
  const list = document.getElementById('list');
  stamp(document); if (list) group(list);
  setInterval(() => stamp(document), 30000);

  // The index is one endless list: the next page of rows loads near the bottom.
  const PAGE_SIZE = list ? +(list.dataset.pageSize || 100) : 0;
  const sentinel = document.getElementById('more');
  const fetchRows = (offset, limit) => {
    const u = new URL(location.href);
    u.searchParams.set('partial', '1'); u.searchParams.set('offset', offset); u.searchParams.set('limit', limit);
    return fetch(u).then((r) => r.text());
  };
  const showStatus = () => {
    if (!sentinel || !list) return;
    sentinel.textContent = list.dataset.done === 'true' ? (list.querySelector('li.row') ? 'End of the list' : '') : 'Loading more…';
  };
  let loading = null;
  // Bumped whenever the rows are replaced, so a fetch for the old query can't land on the new list.
  let listGen = 0;
  const replaceRows = async (n) => {
    const gen = ++listGen;
    const html = await fetchRows(0, n);
    if (gen !== listGen) return false;
    list.innerHTML = html;
    list.dataset.done = String(list.querySelectorAll('li.row').length < n);
    stamp(list); group(list); showStatus();
    const empty = document.getElementById('empty');
    if (empty) empty.hidden = !!list.querySelector('li.row');
    document.dispatchEvent(new CustomEvent('artifacts:list'));
    return true;
  };
  const nearBottom = () => sentinel && sentinel.getBoundingClientRect().top < innerHeight + 600;
  const more = () => {
    if (!list || list.dataset.done === 'true') return Promise.resolve(false);
    if (loading) return loading;
    const gen = listGen;
    loading = fetchRows(list.querySelectorAll('li.row').length, PAGE_SIZE).then((html) => {
      if (gen !== listGen) return false;
      const tmp = document.createElement('ul');
      tmp.innerHTML = html;
      const got = tmp.querySelectorAll('li.row').length;
      list.append(...tmp.children);
      if (got < PAGE_SIZE) list.dataset.done = 'true';
      stamp(list); group(list);
      document.dispatchEvent(new CustomEvent('artifacts:rows'));
      return got > 0;
    }).finally(() => { loading = null; showStatus(); });
    return loading.then((grew) => { if (grew && nearBottom()) more(); return grew; });
  };
  window.artifactsMore = more;
  showStatus();
  if (sentinel) {
    let ticking = false;
    addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; if (nearBottom()) more(); });
    }, { passive: true });
    if (nearBottom()) more();
  }

  // The search box filters as you type (`/` focuses it); the URL keeps the query for reload and back.
  const search = document.querySelector('form.filters input[type=search]');
  if (search && list) {
    let typed = null;
    const apply = () => {
      clearTimeout(typed);
      const u = new URL(location.href);
      const q = search.value.trim();
      if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
      if (u.href === location.href) return;
      history.replaceState(history.state, '', u);
      replaceRows(PAGE_SIZE).then((ok) => ok && scrollTo({ top: 0, behavior: 'instant' }));
    };
    search.addEventListener('input', () => { clearTimeout(typed); typed = setTimeout(apply, 120); });
    search.form.addEventListener('submit', (e) => { e.preventDefault(); apply(); search.blur(); });
  }

  const dot = document.querySelector('.live');
  const REV = +(document.body.dataset.rev || 0);
  let timer = null;
  const refresh = async (slug) => {
    if (SLUG) { location.reload(); return; }
    if (!list) return;
    // Re-fetch as many rows as are loaded, so a refresh doesn't drop what was scrolled in.
    if (!(await replaceRows(Math.max(PAGE_SIZE, list.querySelectorAll('li.row').length)))) return;
    const row = slug && list.querySelector('li.row[data-slug="' + CSS.escape(slug) + '"]');
    if (row) { row.classList.add('fresh'); setTimeout(() => row.classList.remove('fresh'), 2500); }
  };
  // Events aren't replayed, so whenever the stream (re)connects, check for anything missed while
  // it was down: a page compares its revision with the stored one, the index refetches its rows.
  let opened = false;
  const catchUp = async () => {
    if (REV) {
      const r = await fetch('/api/artifacts/' + encodeURIComponent(SLUG)).catch(() => null);
      if (r && (r.status === 404 || (r.ok && (await r.json()).revision !== REV))) location.reload();
    } else if (opened && !SLUG) refresh(null);
    opened = true;
  };
  let es = null;
  const connect = () => {
    es = new EventSource('/events');
    es.onopen = () => { dot && dot.classList.add('on'); catchUp(); };
    es.onerror = () => dot && dot.classList.remove('on');
    es.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (SLUG && m.slug !== SLUG) return;
      clearTimeout(timer);
      timer = setTimeout(() => refresh(m.slug), 250);
    };
  };
  connect();
  // Coming back through the back/forward cache: the stream may have been closed, and the page
  // is whatever it was when you left.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (es.readyState === EventSource.CLOSED) connect(); else catchUp();
  });

  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { e.preventDefault(); navigator.clipboard.writeText(c.dataset.copy); c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 900); return; }
    const x = e.target.closest('.dcp-expand, .dcp-collapse');
    if (x) { const open = x.classList.contains('dcp-expand'); for (const d of x.closest('.dcp').querySelectorAll('details')) d.open = open; return; }
    const img = e.target.closest('.md img, .frag img');
    if (img && !img.closest('a')) { const lb = document.getElementById('lb'); lb.querySelector('img').src = img.currentSrc || img.src; lb.classList.add('open'); return; }
    if (e.target.closest('#lb')) document.getElementById('lb').classList.remove('open');
  });

  const frame = document.querySelector('iframe.doc-frame');
  if (frame) {
    const fit = () => { try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch (_) {} };
    frame.addEventListener('load', () => { fit(); try { new ResizeObserver(fit).observe(frame.contentDocument.body); } catch (_) {} });
  }
})();
</script>"#;

const MERMAID: &str = r#"<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';
const forced = document.documentElement.dataset.theme;
const dark = forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'neutral', securityLevel: 'loose' });
</script>"#;

/// `body` carries what the keys need: `data-page`, and on a page its slug, its parent
/// (`data-up`) and its neighbours in index order (`data-newer` / `data-older`).
fn shell(title: &str, body: &[(&str, Option<&str>)], top: &str, main: &str, needs_mermaid: bool) -> String {
    let data: String = body
        .iter()
        .filter_map(|(name, value)| value.map(|v| format!(r#" data-{name}="{}""#, escape(v))))
        .collect();
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{}</title>{THEME}{STYLE}</head><body{data}>
<header class="top"><div class="top-in"><span class="live" title="Live: reloads when this changes"></span><a class="brand" href="/">artifacts <span>:4620</span></a>{top}<span class="keys-hint"><kbd>?</kbd> keys</span></div></header>
<main>{main}</main>
<div id="lb"><img alt=""></div>
{SCRIPT}<script>{KEYS}</script>{}</body></html>"#,
        escape(title),
        if needs_mermaid { MERMAID } else { "" }
    )
}

const KINDS: [(&str, &str); 3] = [("code-path", "code path"), ("md", "notes"), ("html", "page")];

fn kind_label(kind: &str) -> &str {
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, l)| *l).unwrap_or(kind)
}

fn filters(f: &Filter, slots: &[i64]) -> String {
    let mut kind_opts = String::from(r#"<option value="">all kinds</option>"#);
    for (k, label) in KINDS {
        let sel = if f.kind.as_deref() == Some(k) { " selected" } else { "" };
        kind_opts.push_str(&format!(r#"<option value="{k}"{sel}>{label}</option>"#));
    }
    let mut slot_opts = String::from(r#"<option value="">all slots</option>"#);
    for s in slots {
        let sel = if f.slot == Some(*s) { " selected" } else { "" };
        slot_opts.push_str(&format!(r#"<option value="{s}"{sel}>slot {s}</option>"#));
    }
    format!(
        r#"<form class="filters" method="get" action="/"><input type="search" name="q" placeholder="Search titles, tickets, branches, source  ( / )" value="{}"><select name="kind" onchange="this.form.submit()">{kind_opts}</select><select name="slot" onchange="this.form.submit()">{slot_opts}</select></form>"#,
        escape(f.q.as_deref().unwrap_or(""))
    )
}

pub fn list_rows(items: &[ListItem]) -> String {
    let mut out = String::new();
    for item in items {
        let mut meta = format!(r#"<span class="chip kind">{}</span>"#, kind_label(&item.kind));
        if let Some(slot) = item.slot {
            meta.push_str(&format!(r#"<a class="chip" href="/?slot={slot}">slot {slot}</a>"#));
        } else if let Some(repo) = &item.repo {
            meta.push_str(&format!(r#"<span class="chip">{}</span>"#, escape(repo)));
        }
        if let Some(ticket) = &item.ticket {
            meta.push_str(&format!(r#"<a class="chip" href="/?q={0}">{0}</a>"#, escape(ticket)));
        } else if let Some(branch) = item.branch.as_deref().filter(|b| *b != "main") {
            meta.push_str(&format!(r#"<span class="chip">{}</span>"#, escape(branch)));
        }
        if item.revision > 1 {
            meta.push_str(&format!(r#"<span class="chip">v{}</span>"#, item.revision));
        }
        out.push_str(&format!(
            r#"<li class="row" data-ts="{ts}" data-slug="{slug}"><time data-ts="{ts}" data-fmt="clock"></time><div class="main"><a class="title" href="/a/{slug}/">{title}</a>{sum}</div><div class="meta">{meta}</div></li>"#,
            ts = item.updated_at,
            slug = escape(&item.slug),
            title = escape(&item.title),
            sum = item.summary.as_deref().map(|s| format!(r#"<div class="sum">{}</div>"#, escape(s))).unwrap_or_default(),
        ));
    }
    out
}

/// Rows per fetch on the index; the rest load as you scroll or move the selection down.
pub const PAGE_SIZE: i64 = 100;

pub fn index(items: &[ListItem], f: &Filter, slots: &[i64]) -> String {
    let filtered = f.q.is_some() || f.kind.is_some() || f.slot.is_some();
    let empty = if items.is_empty() && !filtered {
        r#"<p class="empty" id="empty">Nothing yet. From any slot: <code>artifacts add notes.md</code> or <code>artifacts add spec.json</code></p>"#.to_string()
    } else {
        // Typing in the search box refills the list in place, so this is toggled rather than rendered.
        let hidden = if items.is_empty() { "" } else { " hidden" };
        format!(r#"<p class="empty" id="empty"{hidden}>No matches. <a href="/">Clear filters</a></p>"#)
    };
    let main = format!(
        r#"{empty}<ul class="list" id="list" data-page-size="{PAGE_SIZE}" data-done="{}">{}</ul><div class="more" id="more"></div>"#,
        (items.len() as i64) < PAGE_SIZE,
        list_rows(items)
    );
    shell("artifacts", &[("page", Some("index"))], &filters(f, slots), &main, false)
}

fn chip_link(href: &str, text: &str, title: &str) -> String {
    format!(r#"<a class="chip" href="{}" title="{}" target="_blank" rel="noopener">{}</a>"#, escape(href), escape(title), escape(text))
}

/// A link chip when there is somewhere to go, plain text otherwise.
fn chip_maybe_link(href: Option<String>, text: &str, title: &str) -> String {
    match href {
        Some(href) => chip_link(&href, text, title),
        None => format!(r#"<span class="chip" title="{}">{}</span>"#, escape(title), escape(text)),
    }
}

/// `ARTIFACTS_TICKET_URL`, e.g. `https://linear.app/<workspace>/issue/{ticket}`, links ticket chips.
fn ticket_url(ticket: &str) -> Option<String> {
    let template = std::env::var("ARTIFACTS_TICKET_URL").ok().filter(|t| t.contains("{ticket}"))?;
    Some(template.replace("{ticket}", ticket))
}

fn context_bar(ctx: &Context) -> String {
    let mut chips: Vec<String> = vec![];
    let github = ctx.github.as_deref();
    if let Some(root) = &ctx.repo_root {
        let label = match ctx.slot {
            Some(slot) => format!("slot {slot}"),
            None => ctx.repo.clone().unwrap_or_else(|| root.clone()),
        };
        chips.push(format!(r#"<a class="chip" href="{}" title="Open {} in Zed">{}</a>"#, escape(&format!("zed://file{root}")), escape(root), escape(&label)));
    } else if let Some(cwd) = &ctx.cwd {
        chips.push(format!(r#"<span class="chip" title="cwd">{}</span>"#, escape(cwd)));
    }
    if let Some(branch) = &ctx.branch {
        let href = github.map(|g| format!("https://github.com/{g}/tree/{branch}"));
        chips.push(chip_maybe_link(href, branch, "Branch when this was written"));
    }
    if let Some(sha) = &ctx.sha {
        let short: String = sha.chars().take(10).collect();
        let href = github.map(|g| format!("https://github.com/{g}/commit/{sha}"));
        chips.push(chip_maybe_link(href, &short, "HEAD when this was written"));
        if ctx.dirty == Some(true) {
            chips.push(r#"<span class="chip warn" title="The checkout had uncommitted changes">dirty</span>"#.into());
        }
    }
    if let Some(ticket) = &ctx.ticket {
        chips.push(chip_maybe_link(ticket_url(ticket), ticket, "Ticket"));
    }
    let herdr = ctx.herdr_tab_label.clone().or_else(|| ctx.herdr_tab.clone());
    if let Some(tab) = herdr {
        let title = format!(
            "herdr {} · tab {} · pane {}",
            ctx.herdr_workspace.as_deref().unwrap_or("?"),
            ctx.herdr_tab.as_deref().unwrap_or("?"),
            ctx.herdr_pane.as_deref().unwrap_or("?")
        );
        chips.push(format!(r#"<span class="chip" title="{}">tab {}</span>"#, escape(&title), escape(&tab)));
    }
    if let Some(session) = &ctx.session_id {
        let agent = ctx.agent.as_deref().unwrap_or("claude");
        let dir = ctx.cwd.as_deref().unwrap_or("~");
        let resume = if agent == "codex" {
            format!("cd {dir} && codex resume {session}")
        } else {
            format!("cd {dir} && claude --resume {session}")
        };
        let chat = ctx.chat_title.clone().unwrap_or_else(|| session.chars().take(8).collect());
        chips.push(format!(
            r#"<button type="button" class="chip btn" data-copy="{}" title="Copy: {}">{} · {}</button>"#,
            escape(&resume),
            escape(&resume),
            escape(agent),
            escape(&chat)
        ));
    }
    chips.join("")
}

pub struct View<'a> {
    pub artifact: &'a Artifact,
    pub ctx: &'a Context,
    pub revisions: &'a [(i64, i64)],
    /// Set when showing an earlier revision instead of the current one.
    pub old: Option<(i64, &'a str, &'a str, i64)>,
    /// The pages just above and below this one on the index (newest first).
    pub newer: Option<String>,
    pub older: Option<String>,
}

pub fn artifact(v: View) -> String {
    let a = v.artifact;
    let (title, html, written_at) = match v.old {
        Some((_, title, html, at)) => (title, html, at),
        None => (a.title.as_str(), a.html.as_str(), a.updated_at),
    };
    let mut main = String::new();
    if let Some((rev, ..)) = v.old {
        main.push_str(&format!(
            r#"<div class="banner">Revision {rev} of {}. <a href="/a/{}/">Show the current one</a></div>"#,
            a.revision,
            escape(&a.slug)
        ));
    }
    main.push_str(&format!(r#"<h1 class="page-title">{}</h1>"#, escape(title)));
    if let Some(summary) = &a.summary {
        main.push_str(&format!(r#"<p class="page-sum">{}</p>"#, escape(summary)));
    }
    main.push_str(&format!(
        r#"<div class="ctx"><span class="chip kind">{}</span>{}<span class="chip" title="Written"><time data-ts="{written_at}"></time></span>{}</div>"#,
        kind_label(&a.kind),
        context_bar(v.ctx),
        if a.revision > 1 { format!(r#"<span class="chip">v{}</span>"#, v.old.map(|o| o.0).unwrap_or(a.revision)) } else { String::new() }
    ));
    if let Some(question) = &a.question {
        main.push_str(&format!(r#"<div class="question">{}</div>"#, escape(question)));
    }
    let body = match a.kind.as_str() {
        "code-path" => html.to_string(),
        "md" => format!(r#"<article class="md">{html}</article>"#),
        _ if is_full_document(html) => {
            let src = match v.old {
                Some((rev, ..)) => format!("/a/{}/r/{rev}/raw", a.slug),
                None => format!("/a/{}/raw", a.slug),
            };
            format!(r#"<iframe class="doc-frame" src="{}"></iframe>"#, escape(&src))
        }
        _ => format!(r#"<article class="frag">{html}</article>"#),
    };
    main.push_str(&body);

    let mut revs = format!(r#"<div class="revs"><a href="/a/{0}/source">source</a>"#, escape(&a.slug));
    if !v.revisions.is_empty() {
        revs.push_str(&format!(r#" · <a href="/a/{}/">v{}</a>"#, escape(&a.slug), a.revision));
        for (rev, at) in v.revisions {
            revs.push_str(&format!(r#"<a href="/a/{}/r/{rev}/" title="{at}">v{rev}</a>"#, escape(&a.slug)));
        }
    }
    if let Some(file) = &v.ctx.source_file {
        revs.push_str(&format!(r#" · from <span class="loc" data-copy="{0}" title="Copy {0}">{0}</span>"#, escape(file)));
    }
    revs.push_str("</div>");
    main.push_str(&revs);

    let needs_mermaid = html.contains(r#"class="mermaid""#);
    let current = format!("/a/{}/", a.slug);
    let rev = a.revision.to_string();
    let body = [
        ("page", Some(if v.old.is_some() { "revision" } else { "artifact" })),
        ("slug", Some(a.slug.as_str())),
        // What the live check compares against; an earlier revision never goes stale.
        ("rev", v.old.is_none().then_some(rev.as_str())),
        ("up", Some(if v.old.is_some() { current.as_str() } else { "/" })),
        ("newer", v.newer.as_deref()),
        ("older", v.older.as_deref()),
    ];
    shell(title, &body, "", &main, needs_mermaid)
}

pub fn not_found(what: &str) -> String {
    shell("not found", &[("page", Some("other")), ("up", Some("/"))], "", &format!(r#"<p class="empty">{}. <a href="/">All pages</a></p>"#, escape(what)), false)
}
