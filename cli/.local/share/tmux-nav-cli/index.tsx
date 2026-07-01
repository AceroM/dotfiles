#!/usr/bin/env bun

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
  claudeSession: string;
}

interface TmuxClient {
  tty: string;
  session: string;
  activity: number;
  // Whether this client's terminal pane currently has keyboard focus (requires
  // `focus-events on`, which reports focus in/out from the terminal emulator).
  focused: boolean;
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
  J/K           Jump to next/previous busy or waiting session
  a             Toggle auto-switch after j/k navigation
  Enter         Switch the target tmux client to the selected session (and focus its split)
  right         Switch the target tmux client to the selected session (and focus its split)
  l             Switch the target tmux client to the selected session (and focus its split)
  c             Spawn a new claude session in the selected session's directory
  C             Spawn a new codex session in the selected session's directory
  b             Branch: new claude prefilled to look at the selected claude session's transcript
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
const claudeProjectsRoot = `${process.env.HOME}/.claude/projects`;
const rolloutPathCache = new Map<string, string>();
const rolloutTitleCache = new Map<string, { mtime: number; title: string }>();
const claudeTranscriptPathCache = new Map<string, string>();
const claudeTranscriptTitleCache = new Map<string, { mtime: number; title: string }>();
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

function findClaudeTranscriptByUuid(uuid: string): string | null {
  if (!/^[0-9a-fA-F-]{8,}$/.test(uuid)) return null;
  const cached = claudeTranscriptPathCache.get(uuid);
  if (cached && existsSync(cached)) return cached;

  try {
    const glob = new Bun.Glob(`**/${uuid}.jsonl`);
    for (const rel of glob.scanSync(claudeProjectsRoot)) {
      const full = `${claudeProjectsRoot}/${rel}`;
      claudeTranscriptPathCache.set(uuid, full);
      return full;
    }
  } catch {}

  return null;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function cleanTranscriptTitle(value: string): string {
  const commandArgs = /<command-args>([\s\S]*?)<\/command-args>/i.exec(value)?.[1] || "";
  return (commandArgs || value)
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, " ")
    .replace(/<local-command-[^>]+>[\s\S]*?<\/local-command-[^>]+>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function readClaudeTitle(path: string | null): string {
  if (!path) return "";

  try {
    const mtime = statSync(path).mtimeMs;
    const cached = claudeTranscriptTitleCache.get(path);
    if (cached && cached.mtime === mtime) return cached.title;

    let title = "";
    for (const line of readHead(path, 256 * 1024).split("\n")) {
      if (!line.includes('"type":"user"')) continue;
      try {
        const d = JSON.parse(line);
        if (d?.type !== "user" || d?.isMeta || d?.isSidechain) continue;
        const text = cleanTranscriptTitle(messageText(d?.message?.content));
        if (text) {
          title = text;
          break;
        }
      } catch {}
    }

    claudeTranscriptTitleCache.set(path, { mtime, title });
    return title;
  } catch {
    return "";
  }
}

// ---- Agent usage footer -----------------------------------------------------
// Per agent: rate-limit windows when on a subscription, else an estimated dollar
// spend over trailing day / week / month windows from local token usage. Neither
// agent records a dollar figure — only token counts — so the cost is an estimate
// against a static price table. To keep it cheap despite a month of transcripts,
// each file's per-date cost is cached by mtime, so only files that grew since the
// last scan are re-parsed (see estimateClaudeCost / estimateCodexCost).

interface UsageWindow {
  used_percentage: number;
}
interface CostWindows {
  day: number;
  week: number;
  month: number;
}
interface AgentUsage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  // Estimated spend; null when the agent is on a subscription (windows shown).
  cost: CostWindows | null;
}
interface UsageSummary {
  claude: AgentUsage;
  codex: AgentUsage;
}
interface Price {
  input: number; // $/Mtok, uncached input
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

function claudePrice(model: string): Price {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 };
  if (m.includes("haiku")) return { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 };
  return { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 }; // sonnet / default
}

// Codex token_count events don't carry the model; price with a gpt-5-class
// default (OpenAI bills no separate cache-creation charge).
const CODEX_PRICE: Price = { input: 1.25, output: 10, cacheRead: 0.125, cacheCreate: 0 };

function finiteNum(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

function normWindow(win: unknown): UsageWindow | null {
  if (!win || typeof win !== "object") return null;
  const o = win as Record<string, unknown>;
  const used = finiteNum(o.used_percentage ?? o.used_percent);
  return used == null ? null : { used_percentage: used };
}

// Local calendar date (YYYY-MM-DD) for a unix-ms timestamp. ISO date strings
// compare lexicographically, so window membership is a string comparison.
function localDateStr(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Inclusive start dates for the day (today), week (last 7 days) and month
// (last 30 days) windows.
function windowStartDates(): { today: string; weekStart: string; monthStart: string } {
  const now = Date.now();
  return {
    today: localDateStr(now),
    weekStart: localDateStr(now - 6 * 864e5),
    monthStart: localDateStr(now - 29 * 864e5),
  };
}

function sumWindows(daily: Map<string, number>): CostWindows {
  const { today, weekStart, monthStart } = windowStartDates();
  const cost: CostWindows = { day: 0, week: 0, month: 0 };
  for (const [date, c] of daily) {
    if (date < monthStart) continue;
    cost.month += c;
    if (date >= weekStart) cost.week += c;
    if (date === today) cost.day += c;
  }
  return cost;
}

function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const startAt = Math.max(0, size - bytes);
  const len = size - startAt;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, startAt);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

// Claude subscription windows live in ~/.claude/rate-limits.json (written by the
// statusline hook). Absent/empty ⇒ the account is API-billed.
function readClaudeWindows(): { five: UsageWindow | null; seven: UsageWindow | null } {
  try {
    const path = `${process.env.HOME}/.claude/rate-limits.json`;
    if (!existsSync(path)) return { five: null, seven: null };
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { five: normWindow(raw?.five_hour), seven: normWindow(raw?.seven_day) };
  } catch {
    return { five: null, seven: null };
  }
}

// Codex windows come from the newest rollout's latest token_count event carrying
// rate_limits. None found ⇒ API-billed.
function readCodexWindows(): { five: UsageWindow | null; seven: UsageWindow | null } {
  for (const row of recentRollouts().slice(0, 30)) {
    let tail: string;
    try {
      tail = readTail(row.path, 512 * 1024);
    } catch {
      continue;
    }
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) continue;
      try {
        const d = JSON.parse(line);
        const p = d?.payload;
        const limits = p?.rate_limits;
        if (p?.type !== "token_count" || !limits) continue;
        return { five: normWindow(limits.primary), seven: normWindow(limits.secondary) };
      } catch {}
    }
  }
  return { five: null, seven: null };
}

// Per-file cost bucketed by local date, keyed by mtime so only files that grew
// since the last scan are re-parsed. Keyed by absolute path; entries are cheap
// (a few dates each) and never invalidated — a changed mtime just replaces one.
const claudeDailyCache = new Map<string, { mtime: number; daily: Map<string, number> }>();
const codexDailyCache = new Map<string, { mtime: number; daily: Map<string, number> }>();

function parseClaudeDaily(path: string): Map<string, number> {
  const daily = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return daily;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== "assistant") continue;
    const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const u = d.message?.usage;
    if (!u) continue;
    const p = claudePrice(d.message?.model ?? "");
    const inp = finiteNum(u.input_tokens) ?? 0;
    const out = finiteNum(u.output_tokens) ?? 0;
    const cr = finiteNum(u.cache_read_input_tokens) ?? 0;
    const cc = finiteNum(u.cache_creation_input_tokens) ?? 0;
    const c = (inp * p.input + out * p.output + cr * p.cacheRead + cc * p.cacheCreate) / 1e6;
    const date = localDateStr(ts);
    daily.set(date, (daily.get(date) ?? 0) + c);
  }
  return daily;
}

function parseCodexDaily(path: string): Map<string, number> {
  const daily = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return daily;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.payload?.type !== "token_count") continue;
    const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    // last_token_usage is that turn's delta; summing deltas per date ≈ per-day spend.
    const last = d.payload?.info?.last_token_usage;
    if (!last) continue;
    const input = finiteNum(last.input_tokens) ?? 0;
    const cached = finiteNum(last.cached_input_tokens) ?? 0;
    const output = finiteNum(last.output_tokens) ?? 0;
    const uncached = Math.max(0, input - cached);
    const c = (uncached * CODEX_PRICE.input + cached * CODEX_PRICE.cacheRead + output * CODEX_PRICE.output) / 1e6;
    const date = localDateStr(ts);
    daily.set(date, (daily.get(date) ?? 0) + c);
  }
  return daily;
}

// Walk the transcripts once (cold), then only re-parse files whose mtime changed.
// Files whose newest byte predates the month window are skipped outright.
function estimateCost(
  root: string,
  pattern: string,
  cache: Map<string, { mtime: number; daily: Map<string, number> }>,
  parse: (path: string) => Map<string, number>,
): CostWindows {
  const monthStart = windowStartDates().monthStart;
  const total: CostWindows = { day: 0, week: 0, month: 0 };
  try {
    for (const rel of new Bun.Glob(pattern).scanSync(root)) {
      const path = `${root}/${rel}`;
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (localDateStr(mtime) < monthStart) continue; // last touched before the window
      let entry = cache.get(path);
      if (!entry || entry.mtime !== mtime) {
        entry = { mtime, daily: parse(path) };
        cache.set(path, entry);
      }
      const w = sumWindows(entry.daily);
      total.day += w.day;
      total.week += w.week;
      total.month += w.month;
    }
  } catch {}
  return total;
}

const estimateClaudeCost = (): CostWindows =>
  estimateCost(claudeProjectsRoot, "**/*.jsonl", claudeDailyCache, parseClaudeDaily);
const estimateCodexCost = (): CostWindows =>
  estimateCost(codexSessionsRoot, "**/rollout-*.jsonl", codexDailyCache, parseCodexDaily);

let usageCache: { at: number; data: UsageSummary } | null = null;

// Recomputed at most every 15s. Cost is only estimated for an agent with no
// subscription windows (API-billed); the per-file cache keeps recomputes cheap
// after the one-time cold scan, so subscription users never pay it at all.
function loadUsage(): UsageSummary {
  const now = Date.now();
  if (usageCache && now - usageCache.at < 15_000) return usageCache.data;

  const claudeWin = readClaudeWindows();
  const codexWin = readCodexWindows();
  const data: UsageSummary = {
    claude: {
      five_hour: claudeWin.five,
      seven_day: claudeWin.seven,
      cost: claudeWin.five || claudeWin.seven ? null : estimateClaudeCost(),
    },
    codex: {
      five_hour: codexWin.five,
      seven_day: codexWin.seven,
      cost: codexWin.five || codexWin.seven ? null : estimateCodexCost(),
    },
  };
  usageCache = { at: now, data };
  return data;
}

function formatUsageLine(name: string, u: AgentUsage): string | null {
  if (u.five_hour || u.seven_day) {
    const parts: string[] = [];
    if (u.five_hour) parts.push(`5hr ${Math.round(u.five_hour.used_percentage)}%`);
    if (u.seven_day) parts.push(`1w ${Math.round(u.seven_day.used_percentage)}%`);
    return `${name}: ${parts.join(" | ")}`;
  }
  if (u.cost) {
    const c = u.cost;
    return `${name}: 1d $${c.day.toFixed(2)} | 1w $${c.week.toFixed(2)} | 1m $${c.month.toFixed(2)}`;
  }
  return null;
}

// ---- Admin API (org usage, cross-machine) -----------------------------------
// When ANTHROPIC_ADMIN_API_KEY is set, prefer the org Usage Report over local
// transcript scanning for Claude: it aggregates this user's key usage across all
// machines. The Cost Report returns real USD but only groups by workspace /
// description (no per-user breakdown), so on a shared org it can't isolate one
// person — instead we price the authoritative per-key token counts ourselves
// (same approach as the `ms` shell helper). Filtered to the user's keys by name.

const ADMIN_BASE = "https://api.anthropic.com/v1";

// Which person's keys to sum. Keys are named `claude_code_key_<who>_<rand>`.
function adminWho(): string {
  return (process.env.TMUX_NAV_USAGE_WHO || "miguel").toLowerCase();
}
function keyGroupName(name: string): string {
  return name.match(/^claude_code_key_(.+)_[a-z]{4}$/)?.[1] ?? name;
}

async function adminApiKeyNames(key: string): Promise<Map<string, string>> {
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const map = new Map<string, string>();
  let after: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after_id", after);
    const res = await fetch(`${ADMIN_BASE}/organizations/api_keys?${params}`, { headers });
    if (!res.ok) throw new Error(`api_keys ${res.status}`);
    const j: any = await res.json();
    for (const k of j.data ?? []) map.set(k.id, k.name ?? k.id);
    if (!j.has_more || !j.last_id) break;
    after = j.last_id;
  }
  return map;
}

// Fetch this user's Claude token usage for the trailing 30 days and price it into
// day/week/month windows. Returns null when no admin key is configured.
async function fetchAdminClaudeCost(): Promise<CostWindows | null> {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!key) return null;
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };

  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 29);
  start.setUTCHours(0, 0, 0, 0);
  const params = new URLSearchParams({
    bucket_width: "1d",
    starting_at: start.toISOString(),
    ending_at: now.toISOString(),
    limit: "31",
  });
  params.append("group_by[]", "api_key_id");
  params.append("group_by[]", "model");

  const nameMap = await adminApiKeyNames(key);
  const who = adminWho();

  const daily = new Map<string, number>();
  let page: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const url = `${ADMIN_BASE}/organizations/usage_report/messages?${params}${page ? `&page=${page}` : ""}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`usage_report ${res.status}`);
    const j: any = await res.json();
    for (const bucket of j.data ?? []) {
      const date = typeof bucket.starting_at === "string" ? bucket.starting_at.slice(0, 10) : "";
      if (!date) continue;
      for (const r of bucket.results ?? []) {
        const name = r.api_key_id ? nameMap.get(r.api_key_id) ?? "" : "";
        if (!keyGroupName(name).toLowerCase().includes(who)) continue;
        const p = claudePrice(r.model ?? "");
        const inp = finiteNum(r.uncached_input_tokens) ?? 0;
        const out = finiteNum(r.output_tokens) ?? 0;
        const cr = finiteNum(r.cache_read_input_tokens) ?? 0;
        const cc =
          (finiteNum(r.cache_creation?.ephemeral_1h_input_tokens) ?? 0) +
          (finiteNum(r.cache_creation?.ephemeral_5m_input_tokens) ?? 0);
        const c = (inp * p.input + out * p.output + cr * p.cacheRead + cc * p.cacheCreate) / 1e6;
        daily.set(date, (daily.get(date) ?? 0) + c);
      }
    }
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return sumWindows(daily);
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
          agent === "codex"
            ? readCodexTitle(resolveCodexTranscript(cwd || "", codexSession || ""))
            : agent === "claude"
              ? readClaudeTitle(findClaudeTranscriptByUuid(claudeSession || ""))
              : "",
        claudeSession: claudeSession || "",
      };
    });

  sessions.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));

  return sessions;
}

function listClients(socket: string): TmuxClient[] {
  const format = ["#{client_tty}", "#{client_session}", "#{client_activity}", "#{client_flags}"].join(SEP);
  try {
    const raw = tmux(socket, ["list-clients", "-F", format]);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [tty, session, activity, flags] = line.split(SEP);
        return {
          tty,
          session,
          activity: Number(activity) || 0,
          focused: (flags || "").split(",").includes("focused"),
        };
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

// Move keyboard focus from this (tmux-nav) split to the terminal split after a
// commit action (Enter / spawn). tmux-nav runs as a plain process in its own
// Ghostty split, so switch-client only re-points what the *other* split is
// attached to — focus stays here. Ghostty 1.3.x exposes no IPC to trigger
// goto_split from a child, and tmux can't move focus across Ghostty splits
// (separate PTYs), so we synthesize its default `super+]` (goto_split:next)
// keybind via macOS System Events. Requires granting Ghostty Accessibility
// permission (first use prompts). Opt out with TMUX_NAV_NO_FOCUS=1; change the
// key with TMUX_NAV_FOCUS_KEY (default "]", e.g. "[" for goto_split:previous).
function focusOtherSplit() {
  if (process.platform !== "darwin" || process.env.TMUX_NAV_NO_FOCUS) return;
  const key = process.env.TMUX_NAV_FOCUS_KEY || "]";
  try {
    spawnSync(
      "osascript",
      ["-e", `tell application "System Events" to keystroke "${key}" using command down`],
      { stdio: "ignore" },
    );
  } catch {}
}

function spawnAgentSession(
  agent: "claude" | "codex",
  socket: string,
  targetClient: TmuxClient | null,
  cwd: string,
  // When set (claude only), the new session's input is prefilled with this text
  // but NOT submitted, so the user can finish the prompt before sending.
  prompt: string = "",
) {
  if (!cwd) throw new Error("Selected session has no current directory");

  const helper =
    agent === "claude"
      ? {
          source: "$HOME/.config/zsh/claude.zsh",
          fn: "_claude_new_here",
        }
      : {
          source: "$HOME/.config/zsh/codex.zsh",
          fn: "_codex_new_here",
        };

  // Only claude's helper accepts a prefill prompt (4th arg).
  const call =
    agent === "claude"
      ? `${helper.fn} "$TMUX_NAV_SELECTED_CWD" "$TMUX_NAV_TARGET_CLIENT" "$TMUX_NAV_SOCKET" "$TMUX_NAV_PROMPT"`
      : `${helper.fn} "$TMUX_NAV_SELECTED_CWD" "$TMUX_NAV_TARGET_CLIENT" "$TMUX_NAV_SOCKET"`;

  const result = spawnSync(
    "zsh",
    [
      "-lc",
      [
        "source $HOME/.config/zsh/variables.zsh",
        `source ${helper.source}`,
        call,
      ].join("; "),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TMUX_NAV_SELECTED_CWD: cwd,
        TMUX_NAV_TARGET_CLIENT: targetClient?.tty || "",
        TMUX_NAV_SOCKET: socket,
        TMUX_NAV_PROMPT: prompt,
      },
    },
  );

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(stderr || stdout || `${agent} launcher exited with status ${result.status}`);
  }
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
  const bits = [statusFor(session), title];
  if (cwd && cwd !== title) bits.push(cwd);
  if (session.busy) bits.push("running");
  else if (session.waiting) bits.push("waiting");
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
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [adminCost, setAdminCost] = useState<CostWindows | null>(null);

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
      setUsage(loadUsage());
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

  // Poll the Admin API for authoritative Claude spend (across machines) when a
  // key is configured; it overrides the local estimate in the footer. Network,
  // so it runs off the render loop on a slow cadence and fails quietly.
  useEffect(() => {
    if (!process.env.ANTHROPIC_ADMIN_API_KEY) return;
    let cancelled = false;
    const run = () => {
      fetchAdminClaudeCost()
        .then((cost) => {
          if (!cancelled && cost) setAdminCost(cost);
        })
        .catch(() => {});
    };
    run();
    const timer = setInterval(run, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
      // On first open (no prior selection) land on the focused/attached session
      // so it reads as selected+focused (green) right away; otherwise keep the
      // cursor's position across refreshes/removals.
      const preferActive = selectedName === "" && sessions.some((s) => s.name === activeSession);
      setSelectedName(
        preferActive ? activeSession : selectionAfterRefresh(previousSessionsRef.current, sessions, selectedName),
      );
    }
    previousSessionsRef.current = sessions;
  }, [activeSession, selectedName, sessions]);

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

  const spawnForSelected = useCallback(
    (agent: "claude" | "codex", session: TmuxSession, prompt: string = "") => {
      try {
        spawnAgentSession(agent, args.socket, snapshot.targetClient, session.cwd, prompt);
        const next = loadSnapshot(args, targetClientRef.current);
        if (!targetClientRef.current && next.targetClient) targetClientRef.current = next.targetClient.tty;
        setSnapshot(next);
        setSelectedName(next.targetClient?.session || session.name);
        setError(null);
        focusOtherSplit();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [args, snapshot.targetClient],
  );

  const move = useCallback(
    (delta: number): string | null => {
      if (!sessions.length) return null;
      const idx = sessions.findIndex((session) => session.name === selectedName);
      const currentIdx = idx < 0 ? 0 : idx;
      const nextIdx = ((currentIdx + delta) % sessions.length + sessions.length) % sessions.length;
      const nextName = sessions[nextIdx].name;
      setSelectedName(nextName);
      return nextName;
    },
    [selectedName, sessions],
  );

  // Jump to the next/previous session that is in progress (busy) or needs
  // action (waiting), wrapping around the list.
  const moveToAttention = useCallback(
    (delta: number): string | null => {
      if (!sessions.length) return null;
      const idx = sessions.findIndex((session) => session.name === selectedName);
      const currentIdx = idx < 0 ? 0 : idx;
      for (let step = 1; step <= sessions.length; step++) {
        const nextIdx = (((currentIdx + step * delta) % sessions.length) + sessions.length) % sessions.length;
        const candidate = sessions[nextIdx];
        if (candidate.busy || candidate.waiting) {
          setSelectedName(candidate.name);
          return candidate.name;
        }
      }
      return null;
    },
    [selectedName, sessions],
  );

  // Admin-API spend supersedes the local estimate for API-billed Claude.
  const claudeAgent =
    usage && adminCost && !(usage.claude.five_hour || usage.claude.seven_day)
      ? { ...usage.claude, cost: adminCost }
      : usage?.claude ?? null;
  const usageLines =
    usage && claudeAgent
      ? ([formatUsageLine("claude", claudeAgent), formatUsageLine("codex", usage.codex)].filter(
          Boolean,
        ) as string[])
      : [];
  const headerLines = filtering || filter ? 3 : 2;
  const footerLines = (error || !snapshot.targetClient ? 2 : 1) + usageLines.length;
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

    if (key.escape) {
      setCountPrefix("");
      setFilter("");
      return;
    }

    if (input === "q" || (input === "c" && key.ctrl)) {
      exit();
    } else if (/^\d$/.test(input) && !key.ctrl && !key.meta && (countPrefix || input !== "0")) {
      setCountPrefix((value) => `${value}${input}`.slice(0, 4));
    } else if (input === "r") {
      setCountPrefix("");
      refresh();
    } else if (input === "a") {
      setCountPrefix("");
      setAutoSwitch((value) => !value);
    } else if (input === "/" || input === "f") {
      setCountPrefix("");
      setFiltering(true);
    } else if (input === "j" || key.downArrow) {
      const count = Number(countPrefix) || 1;
      setCountPrefix("");
      const nextName = move(count);
      if (autoSwitch && nextName) switchToName(nextName);
    } else if (input === "k" || key.upArrow) {
      const count = Number(countPrefix) || 1;
      setCountPrefix("");
      const nextName = move(-count);
      if (autoSwitch && nextName) switchToName(nextName);
    } else if (input === "J") {
      setCountPrefix("");
      const nextName = moveToAttention(1);
      if (autoSwitch && nextName) switchToName(nextName);
    } else if (input === "K") {
      setCountPrefix("");
      const nextName = moveToAttention(-1);
      if (autoSwitch && nextName) switchToName(nextName);
    } else if (input === "g") {
      setCountPrefix("");
      const first = sessions[0];
      if (first) {
        setSelectedName(first.name);
        if (autoSwitch) switchToName(first.name);
      }
    } else if (input === "G") {
      setCountPrefix("");
      const last = sessions[sessions.length - 1];
      if (last) {
        setSelectedName(last.name);
        if (autoSwitch) switchToName(last.name);
      }
    } else if ((key.return || key.rightArrow || input === "l") && selected) {
      setCountPrefix("");
      setFilter("");
      switchToName(selected.name);
      focusOtherSplit();
    } else if (input === "c" && selected) {
      setCountPrefix("");
      setFilter("");
      spawnForSelected("claude", selected);
    } else if (input === "C" && selected) {
      setCountPrefix("");
      setFilter("");
      spawnForSelected("codex", selected);
    } else if (input === "b" && selected) {
      // Branch: spawn a fresh claude in the same dir, prefilled with a pointer to
      // the selected session's transcript so it can pick up context on demand
      // without inheriting the whole (expensive) chat history.
      setCountPrefix("");
      setFilter("");
      if (selected.claudeSession) {
        spawnForSelected("claude", selected, `Look at claude session id ${selected.claudeSession}, `);
      } else {
        setError("Selected session has no claude session to branch from");
      }
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
  const help = `j/k move${autoSwitch ? "+switch" : ""}  J/K jump  c claude  C codex  b branch  enter switch  x kill  / filter  q`;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text bold color="cyan">
          {activeSession || selectedName || "tmux-nav"}{autoSwitch ? " [auto]" : ""}
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
            const selectedRow = session.name === selectedName;
            const width = Math.max(1, listWidth - 1);
            const line = truncate(rowFor(session, width).padEnd(width, " "), width);

            return (
              <Text key={session.name} inverse={selectedRow}>
                {line}
              </Text>
            );
          })
        )}
      </Box>

      <Box flexDirection="column">
        {usageLines.map((line, i) => (
          <Text key={`usage-${i}`} color="cyan" dimColor>
            {truncate(line, listWidth - 1)}
          </Text>
        ))}
        {error && <Text color="red">{truncate(error, Math.max(20, listWidth - 1))}</Text>}
        <Text color="gray">{truncate(help, listWidth - 1)}</Text>
      </Box>
    </Box>
  );
}

const args = parseArgs(process.argv.slice(2));
render(<App args={args} />);
