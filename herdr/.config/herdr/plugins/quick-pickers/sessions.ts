// Recent Claude + Codex sessions, newest transcript first. Enter resumes the
// session in a new tab (cwd = the session's cwd) with permissions bypassed, or
// focuses the pane if that session is already running under Herdr.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { emitKeypressEvents } from "node:readline";

type Kind = "claude" | "codex";
type Session = { kind: Kind; id: string; title: string; cwd: string; branch: string; mtime: number; search: string; live?: LivePane };
type LivePane = { pane_id: string; tab_id: string; workspace_id: string };
type Snapshot = {
  agents?: { agent_session?: { value?: string }; pane_id: string; tab_id: string; workspace_id: string }[];
  focused_workspace_id?: string;
};

const LIMIT = 20;
const home = homedir();
const socketPath = process.env.HERDR_SOCKET_PATH || `${home}/.config/herdr/herdr.sock`;
const pidfile = `${home}/.cache/herdr-quick-picker.pid`;

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Sessions picker needs an interactive terminal");
  process.exit(1);
}

let all: Session[] = [];
let shown: Session[] = [];
let snapshot: Snapshot = {};
let query = "";
let selected = 0;
let scroll = 0;
let message = "Scanning sessions…";
let busy = false;
let closed = false;

function clean(value: string | undefined): string {
  return (value || "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  const chars = Array.from(value);
  if (width <= 0) return "";
  return chars.length <= width ? value : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

// Keep the tail of a path, which is the part that tells worktrees apart.
function clipLeft(value: string, width: number): string {
  const chars = Array.from(value);
  if (width <= 0) return "";
  return chars.length <= width ? value : `…${chars.slice(chars.length - width + 1).join("")}`;
}

function tilde(path: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function age(mtime: number): string {
  const s = Math.max(0, (Date.now() - mtime) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Transcripts run to many MB; only the head (first prompt, metadata) and the
// tail (latest title, cwd, branch) are needed.
function readRange(path: string, size: number, from: "head" | "tail", bytes: number): string {
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, from === "head" ? 0 : size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function lastMatch(text: string, pattern: RegExp): string {
  let found = "";
  for (const match of text.matchAll(pattern)) found = match[1];
  return found ? (parse(`"${found}"`) ?? found) : "";
}

// Drop slash-command / system wrappers so the first prompt reads as a title.
function promptText(text: string): string {
  const command = text.match(/<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/u);
  if (command) return clean(`${command[1]} ${command[2] || ""}`);
  if (text.startsWith("<") || text.startsWith("# AGENTS.md") || text.startsWith("Caveat:")) return "";
  return clean(text);
}

type Candidate = { kind: Kind; path: string; mtime: number; size: number };

function candidates(): Candidate[] {
  const found: Candidate[] = [];
  const add = (kind: Kind, path: string) => {
    try {
      const stat = statSync(path);
      if (stat.size > 0) found.push({ kind, path, mtime: stat.mtimeMs, size: stat.size });
    } catch {}
  };
  // ~/.claude/projects/<encoded cwd>/<uuid>.jsonl (subagent transcripts live a level deeper).
  const projects = `${home}/.claude/projects`;
  for (const dir of safeReaddir(projects)) {
    for (const file of safeReaddir(`${projects}/${dir}`)) {
      if (file.endsWith(".jsonl")) add("claude", `${projects}/${dir}/${file}`);
    }
  }
  // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Walk every day: a resumed
  // session keeps writing to the file under the day it started.
  const walk = (dir: string) => {
    for (const name of safeReaddir(dir)) {
      if (name.endsWith(".jsonl")) add("codex", `${dir}/${name}`);
      else if (/^\d+$/u.test(name)) walk(`${dir}/${name}`);
    }
  };
  walk(`${home}/.codex/sessions`);
  return found.sort((a, b) => b.mtime - a.mtime);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function claudeSession(c: Candidate): Session | undefined {
  const head = readRange(c.path, c.size, "head", 256 * 1024);
  const tail = c.size > 256 * 1024 ? readRange(c.path, c.size, "tail", 1024 * 1024) : head;
  // `claude -p` runs (hooks, scripts) aren't worth resuming.
  if (/"entrypoint":"sdk-cli"/u.test(head)) return undefined;
  const id = c.path.slice(c.path.lastIndexOf("/") + 1, -".jsonl".length);
  let title = lastMatch(tail, /"customTitle":"((?:[^"\\]|\\.)*)"/gu) || lastMatch(tail, /"aiTitle":"((?:[^"\\]|\\.)*)"/gu);
  let prompt = "";
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    const record = parse(line);
    if (!record || record.isMeta || record.isSidechain) continue;
    const content = record.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((part: any) => part?.type === "text")?.text : "";
    prompt = promptText(text || "");
    if (prompt) break;
  }
  if (!title && !prompt) return undefined;
  title = clean(title) || prompt;
  const cwd = lastMatch(tail, /"cwd":"((?:[^"\\]|\\.)*)"/gu) || lastMatch(head, /"cwd":"((?:[^"\\]|\\.)*)"/gu);
  const branch = lastMatch(tail, /"gitBranch":"((?:[^"\\]|\\.)*)"/gu);
  return session("claude", id, title, cwd, branch, c.mtime, prompt);
}

let codexTitles: Map<string, string> | undefined;
function codexTitle(id: string): string {
  if (!codexTitles) {
    codexTitles = new Map();
    try {
      // Append-only; the last rename for an id wins.
      for (const line of readFileSync(`${home}/.codex/session_index.jsonl`, "utf8").split("\n")) {
        const record = parse(line);
        if (record?.id && record.thread_name) codexTitles.set(record.id, record.thread_name);
      }
    } catch {}
  }
  return codexTitles.get(id) || "";
}

function codexSession(c: Candidate): Session | undefined {
  let head = readRange(c.path, c.size, "head", 256 * 1024);
  if (!head.includes("\n")) head = readRange(c.path, c.size, "head", 4 * 1024 * 1024);
  const lines = head.split("\n");
  const meta = parse(lines[0])?.payload;
  if (!meta?.id) return undefined;
  // Subagent threads and `codex exec` runs aren't worth resuming.
  if (meta.thread_source && meta.thread_source !== "user") return undefined;
  if (meta.source && meta.source !== "cli" && meta.source !== "vscode") return undefined;
  let prompt = "";
  for (const line of lines.slice(1)) {
    if (!line.includes('"role":"user"')) continue;
    const payload = parse(line)?.payload;
    if (payload?.type !== "message" || payload.role !== "user") continue;
    prompt = promptText(payload.content?.find((part: any) => part?.type === "input_text")?.text || "");
    if (prompt) break;
  }
  const title = clean(codexTitle(meta.id)) || prompt;
  if (!title) return undefined;
  return session("codex", meta.id, title, meta.cwd || "", meta.git?.branch || "", c.mtime, prompt);
}

function session(kind: Kind, id: string, title: string, cwd: string, branch: string, mtime: number, prompt: string): Session {
  return { kind, id, title, cwd, branch, mtime, search: `${kind} ${title} ${prompt} ${cwd} ${branch} ${id}`.toLowerCase() };
}

function scan(): Session[] {
  const result: Session[] = [];
  const seen = new Set<string>();
  for (const c of candidates()) {
    if (result.length >= LIMIT) break;
    let s: Session | undefined;
    try {
      s = c.kind === "claude" ? claudeSession(c) : codexSession(c);
    } catch {}
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    result.push(s);
  }
  return result;
}

function markLive() {
  const live = new Map<string, LivePane>();
  for (const agent of snapshot.agents || []) {
    const id = agent.agent_session?.value;
    if (id) live.set(id, { pane_id: agent.pane_id, tab_id: agent.tab_id, workspace_id: agent.workspace_id });
  }
  for (const s of all) s.live = live.get(s.id);
}

function visibleRows(): number {
  return Math.max(1, (process.stdout.rows || 24) - 5);
}

function filter() {
  const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  shown = words.length ? all.filter((s) => words.every((word) => s.search.includes(word))) : all;
  selected = Math.min(selected, Math.max(0, shown.length - 1));
  const rows = visibleRows();
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + rows) scroll = selected - rows + 1;
  scroll = Math.min(scroll, Math.max(0, shown.length - rows));
  render();
}

function row(s: Session, index: number, active: boolean, width: number): string {
  const marker = active ? ">" : " ";
  const number = index < 9 ? String(index + 1) : " ";
  const kind = `${s.kind}${s.live ? "*" : " "}`.padEnd(7);
  const when = age(s.mtime).padStart(3);
  const locationWidth = Math.min(34, Math.max(0, Math.floor((width - 20) / 3)));
  const labelWidth = Math.max(1, width - locationWidth - 20);
  const line = clip(`${marker}${number} ${kind} ${when}  ${clip(s.title, labelWidth).padEnd(labelWidth)}  ${clipLeft(tilde(s.cwd), locationWidth)}`, width - 1);
  return active ? `\x1b[7m${line.padEnd(width - 1)}\x1b[0m` : line;
}

function render() {
  if (closed) return;
  const width = Math.max(20, process.stdout.columns || 80);
  const height = Math.max(8, process.stdout.rows || 24);
  const rows = visibleRows();
  const current = shown[selected];
  const detail = current ? `${shown.length}/${all.length} · ${current.branch || current.id}` : `${shown.length}/${all.length} sessions`;
  const lines = [` > ${query || "Type to filter…"}`, ` ${message || detail}`, ""];
  for (let index = scroll; index < Math.min(shown.length, scroll + rows); index += 1) {
    lines.push(row(shown[index], index, index === selected, width));
  }
  if (!shown.length && !message) lines.push(" No matches");
  while (lines.length < height - 1) lines.push("");
  lines.push(" ↑↓ move · ⏎ resume (yolo) · * live → focus · ^R rescan");
  process.stdout.write(`\x1b[H\x1b[2J${lines.slice(0, height).map((line) => line.includes("\x1b[7m") ? line : clip(line, width - 1)).join("\n")}`);
}

// Talk to the Herdr socket directly: spawning the herdr CLI costs ~30ms a call.
function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "sessions-picker", method, params })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, end)) as { result?: T; error?: { message?: string } };
        if (response.error) reject(new Error(response.error.message || `${method} failed`));
        else resolve(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function resumeCommand(s: Session): string {
  return s.kind === "claude"
    ? `claude --resume ${shellQuote(s.id)} --dangerously-skip-permissions`
    : `codex resume --dangerously-bypass-approvals-and-sandbox ${shellQuote(s.id)}`;
}

async function choose(index = selected) {
  const target = shown[index];
  if (!target || busy) return;
  busy = true;
  try {
    if (target.live) {
      message = `Focusing ${target.title}…`;
      render();
      await call("workspace.focus", { workspace_id: target.live.workspace_id });
      await call("agent.focus", { target: target.live.pane_id });
      await call("tab.focus", { tab_id: target.live.tab_id });
      return finish();
    }
    if (!target.cwd || !existsSync(target.cwd)) throw new Error(`cwd is gone: ${tilde(target.cwd) || "(unknown)"}`);
    message = `Resuming ${target.title}…`;
    render();
    const created = await call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>("tab.create", {
      workspace_id: snapshot.focused_workspace_id ?? null,
      cwd: target.cwd,
      label: clip(target.title.toLowerCase(), 30),
      focus: true,
    });
    const pane = created.root_pane?.pane_id;
    if (!pane) throw new Error("tab.create returned no pane");
    await call("pane.send_input", { pane_id: pane, text: resumeCommand(target), keys: ["enter"] });
    finish();
  } catch (error) {
    message = `Failed: ${error instanceof Error ? error.message : String(error)}`;
    busy = false;
    render();
  }
}

async function refresh() {
  if (busy || closed) return;
  message = "Scanning sessions…";
  render();
  // Let the frame paint before the synchronous scan.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    all = scan();
    const fresh = await call<{ snapshot?: Snapshot }>("session.snapshot").catch(() => undefined);
    if (fresh?.snapshot) snapshot = fresh.snapshot;
    markLive();
    message = "";
  } catch (error) {
    message = `Scan failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  filter();
}

function finish(code = 0) {
  if (closed) return;
  closed = true;
  try {
    if (readFileSync(pidfile, "utf8").startsWith(`${process.pid} `)) rmSync(pidfile);
  } catch {}
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  process.exit(code);
}

// open.sh / herdrkeys.lua read this to make the hotkeys toggle the popup.
try {
  mkdirSync(`${home}/.cache`, { recursive: true });
  writeFileSync(pidfile, `${process.pid} sessions\n`);
} catch {}
process.on("SIGTERM", () => finish());
process.on("SIGHUP", () => finish());

process.stdout.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.resume();
emitKeypressEvents(process.stdin);
process.stdin.on("keypress", (text, key) => {
  if (closed || busy) return;
  if (key?.name === "escape" || (key?.ctrl && key.name === "c")) {
    finish();
  } else if (key?.name === "return" || key?.name === "enter") {
    void choose();
  } else if (!key?.ctrl && !key?.meta && text && /^[1-9]$/u.test(text)) {
    if (Number(text) <= shown.length) void choose(Number(text) - 1);
  } else if (key?.name === "up" || key?.name === "down" || key?.name === "pageup" || key?.name === "pagedown" || key?.name === "home" || key?.name === "end") {
    const page = visibleRows();
    const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -page : page;
    selected = key.name === "home" ? 0 : key.name === "end" ? shown.length - 1 : selected + delta;
    if (key.name === "up" || key.name === "down") selected = (selected + shown.length) % Math.max(1, shown.length);
    selected = Math.max(0, Math.min(shown.length - 1, selected));
    filter();
  } else if (key?.ctrl && key.name === "r") {
    void refresh();
  } else if ((key?.ctrl && key.name === "w") || (key?.meta && key.name === "backspace")) {
    query = query.replace(/\s*\S+\s*$/u, "");
    selected = 0;
    scroll = 0;
    filter();
  } else if (key?.name === "backspace" || key?.name === "delete") {
    query = Array.from(query).slice(0, -1).join("");
    selected = 0;
    scroll = 0;
    filter();
  } else if (key?.ctrl && key.name === "u") {
    query = "";
    selected = 0;
    scroll = 0;
    filter();
  } else if (!key?.ctrl && !key?.meta && text && !/[\u0000-\u001f\u007f]/u.test(text)) {
    query = `${query}${text}`.slice(0, 200);
    selected = 0;
    scroll = 0;
    filter();
  }
});
process.stdout.on("resize", render);

// The opener already fetched a snapshot to size the popup; reuse it for the
// live markers and the target space, and skip the socket round-trip.
const preloaded = process.env.QP_SNAPSHOT;
delete process.env.QP_SNAPSHOT;
if (preloaded) {
  try {
    snapshot = (JSON.parse(preloaded) as { result?: { snapshot?: Snapshot } }).result?.snapshot || {};
  } catch {}
}
render();
setTimeout(() => {
  try {
    all = scan();
    markLive();
    message = "";
  } catch (error) {
    message = `Scan failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  filter();
  if (!snapshot.focused_workspace_id) void call<{ snapshot?: Snapshot }>("session.snapshot").then((r) => { if (r?.snapshot) { snapshot = r.snapshot; markLive(); render(); } }, () => {});
}, 0);
