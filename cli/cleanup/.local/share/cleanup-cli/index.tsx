#!/usr/bin/env bun

import React, {
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PR = {
  number: number;
  title: string;
  createdAt: string;
  url: string;
  isDraft: boolean;
};

type Issue = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  teamId: string;
};

type Item =
  | { kind: "pr"; key: string; data: PR }
  | { kind: "linear"; key: string; data: Issue };

type ItemStatus = "idle" | "closing" | "closed" | "error";

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchPRs(): Promise<PR[]> {
  const proc = Bun.spawn([
    "gh",
    "pr",
    "list",
    "--author",
    "@me",
    "--json",
    "number,title,createdAt,url,isDraft",
    "--limit",
    "50",
  ]);
  const text = await new Response(proc.stdout).text();
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function fetchIssues(): Promise<Issue[]> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return [];

  const query = `{
    viewer {
      assignedIssues(
        filter: { state: { type: { nin: ["completed", "cancelled"] } } }
        first: 50
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          state { name }
          team { id }
        }
      }
    }
  }`;

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query }),
  });

  const json = (await res.json()) as any;
  return (json.data?.viewer?.assignedIssues?.nodes ?? []).map((n: any) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    state: n.state.name,
    teamId: n.team.id,
  }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function closePR(
  number: number,
  deleteBranch: boolean,
): Promise<void> {
  const args = ["gh", "pr", "close", String(number)];
  if (deleteBranch) args.push("--delete-branch");
  const proc = Bun.spawn(args);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`gh pr close exited ${code}`);
}

async function cancelIssue(issueId: string, teamId: string): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("LINEAR_API_KEY not set");

  const headers = {
    "Content-Type": "application/json",
    Authorization: apiKey,
  };

  const stateRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `query ($teamId: String!) {
        workflowStates(
          filter: { team: { id: { eq: $teamId } }, type: { eq: "cancelled" } }
          first: 1
        ) { nodes { id } }
      }`,
      variables: { teamId },
    }),
  });

  const stateJson = (await stateRes.json()) as any;
  const cancelledStateId =
    stateJson.data?.workflowStates?.nodes?.[0]?.id;
  if (!cancelledStateId) throw new Error("Could not find cancelled state");

  const updateRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `mutation ($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
      }`,
      variables: { issueId, stateId: cancelledStateId },
    }),
  });

  const updateJson = (await updateRes.json()) as any;
  if (!updateJson.data?.issueUpdate?.success)
    throw new Error("Failed to cancel issue");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function Header({ deleteBranch }: { deleteBranch: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        cleanup
      </Text>
      <Text dimColor>Tidy up Linear tickets & GitHub PRs</Text>
      <Box gap={1}>
        <Text dimColor>
          ↑↓ navigate · space select · a all · n none · enter close · d
          branches{" "}
        </Text>
        <Text color={deleteBranch ? "red" : "gray"}>
          {deleteBranch ? "ON" : "off"}
        </Text>
        <Text dimColor> · q quit</Text>
      </Box>
    </Box>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Box marginTop={1} marginBottom={0}>
      <Text bold dimColor>
        ── {children} ──
      </Text>
    </Box>
  );
}

function ItemRow({
  item,
  active,
  selected,
  status,
  width,
}: {
  item: Item;
  active: boolean;
  selected: boolean;
  status: ItemStatus;
  width: number;
}) {
  const cursor = active ? "❯" : " ";
  const check =
    status === "closed"
      ? "✓"
      : status === "closing"
        ? "⋯"
        : status === "error"
          ? "✗"
          : selected
            ? "◉"
            : "○";
  const checkColor =
    status === "closed"
      ? "green"
      : status === "closing"
        ? "yellow"
        : status === "error"
          ? "red"
          : selected
            ? "yellow"
            : "gray";

  const titleMax = Math.max(20, width - 30);

  if (item.kind === "pr") {
    const { number, title, isDraft, createdAt } = item.data;
    return (
      <Box>
        <Text color={active ? "cyan" : undefined}>{cursor} </Text>
        <Text color={checkColor}>{check} </Text>
        <Text color={isDraft ? "gray" : "blue"} bold>
          {isDraft ? "DRAFT" : "PR"}{" "}
        </Text>
        <Text dimColor>#{number} </Text>
        <Text
          color={status === "closed" ? "green" : undefined}
          strikethrough={status === "closed"}
        >
          {truncate(title, titleMax)}
        </Text>
        <Text dimColor> {timeAgo(createdAt)}</Text>
      </Box>
    );
  }

  const { identifier, title, state } = item.data;
  return (
    <Box>
      <Text color={active ? "cyan" : undefined}>{cursor} </Text>
      <Text color={checkColor}>{check} </Text>
      <Text color="magenta" bold>
        LIN{" "}
      </Text>
      <Text dimColor>{identifier} </Text>
      <Text
        color={status === "closed" ? "green" : undefined}
        strikethrough={status === "closed"}
      >
        {truncate(title, titleMax)}
      </Text>
      <Text dimColor> {state}</Text>
    </Box>
  );
}

function Footer({
  selectedCount,
  closedCount,
  total,
  viewport,
  rows,
}: {
  selectedCount: number;
  closedCount: number;
  total: number;
  viewport: number;
  rows: number;
}) {
  const scroll =
    total > rows
      ? ` · ${viewport + 1}–${Math.min(viewport + rows, total)} of ${total}`
      : "";
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {selectedCount} selected · {closedCount} closed{scroll}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const termRows = (stdout?.rows ?? 24) - 10;

  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Map<string, ItemStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    Promise.all([fetchPRs(), fetchIssues()])
      .then(([prs, issues]) => {
        const all: Item[] = [
          ...prs.map(
            (pr) => ({ kind: "pr", key: `pr-${pr.number}`, data: pr }) as Item,
          ),
          ...issues.map(
            (issue) =>
              ({
                kind: "linear",
                key: `lin-${issue.identifier}`,
                data: issue,
              }) as Item,
          ),
        ];
        setItems(all);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const closeSelected = useCallback(async () => {
    const toClose = items.filter((item) => selected.has(item.key));
    for (const item of toClose) {
      setStatuses((prev) => new Map(prev).set(item.key, "closing"));
      try {
        if (item.kind === "pr") {
          await closePR(item.data.number, deleteBranch);
        } else {
          await cancelIssue(item.data.id, item.data.teamId);
        }
        setStatuses((prev) => new Map(prev).set(item.key, "closed"));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(item.key);
          return next;
        });
      } catch {
        setStatuses((prev) => new Map(prev).set(item.key, "error"));
      }
    }
  }, [items, selected, deleteBranch]);

  useInput((input, key) => {
    if (loading) return;

    if (input === "q") {
      exit();
      return;
    }

    if (key.upArrow) {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        setViewport((v) => (next < v ? next : v));
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setCursor((c) => {
        const next = Math.min(items.length - 1, c + 1);
        setViewport((v) => (next >= v + termRows ? next - termRows + 1 : v));
        return next;
      });
      return;
    }

    if (input === " ") {
      const item = items[cursor];
      if (!item || statuses.get(item.key) === "closed") return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
      return;
    }

    if (input === "a") {
      setSelected(
        new Set(
          items
            .filter((i) => statuses.get(i.key) !== "closed")
            .map((i) => i.key),
        ),
      );
      return;
    }

    if (input === "n") {
      setSelected(new Set());
      return;
    }

    if (input === "d") {
      setDeleteBranch((prev) => !prev);
      return;
    }

    if (key.return && selected.size > 0) {
      closeSelected();
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Header deleteBranch={false} />
        <Text>Loading PRs and issues…</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Header deleteBranch={false} />
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Header deleteBranch={false} />
        <Text color="green">Nothing to clean up!</Text>
      </Box>
    );
  }

  const prs = items.filter((i) => i.kind === "pr");
  const issues = items.filter((i) => i.kind === "linear");
  const closedCount = [...statuses.values()].filter(
    (s) => s === "closed",
  ).length;

  const allVisible = items.slice(viewport, viewport + termRows);

  const firstVisibleLinearIdx = allVisible.findIndex(
    (i) => i.kind === "linear",
  );
  const showPrHeader = allVisible.some((i) => i.kind === "pr");
  const showLinearHeader =
    firstVisibleLinearIdx !== -1 && issues.length > 0;

  return (
    <Box flexDirection="column">
      <Header deleteBranch={deleteBranch} />

      {showPrHeader && (
        <SectionLabel>
          GitHub PRs ({prs.length})
        </SectionLabel>
      )}

      {allVisible.map((item, i) => {
        const globalIdx = viewport + i;
        const parts: ReactNode[] = [];

        if (
          showLinearHeader &&
          item.kind === "linear" &&
          (i === 0 || allVisible[i - 1]?.kind === "pr")
        ) {
          parts.push(
            <SectionLabel key={`sec-${i}`}>
              Linear Issues ({issues.length})
            </SectionLabel>,
          );
        }

        parts.push(
          <ItemRow
            key={item.key}
            item={item}
            active={globalIdx === cursor}
            selected={selected.has(item.key)}
            status={statuses.get(item.key) ?? "idle"}
            width={termWidth}
          />,
        );

        return <React.Fragment key={item.key}>{parts}</React.Fragment>;
      })}

      <Footer
        selectedCount={selected.size}
        closedCount={closedCount}
        total={items.length}
        viewport={viewport}
        rows={termRows}
      />
    </Box>
  );
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("cleanup requires an interactive terminal.");
  process.exit(1);
}

render(<App />);
