#!/usr/bin/env node
// Drive the user's running Helium browser over CDP.
//
// Helium (imput.co, Chromium 150) must have remote debugging ON:
//   helium://inspect/#remote-debugging → "Allow remote debugging for this browser instance"
// The legacy http://127.0.0.1:9222/json/* discovery is DEAD (404) in Chromium 150,
// so we read the browser WS endpoint from the DevToolsActivePort file instead.
//
// Usage:
//   node helium-cdp.mjs list
//   node helium-cdp.mjs shot <url-substr> [out.png]
//   node helium-cdp.mjs eval <url-substr> "<js expr>"
//   node helium-cdp.mjs goto <url-substr|any> <url>
//   node helium-cdp.mjs newtab <url>
//   node helium-cdp.mjs click <url-substr> "<css selector>"
//   node helium-cdp.mjs type  <url-substr> "<css selector>" "<text>"
//   node helium-cdp.mjs waitfor <url-substr> "<css selector>" [timeoutMs]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- locate puppeteer-core -------------------------------------------------
function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_CORE,
    path.join(os.homedir(), 'porio/vibesdk/node_modules/puppeteer-core'),
    'puppeteer-core',
    'puppeteer',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const pkg = c.endsWith('puppeteer-core') || c === 'puppeteer' || c === 'puppeteer-core'
        ? c
        : c;
      // Prefer the ESM entry when given a dir path.
      const esm = path.join(c, 'lib/esm/puppeteer/puppeteer-core.js');
      if (c.startsWith('/') && fs.existsSync(esm)) return import(esm).then(m => m.default ?? m);
      return import(require.resolve(pkg)).then(m => m.default ?? m);
    } catch {}
  }
  throw new Error('puppeteer-core not found. Set PUPPETEER_CORE=/path/to/node_modules/puppeteer-core');
}

// --- locate the DevToolsActivePort file ------------------------------------
function wsEndpoint() {
  const paths = [
    process.env.HELIUM_DTAP,
    path.join(os.homedir(), 'Library/Application Support/net.imput.helium/DevToolsActivePort'),
    path.join(os.homedir(), 'Library/Application Support/Chromium/DevToolsActivePort'),
    path.join(os.homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      const [port, wsPath] = fs.readFileSync(p, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    } catch {}
  }
  throw new Error('DevToolsActivePort not found. Is Helium running with remote debugging enabled (helium://inspect/#remote-debugging)?');
}

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint(), defaultViewport: null });
const [cmd, ...args] = process.argv.slice(2);

const pages = () => browser.pages();
async function find(sub) {
  if (sub === 'any') return (await pages())[0];
  const p = (await pages()).find(pg => pg.url().includes(sub));
  if (!p) { console.error('NO PAGE matching:', sub); process.exit(2); }
  return p;
}

try {
  switch (cmd) {
    case 'list': {
      for (const p of await pages()) {
        let t = ''; try { t = await p.title(); } catch {}
        console.log(t.slice(0, 60).padEnd(61), '|', p.url());
      }
      break;
    }
    case 'shot': {
      const p = await find(args[0]);
      await p.bringToFront().catch(() => {});
      const out = args[1] || '/tmp/helium-shot.png';
      await p.screenshot({ path: out });
      console.log('shot ->', out, '| url:', p.url());
      break;
    }
    case 'eval': {
      const p = await find(args[0]);
      const r = await p.evaluate(new Function('return (' + args[1] + ')'));
      console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
      break;
    }
    case 'goto': {
      const p = await find(args[0]);
      await p.goto(args[1], { waitUntil: 'domcontentloaded' });
      console.log('now at', p.url());
      break;
    }
    case 'newtab': {
      const p = await browser.newPage();
      await p.goto(args[0], { waitUntil: 'domcontentloaded' });
      console.log('opened', p.url());
      break;
    }
    case 'click': {
      const p = await find(args[0]);
      await p.click(args[1]);
      console.log('clicked', args[1]);
      break;
    }
    case 'type': {
      const p = await find(args[0]);
      await p.focus(args[1]);
      await p.type(args[1], args[2], { delay: 15 });
      console.log('typed into', args[1]);
      break;
    }
    case 'waitfor': {
      const p = await find(args[0]);
      await p.waitForSelector(args[1], { timeout: Number(args[2] || 15000) });
      console.log('present:', args[1]);
      break;
    }
    default:
      console.error('unknown cmd:', cmd, '\nsee header for usage');
      process.exitCode = 1;
  }
} finally {
  await browser.disconnect();
}
