import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { emitKeypressEvents } from "node:readline";

type Agent = {
  agent: string;
  agent_status: string;
  cwd?: string;
  name?: string;
  pane_id: string;
  state_change_seq?: number;
  tab_id: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  workspace_id: string;
};

type Space = {
  agent_status?: string;
  label?: string;
  number?: number;
  pane_count?: number;
  tab_count?: number;
  tokens?: { folder?: string };
  workspace_id: string;
};

type Tab = { label?: string; number?: number; tab_id: string };
type Snapshot = {
  agents: Agent[];
  workspaces: Space[];
  tabs: Tab[];
  focused_pane_id?: string;
  focused_tab_id?: string;
  focused_workspace_id?: string;
};
type Entry = { id: string; label: string; location: string; status: string; search: string; agent?: Agent; space?: Space };

const mode = process.argv[2];
if (mode !== "agents" && mode !== "spaces") {
  console.error("usage: picker.ts agents|spaces");
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Quick picker needs an interactive terminal");
  process.exit(1);
}

const socketPath = process.env.HERDR_SOCKET_PATH || `${homedir()}/.config/herdr/herdr.sock`;
const priority: Record<string, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
let all: Entry[] = [];
let shown: Entry[] = [];
let query = "";
let selected = 0;
let scroll = 0;
let message = "Loading Herdr…";
let loading = false;
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

function statusRank(status: string): number {
  return priority[status] ?? 5;
}

function entries(snapshot: Snapshot): Entry[] {
  if (mode === "spaces") {
    return snapshot.workspaces
      .slice()
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
      .map((space) => {
        const label = clean(space.label) || space.workspace_id;
        const folder = clean(space.tokens?.folder);
        const location = `${folder ? `${folder} · ` : ""}${space.tab_count ?? 0} tabs · ${space.pane_count ?? 0} panes`;
        return {
          id: space.workspace_id,
          label,
          location,
          status: clean(space.agent_status) || "unknown",
          search: `${label} ${folder} ${space.workspace_id} ${space.agent_status || ""}`.toLowerCase(),
          space,
        };
      });
  }

  const spaces = new Map(snapshot.workspaces.map((space) => [space.workspace_id, space]));
  const tabs = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  return snapshot.agents
    .slice()
    .sort((a, b) =>
      statusRank(a.agent_status) - statusRank(b.agent_status) ||
      (b.state_change_seq ?? 0) - (a.state_change_seq ?? 0) ||
      a.pane_id.localeCompare(b.pane_id),
    )
    .map((agent) => {
      const title = clean(agent.terminal_title_stripped || agent.terminal_title);
      const name = clean(agent.name);
      const label = name ? `${name} · ${title || agent.agent}` : title || `${agent.agent} ${agent.pane_id}`;
      const space = spaces.get(agent.workspace_id);
      const tab = tabs.get(agent.tab_id);
      const spaceLabel = clean(space?.label) || agent.workspace_id;
      const tabLabel = clean(tab?.label) || String(tab?.number ?? agent.tab_id);
      const location = `${spaceLabel} / ${tabLabel}`;
      return {
        id: agent.pane_id,
        label,
        location,
        status: agent.agent_status,
        search: `${label} ${agent.agent} ${agent.cwd || ""} ${location} ${agent.pane_id} ${agent.agent_status}`.toLowerCase(),
        agent,
      };
    });
}

function visibleRows(): number {
  return Math.max(1, (process.stdout.rows || 24) - 5);
}

function filter() {
  const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  shown = words.length ? all.filter((entry) => words.every((word) => entry.search.includes(word))) : all;
  selected = Math.min(selected, Math.max(0, shown.length - 1));
  const rows = visibleRows();
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + rows) scroll = selected - rows + 1;
  scroll = Math.min(scroll, Math.max(0, shown.length - rows));
  render();
}

function row(entry: Entry, index: number, active: boolean, width: number): string {
  const marker = active ? ">" : " ";
  const number = index < 9 ? String(index + 1) : " ";
  const status = entry.status.padEnd(7).slice(0, 7);
  const locationWidth = Math.min(25, Math.max(0, Math.floor((width - 15) / 3)));
  const labelWidth = Math.max(1, width - locationWidth - 15);
  const line = clip(`${marker}${number} ${status}  ${clip(entry.label, labelWidth).padEnd(labelWidth)}  ${clip(entry.location, locationWidth)}`, width - 1);
  return active ? `\x1b[7m${line.padEnd(width - 1)}\x1b[0m` : line;
}

function render() {
  if (closed) return;
  const width = Math.max(20, process.stdout.columns || 80);
  const height = Math.max(8, process.stdout.rows || 24);
  const rows = visibleRows();
  const count = `${shown.length}/${all.length} ${mode}`;
  const lines = [
    ` > ${query || "Type to filter…"}`,
    ` ${message || count}`,
    "",
  ];

  for (let index = scroll; index < Math.min(shown.length, scroll + rows); index += 1) {
    lines.push(row(shown[index], index, index === selected, width));
  }
  if (!shown.length && !loading) lines.push(" No matches");
  while (lines.length < height - 1) lines.push("");
  lines.push(" ↑↓ move · ⏎ focus · ^R refresh");
  process.stdout.write(`\x1b[H\x1b[2J${lines.slice(0, height).map((line) => line.includes("\x1b[7m") ? line : clip(line, width - 1)).join("\n")}`);
}

// Talk to the Herdr socket directly: spawning the herdr CLI costs ~30ms a call.
function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "quick-picker", method, params })}\n`));
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

function load(snapshot: Snapshot | undefined) {
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs)) {
    throw new Error("Herdr returned an invalid snapshot");
  }
  all = entries(snapshot);
  message = "";
  selected = Math.max(0, current(snapshot));
  scroll = 0;
}

// Start on where I already am: the focused space, or the focused pane's agent
// (else the first agent in the focused tab).
function current(snapshot: Snapshot): number {
  if (mode === "spaces") return all.findIndex((entry) => entry.id === snapshot.focused_workspace_id);
  const pane = all.findIndex((entry) => entry.id === snapshot.focused_pane_id);
  return pane >= 0 ? pane : all.findIndex((entry) => entry.agent?.tab_id === snapshot.focused_tab_id);
}

async function refresh() {
  if (loading || busy || closed) return;
  loading = true;
  message = "Loading Herdr…";
  render();
  try {
    load((await call<{ snapshot?: Snapshot }>("session.snapshot")).snapshot);
  } catch (error) {
    message = `Herdr: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading = false;
    filter();
  }
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

async function focusSelected(index = selected) {
  const target = shown[index];
  if (!target || busy) return;
  busy = true;
  message = `Focusing ${target.label}…`;
  render();
  try {
    if (target.agent) {
      await call("agent.focus", { target: target.agent.pane_id });
      // Herdr 0.9.0 also needs tab.focus to move the attached client's viewport.
      await call("tab.focus", { tab_id: target.agent.tab_id });
    } else if (target.space) {
      await call("workspace.focus", { workspace_id: target.space.workspace_id });
    }
    finish();
  } catch (error) {
    message = `Focus failed: ${error instanceof Error ? error.message : String(error)}`;
    busy = false;
    render();
  }
}

// open.sh reads this to make the hotkeys toggle the popup.
const pidfile = `${homedir()}/.cache/herdr-quick-picker.pid`;
try {
  mkdirSync(`${homedir()}/.cache`, { recursive: true });
  writeFileSync(pidfile, `${process.pid} ${mode}\n`);
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
    void focusSelected();
  } else if (!key?.ctrl && !key?.meta && text && /^[1-9]$/u.test(text)) {
    // Digits jump straight to the numbered row instead of filtering.
    if (Number(text) <= shown.length) void focusSelected(Number(text) - 1);
  } else if (key?.name === "up" || key?.name === "down" || key?.name === "pageup" || key?.name === "pagedown" || key?.name === "home" || key?.name === "end") {
    const page = visibleRows();
    const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -page : page;
    selected = key.name === "home" ? 0 : key.name === "end" ? shown.length - 1 : selected + delta;
    // Single steps wrap around the ends; paging and home/end stop at them.
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
// The opener already fetched a snapshot to size the popup; reuse it when given.
const preloaded = process.env.QP_SNAPSHOT;
delete process.env.QP_SNAPSHOT;
let usedPreload = false;
if (preloaded) {
  try {
    load((JSON.parse(preloaded) as { result?: { snapshot?: Snapshot } }).result?.snapshot);
    usedPreload = true;
  } catch {}
}
if (usedPreload) filter();
else {
  render();
  void refresh();
}
