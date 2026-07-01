#!/usr/bin/env bun

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";

const SEP = "\x1f";

interface Args {
  socket: string;
  client: string | null;
  refreshMs: number;
}

interface TmuxSession {
  name: string;
  attached: number;
  // Last active window output/activity. This stays stable when merely switching
  // clients, unlike session_activity, which jumps on navigation.
  activity: number;
  created: number;
  cwd: string;
  cwdBase: string;
  command: string;
  title: string;
  task: string;
  busy: boolean;
  waiting: boolean;
  agent: string;
  transcriptTitle: string;
}

interface TmuxClient {
  tty: string;
  session: string;
  activity: number;
}

interface Snapshot {
  sessions: TmuxSession[];
  clients: TmuxClient[];
  targetClient: TmuxClient | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    socket: process.env.TMUX_NAV_SOCKET || "default",
    client: process.env.TMUX_NAV_CLIENT || null,
    refreshMs: 1500,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--socket" || arg === "-L") {
      args.socket = argv[++i] || args.socket;
    } else if (arg.startsWith("--socket=")) {
      args.socket = arg.slice("--socket=".length) || args.socket;
    } else if (arg === "--client" || arg === "-c") {
      args.client = argv[++i] || args.client;
    } else if (arg.startsWith("--client=")) {
      args.client = arg.slice("--client=".length) || args.client;
    } else if (arg === "--refresh-ms") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 250) args.refreshMs = n;
    } else if (arg === "--sort") {
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`tmux-nav

Arc-style tmux session navigator for a narrow terminal pane.

Usage:
  tmux-nav [--socket default] [--client /dev/ttys001]

Keys:
  j/down, k/up  Move selection (supports counts: 5j, 7k)
  Enter         Switch the target tmux client to the selected session
  right         Switch the target tmux client to the selected session
  l             Switch the target tmux client to the selected session
  x             Kill the selected session
  /             Filter sessions
  Esc           Clear filter
  r             Refresh now
  q             Quit

Typical setup:
  1. Put Ghostty in two vertical splits.
  2. In the right split: tmux -L default attach
  3. In the left split:  tmux-nav

When multiple tmux clients are attached, pass --client with the right split's tty.
`);
}

function tmux(socket: string, args: string[]): string {
  const result = spawnSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(stderr || stdout || `tmux exited with status ${result.status}`);
  }

  return result.stdout || "";
}

function cleanTitle(title: string, sessionName: string, command: string, cwdBase: string): string {
  let task = title.replace(/^[^\x00-\x7f]\s*/u, "").trim();
  const commandLooksLikeClaudeVersion = /^\d+\.\d+\.\d+$/.test(command);

  if (
    task === sessionName ||
    task === "zsh" ||
    task === command ||
    task === "Claude Code" ||
    task === "claude" ||
    task === cwdBase ||
    (commandLooksLikeClaudeVersion && task === "Mac")
  ) {
    task = "";
  }

  return task;
}

function agentFor(command: string, claudeSession: string, codexSession: string): string {
  if (codexSession || command === "codex") return "codex";
  if (claudeSession || command === "claude" || /^\d+\.\d+\.\d+$/.test(command)) return "claude";
  return command || "shell";
}

const PROMPT_CURSOR = /❯\s*\d+\.\s/u;
const PROMPT_FOOTER = /(?:to select|↑\/↓|to navigate|Do you want to proceed|Would you like to proceed)/iu;

function isWaitingForClaudeInput(socket: string, name: string): boolean {
  try {
    const pane = tmux(socket, ["capture-pane", "-p", "-S", "-120", "-t", `${name}:0.0`]);
    return PROMPT_CURSOR.test(pane) || PROMPT_FOOTER.test(pane);
  } catch {
    return false;
  }
}

const codexSessionsRoot = `${process.env.HOME}/.codex/sessions`;
const rolloutPathCache = new Map<string, string>();
const rolloutTitleCache = new Map<string, { mtime: number; title: string }>();
let recentRolloutsCache: { expires: number; rows: { path: string; mtime: number }[] } | null = null;

function readHead(path: string, bytes: number): string {
  const size = Math.min(bytes, statSync(path).size);
  if (size <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

function findRolloutByUuid(uuid: string): string | null {
  if (!/^[0-9a-fA-F-]{8,}$/.test(uuid)) return null;
  const cached = rolloutPathCache.get(uuid);
  if (cached && existsSync(cached)) return cached;

  try {
    const glob = new Bun.Glob(`**/rollout-*-${uuid}.jsonl`);
    for (const rel of glob.scanSync(codexSessionsRoot)) {
      const full = `${codexSessionsRoot}/${rel}`;
      rolloutPathCache.set(uuid, full);
      return full;
    }
  } catch {}

  return null;
}

function rolloutCwd(path: string): string {
  try {
    const line1 = readHead(path, 8192).split("\n", 1)[0] ?? "";
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line1);
    return m ? (JSON.parse(`"${m[1]}"`) as string) : "";
  } catch {
    return "";
  }
}

function recentRollouts(): { path: string; mtime: number }[] {
  if (recentRolloutsCache && recentRolloutsCache.expires > Date.now()) return recentRolloutsCache.rows;

  const rows: { path: string; mtime: number }[] = [];
  try {
    const glob = new Bun.Glob("**/rollout-*.jsonl");
    for (const rel of glob.scanSync(codexSessionsRoot)) {
      const path = `${codexSessionsRoot}/${rel}`;
      try {
        rows.push({ path, mtime: statSync(path).mtimeMs });
      } catch {}
    }
  } catch {}

  rows.sort((a, b) => b.mtime - a.mtime);
  recentRolloutsCache = { expires: Date.now() + 5000, rows };
  return rows;
}

function resolveCodexTranscript(cwd: string, uuid: string): string | null {
  if (uuid) return findRolloutByUuid(uuid);
  if (!cwd) return null;
  for (const row of recentRollouts().slice(0, 60)) {
    if (rolloutCwd(row.path) === cwd) return row.path;
  }
  return null;
}

function readCodexTitle(path: string | null): string {
  if (!path) return "";

  try {
    const mtime = statSync(path).mtimeMs;
    const cached = rolloutTitleCache.get(path);
    if (cached && cached.mtime === mtime) return cached.title;

    let title = "";
    for (const line of readHead(path, 256 * 1024).split("\n")) {
      if (!line.includes('"event_msg"') || !line.includes('"user_message"')) continue;
      try {
        const d = JSON.parse(line);
        const msg = d?.payload?.message;
        if (d?.type === "event_msg" && d?.payload?.type === "user_message" && typeof msg === "string") {
          title = msg.replace(/\s+/g, " ").trim().slice(0, 80);
          if (title) break;
        }
      } catch {}
    }

    rolloutTitleCache.set(path, { mtime, title });
    return title;
  } catch {
    return "";
  }
}

function listSessions(socket: string): TmuxSession[] {
  const format = [
    "#{session_name}",
    "#{session_attached}",
    "#{window_activity}",
    "#{session_created}",
    "#{pane_current_path}",
    "#{pane_current_command}",
    "#{pane_title}",
    "#{@claude_session}",
    "#{@codex_session}",
  ].join(SEP);

  const raw = tmux(socket, ["list-sessions", "-F", format]);
  const sessions = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, attached, activity, created, cwd, command, title, claudeSession, codexSession] = line.split(SEP);
      const cwdBase = basename(cwd || "") || cwd || "";
      const agent = agentFor(command || "", claudeSession || "", codexSession || "");
      const busy = /^[\u2800-\u28ff]/u.test(title || "");
      return {
        name,
        attached: Number(attached) || 0,
        activity: Number(activity) || 0,
        created: Number(created) || 0,
        cwd: cwd || "",
        cwdBase,
        command: command || "",
        title: title || "",
        task: cleanTitle(title || "", name, command || "", cwdBase),
        busy,
        waiting: agent === "claude" && !busy && isWaitingForClaudeInput(socket, name),
        agent,
        transcriptTitle:
          agent === "codex" ? readCodexTitle(resolveCodexTranscript(cwd || "", codexSession || "")) : "",
      };
    });

  sessions.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));

  return sessions;
}

function listClients(socket: string): TmuxClient[] {
  const format = ["#{client_tty}", "#{client_session}", "#{client_activity}"].join(SEP);
  try {
    const raw = tmux(socket, ["list-clients", "-F", format]);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [tty, session, activity] = line.split(SEP);
        return { tty, session, activity: Number(activity) || 0 };
      })
      .sort((a, b) => b.activity - a.activity);
  } catch {
    return [];
  }
}

function resolveTargetClient(clients: TmuxClient[], wanted: string | null): TmuxClient | null {
  if (clients.length === 0) return null;
  if (!wanted) return clients[0] || null;

  return (
    clients.find((c) => c.tty === wanted) ||
    clients.find((c) => c.session === wanted) ||
    clients.find((c) => c.tty.endsWith(wanted)) ||
    clients[0] ||
    null
  );
}

function loadSnapshot(args: Args, targetClient: string | null = args.client): Snapshot {
  const sessions = listSessions(args.socket);
  const clients = listClients(args.socket);
  return {
    sessions,
    clients,
    targetClient: resolveTargetClient(clients, targetClient),
  };
}

function switchToSession(socket: string, targetClient: TmuxClient | null, sessionName: string) {
  const args = ["switch-client"];
  if (targetClient) args.push("-c", targetClient.tty);
  args.push("-t", sessionName);
  tmux(socket, args);
}

function killSession(socket: string, sessionName: string) {
  tmux(socket, ["kill-session", "-t", sessionName]);
}

function timeAgo(seconds: number): string {
  if (!seconds) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 86400 / 7)}w`;
}

function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return value.slice(0, max - 1) + "~";
}

function matchesFilter(session: TmuxSession, filter: string): boolean {
  if (!filter.trim()) return true;
  const q = filter.trim().toLowerCase();
  return [session.name, session.task, session.transcriptTitle, session.cwd, session.command, session.agent]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function selectionAfterRemoval(sessions: TmuxSession[], removedName: string): string {
  const idx = sessions.findIndex((session) => session.name === removedName);
  if (idx < 0) return sessions[0]?.name || "";

  const remaining = sessions.filter((session) => session.name !== removedName);
  if (remaining.length === 0) return "";

  return remaining[Math.min(idx, remaining.length - 1)].name;
}

function selectionAfterRefresh(previous: TmuxSession[], current: TmuxSession[], removedName: string): string {
  if (current.length === 0) return "";

  const idx = previous.findIndex((session) => session.name === removedName);
  if (idx < 0) return current[0].name;

  return current[Math.min(idx, current.length - 1)].name;
}

function detailFor(session: TmuxSession): string {
  if (session.task) return session.task;
  if (session.transcriptTitle) return session.transcriptTitle;
  const rawTitle = session.title.replace(/^[^\x00-\x7f]\s*/u, "").trim();
  if (rawTitle && rawTitle !== session.name) return rawTitle;
  if (session.cwdBase) return session.cwdBase;
  if (session.agent === "claude") return "Claude Code";
  return session.command || "untitled";
}

function statusFor(session: TmuxSession): string {
  if (session.busy) return "*";
  if (session.waiting) return "!";
  if (session.agent === "claude") return ".";
  return "-";
}

function rowFor(session: TmuxSession, width: number): string {
  const title = detailFor(session);
  const cwd = session.cwdBase || session.cwd || "-";
  const age = timeAgo(session.activity);
  const bits = [statusFor(session), title];
  if (cwd && cwd !== title) bits.push(cwd);
  if (age) bits.push(age);
  if (session.busy) bits.push("running");
  else if (session.waiting) bits.push("waiting");
  else if (session.attached > 0) bits.push("attached");
  const line = bits.join(" ");
  return truncate(line, Math.max(1, width));
}

function App({ args }: { args: Args }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout.rows || 24;
  const columns = stdout.columns || 36;
  const targetClientRef = useRef<string | null>(args.client);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => {
    try {
      const next = loadSnapshot(args, targetClientRef.current);
      if (!targetClientRef.current && next.targetClient) targetClientRef.current = next.targetClient.tty;
      return next;
    } catch {
      return { sessions: [], clients: [], targetClient: null };
    }
  });
  const [selectedName, setSelectedName] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [countPrefix, setCountPrefix] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      let next = loadSnapshot(args, targetClientRef.current);
      if (
        targetClientRef.current &&
        !next.clients.some((client) => client.tty === targetClientRef.current)
      ) {
        targetClientRef.current = args.client;
        next = loadSnapshot(args, targetClientRef.current);
      }
      if (!targetClientRef.current && next.targetClient) targetClientRef.current = next.targetClient.tty;
      setSnapshot(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [args]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, args.refreshMs);
    return () => clearInterval(timer);
  }, [args.refreshMs, refresh]);

  const activeSession = snapshot.targetClient?.session || "";
  const sessions = useMemo(
    () => snapshot.sessions.filter((session) => matchesFilter(session, filter)),
    [filter, snapshot.sessions],
  );
  const previousSessionsRef = useRef<TmuxSession[]>(sessions);

  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedName("");
    } else if (!sessions.some((session) => session.name === selectedName)) {
      setSelectedName(selectionAfterRefresh(previousSessionsRef.current, sessions, selectedName));
    }
    previousSessionsRef.current = sessions;
  }, [selectedName, sessions]);

  const selectedIndex = Math.max(0, sessions.findIndex((session) => session.name === selectedName));
  const selected = sessions[selectedIndex] || null;

  const switchToName = useCallback(
    (sessionName: string) => {
      try {
        switchToSession(args.socket, snapshot.targetClient, sessionName);
        setSnapshot((current) => ({
          ...current,
          targetClient: current.targetClient
            ? { ...current.targetClient, session: sessionName }
            : current.targetClient,
        }));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [args.socket, snapshot.targetClient],
  );

  const move = useCallback(
    (delta: number) => {
      if (!sessions.length) return;
      const idx = sessions.findIndex((session) => session.name === selectedName);
      const currentIdx = idx < 0 ? 0 : idx;
      const nextIdx = ((currentIdx + delta) % sessions.length + sessions.length) % sessions.length;
      setSelectedName(sessions[nextIdx].name);
    },
    [selectedName, sessions],
  );

  const headerLines = filtering || filter ? 3 : 2;
  const footerLines = error || !snapshot.targetClient ? 2 : 1;
  const maxVisible = Math.max(1, rows - headerLines - footerLines);
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(maxVisible / 2)),
    Math.max(0, sessions.length - maxVisible),
  );
  const visible = sessions.slice(start, start + maxVisible);

  useInput((input, key) => {
    if (filtering) {
      if (key.escape) {
        setFilter("");
        setFiltering(false);
      } else if (key.return) {
        setFiltering(false);
      } else if (key.backspace || key.delete) {
        setFilter((value) => value.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setFilter((value) => value + input);
      }
      return;
    }

    if (input === "q" || (input === "c" && key.ctrl)) {
      exit();
    } else if (/^\d$/.test(input) && !key.ctrl && !key.meta && (countPrefix || input !== "0")) {
      setCountPrefix((value) => `${value}${input}`.slice(0, 4));
    } else if (input === "r") {
      setCountPrefix("");
      refresh();
    } else if (input === "/" || input === "f") {
      setCountPrefix("");
      setFiltering(true);
    } else if (input === "j" || key.downArrow) {
      const count = Number(countPrefix) || 1;
      setCountPrefix("");
      move(count);
    } else if (input === "k" || key.upArrow) {
      const count = Number(countPrefix) || 1;
      setCountPrefix("");
      move(-count);
    } else if (input === "g") {
      setCountPrefix("");
      if (sessions[0]) setSelectedName(sessions[0].name);
    } else if (input === "G") {
      setCountPrefix("");
      if (sessions[sessions.length - 1]) setSelectedName(sessions[sessions.length - 1].name);
    } else if ((key.return || key.rightArrow || input === "l") && selected) {
      setCountPrefix("");
      switchToName(selected.name);
    } else if (input === "x" && selected) {
      setCountPrefix("");
      try {
        const nextSelectedName = selectionAfterRemoval(sessions, selected.name);
        if (selected.name === activeSession && nextSelectedName) {
          switchToSession(args.socket, snapshot.targetClient, nextSelectedName);
          setSnapshot((current) => ({
            ...current,
            targetClient: current.targetClient
              ? { ...current.targetClient, session: nextSelectedName }
              : current.targetClient,
          }));
        }
        killSession(args.socket, selected.name);
        setSelectedName(nextSelectedName);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  });

  const listWidth = Math.max(24, columns);
  const help = "j/k move  enter switch  x kill  / filter  q";

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text bold color="cyan">
          {activeSession || selectedName || "tmux-nav"}
        </Text>
        {(filtering || filter) && (
          <Text color={filtering ? "yellow" : "gray"}>
            filter {filtering ? "> " : ""}{filter || "(none)"}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" height={maxVisible}>
        {visible.length === 0 ? (
          <Text color="gray">{snapshot.sessions.length === 0 ? "No tmux sessions." : "No matches."}</Text>
        ) : (
          visible.map((session) => {
            const active = session.name === activeSession;
            const selectedRow = session.name === selectedName;

            return (
              <Text key={session.name} inverse={selectedRow} color={active ? "cyan" : undefined}>
                {rowFor(session, listWidth - 1)}
              </Text>
            );
          })
        )}
      </Box>

      <Box flexDirection="column">
        {error && <Text color="red">{truncate(error, Math.max(20, listWidth - 1))}</Text>}
        {!snapshot.targetClient && (
          <Text color="yellow">Open a tmux client in another split, or pass --client.</Text>
        )}
        <Text color="gray">{truncate(help, listWidth - 1)}</Text>
      </Box>
    </Box>
  );
}

const args = parseArgs(process.argv.slice(2));
render(<App args={args} />);
