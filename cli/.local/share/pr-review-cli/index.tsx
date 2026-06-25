#!/usr/bin/env bun

import React, { useCallback, useEffect, useState, type ReactNode } from "react";
import { render, Box, Text, useApp, useInput } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Side = "RIGHT" | "LEFT";

type PendingComment = {
  path: string;
  line?: number; // omitted => file-level comment
  startLine?: number; // present => multi-line range
  side: Side;
  body: string;
};

type Pr = {
  number: number;
  title: string;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
};

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

type Screen =
  | "loading"
  | "menu"
  | "loc"
  | "body"
  | "summary"
  | "remove"
  | "event"
  | "submitting"
  | "done"
  | "fatal";

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

async function gh(
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function fetchPr(target?: string): Promise<Pr> {
  const args = ["pr", "view"];
  if (target) args.push(target);
  args.push(
    "--json",
    "number,title,headRefOid,baseRefName,headRefName",
  );
  const { code, out, err } = await gh(args);
  if (code !== 0) {
    throw new Error(
      (err || out).trim() ||
        "Could not find a PR for this branch. Run `gh pr create` first, or pass a PR number.",
    );
  }
  return JSON.parse(out) as Pr;
}

function toApiComment(c: PendingComment): Record<string, unknown> {
  const base: Record<string, unknown> = { path: c.path, body: c.body };
  if (c.line == null) {
    base.subject_type = "file";
    return base;
  }
  base.side = c.side;
  base.line = c.line;
  if (c.startLine != null) {
    base.start_line = c.startLine;
    base.start_side = c.side;
  }
  return base;
}

async function submitReview(
  pr: Pr,
  event: ReviewEvent,
  summary: string,
  comments: PendingComment[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    commit_id: pr.headRefOid,
    event,
    comments: comments.map(toApiComment),
  };
  if (summary.trim()) payload.body = summary;

  const { code, out, err } = await gh(
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${pr.number}/reviews`,
      "--input",
      "-",
    ],
    JSON.stringify(payload),
  );
  if (code !== 0) {
    throw new Error((err || out).trim() || "gh api failed");
  }
  try {
    const parsed = JSON.parse(out) as { html_url?: string };
    return parsed.html_url ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// "src/foo.tsx:71"      -> { path, line: 71 }
// "src/foo.tsx:71-75"   -> { path, startLine: 71, line: 75 }
// "src/foo.tsx"         -> { path }  (file-level)
function parseLocation(
  raw: string,
): { path: string; line?: number; startLine?: number } | null {
  const s = raw.trim().replace(/^@/, "");
  if (!s) return null;
  const m = s.match(/^(.+?):(\d+)(?:[-:](\d+))?$/);
  if (!m) return { path: s };
  const path = m[1];
  const a = parseInt(m[2], 10);
  const b = m[3] ? parseInt(m[3], 10) : undefined;
  if (b != null && b !== a) {
    return { path, startLine: Math.min(a, b), line: Math.max(a, b) };
  }
  return { path, line: a };
}

function locLabel(c: PendingComment): string {
  if (c.line == null) return `${c.path} (whole file)`;
  if (c.startLine != null) return `${c.path}:${c.startLine}-${c.line}`;
  return `${c.path}:${c.line}`;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// ---------------------------------------------------------------------------
// Reusable components
// ---------------------------------------------------------------------------

type SelectItem = { label: string; value: string; hint?: string };

function Select({
  items,
  onSelect,
  onCancel,
}: {
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel?: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const clamped = Math.min(idx, Math.max(0, items.length - 1));

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") {
      setIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (key.return) {
      const it = items[clamped];
      if (it) onSelect(it.value);
    } else if (key.escape) {
      onCancel?.();
    } else if (/^[1-9]$/.test(input)) {
      const n = parseInt(input, 10) - 1;
      const it = items[n];
      if (it) onSelect(it.value);
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((it, i) => {
        const active = i === clamped;
        return (
          <Text key={it.value} color={active ? "cyan" : undefined}>
            {active ? "❯ " : "  "}
            <Text bold={active}>
              {i + 1}. {it.label}
            </Text>
            {it.hint ? <Text dimColor>  {it.hint}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function TextPrompt({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
      return;
    // Normal typing / paste (paste may arrive as a chunk, possibly with \n).
    if (input) onChange(value + input);
  });

  const lines = value.length ? value.split("\n") : [];

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      {lines.length === 0 ? (
        <Text>
          <Text dimColor>{placeholder ?? ""}</Text>
          <Text color="cyan">▌</Text>
        </Text>
      ) : (
        lines.map((ln, i) => (
          <Text key={i}>
            {ln}
            {i === lines.length - 1 ? <Text color="cyan">▌</Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{children}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App({ target }: { target?: string }) {
  const { exit } = useApp();

  const [screen, setScreen] = useState<Screen>("loading");
  const [pr, setPr] = useState<Pr | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const [comments, setComments] = useState<PendingComment[]>([]);
  const [summary, setSummary] = useState("");

  // drafts for the active input screen
  const [draftLoc, setDraftLoc] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [pendingLoc, setPendingLoc] = useState<{
    path: string;
    line?: number;
    startLine?: number;
  } | null>(null);
  const [locError, setLocError] = useState<string | null>(null);

  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [reviewUrl, setReviewUrl] = useState("");

  useEffect(() => {
    fetchPr(target)
      .then((p) => {
        setPr(p);
        setScreen("menu");
      })
      .catch((e: Error) => {
        setFatal(e.message);
        setScreen("fatal");
      });
  }, [target]);

  const goMenu = useCallback(() => {
    setLocError(null);
    setScreen("menu");
  }, []);

  // ----- loading / fatal -----
  if (screen === "loading") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          pr-review
        </Text>
        <Text dimColor>Loading PR…</Text>
      </Box>
    );
  }

  if (screen === "fatal" || !pr) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          pr-review
        </Text>
        <Text color="red">{fatal ?? "No PR."}</Text>
        <Hint>press q or esc to quit</Hint>
        <QuitOnly onQuit={exit} />
      </Box>
    );
  }

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan" bold>
          #{pr.number}
        </Text>{" "}
        <Text bold>{oneLine(pr.title, 60)}</Text>
      </Text>
      <Text dimColor>
        {pr.headRefName} → {pr.baseRefName} · {comments.length} inline comment
        {comments.length === 1 ? "" : "s"}
        {summary.trim() ? " · summary set" : ""}
      </Text>
    </Box>
  );

  // ----- pending comments panel -----
  const commentsPanel =
    comments.length > 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>
          ── pending comments ──
        </Text>
        {comments.map((c, i) => (
          <Text key={i}>
            <Text color="yellow">{locLabel(c)}</Text>
            <Text dimColor>  {oneLine(c.body, 50)}</Text>
          </Text>
        ))}
      </Box>
    ) : null;

  // ----- menu -----
  if (screen === "menu") {
    const items: SelectItem[] = [
      {
        label: "Add inline comment (file:line)",
        value: "loc",
        hint: "comment on a specific line/range",
      },
      {
        label: summary.trim()
          ? "Edit overall summary"
          : "Add overall summary",
        value: "summary",
      },
    ];
    if (comments.length > 0) {
      items.push({ label: "Remove a comment", value: "remove" });
    }
    if (comments.length > 0 || summary.trim()) {
      items.push({
        label: "Submit review →",
        value: "event",
        hint: "send to GitHub via gh",
      });
    }
    items.push({ label: "Quit", value: "quit" });

    return (
      <Box flexDirection="column" padding={1}>
        {header}
        {commentsPanel}
        <Select
          items={items}
          onSelect={(v) => {
            if (v === "quit") return exit();
            if (v === "loc") {
              setDraftLoc("");
              setLocError(null);
              setScreen("loc");
            } else if (v === "summary") {
              setDraftBody(summary);
              setScreen("summary");
            } else if (v === "remove") {
              setScreen("remove");
            } else if (v === "event") {
              setScreen("event");
            }
          }}
          onCancel={exit}
        />
        <Hint>↑↓ or number to choose · enter to select · esc/q quit</Hint>
      </Box>
    );
  }

  // ----- add inline: location -----
  if (screen === "loc") {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text bold>Where? Paste a location:</Text>
        <Text dimColor>
          e.g. src/components/Foo.tsx:71 · or a range Foo.tsx:71-75 · or just a
          path for a whole-file comment
        </Text>
        <Box marginTop={1}>
          <TextPrompt
            value={draftLoc}
            placeholder="path/to/file.tsx:42"
            onChange={(v) => {
              setDraftLoc(v);
              setLocError(null);
            }}
            onCancel={goMenu}
            onSubmit={(v) => {
              const parsed = parseLocation(v);
              if (!parsed) {
                setLocError("Enter a path (optionally :line).");
                return;
              }
              setPendingLoc(parsed);
              setDraftBody("");
              setScreen("body");
            }}
          />
        </Box>
        {locError ? <Text color="red">{locError}</Text> : null}
        <Hint>enter to continue · esc to cancel</Hint>
      </Box>
    );
  }

  // ----- add inline: body -----
  if (screen === "body" && pendingLoc) {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text bold>
          Comment on{" "}
          <Text color="yellow">
            {pendingLoc.line == null
              ? `${pendingLoc.path} (whole file)`
              : pendingLoc.startLine != null
                ? `${pendingLoc.path}:${pendingLoc.startLine}-${pendingLoc.line}`
                : `${pendingLoc.path}:${pendingLoc.line}`}
          </Text>
        </Text>
        <Box marginTop={1}>
          <TextPrompt
            value={draftBody}
            placeholder="your comment…"
            onChange={setDraftBody}
            onCancel={() => setScreen("loc")}
            onSubmit={(v) => {
              if (!v.trim()) return; // ignore empty submit
              setComments((cs) => [
                ...cs,
                {
                  path: pendingLoc.path,
                  line: pendingLoc.line,
                  startLine: pendingLoc.startLine,
                  side: "RIGHT",
                  body: v.trimEnd(),
                },
              ]);
              setPendingLoc(null);
              setDraftBody("");
              goMenu();
            }}
          />
        </Box>
        <Hint>enter to save · paste keeps newlines · esc to go back</Hint>
      </Box>
    );
  }

  // ----- overall summary -----
  if (screen === "summary") {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text bold>Overall review summary (optional):</Text>
        <Box marginTop={1}>
          <TextPrompt
            value={draftBody}
            placeholder="overall thoughts…"
            onChange={setDraftBody}
            onCancel={goMenu}
            onSubmit={(v) => {
              setSummary(v.trimEnd());
              goMenu();
            }}
          />
        </Box>
        <Hint>enter to save · esc to cancel</Hint>
      </Box>
    );
  }

  // ----- remove a comment -----
  if (screen === "remove") {
    const items: SelectItem[] = comments.map((c, i) => ({
      label: locLabel(c),
      value: String(i),
      hint: oneLine(c.body, 40),
    }));
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text bold>Remove which comment?</Text>
        <Box marginTop={1}>
          <Select
            items={items}
            onSelect={(v) => {
              const idx = parseInt(v, 10);
              setComments((cs) => cs.filter((_, i) => i !== idx));
              goMenu();
            }}
            onCancel={goMenu}
          />
        </Box>
        <Hint>enter to remove · esc to cancel</Hint>
      </Box>
    );
  }

  // ----- choose event + submit -----
  if (screen === "event") {
    const items: SelectItem[] = [
      { label: "Comment", value: "COMMENT", hint: "leave feedback, no verdict" },
      { label: "Approve", value: "APPROVE", hint: "approve the PR" },
      {
        label: "Request changes",
        value: "REQUEST_CHANGES",
        hint: "block until addressed",
      },
    ];
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        {commentsPanel}
        <Text bold>Submit as:</Text>
        <Box marginTop={1}>
          <Select
            items={items}
            onSelect={(v) => {
              setScreen("submitting");
              setSubmitErr(null);
              submitReview(pr, v as ReviewEvent, summary, comments)
                .then((url) => {
                  setReviewUrl(url);
                  setScreen("done");
                })
                .catch((e: Error) => {
                  setSubmitErr(e.message);
                  setScreen("event");
                });
            }}
            onCancel={goMenu}
          />
        </Box>
        {submitErr ? (
          <Box marginTop={1}>
            <Text color="red">Failed: {oneLine(submitErr, 120)}</Text>
          </Box>
        ) : null}
        <Hint>enter to submit · esc to go back</Hint>
      </Box>
    );
  }

  if (screen === "submitting") {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text color="cyan">Submitting review…</Text>
      </Box>
    );
  }

  if (screen === "done") {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text color="green" bold>
          ✓ Review submitted
        </Text>
        {reviewUrl ? <Text dimColor>{reviewUrl}</Text> : null}
        <Hint>press q or esc to quit</Hint>
        <QuitOnly onQuit={exit} />
      </Box>
    );
  }

  return null;
}

function QuitOnly({ onQuit }: { onQuit: () => void }) {
  useInput((input, key) => {
    if (input === "q" || key.escape || key.return) onQuit();
  });
  return null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("pr-review requires an interactive terminal.");
  process.exit(1);
}

const target = process.argv[2];
render(<App target={target} />);
