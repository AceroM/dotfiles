export const TRANSCRIPT_LINES = 100;
export const MAX_STATE_TRANSCRIPT_CHARS = 64_000;
export const MIN_TRANSCRIPT_CHARS_PER_AGENT = 256;
export const MAX_TRANSCRIPT_CHARS_PER_AGENT = 8_000;
export const MIN_MATCH_PROBABILITY = 0.25;

export type HerdrAgent = {
  agent: string;
  agent_session?: {
    value?: string;
  };
  agent_status: string;
  cwd?: string;
  focused?: boolean;
  name?: string;
  pane_id: string;
  tab_id: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  workspace_id: string;
};

export type Snapshot = {
  tabs?: Array<{
    label?: string;
    number?: number;
    tab_id: string;
  }>;
  workspaces?: Array<{
    label?: string;
    number?: number;
    workspace_id: string;
  }>;
};

export type Candidate = {
  id: string;
  kind: string;
  name: string | null;
  status: string;
  paneId: string;
  sessionId: string | null;
  title: string;
  cwd: string;
  workspace: {
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
      name: string | null;
      status: string;
      pane_id: string;
      title: string;
      cwd: string;
      workspace: Candidate["workspace"];
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

export function makeCandidates(
  agents: HerdrAgent[],
  snapshot: Snapshot,
  transcripts: Map<string, string>,
): Candidate[] {
  const workspaces = new Map(
    (snapshot.workspaces ?? []).map((workspace) => [
      workspace.workspace_id,
      workspace,
    ]),
  );
  const tabs = new Map(
    (snapshot.tabs ?? []).map((tab) => [tab.tab_id, tab]),
  );
  const charLimit = transcriptCharLimit(agents.length);

  return agents.map((agent, index) => {
    const workspace = workspaces.get(agent.workspace_id);
    const tab = tabs.get(agent.tab_id);

    return {
      id: `agent_${index}`,
      kind: agent.agent,
      name: agent.name ?? null,
      status: agent.agent_status,
      paneId: agent.pane_id,
      sessionId: agent.agent_session?.value ?? null,
      title:
        agent.terminal_title_stripped ??
        agent.terminal_title ??
        agent.name ??
        agent.pane_id,
      cwd: agent.cwd ?? "",
      workspace: {
        id: agent.workspace_id,
        label: workspace?.label ?? null,
        number: workspace?.number ?? null,
      },
      tab: {
        id: agent.tab_id,
        label: tab?.label ?? null,
        number: tab?.number ?? null,
      },
      transcript: tailText(transcripts.get(agent.pane_id) ?? "", charLimit),
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
        name: candidate.name,
        status: candidate.status,
        pane_id: candidate.paneId,
        title: candidate.title,
        cwd: candidate.cwd,
        workspace: candidate.workspace,
        tab: candidate.tab,
        recent_terminal_output: candidate.transcript,
      })),
    },
    questions: {
      target: {
        type: "choice",
        instructions: {
          question:
            "Which live Herdr agent is the user trying to find in `query`?",
          guidance: [
            "Choose the matching agent id from `agents`.",
            "Use semantic meaning, not only exact word overlap.",
            "Prefer an agent whose current task or recent work matches the query; title, workspace, tab, cwd, and recent terminal output are all evidence.",
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
    [candidate.paneId, candidate.name, candidate.title]
      .filter((value): value is string => Boolean(value))
      .some((value) => normalize(value) === needle),
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

  return candidate;
}
