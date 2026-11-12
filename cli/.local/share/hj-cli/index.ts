#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import {
  buildSearchPayload,
  exactMatch,
  makeCandidates,
  metadataMatch,
  selectedCandidate,
  TRANSCRIPT_LINES,
  type Candidate,
  type Layout,
  type RexAgent,
  type SearchAnswers,
} from "./search";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const REX_BIN = process.env.REX_BIN || "rex";
// Rex has no agent registry of its own; rex-agents (cli/.local/bin) builds one
// from every pane's foreground program and the state agents report (OSC 7501).
const REX_AGENTS_BIN = process.env.REX_AGENTS_BIN || "rex-agents";
const MAX_AGENTS = 255;

type SessionList = {
  sessions?: Array<{ session_id: string; label?: string }>;
};

type WindowList = {
  windows?: Array<{ window_id: string; label?: string }>;
};

type TypeSafeResponse = {
  answers?: SearchAnswers;
  detail?: unknown;
  error?: unknown;
  message?: unknown;
};

class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

async function run(command: string, args: string[]): Promise<string> {
  let processHandle: Bun.Subprocess;
  try {
    processHandle = Bun.spawn([command, ...args], {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`Could not start ${command}: ${errorMessage(error)}`);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  if (exitCode !== 0) {
    // rex prints its failures as "Error: …".
    const reason = stderr.trim().replace(/^Error:\s*/, "") || `exit ${exitCode}`;
    throw new CommandError(`${command} ${args.join(" ")} failed: ${reason}`, reason);
  }

  return stdout;
}

function parseJson<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${source} returned invalid JSON`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function apiError(body: TypeSafeResponse | string, status: number): string {
  if (typeof body === "string") return body || `HTTP ${status}`;
  const detail = body.detail ?? body.error ?? body.message;
  if (typeof detail === "string") return detail;
  if (detail !== undefined) return JSON.stringify(detail);
  return `HTTP ${status}`;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 5_000);
  return 300 * 2 ** attempt;
}

async function askTypeSafe(
  query: string,
  candidates: Candidate[],
  apiKey: string,
): Promise<SearchAnswers> {
  const payload = buildSearchPayload(query, candidates);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    let body: TypeSafeResponse | string = text;
    try {
      body = JSON.parse(text) as TypeSafeResponse;
    } catch {
      // Keep the raw response for a useful error below.
    }

    if (response.ok) {
      const answers = typeof body === "string" ? undefined : body.answers;
      if (!answers) throw new Error("TypeSafe response did not include answers");
      return answers;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await Bun.sleep(retryDelay(response, attempt));
      continue;
    }

    throw new Error(`TypeSafe request failed: ${apiError(body, response.status)}`);
  }

  throw new Error("TypeSafe request failed after retries");
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      runWorker,
    ),
  );
  return results;
}

// Session and tab positions, for the numbers the sidebar shows. Only evidence
// for the model ("the agent in tab 3"), so a session that fails to list just
// goes without numbers.
async function loadLayout(): Promise<Layout> {
  const sessionList = parseJson<SessionList>(
    await run(REX_BIN, ["ls", "--json"]),
    "rex ls",
  );
  const sessions = (sessionList.sessions ?? []).map((session, index) => ({
    session_id: session.session_id,
    label: session.label,
    number: index + 1,
  }));
  const windowLists = await Promise.all(
    sessions.map(async (session) => {
      try {
        const text = await run(REX_BIN, [
          "window",
          "ls",
          "-s",
          session.session_id,
          "--json",
        ]);
        return parseJson<WindowList>(text, "rex window ls").windows ?? [];
      } catch {
        return [];
      }
    }),
  );
  const tabs = windowLists.flatMap((windows) =>
    windows.map((window, index) => ({
      window_id: window.window_id,
      label: window.label,
      number: index + 1,
    })),
  );
  return { sessions, tabs };
}

// The last TRANSCRIPT_LINES lines of a pane, soft wraps joined. An agent in
// the alternate screen (Claude Code's) has no scrollback, so this is its screen.
async function readTranscript(agent: RexAgent): Promise<string> {
  const text = await run(REX_BIN, [
    "capture",
    "-s",
    agent.session_id,
    "-b",
    agent.block_id,
    "--trim",
    "--unwrap",
  ]);
  return text.split("\n").slice(-TRANSCRIPT_LINES).join("\n");
}

export type Loaded = {
  candidates: Candidate[];
  // The tab hj itself runs in, when rex-agents can see it.
  ownWindowId: string | null;
};

export async function loadCandidates(): Promise<Loaded> {
  // --all: hj's own pane is no agent, but its row says which tab hj is in.
  const [paneText, layout] = await Promise.all([
    run(REX_AGENTS_BIN, ["--all", "--json"]),
    loadLayout(),
  ]);
  const panes = parseJson<RexAgent[]>(paneText, "rex-agents --all --json");
  const ownWindowId =
    panes.find((pane) => pane.block_id === process.env.REX_BLOCK)?.window_id ??
    null;
  const agents = panes.filter((pane) => Boolean(pane.agent));

  if (agents.length > MAX_AGENTS) {
    throw new Error(
      `Found ${agents.length} agents; hj currently supports at most ${MAX_AGENTS}`,
    );
  }

  const transcriptValues = await mapWithConcurrency(agents, 8, async (agent) => {
    try {
      return await readTranscript(agent);
    } catch {
      return "";
    }
  });
  const transcripts = new Map(
    agents.map((agent, index) => [agent.block_id, transcriptValues[index]]),
  );

  return {
    candidates: makeCandidates(agents, layout, transcripts),
    ownWindowId,
  };
}

function where(candidate: Candidate): string {
  const session = candidate.session.label ?? candidate.session.id;
  const tab = candidate.tab.label ?? candidate.tab.id;
  return `${session}/${tab}`;
}

// `rex block focus` makes the agent the focused pane of its tab and that tab
// its session's active one. The app keeps its own selected session and tab, so
// it also has to be asked to show them, and from the CLI that ask
// (`rex do session.select`) only goes through with Remote Control on in
// Rex.app (Settings → Rex Server). Within hj's own tab the first step is enough.
async function focusAgent(candidate: Candidate, ownWindowId: string | null) {
  await run(REX_BIN, [
    "block",
    "focus",
    "-s",
    candidate.session.id,
    candidate.blockId,
  ]);
  if (candidate.tab.id === ownWindowId) return;
  try {
    await run(REX_BIN, [
      "do",
      "session.select",
      `session_id=${candidate.session.id}`,
      `window_id=${candidate.tab.id}`,
    ]);
  } catch (error) {
    const reason = error instanceof CommandError ? error.stderr : errorMessage(error);
    throw new Error(
      `${where(candidate)} is focused in Rex, but the app didn't switch to it: ${reason}`,
    );
  }
}

async function readQuery(args: string[]): Promise<string> {
  if (args.length > 0) return args.join(" ").trim();

  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await readline.question("> ")).trim();
  } finally {
    readline.close();
  }
}

function printHelp() {
  console.log(`hj — semantically jump to a Rex agent

Usage:
  hj
  hj <description>

Examples:
  hj
  > autobuilder changes

  hj credential automation

hj reads the last ${TRANSCRIPT_LINES} terminal lines from every live agent pane in Rex
(rex-agents), uses Jev to find the semantic match, and focuses that agent's pane.
Switching the Rex app to another session or tab needs Remote Control on in
Rex.app (Settings → Rex Server); without it hj focuses the pane and says where.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    printHelp();
    return;
  }

  if (!process.env.REX_SESSION) {
    throw new Error("hj must run inside a Rex pane (REX_SESSION is unset)");
  }

  const apiKey =
    process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "TYPESAFE_AI_API_KEY is not set (TYPESAFE_API_KEY also works)",
    );
  }

  // Start collecting agent context while the user types.
  let candidatesError: unknown;
  const loadedPromise = loadCandidates().catch((error: unknown): Loaded => {
    candidatesError = error;
    return { candidates: [], ownWindowId: null };
  });
  const query = await readQuery(args);
  if (!query) return;

  if (process.stdout.isTTY) process.stdout.write("\x1b[2mFinding agent…\x1b[0m\n");

  const { candidates, ownWindowId } = await loadedPromise;
  if (candidatesError) throw candidatesError;
  if (candidates.length === 0) throw new Error("No live Rex agents found");

  const exact = exactMatch(query, candidates);
  const otherCandidates = candidates.filter(
    (candidate) => candidate.blockId !== process.env.REX_BLOCK,
  );
  const selected =
    exact ??
    metadataMatch(query, otherCandidates) ??
    (otherCandidates.length > 0
      ? selectedCandidate(
          await askTypeSafe(query, otherCandidates, apiKey),
          otherCandidates,
        )
      : null);

  if (!selected) {
    console.error(`No unambiguous live Rex agent for "${query}".`);
    process.exitCode = 1;
    return;
  }

  await focusAgent(selected, ownWindowId);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`hj: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
