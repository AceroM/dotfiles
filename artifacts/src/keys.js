// Vim-style keys for every page, so Vimium can be turned off for :4620. `?` lists them.
(() => {
  const body = document.body;
  const PAGE = body.dataset.page || 'index';
  const SLUG = body.dataset.slug || null;
  const STEP = 100;
  const HINT_CHARS = 'sadfjklewcmpgh';

  const sGet = (k) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (_) { return null; } };
  const sSet = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const lGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const lSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const headerH = () => document.querySelector('.top')?.offsetHeight || 0;
  const scrollBy = (dy) => window.scrollBy({ top: dy, behavior: 'instant' });
  let lastJumpY = null;
  const jumpTo = (y) => { lastJumpY = window.scrollY; window.scrollTo({ top: y, behavior: 'instant' }); };

  // ---- feedback ------------------------------------------------------------------------------
  const el = (id, cls) => { let n = document.getElementById(id); if (!n) { n = document.createElement('div'); n.id = id; if (cls) n.className = cls; body.append(n); } return n; };
  let toastTimer = null;
  const toast = (msg) => { const t = el('kb-toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1300); };
  const copy = (text, label) => {
    const done = () => toast('Copied ' + label);
    const viaTextarea = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0';
      body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? done() : toast('Copy failed');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, viaTextarea);
    else viaTextarea();
  };

  // ---- index selection -----------------------------------------------------------------------
  const rows = () => [...document.querySelectorAll('#list li.row')];
  let sel = 0;
  const saveList = () => { if (PAGE === 'index') sSet('artifacts:list', rows().map((r) => r.dataset.slug)); };
  const markSel = () => {
    const r = rows();
    if (!r.length) return;
    sel = Math.max(0, Math.min(sel, r.length - 1));
    r.forEach((row, i) => row.classList.toggle('sel', i === sel));
    sSet('artifacts:sel', r[sel].dataset.slug);
  };
  // Keeps ~2 rows of context above and below the selection, like vim's scrolloff.
  const ensureVisible = (node) => {
    const b = node.getBoundingClientRect(), pad = 2 * b.height, top = headerH() + pad;
    if (b.top < top) scrollBy(b.top - top);
    else if (b.bottom > innerHeight - pad) scrollBy(b.bottom - innerHeight + pad);
  };
  const visible = (b) => b.top >= headerH() && b.bottom <= innerHeight;
  // After j/k, keep the selection on screen: it moves to the first (or last) row in view.
  const followViewport = (dir) => {
    if (PAGE !== 'index') return;
    const r = rows();
    if (!r.length || (r[sel] && visible(r[sel].getBoundingClientRect()))) return;
    const inView = r.map((row, i) => [row.getBoundingClientRect(), i]).filter(([b]) => visible(b));
    if (!inView.length) return;
    sel = dir > 0 ? inView[0][1] : inView[inView.length - 1][1];
    markSel();
  };
  // Moving down near the end loads the next page first, so j never stops at a page boundary.
  const moveSel = async (delta) => {
    if (!rows().length) return;
    const target = sel + delta;
    if (window.artifactsMore && target >= rows().length - 5) await window.artifactsMore();
    sel = target;
    markSel();
    ensureVisible(rows()[sel]);
  };
  const selectEdge = (last) => { if (PAGE !== 'index' || !rows().length) return; sel = last ? rows().length - 1 : 0; markSel(); };
  const selectedHref = () => rows()[sel]?.querySelector('a.title')?.href || null;
  if (PAGE === 'index') {
    const saved = sGet('artifacts:sel');
    const i = rows().findIndex((r) => r.dataset.slug === saved);
    sel = i >= 0 ? i : 0;
    markSel();
    saveList();
    document.addEventListener('artifacts:rows', saveList);
    document.addEventListener('artifacts:list', () => {
      const keep = sGet('artifacts:sel');
      const j = rows().findIndex((r) => r.dataset.slug === keep);
      sel = j >= 0 ? j : 0;
      markSel();
      saveList();
    });
    if (location.hash === '#search') {
      history.replaceState(null, '', location.pathname + location.search);
      document.querySelector('form.filters input[type=search]')?.focus();
    }
  }

  // ---- navigation ----------------------------------------------------------------------------
  const go = (href) => { if (href) location.href = href; };
  const up = () => body.dataset.up ? go(body.dataset.up) : toast('Already at the top level');
  const back = () => {
    const nav = window.navigation;
    const sameSiteReferrer = document.referrer.startsWith(location.origin);
    if ((nav && nav.canGoBack) || (!nav && sameSiteReferrer && history.length > 1)) history.back();
    else up();
  };
  // Newer (-1) or older (+1) page, in the order of the index you came from (filters included).
  const neighbor = (delta) => {
    const list = sGet('artifacts:list');
    if (Array.isArray(list) && SLUG && list.includes(SLUG)) {
      const target = list[list.indexOf(SLUG) + delta];
      if (target) { sSet('artifacts:sel', target); return go('/a/' + target + '/'); }
      return toast(delta < 0 ? 'This is the newest page in that list' : 'This is the oldest page in that list');
    }
    const target = delta < 0 ? body.dataset.newer : body.dataset.older;
    if (target) go('/a/' + target + '/');
    else toast(delta < 0 ? 'This is the newest page' : 'This is the oldest page');
  };
  const forward = () => {
    if (PAGE === 'index') return go(selectedHref());
    if (window.navigation && window.navigation.canGoForward) return history.forward();
    neighbor(1);
  };

  // ---- sections and hops ---------------------------------------------------------------------
  const anchors = () => [...document.querySelectorAll('main h1, main h2, main h3, .dcp-head, .dcp ol.dcp-hops > li, #list li.day')];
  const jumpSection = (dir) => {
    const top = headerH() + 8;
    const list = anchors();
    const target = dir > 0
      ? list.find((a) => a.getBoundingClientRect().top - top > 2)
      : [...list].reverse().find((a) => a.getBoundingClientRect().top - top < -2);
    if (target) jumpTo(window.scrollY + target.getBoundingClientRect().top - top);
    else jumpTo(dir > 0 ? document.documentElement.scrollHeight : 0);
  };
  const currentHop = () => {
    const top = headerH() + 12;
    return [...document.querySelectorAll('.dcp details')].find((d) => { const b = d.getBoundingClientRect(); return b.height > 0 && b.bottom > top && b.top < innerHeight; }) || null;
  };
  const fold = (how) => {
    if (how === 'all-open' || how === 'all-closed') {
      for (const d of document.querySelectorAll('.dcp details')) d.open = how === 'all-open';
      return;
    }
    const d = currentHop();
    if (!d) return toast('No code path hop on screen');
    d.open = how === 'toggle' ? !d.open : how === 'open';
    const s = d.querySelector('summary').getBoundingClientRect();
    if (s.top < headerH()) scrollBy(s.top - headerH() - 8);
  };
  const currentLoc = () => {
    const hop = currentHop();
    if (hop) return hop.querySelector('.dcp-loc');
    return [...document.querySelectorAll('.loc')].find((a) => { const b = a.getBoundingClientRect(); return b.height > 0 && b.top >= headerH() && b.bottom <= innerHeight; }) || null;
  };

  // ---- marks ---------------------------------------------------------------------------------
  const marks = () => lGet('artifacts:marks') || {};
  const setMark = (c) => { const all = marks(); (all[location.pathname] ||= {})[c] = window.scrollY; lSet('artifacts:marks', all); toast("Mark '" + c + "' set"); };
  const gotoMark = (c) => { const y = marks()[location.pathname]?.[c]; if (y == null) return toast("No mark '" + c + "' here"); jumpTo(y); };
  const jumpBack = () => { if (lastJumpY == null) return toast('No earlier position'); jumpTo(lastJumpY); };

  // ---- theme ---------------------------------------------------------------------------------
  const cycleTheme = () => {
    const order = [null, 'light', 'dark'];
    const next = order[(order.indexOf(lGet('artifacts:theme')) + 1) % order.length];
    lSet('artifacts:theme', next);
    if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
    toast('Theme: ' + (next || 'system'));
  };

  // ---- link hints ----------------------------------------------------------------------------
  let hint = null;
  const labelsFor = (n) => {
    let len = 1;
    while (HINT_CHARS.length ** len < n) len++;
    return Array.from({ length: n }, (_, i) => {
      let s = '';
      for (let k = 0, v = i; k < len; k++, v = Math.floor(v / HINT_CHARS.length)) s = HINT_CHARS[v % HINT_CHARS.length] + s;
      return s;
    });
  };
  const startHints = (newTab) => {
    const targets = [...document.querySelectorAll('a[href], button, summary, input:not([type=hidden]), select')].filter((t) => {
      if (t.closest('#kb-help, #kb-hints')) return false;
      const b = t.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth && getComputedStyle(t).visibility !== 'hidden';
    });
    if (!targets.length) return toast('Nothing to click on screen');
    const layer = el('kb-hints');
    layer.innerHTML = '';
    const labels = labelsFor(targets.length);
    const items = targets.map((t, i) => {
      const b = t.getBoundingClientRect();
      const span = document.createElement('span');
      span.textContent = labels[i];
      span.style.left = Math.max(0, b.left - 4) + 'px';
      span.style.top = Math.max(0, b.top - 4) + 'px';
      layer.append(span);
      return { t, label: labels[i], span };
    });
    layer.classList.add('on');
    hint = { items, typed: '', newTab };
  };
  const stopHints = () => { hint = null; const layer = document.getElementById('kb-hints'); if (layer) { layer.classList.remove('on'); layer.innerHTML = ''; } };
  const activate = (t, newTab) => {
    stopHints();
    if (t.matches('input, select')) return t.focus();
    if (newTab && t.href) return window.open(t.href, '_blank', 'noopener');
    t.click();
  };
  const hintKey = (e) => {
    e.preventDefault();
    if (e.key === 'Escape') return stopHints();
    if (e.key === 'Backspace') hint.typed = hint.typed.slice(0, -1);
    else if (HINT_CHARS.includes(e.key.toLowerCase())) hint.typed += e.key.toLowerCase();
    else return;
    const live = hint.items.filter((it) => it.label.startsWith(hint.typed));
    if (!live.length) return stopHints();
    for (const it of hint.items) {
      const on = it.label.startsWith(hint.typed);
      it.span.style.display = on ? '' : 'none';
      if (on) it.span.innerHTML = '<b>' + hint.typed + '</b>' + it.label.slice(hint.typed.length);
    }
    const exact = live.find((it) => it.label === hint.typed);
    if (exact && live.length === 1) activate(exact.t, hint.newTab);
  };

  // ---- find in page --------------------------------------------------------------------------
  // `/` on a page searches as you type, with vim's smartcase (any capital makes it case-sensitive).
  // Matches are painted with the CSS Custom Highlight API, so the page's DOM is never rewritten.
  // Enter keeps them for n/N, Esc puts you back where you were.
  const FIND_CSS = '::highlight(kb-find){background-color:rgba(246,216,96,.5)}::highlight(kb-find-cur){background-color:#f59e0b;color:#1d2126}';
  const MAX_MATCHES = 5000;
  const docFrame = () => document.querySelector('iframe.doc-frame');
  let found = null;    // { q, matches: [{ range, frame }], cur }
  let lastQuery = '';
  let runs = null;
  let findFrom = 0;
  let foundBefore = null;
  let bar = null;

  // The page's text, one run per document (this page, then a framed full HTML page). A newline goes
  // between text in different blocks (paragraphs, code lines), so a match can't span two of them.
  const textRuns = () => {
    const out = [];
    const walk = (root, frame) => {
      if (!root) return;
      const nodes = [], starts = [];
      let text = '', prev = null;
      const skip = 'script, style, noscript, template, .ln';
      const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n; (n = w.nextNode()); prev = n) {
        if (prev && !prev.parentElement.contains(n) && !n.parentElement.contains(prev)) text += '\n';
        starts.push(text.length);
        nodes.push(n);
        text += n.data;
      }
      out.push({ nodes, starts, text, frame });
    };
    walk(document.querySelector('main'), null);
    const f = docFrame();
    try { if (f) walk(f.contentDocument.body, f); } catch (_) {}
    return out;
  };
  const locate = (run, i) => {
    let lo = 0, hi = run.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (run.starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return [run.nodes[lo], i - run.starts[lo]];
  };
  const search = (q) => {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), /[A-Z]/.test(q) ? 'g' : 'gi');
    const matches = [];
    for (const run of runs) {
      for (const m of run.text.matchAll(re)) {
        const [sn, so] = locate(run, m.index);
        const [en, eo] = locate(run, m.index + m[0].length - 1);
        const range = sn.ownerDocument.createRange();
        range.setStart(sn, so);
        range.setEnd(en, eo + 1);
        matches.push({ range, frame: run.frame });
        if (matches.length >= MAX_MATCHES) return matches;
      }
    }
    return matches;
  };
  // A match's page y; one inside a closed hop counts as where the hop is.
  const matchY = (m) => {
    let b = m.range.getBoundingClientRect();
    if (!b.height) { const d = m.range.startContainer.parentElement?.closest('details:not([open])'); if (d) b = d.getBoundingClientRect(); }
    return b.top + (m.frame ? m.frame.getBoundingClientRect().top : 0) + window.scrollY;
  };
  const firstBelow = (matches, y) => { const i = matches.findIndex((m) => matchY(m) >= y + headerH()); return i < 0 ? matches.length : i; };

  const paint = () => {
    const f = docFrame();
    for (const [win, frame] of f ? [[window, null], [f.contentWindow, f]] : [[window, null]]) {
      let reg;
      try { reg = win.CSS && win.CSS.highlights; } catch (_) { continue; }
      if (!reg) continue;
      reg.delete('kb-find');
      reg.delete('kb-find-cur');
      if (!found) continue;
      if (frame && !win.document.getElementById('kb-find-css')) {
        const s = win.document.createElement('style'); s.id = 'kb-find-css'; s.textContent = FIND_CSS; win.document.head.append(s);
      }
      const mine = found.matches.filter((m) => m.frame === frame).map((m) => m.range);
      if (mine.length) reg.set('kb-find', new win.Highlight(...mine));
      const cur = found.matches[found.cur];
      if (cur && cur.frame === frame) { const h = new win.Highlight(cur.range); h.priority = 1; reg.set('kb-find-cur', h); }
    }
  };
  // Open any hop the match is folded into, bring it into view sideways in code, then vertically.
  const reveal = (m) => {
    for (let d = m.range.startContainer.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    const pre = m.range.startContainer.parentElement?.closest('pre');
    let b = m.range.getBoundingClientRect();
    if (pre) {
      const p = pre.getBoundingClientRect();
      if (b.left < p.left || b.right > p.right) { pre.scrollLeft += b.left - p.left - p.width / 3; b = m.range.getBoundingClientRect(); }
    }
    const top = b.top + (m.frame ? m.frame.getBoundingClientRect().top + m.frame.clientTop : 0);
    if (top < headerH() + 40 || top + b.height > innerHeight - 60) window.scrollTo({ top: window.scrollY + top - innerHeight / 3, behavior: 'instant' });
  };
  const counter = () => (found ? (found.cur + 1) + '/' + found.matches.length + (found.matches.length >= MAX_MATCHES ? '+' : '') : '');

  const update = () => {
    const q = bar.input.value;
    bar.b.classList.remove('miss');
    found = q ? { q, matches: search(q), cur: 0 } : null;
    if (found && !found.matches.length) { found = null; bar.b.classList.add('miss'); }
    if (found) {
      found.cur = firstBelow(found.matches, findFrom) % found.matches.length;
      reveal(found.matches[found.cur]);
    } else window.scrollTo({ top: findFrom, behavior: 'instant' });
    bar.n.textContent = q && !found ? 'no match' : counter();
    paint();
  };
  const openFind = () => {
    if (!bar) {
      const b = el('kb-find');
      b.innerHTML = '<span>/</span><input type="text" spellcheck="false" autocomplete="off" aria-label="Find in page"><span class="n"></span>';
      bar = { b, input: b.querySelector('input'), n: b.querySelector('.n'), typed: false };
      bar.input.addEventListener('input', () => { bar.typed = true; update(); });
      bar.input.addEventListener('blur', () => closeFind(true));
    }
    runs = textRuns();
    findFrom = window.scrollY;
    foundBefore = found;
    bar.typed = false;
    bar.b.classList.remove('miss');
    bar.n.textContent = '';
    bar.b.classList.add('show');
    // The last query, selected: type to replace it, or Enter to search for it again from here.
    bar.input.value = lastQuery;
    bar.input.focus();
    bar.input.select();
  };
  const closeFind = (keep) => {
    if (!bar || !bar.b.classList.contains('show')) return;
    bar.b.classList.remove('show');
    if (document.activeElement === bar.input) bar.input.blur();
    const q = bar.input.value;
    if (keep && q) {
      lastQuery = q;
      if (found) lastJumpY = findFrom;
      else toast('Not found: ' + q);
      return;
    }
    if (!keep) window.scrollTo({ top: findFrom, behavior: 'instant' });
    found = keep ? null : foundBefore;
    paint();
  };
  const findKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!bar.typed && bar.input.value) update(); closeFind(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(false); }
  };
  // n/N; after Esc cleared the matches, they search again for the last query from the screen down.
  const step = (dir, n) => {
    if (!found) {
      if (!lastQuery) return toast('No search yet: press /');
      runs = textRuns();
      const matches = search(lastQuery);
      if (!matches.length) return toast('Not found: ' + lastQuery);
      const at = firstBelow(matches, window.scrollY);
      found = { q: lastQuery, matches, cur: dir > 0 ? at - 1 : at };
    }
    const len = found.matches.length;
    const to = found.cur + dir * n;
    found.cur = ((to % len) + len) % len;
    lastJumpY = window.scrollY;
    reveal(found.matches[found.cur]);
    paint();
    const wrapped = to >= len ? 'hit the bottom, continuing at the top · ' : to < 0 ? 'hit the top, continuing at the bottom · ' : '';
    toast(wrapped + '/' + found.q + '  ' + counter());
  };
  const clearFind = () => { if (!found) return false; found = null; paint(); return true; };

  // ---- help ----------------------------------------------------------------------------------
  const HELP = [
    ['Scroll', [['j  k', 'down / up 100px'], ['d  u', 'down / up half a page'], ['gg  G', 'top / bottom'], ['}  {', 'next / previous section, hop or day'], ["''", 'back to where you jumped from']]],
    ['Go', [['h', 'back, or up a level'], ['l', 'forward; on the index, open the selection; else the next page'], ['[  ]', 'newer / older page (in the list you came from)'], ['gh', 'home'], ['gu', 'up a level'], ['gs', 'this page\'s source'], ['gi', 'search every page (the index)'], ['s1…s9  sa', 'filter by slot / all slots'], ['r', 'reload']]],
    ['Find', [['/', 'find in this page as you type (a capital makes it case-sensitive)'], ['Enter  Esc', 'keep the matches / cancel and go back'], ['n  N', 'next / previous match'], ['Esc', 'clear the matches']]],
    ['Index', [['/', 'filter the list as you type; Enter or Esc to leave the box'], ['j  k', 'next / previous item (more load as you go)'], ['J  K', 'scroll 100px'], ['gg  G', 'first / last loaded item'], ['l  o  Enter', 'open it'], ['O', 'open it in a new tab']]],
    ['Code paths', [['za', 'toggle the hop at the top of the screen'], ['zo  zc', 'open / close it'], ['zR  zM', 'open / close every hop'], ['yl', 'copy its path:line (or the first one on screen)']]],
    ['Links and copy', [['f  F', 'link hints (F opens in a new tab)'], ['yy', 'copy this URL'], ['yr', 'copy the claude --resume command'], ['ys', 'copy the slug']]],
    ['Other', [['m{a-z}', 'set a mark'], ["'{a-z}", 'jump to a mark'], ['t', 'theme: system, light, dark'], ['5j  3}', 'counts repeat a motion'], ['?', 'this help'], ['Esc', 'close, cancel, or leave the search box']]],
  ];
  const help = () => {
    const h = el('kb-help');
    if (!h.firstChild) {
      const panel = document.createElement('div');
      panel.className = 'panel';
      for (const [title, keys] of HELP) {
        const sec = document.createElement('section');
        sec.innerHTML = '<h4>' + title + '</h4><dl>' + keys.map(([k, d]) => '<dt>' + k.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</dt><dd>' + d.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</dd>').join('') + '</dl>';
        panel.append(sec);
      }
      h.append(panel);
      h.addEventListener('click', (e) => { if (e.target === h) h.classList.remove('open'); });
    }
    h.classList.toggle('open');
  };
  const helpOpen = () => document.getElementById('kb-help')?.classList.contains('open');

  // ---- dispatch ------------------------------------------------------------------------------
  let pending = '';
  let count = '';
  let pendingTimer = null;
  const showCmd = () => { const c = el('kb-cmd'); c.textContent = count + pending; c.classList.toggle('show', !!(count || pending)); };
  const reset = () => { pending = ''; count = ''; clearTimeout(pendingTimer); showCmd(); };

  const single = {
    j: (n) => { if (PAGE === 'index') return moveSel(n); scrollBy(STEP * n); },
    k: (n) => { if (PAGE === 'index') return moveSel(-n); scrollBy(-STEP * n); },
    d: (n) => { scrollBy(Math.round(innerHeight / 2) * n); followViewport(1); },
    u: (n) => { scrollBy(-Math.round(innerHeight / 2) * n); followViewport(-1); },
    G: () => { jumpTo(document.documentElement.scrollHeight); selectEdge(true); },
    h: back,
    l: forward,
    J: (n) => { scrollBy(STEP * n); followViewport(1); },
    K: (n) => { scrollBy(-STEP * n); followViewport(-1); },
    o: () => PAGE === 'index' && go(selectedHref()),
    Enter: () => PAGE === 'index' && go(selectedHref()),
    O: () => { const href = PAGE === 'index' && selectedHref(); if (href) window.open(href, '_blank', 'noopener'); },
    '[': () => neighbor(-1),
    ']': () => neighbor(1),
    '}': (n) => { for (let i = 0; i < n; i++) jumpSection(1); },
    '{': (n) => { for (let i = 0; i < n; i++) jumpSection(-1); },
    // On the index the search box filters the list; on a page it finds text.
    '/': () => {
      const q = document.querySelector('form.filters input[type=search]');
      if (q) { q.focus(); q.select(); } else openFind();
    },
    n: (n) => step(1, n),
    N: (n) => step(-1, n),
    r: () => location.reload(),
    t: cycleTheme,
    f: () => startHints(false),
    F: () => startHints(true),
    '?': help,
  };
  const sequences = {
    g: { g: () => { jumpTo(0); selectEdge(false); }, h: () => go('/'), u: up, s: () => SLUG && go('/a/' + SLUG + '/source'), i: () => { const q = document.querySelector('form.filters input[type=search]'); if (q) { q.focus(); q.select(); } else go('/#search'); } },
    y: { y: () => copy(location.href, 'URL'), r: () => { const c = document.querySelector('.ctx [data-copy]'); c ? copy(c.dataset.copy, 'resume command') : toast('No agent session on this page'); }, l: () => { const a = currentLoc(); const text = a && (a.dataset.copy || a.textContent.trim()); text ? copy(text, text) : toast('No path:line on screen'); }, s: () => SLUG && copy(SLUG, 'slug') },
    z: { a: () => fold('toggle'), o: () => fold('open'), c: () => fold('close'), R: () => fold('all-open'), M: () => fold('all-closed') },
  };

  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const onKey = (e) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (hint) return hintKey(e);
    if (bar && e.target === bar.input) return findKey(e);
    if (typing(e.target)) { if (k === 'Escape') { e.preventDefault(); e.target.blur(); } return; }
    if (k === 'Shift') return;
    if (k === 'Escape') {
      clearFind();
      document.getElementById('kb-help')?.classList.remove('open');
      document.getElementById('lb')?.classList.remove('open');
      return reset();
    }
    if (helpOpen() && k !== '?') return;
    if (k === 'Enter' && e.target.closest && e.target.closest('a, button, summary')) return;

    if (pending) {
      const p = pending;
      reset();
      e.preventDefault();
      if (p === 'm') return /^[a-z]$/.test(k) ? setMark(k) : undefined;
      if (p === "'" || p === '`') return k === "'" || k === '`' ? jumpBack() : /^[a-z]$/.test(k) ? gotoMark(k) : undefined;
      if (p === 's') return /^[1-9]$/.test(k) ? go('/?slot=' + k) : k === 'a' || k === '0' ? go('/') : undefined;
      return sequences[p]?.[k]?.();
    }
    if (/^[0-9]$/.test(k) && (count || k !== '0')) { count += k; showCmd(); e.preventDefault(); return; }
    if ('gyzms\'`'.includes(k)) {
      pending = k;
      showCmd();
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(reset, 1500);
      e.preventDefault();
      return;
    }
    const action = single[k];
    const n = Math.max(1, parseInt(count || '1', 10));
    count = '';
    showCmd();
    if (action) { e.preventDefault(); action(n); }
  };
  document.addEventListener('keydown', onKey, true);

  // A full HTML page sits in a same-origin frame: its keys drive this page too.
  const frame = document.querySelector('iframe.doc-frame');
  if (frame) {
    const hook = () => { try { frame.contentWindow.addEventListener('keydown', onKey, true); } catch (_) {} };
    frame.addEventListener('load', hook);
    if (frame.contentDocument?.readyState === 'complete') hook();
  }
})();
