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
type Snapshot = { agents: Agent[]; workspaces: Space[]; tabs: Tab[] };
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

const herdr = process.env.HERDR_BIN_PATH || "herdr";
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
          label: `${space.number ?? "?"}. ${label}`,
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
  return Math.max(1, (process.stdout.rows || 24) - 6);
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

function row(entry: Entry, active: boolean, width: number): string {
  const marker = active ? ">" : " ";
  const status = entry.status.padEnd(7).slice(0, 7);
  const locationWidth = Math.min(25, Math.max(0, Math.floor((width - 14) / 3)));
  const labelWidth = Math.max(1, width - locationWidth - 14);
  const line = clip(`${marker} ${status}  ${clip(entry.label, labelWidth).padEnd(labelWidth)}  ${clip(entry.location, locationWidth)}`, width - 1);
  return active ? `\x1b[7m${line.padEnd(width - 1)}\x1b[0m` : line;
}

function render() {
  if (closed) return;
  const width = Math.max(20, process.stdout.columns || 80);
  const height = Math.max(8, process.stdout.rows || 24);
  const rows = visibleRows();
  const title = mode === "agents" ? "Agents · attention first" : "Spaces · sidebar order";
  const count = `${shown.length}/${all.length} ${mode}`;
  const lines = [
    ` ${title}`,
    ` > ${query || "Type to filter…"}`,
    ` ${message || count}`,
    "",
  ];

  for (let index = scroll; index < Math.min(shown.length, scroll + rows); index += 1) {
    lines.push(row(shown[index], index === selected, width));
  }
  if (!shown.length && !loading) lines.push(" No matches");
  while (lines.length < height - 1) lines.push("");
  lines.push(" ↑↓ move · PgUp/PgDn scroll · Enter focus · Ctrl-R refresh · Esc close");
  process.stdout.write(`\x1b[H\x1b[2J${lines.slice(0, height).map((line) => line.includes("\x1b[7m") ? line : clip(line, width - 1)).join("\n")}`);
}

async function runHerdr(args: string[]): Promise<string> {
  const child = Bun.spawn([herdr, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `herdr ${args.join(" ")} failed`);
  return stdout;
}

async function refresh() {
  if (loading || busy || closed) return;
  loading = true;
  message = "Loading Herdr…";
  render();
  try {
    const response = JSON.parse(await runHerdr(["api", "snapshot"])) as { result?: { snapshot?: Snapshot } };
    const snapshot = response.result?.snapshot;
    if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs)) {
      throw new Error("Herdr returned an invalid snapshot");
    }
    all = entries(snapshot);
    message = "";
    selected = 0;
    scroll = 0;
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
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  process.exitCode = code;
}

async function focusSelected() {
  const target = shown[selected];
  if (!target || busy) return;
  busy = true;
  message = `Focusing ${target.label}…`;
  render();
  try {
    if (target.agent) {
      await runHerdr(["agent", "focus", target.agent.pane_id]);
      // Herdr 0.9.0 also needs tab.focus to move the attached client's viewport.
      await runHerdr(["tab", "focus", target.agent.tab_id]);
    } else if (target.space) {
      await runHerdr(["workspace", "focus", target.space.workspace_id]);
    }
    finish();
  } catch (error) {
    message = `Focus failed: ${error instanceof Error ? error.message : String(error)}`;
    busy = false;
    render();
  }
}

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
  } else if (key?.name === "up" || key?.name === "down" || key?.name === "pageup" || key?.name === "pagedown" || key?.name === "home" || key?.name === "end") {
    const page = visibleRows();
    const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -page : page;
    selected = key.name === "home" ? 0 : key.name === "end" ? shown.length - 1 : selected + delta;
    selected = Math.max(0, Math.min(shown.length - 1, selected));
    filter();
  } else if (key?.ctrl && key.name === "r") {
    void refresh();
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
render();
void refresh();
