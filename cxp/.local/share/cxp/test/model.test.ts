import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AmbiguousSessionError,
  loadTranscript,
  listRecentConversations,
  resolveTranscript,
  sanitizeText,
  stripInjectedUserContext,
} from "../src/model"

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "cxp-test-"))
  temporaryDirectories.push(directory)
  const codexRoot = join(directory, "codex")
  const claudeRoot = join(directory, "claude")
  await Promise.all([mkdir(codexRoot), mkdir(claudeRoot)])
  return { directory, codexRoot, claudeRoot }
}

describe("session resolution", () => {
  test("lists nested conversations across providers by modification time with useful titles", async () => {
    const roots = await fixtureDirectory()
    const nested = join(roots.codexRoot, "2026", "09")
    await mkdir(nested, { recursive: true })
    const codex = join(nested, "rollout-older.jsonl")
    const claude = join(roots.claudeRoot, "newer.jsonl")
    await Bun.write(codex, [
      { type: "session_meta", payload: { id: "older", cwd: "/code/project" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "# AGENTS.md instructions for /code\n<INSTRUCTIONS>\nhidden\n</INSTRUCTIONS>\nFix the picker" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n")
    await Bun.write(claude, JSON.stringify({ type: "user", sessionId: "newer", cwd: "/code/other", message: { role: "user", content: "Review the change" } }) + "\n{partial")
    await utimes(codex, 100, 100)
    await utimes(claude, 200, 200)
    const recent = await listRecentConversations(roots)
    expect(recent.map((c) => c.id)).toEqual(["newer", "older"])
    expect(recent[1]?.title).toBe("Fix the picker")
    expect(recent[1]?.cwd).toBe("/code/project")
    expect(recent[0]?.title).toBe("Review the change")
    expect((await listRecentConversations({ ...roots, provider: "codex" })).map((c) => c.id)).toEqual(["older"])
  })

  test("returns an empty list when session directories are absent", async () => {
    const { directory } = await fixtureDirectory()
    expect(await listRecentConversations({ codexRoot: join(directory, "missing"), claudeRoot: join(directory, "also-missing") })).toEqual([])
  })

  test("finds Codex rollout names and Claude UUID names", async () => {
    const { codexRoot, claudeRoot } = await fixtureDirectory()
    const codexId = "01a067a2-3807-7571-97cb-b5dd4a13cab9"
    const claudeId = "88ba459a-ec8f-4489-80b8-b0af7ec27102"
    await Bun.write(join(codexRoot, `rollout-2026-09-03-${codexId}.jsonl`), "{}\n")
    await Bun.write(join(claudeRoot, `${claudeId}.jsonl`), "{}\n")

    const codex = await resolveTranscript(codexId, { codexRoot, claudeRoot })
    const claude = await resolveTranscript(`claude:${claudeId.slice(0, 10)}`, { codexRoot, claudeRoot })

    expect(codex.provider).toBe("codex")
    expect(claude.provider).toBe("claude")
  })

  test("reports ambiguous prefixes", async () => {
    const { claudeRoot, codexRoot } = await fixtureDirectory()
    await Bun.write(join(claudeRoot, "abc-one.jsonl"), "{}\n")
    await Bun.write(join(claudeRoot, "abc-two.jsonl"), "{}\n")
    expect(resolveTranscript("abc", { codexRoot, claudeRoot })).rejects.toBeInstanceOf(AmbiguousSessionError)
  })
})

describe("normalization", () => {
  test("pairs Codex tool calls and results and counts encrypted reasoning", async () => {
    const { directory } = await fixtureDirectory()
    const fixture = join(directory, "01a067a2-3807-7571-97cb-b5dd4a13cab9.jsonl")
    const records = [
      { type: "session_meta", timestamp: "2026-09-03T10:00:00Z", payload: { id: "01a067a2-3807-7571-97cb-b5dd4a13cab9", cwd: "/code", cli_version: "1.0" } },
      { type: "turn_context", payload: { model: "gpt-test" } },
      { type: "response_item", timestamp: "2026-09-03T10:00:01Z", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "# AGENTS.md instructions for /code\n\n<INSTRUCTIONS>\nsecret rules\n</INSTRUCTIONS>" },
        { type: "input_text", text: "<environment_context>\n  <cwd>/code</cwd>\n</environment_context>" },
        { type: "input_text", text: "Do it" },
      ] } },
      { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "opaque" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "pwd" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "/code" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
    ]
    await Bun.write(fixture, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

    const transcript = await loadTranscript({ path: fixture, provider: "codex" })
    const tool = transcript.items.find((item) => item.kind === "tool")

    expect(transcript.model).toBe("gpt-test")
    expect(transcript.stats.encryptedReasoning).toBe(1)
    expect(transcript.items[0]?.content).toBe("Do it")
    expect(tool?.toolName).toBe("exec")
    expect(tool?.toolOutput).toBe("/code")
    expect(tool?.toolStatus).toBe("ok")
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"])
  })

  test("normalizes Claude text, thinking, tools, and meta records", async () => {
    const { directory } = await fixtureDirectory()
    const fixture = join(directory, "88ba459a-ec8f-4489-80b8-b0af7ec27102.jsonl")
    const base = { sessionId: "88ba459a-ec8f-4489-80b8-b0af7ec27102", cwd: "/code", timestamp: "2026-09-03T10:00:00Z" }
    const records = [
      { ...base, type: "user", message: { role: "user", content: "Build it" } },
      { ...base, type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "Plan" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/code/a" } }] } },
      { ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] } },
      { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Finished." }] } },
      { ...base, type: "user", isMeta: true, message: { role: "user", content: "internal context" } },
    ]
    await Bun.write(fixture, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

    const transcript = await loadTranscript({ path: fixture, provider: "claude" })
    const tool = transcript.items.find((item) => item.kind === "tool")

    expect(transcript.model).toBe("claude-test")
    expect(transcript.stats.reasoning).toBe(1)
    expect(transcript.stats.system).toBe(1)
    expect(tool?.toolOutput).toBe("contents")
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "reasoning", "tool", "assistant", "system"])
  })

  test("strips escape and control sequences from transcript text", () => {
    expect(sanitizeText("safe\u001b[2J\u0000text")).toBe("safetext")
  })

  test("hides injected AGENTS and environment envelopes without losing the prompt", () => {
    const content = [
      "# AGENTS.md instructions for /code",
      "",
      "<INSTRUCTIONS>",
      "Never show this.",
      "</INSTRUCTIONS>",
      "<environment_context>",
      "  <cwd>/code</cwd>",
      "</environment_context>",
      "Keep this user request.",
    ].join("\n")

    expect(stripInjectedUserContext(content)).toBe("Keep this user request.")
  })
})
