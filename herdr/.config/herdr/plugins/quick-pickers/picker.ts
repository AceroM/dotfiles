import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { MoveTabError } from "./move-tab";
import { moveTabInWorker } from "./move-tab-worker";
import { call } from "./rpc";

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

type Tab = { agent_status?: string; label?: string; number?: number; pane_count?: number; tab_id: string; workspace_id?: string };
type Pane = {
  agent?: string;
  agent_status?: string;
  cwd?: string;
  pane_id: string;
  tab_id: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  workspace_id?: string;
};
type Snapshot = {
  agents: Agent[];
  panes?: Pane[];
  workspaces: Space[];
  tabs: Tab[];
  focused_pane_id?: string;
  focused_tab_id?: string;
  focused_workspace_id?: string;
};
type Entry = { id: string; label: string; location: string; status: string; search: string; agent?: Agent; space?: Space; tab?: Tab; pane?: Pane };

const mode = process.argv[2];
if (mode !== "agents" && mode !== "spaces" && mode !== "move" && mode !== "tabs" && mode !== "grep") {
  console.error("usage: picker.ts agents|spaces|move|tabs|grep");
  process.exit(2);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Quick picker needs an interactive terminal");
  process.exit(1);
}

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
let paneCount = 0;
// Pin the tab from the opener's snapshot. Refreshing the destination list must
// never change which tab is being sent.
let sourceTabId: string | undefined;
let sourceWorkspaceId: string | undefined;
let sourceTabLabel = "";
let moveUnavailable = false;

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
  if (mode === "spaces" || mode === "move") {
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
  if (mode === "tabs") {
    // Sidebar order: space number, then tab number. Pane titles and cwds are
    // searchable so a tab can be found by what is running in it.
    const panes = new Map<string, string[]>();
    for (const pane of snapshot.panes || []) {
      const words = panes.get(pane.tab_id) || [];
      words.push(clean(pane.terminal_title_stripped || pane.terminal_title), pane.cwd || "");
      panes.set(pane.tab_id, words);
    }
    const spaceNumber = (tab: Tab) => spaces.get(tab.workspace_id || "")?.number ?? Infinity;
    return snapshot.tabs
      .slice()
      .sort((a, b) => spaceNumber(a) - spaceNumber(b) || (a.number ?? Infinity) - (b.number ?? Infinity))
      .map((tab) => {
        const space = spaces.get(tab.workspace_id || "");
        const label = clean(tab.label) || String(tab.number ?? tab.tab_id);
        const spaceLabel = clean(space?.label) || tab.workspace_id || "";
        const location = `${spaceLabel} · ${tab.pane_count ?? 0} panes`;
        return {
          id: tab.tab_id,
          label,
          location,
          status: clean(tab.agent_status) || "unknown",
          search: `${label} ${spaceLabel} ${tab.tab_id} ${tab.agent_status || ""} ${(panes.get(tab.tab_id) || []).join(" ")}`.toLowerCase(),
          tab,
        };
      });
  }
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

// The pane I opened grep from, and the picker's own pane when run outside a popup.
function skipPane(pane: Pane, snapshot: Snapshot): boolean {
  return pane.pane_id === snapshot.focused_pane_id || pane.pane_id === process.env.HERDR_PANE_ID;
}

// grep: one entry per non-blank line on every other pane's visible screen
// (source "visible", so nothing is scrolled or read from scrollback).
async function grepEntries(snapshot: Snapshot): Promise<Entry[]> {
  const spaces = new Map(snapshot.workspaces.map((space) => [space.workspace_id, space]));
  const tabs = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab]));
  const spaceNumber = (pane: Pane) => spaces.get(pane.workspace_id || "")?.number ?? Infinity;
  const tabNumber = (pane: Pane) => tabs.get(pane.tab_id)?.number ?? Infinity;
  const panes = (snapshot.panes || [])
    .filter((pane) => !skipPane(pane, snapshot))
    .sort((a, b) => spaceNumber(a) - spaceNumber(b) || tabNumber(a) - tabNumber(b) || a.pane_id.localeCompare(b.pane_id));
  const screens = await Promise.all(
    panes.map((pane) =>
      call<{ read?: { text?: string } }>("pane.read", { pane_id: pane.pane_id, source: "visible" })
        .then((result) => result.read?.text || "")
        .catch(() => ""),
    ),
  );
  const result: Entry[] = [];
  panes.forEach((pane, index) => {
    const tab = tabs.get(pane.tab_id);
    const spaceLabel = clean(spaces.get(pane.workspace_id || "")?.label) || pane.workspace_id || "";
    const tabLabel = clean(tab?.label) || String(tab?.number ?? pane.tab_id);
    const location = `${spaceLabel} / ${tabLabel}`;
    const seen = new Set<string>();
    for (const raw of screens[index].split("\n")) {
      const line = clean(raw);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      result.push({
        id: `${pane.pane_id}#${result.length}`,
        label: line,
        location,
        status: clean(pane.agent_status) || (pane.agent ? "unknown" : "shell"),
        search: line.toLowerCase(),
        pane,
      });
    }
  });
  return result;
}

function visibleRows(): number {
  return Math.max(1, (process.stdout.rows || 24) - 5);
}

function filter() {
  const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  // grep starts empty: every line of every pane is noise until there's a query.
  shown = words.length ? all.filter((entry) => words.every((word) => entry.search.includes(word))) : mode === "grep" ? [] : all;
  selected = Math.min(selected, Math.max(0, shown.length - 1));
  const rows = visibleRows();
  if (selected < scroll) scroll = selected;
  if (selected >= scroll + rows) scroll = selected - rows + 1;
  scroll = Math.min(scroll, Math.max(0, shown.length - rows));
  render();
}

// Shift a long grep line so its first match sits inside the column.
function around(label: string, width: number): string {
  const word = query.toLowerCase().trim().split(/\s+/u)[0];
  const chars = Array.from(label);
  const at = word ? Array.from(label.toLowerCase().slice(0, Math.max(0, label.toLowerCase().indexOf(word)))).length : 0;
  if (chars.length <= width || at + Array.from(word || "").length < width - 1) return label;
  const start = Math.max(1, Math.min(at - Math.floor(width / 3), chars.length - width + 1));
  return `…${chars.slice(start).join("")}`;
}

function row(entry: Entry, index: number, active: boolean, width: number): string {
  const marker = active ? ">" : " ";
  const number = index < 9 ? String(index + 1) : " ";
  const status = entry.status.padEnd(7).slice(0, 7);
  const locationWidth = Math.min(25, Math.max(0, Math.floor((width - 15) / 3)));
  const labelWidth = Math.max(1, width - locationWidth - 15);
  const label = mode === "grep" ? around(entry.label, labelWidth) : entry.label;
  const line = clip(`${marker}${number} ${status}  ${clip(label, labelWidth).padEnd(labelWidth)}  ${clip(entry.location, locationWidth)}`, width - 1);
  return active ? `\x1b[7m${line.padEnd(width - 1)}\x1b[0m` : line;
}

function render() {
  if (closed) return;
  const width = Math.max(20, process.stdout.columns || 80);
  const height = Math.max(8, process.stdout.rows || 24);
  const rows = visibleRows();
  const count = mode === "grep" ? `${shown.length}/${all.length} lines · ${paneCount} panes`
    : mode === "move" ? `Move ${sourceTabLabel || "tab"} → space · ${shown.length}/${all.length}`
    : `${shown.length}/${all.length} ${mode}`;
  const lines = [
    ` > ${query || (mode === "grep" ? "Type to grep other panes' screens…" : "Type to filter…")}`,
    ` ${message || count}`,
    "",
  ];

  for (let index = scroll; index < Math.min(shown.length, scroll + rows); index += 1) {
    lines.push(row(shown[index], index, index === selected, width));
  }
  if (!shown.length && !loading && (query.trim() || mode !== "grep")) lines.push(" No matches");
  while (lines.length < height - 1) lines.push("");
  lines.push(mode === "grep" ? " ↑↓ move · ⏎ focus pane · ^R re-read"
    : mode === "move" ? (moveUnavailable ? " Move incomplete · esc close and inspect" : " 1-9 send · ⏎ send · esc cancel")
    : " ↑↓ move · ⏎ focus · ^R refresh");
  process.stdout.write(`\x1b[H\x1b[2J${lines.slice(0, height).map((line) => line.includes("\x1b[7m") ? line : clip(line, width - 1)).join("\n")}`);
}

async function load(snapshot: Snapshot | undefined) {
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs)) {
    throw new Error("Herdr returned an invalid snapshot");
  }
  if (mode === "move" && !sourceTabId) {
    const source = snapshot.tabs.find((tab) => tab.tab_id === snapshot.focused_tab_id);
    if (!source) throw new Error("No focused tab to move");
    sourceTabId = source.tab_id;
    sourceWorkspaceId = source.workspace_id || snapshot.focused_workspace_id;
    sourceTabLabel = clean(source.label) || source.tab_id;
  }
  if (mode === "grep") {
    paneCount = (snapshot.panes || []).filter((pane) => !skipPane(pane, snapshot)).length;
    message = `Reading ${paneCount} panes…`;
    render();
    all = await grepEntries(snapshot);
    message = "";
    selected = 0;
    scroll = 0;
    return;
  }
  all = entries(snapshot);
  message = "";
  selected = Math.max(0, current(snapshot));
  scroll = 0;
}

// Start on where I already am: the focused space, or the focused pane's agent
// (else the first agent in the focused tab).
function current(snapshot: Snapshot): number {
  if (mode === "move") return all.findIndex((entry) => entry.id === sourceWorkspaceId);
  if (mode === "spaces") return all.findIndex((entry) => entry.id === snapshot.focused_workspace_id);
  if (mode === "tabs") return all.findIndex((entry) => entry.id === snapshot.focused_tab_id);
  const pane = all.findIndex((entry) => entry.id === snapshot.focused_pane_id);
  return pane >= 0 ? pane : all.findIndex((entry) => entry.agent?.tab_id === snapshot.focused_tab_id);
}

async function refresh() {
  if (loading || busy || closed) return;
  loading = true;
  message = "Loading Herdr…";
  render();
  try {
    await load((await call<{ snapshot?: Snapshot }>("session.snapshot")).snapshot);
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
  if (!target || busy || (mode === "move" && moveUnavailable)) return;
  busy = true;
  if (mode === "move") recordMoveState(true);
  message = mode === "move" ? `Moving to ${target.label}…` : `Focusing ${target.label}…`;
  render();
  try {
    if (mode === "move") {
      if (!sourceTabId || !target.space) throw new Error("No tab or destination selected");
      await moveTabInWorker(sourceTabId, target.space.workspace_id);
    } else if (target.pane) {
      if (target.pane.workspace_id) await call("workspace.focus", { workspace_id: target.pane.workspace_id });
      await call("tab.focus", { tab_id: target.pane.tab_id });
      await call("pane.focus", { pane_id: target.pane.pane_id });
    } else if (target.agent) {
      await call("agent.focus", { target: target.agent.pane_id });
      // Herdr 0.9.0 also needs tab.focus to move the attached client's viewport.
      await call("tab.focus", { tab_id: target.agent.tab_id });
    } else if (target.tab) {
      if (target.tab.workspace_id) await call("workspace.focus", { workspace_id: target.tab.workspace_id });
      await call("tab.focus", { tab_id: target.tab.tab_id });
    } else if (target.space) {
      await call("workspace.focus", { workspace_id: target.space.workspace_id });
    }
    finish();
  } catch (error) {
    if (error instanceof MoveTabError) {
      if (error.recoveredTabId) {
        sourceTabId = error.recoveredTabId;
        sourceWorkspaceId = error.sourceWorkspaceId;
      } else if (error.movedTabId) {
        sourceTabId = error.movedTabId;
        sourceWorkspaceId = error.destinationWorkspaceId;
      }
      moveUnavailable = error.partial === true;
    }
    const detail = error instanceof Error ? error.message : String(error);
    message = mode === "move" && error instanceof MoveTabError ? detail : `${mode === "move" ? "Move" : "Focus"} failed: ${detail}`;
    busy = false;
    if (mode === "move") recordMoveState(false);
    render();
  }
}

// open.sh reads this to make the hotkeys toggle the popup.
const pidfile = `${homedir()}/.cache/herdr-quick-picker.pid`;
function recordMoveState(moving: boolean) {
  try {
    writeFileSync(pidfile, `${process.pid} ${mode}${moving ? " busy" : ""}\n`);
  } catch {}
}
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
  } else if (mode !== "grep" && !key?.ctrl && !key?.meta && text && /^[1-9]$/u.test(text)) {
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
let snapshot: Snapshot | undefined;
if (preloaded) {
  try {
    snapshot = (JSON.parse(preloaded) as { result?: { snapshot?: Snapshot } }).result?.snapshot;
  } catch {}
}
if (!snapshot) {
  render();
  void refresh();
} else {
  // grep still has to read every pane; keystrokes typed meanwhile keep filtering.
  loading = mode === "grep";
  load(snapshot)
    .catch((error) => { message = `Herdr: ${error instanceof Error ? error.message : String(error)}`; })
    .finally(() => { loading = false; filter(); });
}
