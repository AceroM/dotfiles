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
  type HerdrAgent,
} from "./search";

const candidates: Candidate[] = [
  {
    id: "agent_0",
    kind: "codex",
    name: null,
    status: "idle",
    paneId: "w1:p1",
    sessionId: "session-1",
    title: "Check Autobuilder browser steps | service.4",
    cwd: "/repo/service.4",
    workspace: { id: "w1", label: "autobuilder", number: 1 },
    tab: { id: "w1:t1", label: "browser", number: 1 },
    transcript: "Investigating why autobuilder batch 126 was cancelled.",
  },
  {
    id: "agent_1",
    kind: "claude",
    name: "credential-check",
    status: "working",
    paneId: "w1:p2",
    sessionId: "session-2",
    title: "Verify credential runner",
    cwd: "/repo/service",
    workspace: { id: "w1", label: "autobuilder", number: 1 },
    tab: { id: "w1:t2", label: "credentials", number: 2 },
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
  test("uses an exact title, pane id, or assigned name without inference", () => {
    expect(exactMatch("w1:p1", candidates)?.id).toBe("agent_0");
    expect(exactMatch("credential-check", candidates)?.id).toBe("agent_1");
    expect(
      exactMatch("Check Autobuilder browser steps | service.4", candidates)
        ?.id,
    ).toBe("agent_0");
    expect(exactMatch("autobuilder", candidates)).toBeNull();
  });

  test("finds a unique name or tab label without relying on transcript mentions", () => {
    expect(metadataMatch("credential", candidates)?.id).toBe("agent_1");
    expect(metadataMatch("browser", candidates)?.id).toBe("agent_0");
    expect(
      metadataMatch("nebraska", [
        ...candidates,
        { ...candidates[0], id: "agent_2", name: "sst_nebraska" },
      ])?.id,
    ).toBe("agent_2");
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

    expect(selected?.paneId).toBe("w1:p2");
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

describe("Herdr context", () => {
  test("combines agent metadata, workspace labels, and recent output", () => {
    const agents: HerdrAgent[] = [
      {
        agent: "codex",
        agent_session: { value: "session-1" },
        agent_status: "idle",
        cwd: "/repo",
        pane_id: "w2:p3",
        tab_id: "w2:t4",
        terminal_title_stripped: "A useful task",
        workspace_id: "w2",
      },
    ];
    const result = makeCandidates(
      agents,
      {
        workspaces: [{ workspace_id: "w2", label: "tax", number: 2 }],
        tabs: [{ tab_id: "w2:t4", label: "filing", number: 4 }],
      },
      new Map([["w2:p3", "latest terminal context"]]),
    );

    expect(result[0]).toMatchObject({
      id: "agent_0",
      paneId: "w2:p3",
      sessionId: "session-1",
      title: "A useful task",
      workspace: { label: "tax" },
      tab: { label: "filing" },
      transcript: "latest terminal context",
    });
  });

  test("keeps the newest transcript content within Jev's state budget", () => {
    expect(transcriptCharLimit(1)).toBe(MAX_TRANSCRIPT_CHARS_PER_AGENT);
    expect(tailText("123456789", 5)).toBe("…\n56789");
  });
});
