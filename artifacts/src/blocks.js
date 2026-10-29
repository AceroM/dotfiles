// Copy and run buttons on every code block, on every kind of page (inside a full HTML document's
// frame too). A shell block gets ▶ as well: it runs on this machine through POST /api/run, in the
// page's checkout, and its output streams in underneath. ▶ again while it runs stops it.
//
// What counts as a shell block, in HTML (markdown ```bash fences render to the same thing):
//   <pre><code class="language-bash">…</code></pre>         bash, sh, shell or zsh
//   <pre data-run>…</pre>                                    anything, run with bash
//   data-cwd="apps/web"   where to run it: absolute, ~/…, or relative to the page's checkout
//   data-shell="zsh"      run it with zsh instead
//   data-norun            copy only
(() => {
  const SHELLS = { bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'zsh' };
  const SLUG = document.body.dataset.slug || null;
  const MAX_OUTPUT = 400000;
  const svg = (d) => `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${d}</svg>`;
  const ICON = {
    run: svg('<path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/>'),
    stop: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
    done: svg('<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    close: svg('<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  };
  // Self-contained, so it reads the same inside an agent's own HTML document. The shell page maps
  // the --ab-* variables onto its theme.
  const CSS = `
.ab { position: relative; margin: 1em 0; }
.ab > pre { margin: 0 !important; }
.ab.ab-runnable > pre { padding-right: 76px; }
.ab-bar { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; z-index: 2; }
.ab-bar button, .ab-head button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 24px; min-width: 24px; padding: 0 6px; border-radius: 5px; cursor: pointer; color: var(--ab-muted, #6b7280);
  background: var(--ab-bg, rgba(255,255,255,.85)); border: 1px solid var(--ab-rule, rgba(128,128,128,.3)); font: 12px/1 var(--ab-mono, ui-monospace, Menlo, monospace); }
.ab-bar button:hover, .ab-head button:hover { color: var(--ab-ink, inherit); border-color: var(--ab-muted, #6b7280); }
.ab-bar button:focus-visible, .ab-head button:focus-visible { outline: 2px solid var(--ab-ok, #2f9e6e); outline-offset: 1px; }
.ab-bar .ab-copy { opacity: 0; transition: opacity .12s; }
.ab:hover .ab-bar .ab-copy, .ab-bar .ab-copy:focus-visible, .ab-bar .ab-copy.ab-did { opacity: 1; }
.ab-bar .ab-run { color: var(--ab-ok, #2f9e6e); }
.ab.ab-running .ab-bar .ab-run { color: var(--ab-err, #c2410c); }
.ab-did { color: var(--ab-ok, #2f9e6e) !important; }
.ab-out { margin-top: 6px; border: 1px solid var(--ab-rule, rgba(128,128,128,.3)); border-radius: 8px; overflow: hidden; background: var(--ab-bg, transparent); }
.ab-out[hidden] { display: none; }
.ab-head { display: flex; align-items: center; gap: 10px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--ab-rule, rgba(128,128,128,.3));
  font: 12px/1.4 var(--ab-mono, ui-monospace, Menlo, monospace); color: var(--ab-muted, #6b7280); }
.ab-status { font-weight: 600; white-space: nowrap; }
.ab-status.ok { color: var(--ab-ok, #2f9e6e); } .ab-status.bad { color: var(--ab-err, #c2410c); }
.ab-running .ab-status::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; vertical-align: 1px;
  background: var(--ab-ok, #2f9e6e); animation: ab-pulse 1s ease-in-out infinite; }
@keyframes ab-pulse { 50% { opacity: .25; } }
.ab-cwd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ab-text { margin: 0 !important; padding: 10px 12px !important; max-height: 460px; overflow: auto; border: 0 !important; border-radius: 0 !important; background: none !important;
  font: 12.5px/1.5 var(--ab-mono, ui-monospace, Menlo, monospace); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ab-ink, inherit); }
.ab-text:empty::before { content: "no output"; color: var(--ab-muted, #6b7280); font-style: italic; }
.ab-text .e { color: var(--ab-err, #c2410c); }
.ab-text .note { color: var(--ab-muted, #6b7280); font-style: italic; }
`;

  const langOf = (pre) => {
    if (pre.dataset.lang) return pre.dataset.lang.toLowerCase();
    const code = pre.querySelector(':scope > code');
    const m = `${code ? code.className : ''} ${pre.className}`.match(/\blang(?:uage)?-([\w+-]+)/);
    return m ? m[1].toLowerCase() : '';
  };

  // A code path's source has a line-number span per row and no newlines between rows.
  const textOf = (pre) => {
    if (pre.classList.contains('dcp-src')) {
      return [...pre.querySelectorAll('code > span')].map((row) => {
        const c = row.cloneNode(true);
        c.querySelector('.ln')?.remove();
        return c.textContent === ' ' ? '' : c.textContent;
      }).join('\n');
    }
    return pre.textContent.replace(/\n$/, '');
  };

  const copyText = (text, doc) => {
    const viaTextarea = () => {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0';
      doc.body.append(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      ta.remove();
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, viaTextarea);
    return Promise.resolve(viaTextarea());
  };

  const flash = (btn, ok) => {
    const was = btn.innerHTML;
    if (!ok) return;
    btn.innerHTML = ICON.done;
    btn.classList.add('ab-did');
    setTimeout(() => { btn.innerHTML = was; btn.classList.remove('ab-did'); }, 900);
  };

  const button = (doc, cls, icon, title) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  };

  const decorate = (doc) => {
    if (!doc || !doc.body) return;
    if (!doc.getElementById('ab-style')) {
      const style = doc.createElement('style');
      style.id = 'ab-style';
      style.textContent = CSS;
      (doc.head || doc.body).append(style);
    }
    const pres = doc === document ? doc.querySelectorAll('main pre') : doc.querySelectorAll('pre');
    for (const pre of pres) {
      if (pre.closest('.ab') || pre.classList.contains('mermaid') || 'noCopy' in pre.dataset) continue;
      const lang = langOf(pre);
      const runnable = !('norun' in pre.dataset) && ('run' in pre.dataset || lang in SHELLS);
      const block = doc.createElement('div');
      block.className = 'ab' + (runnable ? ' ab-runnable' : '');
      // The block takes over the pre's outer margins, so the buttons sit on its corner.
      const m = (doc.defaultView || window).getComputedStyle(pre);
      block.style.margin = `${m.marginTop} ${m.marginRight} ${m.marginBottom} ${m.marginLeft}`;
      pre.replaceWith(block);
      block.append(pre);
      const bar = doc.createElement('div');
      bar.className = 'ab-bar';
      bar.append(button(doc, 'ab-copy', ICON.copy, 'Copy'));
      if (runnable) bar.append(button(doc, 'ab-run', ICON.run, 'Run here (' + (pre.dataset.cwd || "the page's checkout") + ')'));
      block.append(bar);
    }
    if (!doc.abBound) {
      doc.abBound = true;
      doc.addEventListener('click', (e) => {
        const btn = e.target.closest('.ab button');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const block = btn.closest('.ab');
        const pre = block.querySelector(':scope > pre');
        if (btn.classList.contains('ab-copy')) copyText(textOf(pre), doc).then((ok) => flash(btn, ok));
        else if (btn.classList.contains('ab-run')) run(block, pre, doc);
        else if (btn.classList.contains('ab-copy-out')) copyText(block.querySelector('.ab-text').textContent, doc).then((ok) => flash(btn, ok));
        else if (btn.classList.contains('ab-close')) { block._stop?.(); block.querySelector('.ab-out').hidden = true; }
      });
    }
  };

  // Output: strip colour codes, keep \r-redrawn progress lines from piling up.
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g;
  const clean = (s) => s.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '');

  const panel = (block, doc) => {
    let out = block.querySelector(':scope > .ab-out');
    if (out) return out;
    out = doc.createElement('div');
    out.className = 'ab-out';
    out.innerHTML = '<div class="ab-head"><span class="ab-status"></span><span class="ab-cwd"></span></div><pre class="ab-text"></pre>';
    out.querySelector('.ab-head').append(button(doc, 'ab-copy-out', ICON.copy, 'Copy the output'), button(doc, 'ab-close', ICON.close, 'Stop and hide'));
    block.append(out);
    return out;
  };

  const run = async (block, pre, doc) => {
    if (block._stop) { block._stop(); return; }
    const out = panel(block, doc);
    const status = out.querySelector('.ab-status');
    const cwd = out.querySelector('.ab-cwd');
    const text = out.querySelector('.ab-text');
    const runBtn = block.querySelector('.ab-run');
    out.hidden = false;
    text.textContent = '';
    cwd.textContent = '';
    status.className = 'ab-status';
    let size = 0;
    const append = (s, cls) => {
      s = clean(s);
      if (!s) return;
      const stick = text.scrollTop + text.clientHeight >= text.scrollHeight - 4;
      const span = doc.createElement('span');
      if (cls) span.className = cls;
      span.textContent = s;
      text.append(span);
      size += s.length;
      while (size > MAX_OUTPUT && text.firstChild) { size -= text.firstChild.textContent.length; text.firstChild.remove(); }
      if (stick) text.scrollTop = text.scrollHeight;
    };

    const ctl = new AbortController();
    let stopped = false;
    block._stop = () => { stopped = true; ctl.abort(); };
    block.classList.add('ab-running');
    runBtn.innerHTML = ICON.stop;
    runBtn.title = 'Stop';
    const t0 = performance.now();
    const took = (ms) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');
    const secs = () => took(performance.now() - t0);
    const tick = setInterval(() => { status.textContent = 'running · ' + secs(); }, 100);
    status.textContent = 'running';
    let ended = false;
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: textOf(pre), slug: SLUG, cwd: pre.dataset.cwd || null, shell: pre.dataset.shell || SHELLS[langOf(pre)] || 'bash' }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        append(await res.text(), 'e');
        status.textContent = 'not run';
        status.classList.add('bad');
        ended = true;
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.o != null) append(m.o);
          else if (m.e != null) append(m.e, 'e');
          else if (m.cwd) { cwd.textContent = m.cwd; cwd.title = m.cwd; }
          else if ('exit' in m) {
            ended = true;
            const ok = m.exit === 0;
            status.textContent = (m.signal != null ? 'signal ' + m.signal : 'exit ' + m.exit) + ' · ' + took(m.ms);
            status.classList.add(ok ? 'ok' : 'bad');
          }
        }
      }
    } catch (err) {
      if (!stopped) append(String(err) + '\n', 'e');
    } finally {
      clearInterval(tick);
      if (!ended) {
        status.textContent = (stopped ? 'stopped' : 'lost the server') + ' · ' + secs();
        status.classList.add('bad');
      }
      block._stop = null;
      block.classList.remove('ab-running');
      runBtn.innerHTML = ICON.run;
      runBtn.title = 'Run again';
    }
  };

  window.artifactsBlocks = decorate;
  decorate(document);
  // A full HTML document is shown in a same-origin frame; give its blocks the same buttons.
  for (const frame of document.querySelectorAll('iframe.doc-frame')) {
    const go = () => { try { decorate(frame.contentDocument); } catch (_) {} };
    frame.addEventListener('load', go);
    if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.URL !== 'about:blank') go();
  }
})();
