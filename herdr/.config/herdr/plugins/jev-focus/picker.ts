import { emitKeypressEvents } from "node:readline";
import { buildSearchPayload, metadataMatch, type Candidate, type SearchAnswers } from "../../../../../cli/.local/share/hj-cli/search";
import { loadCandidates } from "../../../../../cli/.local/share/hj-cli/index";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const API_KEY = process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY;
const SOURCE_PANE = process.env.HJ_SOURCE_PANE_ID || "";
const DEBOUNCE_MS = 140;

type Result = { candidate: Candidate; probability: number | null; direct?: boolean };

let candidates: Candidate[] = [];
let results: Result[] = [];
let query = "";
let selected = 0;
let status = "Loading live agents…";
let closed = false;
let sequence = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
let activeRequest: AbortController | undefined;

function shorten(value: string, length: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length <= length ? chars.join("") : `${chars.slice(0, Math.max(0, length - 1)).join("")}…`;
}

function clip(value: string, length: number): string {
  const chars = Array.from(value);
  return chars.length <= length ? value : `${chars.slice(0, Math.max(0, length - 1)).join("")}…`;
}

function initialResults(): Result[] {
  const priority: Record<string, number> = {
    blocked: 0,
    done: 1,
    working: 2,
    idle: 3,
  };
  return [...candidates]
    .sort((a, b) =>
      (priority[a.status] ?? 4) - (priority[b.status] ?? 4) ||
      a.title.localeCompare(b.title),
    )
    .map((candidate) => ({ candidate, probability: null }));
}

function rank(answers: SearchAnswers): Result[] {
  const probabilities = answers.target?.probabilities ?? {};
  const ordered = candidates
    .map((candidate) => ({
      candidate,
      probability: probabilities[candidate.id] ?? 0,
    }))
    .sort((a, b) => b.probability - a.probability)
    .filter((result) => result.probability >= 0.01);
  const direct = metadataMatch(query, candidates);
  if (!direct) return ordered.length > 0 ? ordered : initialResults().slice(0, 1);
  return [
    { candidate: direct, probability: null, direct: true },
    ...ordered.filter((result) => result.candidate.id !== direct.id),
  ];
}

function render() {
  if (closed) return;
  const width = Math.max(40, process.stdout.columns || 80);
  const height = Math.max(10, process.stdout.rows || 24);
  const rowCount = Math.min(results.length, Math.max(1, Math.floor((height - 6) / 2)));
  if (selected >= rowCount) selected = Math.max(0, rowCount - 1);

  const lines = [
    " Find an agent",
    ` > ${shorten(query, width - 5)}${query ? "" : "_"}`,
    ` ${shorten(status, width - 2)}`,
    "",
  ];

  for (let index = 0; index < rowCount; index += 1) {
    const { candidate, probability, direct } = results[index];
    const marker = index === selected ? "›" : " ";
    const score = direct
      ? "name"
      : probability === null
        ? "    "
        : `${Math.round(probability * 100).toString().padStart(3)}%`;
    const title = candidate.name || candidate.title;
    lines.push(
      ` ${marker} ${score}  ${shorten(title, width - 16)}  [${candidate.status}]`,
    );
    const place = `${candidate.workspace.label || candidate.workspace.id} / ${candidate.tab.label || candidate.tab.id}`;
    const description = candidate.name ? `${candidate.title} · ${place}` : place;
    lines.push(`          ${shorten(description, width - 12)}`);
  }

  while (lines.length < height - 1) lines.push("");
  lines.push(" ↑↓ choose  ·  Enter focus  ·  Esc close");
  process.stdout.write(`\x1b[H\x1b[2J${lines.map((line) => clip(line, width - 1)).join("\n")}`);
}

async function search(expectedQuery: string, expectedSequence: number) {
  if (!API_KEY) {
    status = "TypeSafe key is unavailable";
    render();
    return;
  }

  const controller = new AbortController();
  activeRequest = controller;
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildSearchPayload(expectedQuery, candidates)),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    const body = (await response.json()) as {
      answers?: SearchAnswers;
      detail?: string;
    };
    if (!response.ok || !body.answers) {
      throw new Error(body.detail || `TypeSafe HTTP ${response.status}`);
    }
    if (closed || expectedSequence !== sequence) return;
    results = rank(body.answers);
    selected = 0;
    status =
      (body.answers.exists?.noul ?? 0) < 0.25
        ? "No likely match · you can still choose a result"
        : "Jev results";
    render();
  } catch (error) {
    if (closed || expectedSequence !== sequence || controller.signal.aborted) return;
    status = `Jev: ${error instanceof Error ? error.message : String(error)}`;
    render();
  } finally {
    if (activeRequest === controller) activeRequest = undefined;
  }
}

function updateQuery(next: string) {
  query = next;
  sequence += 1;
  if (debounce) clearTimeout(debounce);
  activeRequest?.abort();
  selected = 0;
  if (!query.trim()) {
    results = initialResults();
    status = `${candidates.length} live agents · type to search with Jev`;
  } else {
    const direct = metadataMatch(query, candidates);
    results = direct ? [{ candidate: direct, probability: null, direct: true }] : [];
    status = "Searching Jev…";
    if (candidates.length > 0) {
      const expectedSequence = sequence;
      const expectedQuery = query.trim();
      debounce = setTimeout(
        () => void search(expectedQuery, expectedSequence),
        DEBOUNCE_MS,
      );
    }
  }
  render();
}

async function runHerdr(args: string[]) {
  const child = Bun.spawn([HERDR_BIN, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `herdr ${args.join(" ")} failed`);
}

function finish(code = 0) {
  if (closed) return;
  closed = true;
  if (debounce) clearTimeout(debounce);
  activeRequest?.abort();
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?1049l");
  process.exitCode = code;
}

async function focusSelected() {
  const target = results[selected]?.candidate;
  if (!target) return;
  status = `Focusing ${target.name || target.title}…`;
  render();
  try {
    await runHerdr(["agent", "focus", target.paneId]);
    // Herdr 0.9.0 needs tab.focus to move the attached client's viewport.
    await runHerdr(["tab", "focus", target.tab.id]);
    finish();
  } catch (error) {
    status = `Focus failed: ${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Jev picker needs an interactive terminal");
  process.exit(1);
}

process.stdout.write("\x1b[?1049h");
process.stdin.setRawMode(true);
process.stdin.resume();
emitKeypressEvents(process.stdin);
process.stdin.on("keypress", (text, key) => {
  if (closed) return;
  if (key?.name === "escape" || (key?.ctrl && key.name === "c")) {
    finish();
  } else if (key?.name === "return" || key?.name === "enter") {
    void focusSelected();
  } else if (key?.name === "up") {
    selected = Math.max(0, selected - 1);
    render();
  } else if (key?.name === "down") {
    selected = Math.max(0, Math.min(results.length - 1, selected + 1));
    render();
  } else if (key?.name === "backspace" || key?.name === "delete") {
    updateQuery(Array.from(query).slice(0, -1).join(""));
  } else if (key?.ctrl && key.name === "u") {
    updateQuery("");
  } else if (key?.ctrl && key.name === "w") {
    updateQuery(query.replace(/\s*\S+\s*$/, ""));
  } else if (!key?.ctrl && !key?.meta && text && !/[\x00-\x1f\x7f]/u.test(text)) {
    updateQuery(`${query}${text}`.slice(0, 200));
  }
});
process.stdout.on("resize", render);
render();

try {
  const loaded = await loadCandidates();
  candidates = loaded.filter((candidate) => candidate.paneId !== SOURCE_PANE);
  if (candidates.length === 0) candidates = loaded;
  if (closed) process.exit(0);
  updateQuery(query);
} catch (error) {
  status = `Herdr: ${error instanceof Error ? error.message : String(error)}`;
  render();
}
