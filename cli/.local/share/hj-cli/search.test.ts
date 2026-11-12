import { describe, expect, test } from "bun:test";
import {
  buildSearchPayload,
  exactMatch,
  makeCandidates,
  MAX_TRANSCRIPT_CHARS_PER_AGENT,
  MIN_MATCH_PROBABILITY,
  metadataMatch,
  selectedCandidate,
  tailText,
  transcriptCharLimit,
  type Candidate,
  type RexAgent,
} from "./search";

const candidates: Candidate[] = [
  {
    id: "agent_0",
    kind: "codex",
    status: "idle",
    blockId: "block:p1",
    title: "Check Autobuilder browser steps | service.4",
    cwd: "/repo/service.4",
    session: { id: "session:s1", label: "agents", number: 1 },
    tab: { id: "window:t1", label: "browser", number: 1 },
    transcript: "Investigating why autobuilder batch 126 was cancelled.",
  },
  {
    id: "agent_1",
    kind: "claude",
    status: "working",
    blockId: "block:p2",
    title: "Verify credential runner",
    cwd: "/repo/service",
    session: { id: "session:s1", label: "agents", number: 1 },
    tab: { id: "window:t2", label: "credential_check", number: 2 },
    transcript: "Running the credential automation end to end.",
  },
];

describe("search payload", () => {
  test("asks a Choice and a no-match Noul over every candidate", () => {
    const payload = buildSearchPayload("autobuilder changes", candidates);

    expect(payload.model).toBe("jev-latest");
    expect(payload.state.query).toBe("autobuilder changes");
    expect(payload.state.agents).toHaveLength(2);
    expect(payload.state.agents[0].recent_terminal_output).toContain("batch 126");
    expect(payload.questions.target.criteria).toEqual({
      agent_0: null,
      agent_1: null,
    });
    expect(payload.questions.exists.type).toBe("noul");
  });
});

describe("candidate selection", () => {
  test("uses an exact title or block id without inference", () => {
    expect(exactMatch("block:p1", candidates)?.id).toBe("agent_0");
    expect(exactMatch("Verify credential runner", candidates)?.id).toBe("agent_1");
    expect(
      exactMatch("Check Autobuilder browser steps | service.4", candidates)
        ?.id,
    ).toBe("agent_0");
    expect(exactMatch("autobuilder", candidates)).toBeNull();
  });

  test("finds a unique title, tab or session label without relying on transcript mentions", () => {
    expect(metadataMatch("credential check", candidates)?.id).toBe("agent_1");
    expect(metadataMatch("browser", candidates)?.id).toBe("agent_0");
    expect(
      metadataMatch("nebraska", [
        ...candidates,
        {
          ...candidates[0],
          id: "agent_2",
          tab: { id: "window:t3", label: "sst_nebraska", number: 3 },
        },
      ])?.id,
    ).toBe("agent_2");
    // A ticket session holds one agent, so its label names it…
    expect(
      metadataMatch("prod-3083", [
        ...candidates,
        {
          ...candidates[1],
          id: "agent_2",
          session: { id: "session:s2", label: "prod-3083", number: 2 },
        },
      ])?.id,
    ).toBe("agent_2");
    // …while a session every agent shares decides nothing.
    expect(metadataMatch("agents", candidates)).toBeNull();
    expect(
      metadataMatch("browser", [
        ...candidates,
        { ...candidates[1], id: "agent_2", tab: candidates[0].tab },
      ]),
    ).toBeNull();
  });

  test("returns Jev's candidate for a plausible match", () => {
    const selected = selectedCandidate(
      {
        target: { choice: "agent_1", confidence: 0.8 },
        exists: { noul: 0.9 },
      },
      candidates,
    );

    expect(selected?.blockId).toBe("block:p2");
  });

  test("does not jump when Jev says no agent matches", () => {
    const selected = selectedCandidate(
      {
        target: { choice: "agent_0", confidence: 0.9 },
        exists: { noul: MIN_MATCH_PROBABILITY - 0.01 },
      },
      candidates,
    );

    expect(selected).toBeNull();
  });

  test("does not jump on a low-confidence semantic guess", () => {
    expect(
      selectedCandidate(
        {
          target: { choice: "agent_0", confidence: 0.45 },
          exists: { noul: 0.94 },
        },
        candidates,
      ),
    ).toBeNull();
  });

  test("rejects an unknown choice", () => {
    expect(() =>
      selectedCandidate(
        {
          target: { choice: "agent_99" },
          exists: { noul: 0.9 },
        },
        candidates,
      ),
    ).toThrow("unknown agent");
  });
});

describe("Rex context", () => {
  test("combines rex-agents rows, session and tab positions, and recent output", () => {
    const agents: RexAgent[] = [
      {
        agent: "codex",
        block_id: "block:p3",
        cwd: "/repo",
        pane: "~/repo  A useful task",
        session: "tax",
        session_id: "session:s2",
        state: "idle",
        tab: "filing",
        title: "A useful task",
        window_id: "window:t4",
      },
    ];
    const result = makeCandidates(
      agents,
      {
        sessions: [{ session_id: "session:s2", label: "tax", number: 2 }],
        tabs: [{ window_id: "window:t4", label: "filing", number: 4 }],
      },
      new Map([["block:p3", "latest terminal context"]]),
    );

    expect(result[0]).toMatchObject({
      id: "agent_0",
      kind: "codex",
      status: "idle",
      blockId: "block:p3",
      title: "A useful task",
      session: { id: "session:s2", label: "tax", number: 2 },
      tab: { id: "window:t4", label: "filing", number: 4 },
      transcript: "latest terminal context",
    });
  });

  test("falls back to the pane label and an unknown state", () => {
    const [candidate] = makeCandidates(
      [
        {
          agent: "claude",
          block_id: "block:p5",
          pane: "~/repo",
          session: "",
          session_id: "session:s3",
          tab: "",
          title: "",
          window_id: "window:t6",
        },
      ],
      {},
      new Map(),
    );

    expect(candidate).toMatchObject({
      status: "unknown",
      title: "~/repo",
      session: { label: null, number: null },
      tab: { label: null, number: null },
      transcript: "",
    });
  });

  test("keeps the newest transcript content within Jev's state budget", () => {
    expect(transcriptCharLimit(1)).toBe(MAX_TRANSCRIPT_CHARS_PER_AGENT);
    expect(tailText("123456789", 5)).toBe("…\n56789");
  });
});
