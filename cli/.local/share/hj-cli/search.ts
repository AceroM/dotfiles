export const TRANSCRIPT_LINES = 100;
export const MAX_STATE_TRANSCRIPT_CHARS = 64_000;
export const MIN_TRANSCRIPT_CHARS_PER_AGENT = 256;
export const MAX_TRANSCRIPT_CHARS_PER_AGENT = 8_000;
export const MIN_MATCH_PROBABILITY = 0.25;
export const MIN_TARGET_CONFIDENCE = 0.6;

// One row of `rex-agents --json` (cli/.local/bin/rex-agents). Rex calls a
// space a session, a tab a window and a pane a block. `agent` is empty for a
// pane that runs no agent (rex-agents --all lists those too).
export type RexAgent = {
  agent: string;
  block_id: string;
  cwd?: string;
  focused?: boolean;
  pane?: string;
  pid?: number | null;
  program?: string;
  session?: string;
  session_id: string;
  state?: string;
  tab?: string;
  title?: string;
  window_id: string;
};

// Where each session and tab sits: sessions in `rex ls` order, each session's
// tabs in `rex window ls` order, numbered from 1.
export type Layout = {
  sessions?: Array<{
    label?: string;
    number?: number;
    session_id: string;
  }>;
  tabs?: Array<{
    label?: string;
    number?: number;
    window_id: string;
  }>;
};

export type Candidate = {
  id: string;
  kind: string;
  status: string;
  blockId: string;
  title: string;
  cwd: string;
  session: {
    id: string;
    label: string | null;
    number: number | null;
  };
  tab: {
    id: string;
    label: string | null;
    number: number | null;
  };
  transcript: string;
};

export type SearchPayload = {
  model: "jev-latest";
  state: {
    query: string;
    agents: Array<{
      id: string;
      kind: string;
      status: string;
      block_id: string;
      title: string;
      cwd: string;
      session: Candidate["session"];
      tab: Candidate["tab"];
      recent_terminal_output: string;
    }>;
  };
  questions: {
    target: {
      type: "choice";
      instructions: Record<string, unknown>;
      criteria: Record<string, null>;
    };
    exists: {
      type: "noul";
      instructions: string;
      criteria: {
        true: string;
        false: string;
      };
    };
  };
};

export type SearchAnswers = {
  target?: {
    choice?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
  };
  exists?: {
    noul?: number;
  };
};

export function transcriptCharLimit(agentCount: number): number {
  if (agentCount <= 0) return 0;
  return Math.min(
    MAX_TRANSCRIPT_CHARS_PER_AGENT,
    Math.max(
      MIN_TRANSCRIPT_CHARS_PER_AGENT,
      Math.floor(MAX_STATE_TRANSCRIPT_CHARS / agentCount),
    ),
  );
}

export function tailText(text: string, maxChars: number): string {
  const normalized = text.replaceAll("\r", "").trim();
  if (normalized.length <= maxChars) return normalized;
  return `…\n${normalized.slice(-maxChars)}`;
}

// Rex leaves labels empty rather than absent; either way there is no label.
function label(value: string | undefined): string | null {
  return value ? value : null;
}

export function makeCandidates(
  agents: RexAgent[],
  layout: Layout,
  transcripts: Map<string, string>,
): Candidate[] {
  const sessions = new Map(
    (layout.sessions ?? []).map((session) => [session.session_id, session]),
  );
  const tabs = new Map(
    (layout.tabs ?? []).map((tab) => [tab.window_id, tab]),
  );
  const charLimit = transcriptCharLimit(agents.length);

  return agents.map((agent, index) => {
    const session = sessions.get(agent.session_id);
    const tab = tabs.get(agent.window_id);

    return {
      id: `agent_${index}`,
      kind: agent.agent,
      status: agent.state || "unknown",
      blockId: agent.block_id,
      // The terminal title is the agent's chat title; the pane label is
      // "<dir>  <title>" (pane-labels.lua), the next best thing without one.
      title: agent.title || agent.pane || agent.block_id,
      cwd: agent.cwd ?? "",
      session: {
        id: agent.session_id,
        label: label(agent.session) ?? label(session?.label),
        number: session?.number ?? null,
      },
      tab: {
        id: agent.window_id,
        label: label(agent.tab) ?? label(tab?.label),
        number: tab?.number ?? null,
      },
      transcript: tailText(transcripts.get(agent.block_id) ?? "", charLimit),
    };
  });
}

export function buildSearchPayload(
  query: string,
  candidates: Candidate[],
): SearchPayload {
  const criteria = Object.fromEntries(
    candidates.map((candidate) => [candidate.id, null]),
  );

  return {
    model: "jev-latest",
    state: {
      query,
      agents: candidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        status: candidate.status,
        block_id: candidate.blockId,
        title: candidate.title,
        cwd: candidate.cwd,
        session: candidate.session,
        tab: candidate.tab,
        recent_terminal_output: candidate.transcript,
      })),
    },
    questions: {
      target: {
        type: "choice",
        instructions: {
          question:
            "Which live Rex agent is the user trying to find in `query`?",
          guidance: [
            "Choose the matching agent id from `agents`.",
            "Use semantic meaning, not only exact word overlap.",
            "Prefer an agent whose current task or recent work matches the query; title, session, tab, cwd, and recent terminal output are all evidence.",
            "Treat task synonyms, feature names, files, bugs, and outcomes as useful evidence.",
          ],
        },
        criteria,
      },
      exists: {
        type: "noul",
        instructions:
          "Does at least one live agent in `agents` meaningfully match what the user describes in `query`?",
        criteria: {
          true:
            "At least one agent's task, context, or recent work is a plausible semantic match for the query.",
          false:
            "The query is empty, meaningless, or unrelated to every listed agent.",
        },
      },
    },
  };
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/^\p{Emoji_Presentation}\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function exactMatch(
  query: string,
  candidates: Candidate[],
): Candidate | null {
  const needle = normalize(query);
  if (!needle) return null;

  const matches = candidates.filter((candidate) =>
    [candidate.blockId, candidate.title]
      .filter((value): value is string => Boolean(value))
      .some((value) => normalize(value) === needle),
  );

  return matches.length === 1 ? matches[0] : null;
}

export function metadataMatch(
  query: string,
  candidates: Candidate[],
): Candidate | null {
  const words = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const needle = words(query);
  if (!needle) return null;

  // A ticket session (prod-3083) holds one agent, so its label names that
  // agent the way a tab label does; a shared session like `agents` matches
  // many and so never decides on its own.
  const matches = candidates.filter((candidate) =>
    [candidate.title, candidate.tab.label, candidate.session.label]
      .filter((value): value is string => Boolean(value))
      .some((value) => ` ${words(value)} `.includes(` ${needle} `)),
  );

  return matches.length === 1 ? matches[0] : null;
}

export function selectedCandidate(
  answers: SearchAnswers,
  candidates: Candidate[],
): Candidate | null {
  const exists = answers.exists?.noul;
  if (typeof exists !== "number") {
    throw new Error("TypeSafe response did not include an exists probability");
  }
  if (exists < MIN_MATCH_PROBABILITY) return null;

  const choice = answers.target?.choice;
  if (!choice) {
    throw new Error("TypeSafe response did not include a target choice");
  }

  const candidate = candidates.find((item) => item.id === choice);
  if (!candidate) {
    throw new Error(`TypeSafe selected an unknown agent: ${choice}`);
  }

  const confidence =
    answers.target?.confidence ?? answers.target?.probabilities?.[choice];
  if (typeof confidence === "number" && confidence < MIN_TARGET_CONFIDENCE) {
    return null;
  }

  return candidate;
}
