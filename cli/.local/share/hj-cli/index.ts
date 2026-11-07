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
  type HerdrAgent,
  type SearchAnswers,
  type Snapshot,
} from "./search";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const HERDR_BIN =
  process.env.HERDR_BIN || process.env.HERDR_BIN_PATH || "herdr";
const MAX_AGENTS = 255;

type AgentListResponse = {
  result?: {
    agents?: HerdrAgent[];
  };
};

type SnapshotResponse = {
  result?: {
    snapshot?: Snapshot;
  };
};

type TypeSafeResponse = {
  answers?: SearchAnswers;
  detail?: unknown;
  error?: unknown;
  message?: unknown;
};

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
    throw new Error(
      `${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
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

export async function loadCandidates(): Promise<Candidate[]> {
  const [agentListText, snapshotText] = await Promise.all([
    run(HERDR_BIN, ["agent", "list"]),
    run(HERDR_BIN, ["api", "snapshot"]),
  ]);
  const agentList = parseJson<AgentListResponse>(agentListText, "herdr agent list");
  const snapshotResponse = parseJson<SnapshotResponse>(
    snapshotText,
    "herdr api snapshot",
  );
  const agents = agentList.result?.agents ?? [];

  if (agents.length > MAX_AGENTS) {
    throw new Error(
      `Found ${agents.length} agents; hj currently supports at most ${MAX_AGENTS}`,
    );
  }

  const transcriptValues = await mapWithConcurrency(agents, 8, async (agent) => {
    try {
      return await run(HERDR_BIN, [
        "agent",
        "read",
        agent.pane_id,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(TRANSCRIPT_LINES),
      ]);
    } catch {
      return "";
    }
  });
  const transcripts = new Map(
    agents.map((agent, index) => [agent.pane_id, transcriptValues[index]]),
  );

  return makeCandidates(
    agents,
    snapshotResponse.result?.snapshot ?? {},
    transcripts,
  );
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
  console.log(`hj — semantically jump to a Herdr agent

Usage:
  hj
  hj <description>

Examples:
  hj
  > autobuilder changes

  hj credential automation

hj reads the last ${TRANSCRIPT_LINES} terminal lines from every live Herdr agent,
uses Jev to find the semantic match, and focuses that agent's pane.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    printHelp();
    return;
  }

  if (process.env.HERDR_ENV !== "1") {
    throw new Error("hj must run inside a Herdr-managed pane");
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
  const candidatesPromise = loadCandidates().catch((error: unknown) => {
    candidatesError = error;
    return [];
  });
  const query = await readQuery(args);
  if (!query) return;

  if (process.stdout.isTTY) process.stdout.write("\x1b[2mFinding agent…\x1b[0m\n");

  const candidates = await candidatesPromise;
  if (candidatesError) throw candidatesError;
  if (candidates.length === 0) throw new Error("No live Herdr agents found");

  const exact = exactMatch(query, candidates);
  const otherCandidates = candidates.filter(
    (candidate) => candidate.paneId !== process.env.HERDR_PANE_ID,
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
    console.error(`No unambiguous live Herdr agent for "${query}".`);
    process.exitCode = 1;
    return;
  }

  await run(HERDR_BIN, ["agent", "focus", selected.paneId]);
  // Herdr 0.9.0 updates server focus for agent.focus without moving attached clients.
  // tab.focus projects the selected tab to the client after the agent pane is chosen.
  await run(HERDR_BIN, ["tab", "focus", selected.tab.id]);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`hj: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
