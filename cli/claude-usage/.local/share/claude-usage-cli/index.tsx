#!/usr/bin/env bun

import React, { useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UsageResult = {
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  } | null;
  output_tokens: number;
  model: string;
  api_key_id: string;
};

type UsageBucket = {
  starting_at: string;
  ending_at: string;
  results: UsageResult[];
};

type UsageResponse = {
  data: UsageBucket[];
  has_more: boolean;
  next_page: string | null;
};

type ApiKey = {
  id: string;
  name: string;
  status: string;
};

type ApiKeysResponse = {
  data: ApiKey[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
};

type DailyUsage = {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost: number;
};

type LeaderboardEntry = {
  group_name: string;
  key_names: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost: number;
  daily: DailyUsage[];
};

type TimeRange = "daily" | "weekly" | "monthly" | "yearly" | "overall";

const TIME_RANGES: TimeRange[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "overall",
];

function rangeDays(range: TimeRange): number {
  switch (range) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
    case "yearly":
      return 365;
    case "overall":
      return 365;
  }
}

function rangeLabel(range: TimeRange): string {
  switch (range) {
    case "daily":
      return "today";
    case "weekly":
      return "last 7 days";
    case "monthly":
      return "last 30 days";
    case "yearly":
      return "last 365 days";
    case "overall":
      return "all time (365d)";
  }
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

type ModelPricing = {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
};

function pricingForModel(model: string): ModelPricing {
  const m = model.toLowerCase();

  if (m.includes("opus")) {
    return { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 };
  }
  if (m.includes("haiku")) {
    return { input: 0.8, output: 4, cache_read: 0.08, cache_creation: 1 };
  }
  // Sonnet / default
  return { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 };
}

function tokenCost(result: UsageResult): number {
  const p = pricingForModel(result.model ?? "");
  const cacheCreation =
    (result.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
    (result.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  return (
    (result.uncached_input_tokens * p.input +
      result.output_tokens * p.output +
      result.cache_read_input_tokens * p.cache_read +
      cacheCreation * p.cache_creation) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Name grouping
// ---------------------------------------------------------------------------

const CLAUDE_CODE_KEY_RE = /^claude_code_key_(.+)_[a-z]{4}$/;

function extractGroupName(keyName: string): string {
  const m = keyName.match(CLAUDE_CODE_KEY_RE);
  if (m) return m[1];
  return keyName;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const BASE = "https://api.anthropic.com/v1";

function apiHeaders(apiKey: string) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

async function fetchUsage(
  apiKey: string,
  days: number,
): Promise<UsageBucket[]> {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days);

  const params = new URLSearchParams({
    bucket_width: "1d",
    "group_by[]": "api_key_id",
    starting_at: start.toISOString(),
    ending_at: now.toISOString(),
    limit: "31",
  });

  const allBuckets: UsageBucket[] = [];
  let page: string | null = null;
  let guard = 0;

  while (guard++ < 50) {
    const url = `${BASE}/organizations/usage_report/messages?${params}${page ? `&page=${page}` : ""}`;
    const res = await fetch(url, { headers: apiHeaders(apiKey) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Usage API ${res.status}: ${body}`);
    }
    const json = (await res.json()) as UsageResponse;
    allBuckets.push(...json.data);
    if (!json.has_more || !json.next_page) break;
    page = json.next_page;
  }

  return allBuckets;
}

async function fetchApiKeys(apiKey: string): Promise<ApiKey[]> {
  const all: ApiKey[] = [];
  let afterId: string | null = null;
  let guard = 0;

  while (guard++ < 50) {
    const params = new URLSearchParams({ limit: "100" });
    if (afterId) params.set("after_id", afterId);
    const url = `${BASE}/organizations/api_keys?${params}`;
    const res = await fetch(url, { headers: apiHeaders(apiKey) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API Keys ${res.status}: ${body}`);
    }
    const json = (await res.json()) as ApiKeysResponse;
    all.push(...json.data);
    if (!json.has_more || !json.last_id) break;
    afterId = json.last_id;
  }

  return all;
}

function buildLeaderboard(
  buckets: UsageBucket[],
  apiKeys: ApiKey[],
): LeaderboardEntry[] {
  const nameMap = new Map(apiKeys.map((k) => [k.id, k.name]));

  type RawEntry = {
    keyName: string;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    total: number;
    cost: number;
    daily: Map<string, DailyUsage>;
  };

  const keyMap = new Map<string, RawEntry>();

  for (const bucket of buckets) {
    const date = bucket.starting_at.slice(0, 10);
    for (const r of bucket.results) {
      const kid = r.api_key_id;
      if (!kid) continue;

      let entry = keyMap.get(kid);
      if (!entry) {
        entry = {
          keyName: nameMap.get(kid) ?? `key_…${kid.slice(-6)}`,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          total: 0,
          cost: 0,
          daily: new Map(),
        };
        keyMap.set(kid, entry);
      }

      const inp = r.uncached_input_tokens ?? 0;
      const out = r.output_tokens ?? 0;
      const cr = r.cache_read_input_tokens ?? 0;
      const cc =
        (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
        (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
      const c = tokenCost(r);

      entry.input += inp;
      entry.output += out;
      entry.cache_read += cr;
      entry.cache_creation += cc;
      entry.total += inp + out + cr + cc;
      entry.cost += c;

      let day = entry.daily.get(date);
      if (!day) {
        day = {
          date,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 0,
          cost: 0,
        };
        entry.daily.set(date, day);
      }
      day.input_tokens += inp;
      day.output_tokens += out;
      day.cache_read_tokens += cr;
      day.cache_creation_tokens += cc;
      day.total_tokens += inp + out + cr + cc;
      day.cost += c;
    }
  }

  // Group by extracted person/service name
  const groupMap = new Map<
    string,
    {
      key_names: string[];
      input: number;
      output: number;
      cache_read: number;
      cache_creation: number;
      total: number;
      cost: number;
      daily: Map<string, DailyUsage>;
    }
  >();

  for (const [, raw] of keyMap) {
    const group = extractGroupName(raw.keyName);
    let g = groupMap.get(group);
    if (!g) {
      g = {
        key_names: [],
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
        total: 0,
        cost: 0,
        daily: new Map(),
      };
      groupMap.set(group, g);
    }

    g.key_names.push(raw.keyName);
    g.input += raw.input;
    g.output += raw.output;
    g.cache_read += raw.cache_read;
    g.cache_creation += raw.cache_creation;
    g.total += raw.total;
    g.cost += raw.cost;

    for (const [date, day] of raw.daily) {
      let gDay = g.daily.get(date);
      if (!gDay) {
        gDay = {
          date,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: 0,
          cost: 0,
        };
        g.daily.set(date, gDay);
      }
      gDay.input_tokens += day.input_tokens;
      gDay.output_tokens += day.output_tokens;
      gDay.cache_read_tokens += day.cache_read_tokens;
      gDay.cache_creation_tokens += day.cache_creation_tokens;
      gDay.total_tokens += day.total_tokens;
      gDay.cost += day.cost;
    }
  }

  const entries: LeaderboardEntry[] = [];
  for (const [groupName, g] of groupMap) {
    const daily = [...g.daily.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    entries.push({
      group_name: groupName,
      key_names: g.key_names.sort(),
      input_tokens: g.input,
      output_tokens: g.output,
      cache_read_tokens: g.cache_read,
      cache_creation_tokens: g.cache_creation,
      total_tokens: g.total,
      cost: g.cost,
      daily,
    });
  }

  return entries.sort((a, b) => b.cost - a.cost);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function formatCost(n: number): string {
  if (n < 0.01) return "$0.00";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function pad(str: string, width: number): string {
  return str.length >= width
    ? str.slice(0, width)
    : str + " ".repeat(width - str.length);
}

function rpad(str: string, width: number): string {
  return str.length >= width
    ? str.slice(0, width)
    : " ".repeat(width - str.length) + str;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function Header({ range }: { range: TimeRange }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        claude-usage
      </Text>
      <Text dimColor>
        Anthropic API usage leaderboard — {rangeLabel(range)}
      </Text>
      <Text dimColor>
        ↑↓ navigate · →/← detail · f filter · / search · q quit
      </Text>
    </Box>
  );
}

function FilterBar({
  range,
  search,
  searching,
}: {
  range: TimeRange;
  search: string;
  searching: boolean;
}) {
  return (
    <Box gap={1} marginBottom={0}>
      {TIME_RANGES.map((r) => (
        <Text
          key={r}
          color={r === range ? "cyan" : undefined}
          bold={r === range}
          dimColor={r !== range}
        >
          {r === range ? `[${r}]` : r}
        </Text>
      ))}
      {(searching || search) && (
        <Text>
          <Text dimColor> / </Text>
          <Text color="yellow">{search}</Text>
          {searching && <Text color="yellow">▌</Text>}
        </Text>
      )}
    </Box>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Box marginTop={0} marginBottom={0}>
      <Text bold dimColor>
        ── {children} ──
      </Text>
    </Box>
  );
}

function TableHeader({ width }: { width: number }) {
  const nameW = Math.max(10, width - 52);
  return (
    <Box>
      <Text dimColor>
        {pad(" # ", 4)}
        {pad("Name", nameW)}
        {rpad("Input", 9)}
        {rpad("Output", 9)}
        {rpad("Cache", 9)}
        {rpad("Total", 9)}
        {rpad("Cost", 9)}
      </Text>
    </Box>
  );
}

function LeaderboardRow({
  entry,
  rank,
  active,
  width,
}: {
  entry: LeaderboardEntry;
  rank: number;
  active: boolean;
  width: number;
}) {
  const cursor = active ? "❯" : " ";
  const nameW = Math.max(10, width - 52);
  const label =
    entry.key_names.length > 1
      ? `${entry.group_name} (${entry.key_names.length})`
      : entry.group_name;

  return (
    <Box>
      <Text color={active ? "cyan" : undefined}>
        {cursor}
        {rpad(String(rank), 3)}{" "}
      </Text>
      <Text color={active ? "cyan" : undefined} bold={active}>
        {pad(truncate(label, nameW - 1), nameW)}
      </Text>
      <Text dimColor>{rpad(formatTokens(entry.input_tokens), 9)}</Text>
      <Text dimColor>{rpad(formatTokens(entry.output_tokens), 9)}</Text>
      <Text dimColor>{rpad(formatTokens(entry.cache_read_tokens), 9)}</Text>
      <Text>{rpad(formatTokens(entry.total_tokens), 9)}</Text>
      <Text color="green" bold>
        {rpad(formatCost(entry.cost), 9)}
      </Text>
    </Box>
  );
}

function DetailPanel({
  entry,
  width,
  height,
}: {
  entry: LeaderboardEntry | undefined;
  width: number;
  height: number;
}) {
  const innerWidth = Math.max(10, width - 4);

  if (!entry) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        width={width}
        height={height}
        flexDirection="column"
        paddingX={1}
      >
        <Text dimColor>No item selected</Text>
      </Box>
    );
  }

  const keysLine =
    entry.key_names.length > 1
      ? `${entry.key_names.length} keys`
      : entry.key_names[0] ?? "";

  const headerLines = 5; // name + keys + separator + column headers + bottom separator
  const footerLines = 2; // separator + total row
  const maxRows = Math.max(1, height - headerLines - footerLines - 2);
  const days = entry.daily.slice(-maxRows);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      width={width}
      height={height}
      flexDirection="column"
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate-end">
        {entry.group_name}
      </Text>
      <Text dimColor wrap="truncate-end">
        {keysLine}
      </Text>
      <Text dimColor>{"─".repeat(innerWidth)}</Text>
      <Text dimColor>
        {pad("Date", 12)}
        {rpad("Input", 9)}
        {rpad("Output", 9)}
        {rpad("Cache", 9)}
        {rpad("Cost", 9)}
      </Text>
      {days.map((d) => (
        <Text key={d.date} wrap="truncate-end">
          {pad(d.date, 12)}
          {rpad(formatTokens(d.input_tokens), 9)}
          {rpad(formatTokens(d.output_tokens), 9)}
          {rpad(formatTokens(d.cache_read_tokens), 9)}
          <Text color="green">{rpad(formatCost(d.cost), 9)}</Text>
        </Text>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>{"─".repeat(innerWidth)}</Text>
      <Text bold wrap="truncate-end">
        {pad("Total", 12)}
        {rpad(formatTokens(entry.input_tokens), 9)}
        {rpad(formatTokens(entry.output_tokens), 9)}
        {rpad(formatTokens(entry.cache_read_tokens), 9)}
        <Text color="green" bold>
          {rpad(formatCost(entry.cost), 9)}
        </Text>
      </Text>
    </Box>
  );
}

function Footer({
  total,
  filtered,
  viewport,
  rows,
  totalCost,
}: {
  total: number;
  filtered: number;
  viewport: number;
  rows: number;
  totalCost: number;
}) {
  const count = filtered < total ? `${filtered}/${total}` : `${total}`;
  const scroll =
    filtered > rows
      ? ` · ${viewport + 1}–${Math.min(viewport + rows, filtered)} of ${filtered}`
      : "";
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {count} users · total spend {formatCost(totalCost)}
        {scroll}
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

  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [range, setRange] = useState<TimeRange>("weekly");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);

  const filtered = useMemo(() => {
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.group_name.toLowerCase().includes(q) ||
        e.key_names.some((k) => k.toLowerCase().includes(q)),
    );
  }, [entries, search]);

  const listWidth = detailOpen ? Math.floor(termWidth * 0.5) : termWidth;
  const detailWidth = termWidth - listWidth;

  const loadData = useCallback(async (r: TimeRange) => {
    const apiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
    if (!apiKey) {
      setError("ANTHROPIC_ADMIN_API_KEY is not set");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [buckets, keys] = await Promise.all([
        fetchUsage(apiKey, rangeDays(r)),
        fetchApiKeys(apiKey),
      ]);
      setEntries(buildLeaderboard(buckets, keys));
      setCursor(0);
      setViewport(0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData(range);
  }, [range]);

  useEffect(() => {
    setCursor(0);
    setViewport(0);
  }, [search]);

  useInput((input, key) => {
    // Search mode input
    if (searching) {
      if (key.escape) {
        setSearching(false);
        return;
      }
      if (key.return) {
        setSearching(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((s) => s.slice(0, -1));
        return;
      }
      if (
        input &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.ctrl
      ) {
        setSearch((s) => s + input);
        return;
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (input === "/") {
      setSearching(true);
      return;
    }

    if (input === "f") {
      const idx = TIME_RANGES.indexOf(range);
      setRange(TIME_RANGES[(idx + 1) % TIME_RANGES.length]);
      return;
    }

    if (loading) return;

    if (key.escape) {
      if (search) {
        setSearch("");
        return;
      }
      if (detailOpen) {
        setDetailOpen(false);
        return;
      }
      return;
    }

    if (key.rightArrow) {
      setDetailOpen(true);
      return;
    }

    if (key.leftArrow) {
      setDetailOpen(false);
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
        const next = Math.min(filtered.length - 1, c + 1);
        setViewport((v) => (next >= v + termRows ? next - termRows + 1 : v));
        return next;
      });
      return;
    }
  });

  if (error && !loading) {
    return (
      <Box flexDirection="column">
        <Header range={range} />
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box flexDirection="column">
        <Header range={range} />
        <FilterBar range={range} search={search} searching={searching} />
        <Text>Loading usage data…</Text>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Header range={range} />
        <FilterBar range={range} search={search} searching={searching} />
        <Text color="green">No usage data found.</Text>
      </Box>
    );
  }

  const totalCost = filtered.reduce((s, e) => s + e.cost, 0);
  const visible = filtered.slice(viewport, viewport + termRows);

  return (
    <Box flexDirection="column">
      <Header range={range} />
      <FilterBar range={range} search={search} searching={searching} />

      <Box flexDirection="row">
        <Box flexDirection="column" width={listWidth}>
          <SectionLabel>Leaderboard ({filtered.length} users)</SectionLabel>
          <TableHeader width={listWidth} />
          {visible.map((entry, i) => {
            const globalIdx = viewport + i;
            return (
              <LeaderboardRow
                key={entry.group_name}
                entry={entry}
                rank={globalIdx + 1}
                active={globalIdx === cursor}
                width={listWidth}
              />
            );
          })}
        </Box>

        {detailOpen && (
          <DetailPanel
            entry={filtered[cursor]}
            width={detailWidth}
            height={termRows + 2}
          />
        )}
      </Box>

      <Footer
        total={entries.length}
        filtered={filtered.length}
        viewport={viewport}
        rows={termRows}
        totalCost={totalCost}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("claude-usage requires an interactive terminal.");
  process.exit(1);
}

render(<App />);
