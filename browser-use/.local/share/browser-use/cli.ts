// browser-use — drive the shared "Agents" tab group in the user's browser from Claude Code, Codex,
// or a shell. Talks to the native host (host.ts) that the browser-use extension spawns.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { tmpdir } from "node:os";
import { BROWSERS, EXTENSION_DIR, EXTENSION_ID, HOST_NAME, HOSTS_DIR, LOG_FILE, SRC_DIR, STATE_DIR } from "./paths.ts";

const USAGE = `browser-use — drive the shared "Agents" tab group in your browser

Setup
  install [--browser chrome,helium]  register the native host (then load the extension once)
  status                             connected browsers + extension health
  reload                             reload the extension after editing its source

Tabs (agents share one "Agents" tab group; commands default to the tab you last used)
  tabs [--all]                       list Agents tabs (--all: every tab in the browser)
  open <url> [--bg]                  new tab in the Agents group (becomes your current tab)
  use -t <id>                        make an Agents tab your current tab
  adopt -t <id>                      move one of the human's tabs into the Agents group
  release [-t <id>]                  ungroup a tab (hand it back) and detach the debugger
  close [-t <id>]                    close a tab
  focus [-t <id>]                    bring the tab + window to the front for the human

Look
  snap [--all] [--ref eN] [--urls]   interactive-element tree with refs (e12) for click/fill
  shot [out.png] [--full] [--hires]  screenshot (CSS-pixel coords by default); prints the path
  text [css] [--max N]               visible text of <main> / body / a selector
  console [--errors] [--grep re] [--clear]
  network [--grep re] [--failed] [--clear] | network --body <requestId>

Act (target = e12 ref from snap | "text=Save" | CSS selector | "x,y")
  nav <url|back|forward|reload>
  click <target> [--double] [--right]
  hover <target>
  type <text> [--into <target>] [--clear] [--submit]
  fill <target> <value>              set input/select/checkbox/textarea value directly
  key <combo...> [--repeat N]        Enter, Tab, Escape, cmd+a, shift+Tab, ArrowDown …
  scroll [down|up|<px>] [--at <target>]
  eval <js | ->                      run JS in the page (top-level await ok); '-' reads stdin
  wait [ms] [--for css] [--text t] [--gone css] [--url substr] [--timeout ms]
  dialog [accept|dismiss] [--text t]
  resize <w> <h> [--mobile] | resize --reset

Global flags
  -t, --tab <id>        act on this tab instead of your current one
  --json                raw JSON output
  --browser <name>      pick a connected browser when several are (also BROWSER_USE_BROWSER)

Your "current tab" is tracked per owner: $BROWSER_USE_OWNER, else the herdr pane ($HERDR_PANE_ID).

For the human: ⌘⇧S in the browser copies the visible page (no tab strip / URL bar / side panel)
to the clipboard as a PNG; the latest one is also at ~/.local/state/browser-use/viewport.png.
`;

// ------------------------------------------------------------ argv

type Flags = Record<string, string | boolean>;
const BOOL_FLAGS = new Set(["all", "bg", "full", "hires", "urls", "json", "double", "right", "clear", "submit", "errors", "failed", "mobile", "reset", "help", "h"]);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-t") {
      flags.tab = argv[++i];
      continue;
    }
    if (a.startsWith("--") && a.length > 2) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (BOOL_FLAGS.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
      continue;
    }
    if (a === "-h") {
      flags.help = true;
      continue;
    }
    pos.push(a);
  }
  return { pos, flags };
}

function die(msg: string): never {
  process.stderr.write(`browser-use: ${msg}\n`);
  process.exit(1);
}

function num(v: unknown, name: string) {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) die(`--${name} must be a number`);
  return n;
}

// ------------------------------------------------------------ owner + host discovery

function owner() {
  if (process.env.BROWSER_USE_OWNER) return process.env.BROWSER_USE_OWNER;
  const kind = process.env.CLAUDECODE ? "claude" : Object.keys(process.env).some((k) => k.startsWith("CODEX_")) ? "codex" : "shell";
  return process.env.HERDR_PANE_ID ? `${kind}@${process.env.HERDR_PANE_ID}` : kind;
}

type HostMeta = { pid: number; socket: string; browser: string; version: string; started: number };

function liveHosts(): HostMeta[] {
  if (!existsSync(HOSTS_DIR)) return [];
  const hosts: HostMeta[] = [];
  for (const f of readdirSync(HOSTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const path = `${HOSTS_DIR}/${f}`;
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as HostMeta;
      process.kill(meta.pid, 0);
      hosts.push(meta);
    } catch {
      // Dead host (browser quit without cleanup): sweep its files.
      for (const p of [path, path.replace(/\.json$/, ".sock")]) {
        try {
          unlinkSync(p);
        } catch {}
      }
    }
  }
  return hosts.sort((a, b) => b.started - a.started);
}

function pickHost(flags: Flags): HostMeta {
  const hosts = liveHosts();
  const want = (flags.browser as string) ?? process.env.BROWSER_USE_BROWSER;
  const matches = want ? hosts.filter((h) => h.browser.toLowerCase().includes(want.toLowerCase())) : hosts;
  if (matches.length) return matches[0];
  if (want && hosts.length) die(`no connected browser matches "${want}" (connected: ${hosts.map((h) => h.browser).join(", ")})`);
  die(
    "no browser connected. Is the extension loaded and enabled?\n" +
      `  1. browser-use install            (registers the native host; once per machine)\n` +
      `  2. chrome://extensions → Developer mode → Load unpacked → ${EXTENSION_DIR}\n` +
      `  3. click the extension's toolbar icon (or reload it) to reconnect\n` +
      `  logs: ${LOG_FILE}`,
  );
}

function request(host: HostMeta, cmd: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(host.socket);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ cmd, args, owner: owner() }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      const msg = JSON.parse(buf.slice(0, nl));
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot reach native host (${e.message}) — reload the extension`));
    });
  });
}

// ------------------------------------------------------------ install

function install(flags: Flags) {
  mkdirSync(STATE_DIR, { recursive: true });
  const wrapper = `${STATE_DIR}/native-host`;
  // Browsers spawn hosts with a minimal environment, so pin the absolute bun path.
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" run "${SRC_DIR}/host.ts" "$@"\n`);
  chmodSync(wrapper, 0o755);

  const manifest = JSON.stringify(
    {
      name: HOST_NAME,
      description: "browser-use native host (local agent bridge)",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  );
  const wanted = flags.browser ? String(flags.browser).split(",") : Object.keys(BROWSERS);
  const done: string[] = [];
  for (const name of wanted) {
    const dir = BROWSERS[name];
    if (!dir) die(`unknown browser "${name}" (known: ${Object.keys(BROWSERS).join(", ")})`);
    if (!existsSync(dir)) continue;
    mkdirSync(`${dir}/NativeMessagingHosts`, { recursive: true });
    writeFileSync(`${dir}/NativeMessagingHosts/${HOST_NAME}.json`, manifest + "\n");
    done.push(name);
  }
  // The skill lives in ~/.agents/skills (Codex reads it there); give Claude Code the same copy.
  const agentsSkill = `${homedir()}/.agents/skills/browser-use`;
  const claudeSkills = `${homedir()}/.claude/skills`;
  let skillNote = "";
  if (existsSync(agentsSkill) && existsSync(`${homedir()}/.claude`)) {
    mkdirSync(claudeSkills, { recursive: true });
    const link = `${claudeSkills}/browser-use`;
    let present = false;
    try {
      lstatSync(link);
      present = true;
    } catch {}
    if (!present) {
      symlinkSync(agentsSkill, link);
      skillNote = ` (linked ${link})`;
    }
  }

  console.log(`native host: ${wrapper}`);
  console.log(`skill: ${agentsSkill}${skillNote}`);
  console.log(`registered for: ${done.join(", ") || "(no browsers found)"}`);
  console.log(`\nLoad the extension once per browser profile:`);
  console.log(`  chrome://extensions → Developer mode → Load unpacked → ${EXTENSION_DIR}`);
  console.log(`  expected extension id: ${EXTENSION_ID}`);
}

// ------------------------------------------------------------ output

function printTabs(tabs: any[]) {
  if (!tabs.length) return console.log("(no tabs in the Agents group — `browser-use open <url>`)");
  for (const t of tabs) {
    const mark = t.active ? "*" : " ";
    const who = t.owner ? `  [${t.owner}]` : "";
    console.log(`${mark}${String(t.id).padEnd(11)} ${truncate(t.title || "(untitled)", 60)}${who}\n             ${t.url}`);
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function timeOf(t: number) {
  return new Date(t).toTimeString().slice(0, 8);
}

// ------------------------------------------------------------ main

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (!cmd || flags.help || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "install") return install(flags);

  const json = !!flags.json;
  const tab = flags.tab !== undefined ? num(flags.tab, "tab") : undefined;
  const out = (result: unknown, human: () => void) => (json ? console.log(JSON.stringify(result, null, 2)) : human());

  if (cmd === "status") {
    const hosts = liveHosts();
    if (!hosts.length) pickHost(flags); // prints setup guidance
    for (const h of hosts) {
      try {
        const r = await request(h, "ping", {}, 5000);
        console.log(`${h.browser} (ext ${r.version}, host pid ${h.pid}) — connected, Agents group ${r.group ?? "not created yet"}`);
      } catch (e: any) {
        console.log(`${h.browser} (host pid ${h.pid}) — ${e.message}`);
      }
    }
    console.log(`owner: ${owner()}`);
    return;
  }

  const host = pickHost(flags);
  const call = (c: string, args: Record<string, unknown> = {}, timeout?: number) => request(host, c, { tab, ...args }, timeout);

  switch (cmd) {
    case "reload": {
      await call("reload");
      return console.log("extension reloading — it reconnects in a second or two");
    }
    case "tabs": {
      const r = await call("tabs", { all: !!flags.all });
      return out(r, () => printTabs(r));
    }
    case "open": {
      const r = await call("open", { url: pos[0], background: !!flags.bg });
      return out(r, () => console.log(`opened tab ${r.id}: ${r.title || ""}\n  ${r.url}`));
    }
    case "use":
    case "adopt": {
      if (tab === undefined) die(`${cmd} needs -t <tabId> (see \`browser-use tabs${cmd === "adopt" ? " --all" : ""}\`)`);
      const r = await call(cmd);
      return out(r, () => console.log(`${cmd === "adopt" ? "adopted" : "using"} tab ${r.id}: ${r.title}\n  ${r.url}`));
    }
    case "release":
    case "close":
    case "focus": {
      const r = await call(cmd);
      return out(r, () => console.log(`${cmd}: ok`));
    }
    case "nav": {
      if (!pos[0]) die("nav needs a URL (or back / forward / reload)");
      const r = await call("nav", { url: pos[0], timeout: num(flags.timeout, "timeout") });
      return out(r, () => console.log(`${r.status === "complete" ? "loaded" : r.status}: ${r.title}\n  ${r.url}`));
    }
    case "shot": {
      const r = await call("shot", { full: !!flags.full, hires: !!flags.hires });
      const path = pos[0] ?? `${tmpdir()}/browser-use/shot-${Date.now()}.png`;
      mkdirSync(path.replace(/\/[^/]*$/, "") || ".", { recursive: true });
      writeFileSync(path, Buffer.from(r.data, "base64"));
      const meta = { path, width: r.width, height: r.height, coords: r.coords, url: r.url };
      return out(meta, () => console.log(`${path}  (${r.width}×${r.height}, ${r.coords})`));
    }
    case "snap": {
      const r = await call("snap", { all: !!flags.all, ref: flags.ref, urls: !!flags.urls, max: num(flags.max, "max") });
      return out(r, () => {
        const v = r.viewport;
        console.log(`tab ${r.tab}: ${r.title}\n${r.url}\nviewport ${v.width}×${v.height}, scrollY ${v.scrollY}/${v.scrollHeight}\n`);
        console.log(r.lines.join("\n") || "(no interactive elements visible)");
        if (r.truncated) console.log(`… truncated — narrow with --ref eN or raise --max`);
      });
    }
    case "text": {
      const r = await call("text", { selector: pos[0], max: num(flags.max, "max") });
      return out(r, () => console.log(r.text));
    }
    case "click":
    case "hover": {
      if (!pos[0]) die(`${cmd} needs a target (e12 | text=Label | css | x,y)`);
      const r = await call(cmd, {
        target: pos[0],
        button: flags.right ? "right" : "left",
        count: flags.double ? 2 : 1,
      });
      return out(r, () => console.log(`${cmd}ed ${pos[0]} at ${r.x},${r.y}`));
    }
    case "type": {
      if (pos[0] === undefined) die("type needs text");
      const r = await call("type", { text: pos.join(" "), target: flags.into, clear: !!flags.clear, submit: !!flags.submit });
      return out(r, () => console.log(`typed ${r.typed} chars`));
    }
    case "fill": {
      if (pos.length < 2) die("fill needs <target> <value>");
      const r = await call("fill", { target: pos[0], value: pos.slice(1).join(" ") });
      return out(r, () => console.log(`${pos[0]}: ${r.result}`));
    }
    case "key": {
      if (!pos.length) die("key needs at least one key combo");
      const r = await call("key", { keys: pos, repeat: num(flags.repeat, "repeat") });
      return out(r, () => console.log(`pressed ${r.pressed.join(" ")}`));
    }
    case "scroll": {
      const amt = pos[0] ?? "down";
      const dy = amt === "down" ? 600 : amt === "up" ? -600 : Number(amt);
      if (Number.isNaN(dy)) die("scroll takes down | up | <pixels>");
      const r = await call("scroll", { dy, target: flags.at });
      return out(r, () => console.log(`scrollY ${r.scrollY}/${r.scrollHeight} (viewport ${r.viewport})`));
    }
    case "eval": {
      let js = pos.join(" ");
      if (js === "-" || (!js && !process.stdin.isTTY)) js = await Bun.stdin.text();
      if (!js.trim()) die("eval needs JavaScript (or '-' to read stdin)");
      const r = await call("eval", { js });
      return out(r, () => console.log(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)));
    }
    case "console": {
      const r = await call("console", { errors: !!flags.errors, pattern: flags.grep, clear: !!flags.clear, limit: num(flags.limit, "limit") });
      return out(r, () => {
        if (!r.messages.length) console.log("(no console messages captured yet — capture starts the first time an agent touches the tab; reload to catch startup logs)");
        for (const m of r.messages) console.log(`${timeOf(m.t)} ${m.level.padEnd(9)} ${m.text}`);
      });
    }
    case "network": {
      if (flags.body) {
        const r = await call("network", { body: flags.body });
        return out(r, () => console.log(r.body));
      }
      const r = await call("network", { pattern: flags.grep, failed: !!flags.failed, clear: !!flags.clear, limit: num(flags.limit, "limit") });
      return out(r, () => {
        if (!r.requests.length) console.log("(no requests captured yet — capture starts the first time an agent touches the tab)");
        for (const q of r.requests)
          console.log(`${timeOf(q.t)} ${String(q.status ?? q.error ?? "…").padEnd(4)} ${q.method.padEnd(6)} ${(q.type ?? "").padEnd(10)} ${truncate(q.url, 140)}  #${q.id}`);
      });
    }
    case "wait": {
      const ms = pos[0] !== undefined ? Number(pos[0]) : undefined;
      const timeout = num(flags.timeout, "timeout") ?? 10000;
      const r = await call(
        "wait",
        { ms, selector: flags.for, text: flags.text, gone: flags.gone, url: flags.url, timeout },
        Math.max(timeout, ms ?? 0) + 5000,
      );
      return out(r, () => console.log("ok"));
    }
    case "dialog": {
      const r = await call("dialog", { action: pos[0] ?? "accept", text: flags.text });
      return out(r, () => console.log(r.dialog === null ? "no dialog open" : `${r.action}ed ${r.handled.type}: ${r.handled.message}`));
    }
    case "resize": {
      if (flags.reset) {
        const r = await call("resize", { reset: true });
        return out(r, () => console.log("viewport reset"));
      }
      const [w, h] = pos.map(Number);
      if (!w || !h) die("resize needs <width> <height> (or --reset)");
      const r = await call("resize", { width: w, height: h, mobile: !!flags.mobile });
      return out(r, () => console.log(`viewport ${r.width}×${r.height}`));
    }
    default:
      die(`unknown command "${cmd}" — browser-use --help`);
  }
}

main().catch((e) => die(e.message));
