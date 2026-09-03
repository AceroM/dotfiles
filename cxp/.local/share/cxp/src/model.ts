import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { createInterface } from "node:readline"

export type Provider = "codex" | "claude"
export type ItemKind = "user" | "assistant" | "tool" | "reasoning" | "system"

export interface TranscriptItem {
  id: string
  kind: ItemKind
  timestamp?: string
  content: string
  title?: string
  callId?: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolStatus?: "ok" | "error" | "pending"
  sidechain?: boolean
}

export interface TranscriptStats {
  lines: number
  malformed: number
  user: number
  assistant: number
  tools: number
  reasoning: number
  encryptedReasoning: number
  system: number
}

export interface Transcript {
  provider: Provider
  id: string
  path: string
  cwd?: string
  model?: string
  version?: string
  title?: string
  createdAt?: string
  items: TranscriptItem[]
  stats: TranscriptStats
}

export interface ResolveOptions {
  codexRoot?: string
  claudeRoot?: string
  provider?: Provider
  cwd?: string
}

interface Candidate {
  path: string
  provider: Provider
  exact: boolean
}

type JsonObject = Record<string, unknown>

const ANSI_PATTERN = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\u001b]*(?:\u001b\\)|[@-_])/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const AGENTS_INSTRUCTIONS_PATTERN =
  /(?:^|\n)# AGENTS\.md instructions for [^\n]+\n\s*<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>(?=\n|$)/g
const ENVIRONMENT_CONTEXT_PATTERN = /(?:^|\n)<environment_context>\s*[\s\S]*?<\/environment_context>(?=\n|$)/g

export class SessionNotFoundError extends Error {}
export class AmbiguousSessionError extends Error {
  constructor(public readonly candidates: Candidate[]) {
    super(`More than one transcript matched (${candidates.length}).`)
  }
}

export function sanitizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
}

export function stripInjectedUserContext(value: string): string {
  return sanitizeText(value)
    .replace(AGENTS_INSTRUCTIONS_PATTERN, "\n")
    .replace(ENVIRONMENT_CONTEXT_PATTERN, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function compactText(value: string, maxLength = 140): string {
  const compact = sanitizeText(value).replace(/\s+/g, " ").trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`
}

export function truncateText(value: string, maxChars = 40_000, maxLines = 500): string {
  const clean = sanitizeText(value)
  const lines = clean.split("\n")
  let truncated = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : clean
  let reason = lines.length > maxLines ? `${lines.length - maxLines} lines` : ""

  if (truncated.length > maxChars) {
    reason = `${truncated.length - maxChars} characters${reason ? ` and ${reason}` : ""}`
    truncated = truncated.slice(0, maxChars)
  }

  return reason ? `${truncated}\n\n[… ${reason} hidden]` : truncated
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stringify(value: unknown): string {
  if (typeof value === "string") return sanitizeText(value)
  if (value === undefined || value === null) return ""

  try {
    return sanitizeText(JSON.stringify(value, null, 2))
  } catch {
    return sanitizeText(String(value))
  }
}

function looksLikeToolError(output: string): boolean {
  return /(^|\n)(?:script |command )?(?:error|failed|failure)\b|(?:exit|status) code [1-9]\d*/i.test(output)
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return sanitizeText(value)
  if (Array.isArray(value)) {
    return value
      .map((entry) => textFromContent(entry))
      .filter(Boolean)
      .join("\n")
  }
  if (!isObject(value)) return ""

  for (const field of ["text", "thinking"]) {
    const text = asString(value[field])
    if (text) return sanitizeText(text)
  }

  if (value.content !== undefined) return textFromContent(value.content)

  const type = asString(value.type)
  if (type === "image" || type === "input_image" || type === "image_url") return "[image]"
  if (type === "document") return "[document]"
  return ""
}

async function readRecords(filePath: string): Promise<{ records: JsonObject[]; malformed: number; lines: number }> {
  const records: JsonObject[] = []
  let malformed = 0
  let lines = 0
  const input = createReadStream(filePath, { encoding: "utf8" })
  const reader = createInterface({ input, crlfDelay: Infinity })

  for await (const line of reader) {
    lines++
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isObject(parsed)) records.push(parsed)
      else malformed++
    } catch {
      malformed++
    }
  }

  return { records, malformed, lines }
}

async function existsAsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function findJsonl(root: string, needle: string, provider: Provider): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  const pending = [root]
  const lowerNeedle = needle.toLowerCase()

  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue

    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(entryPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue

      const lowerName = entry.name.toLowerCase()
      if (!lowerName.includes(lowerNeedle)) continue
      const stem = lowerName.slice(0, -".jsonl".length)
      candidates.push({
        path: entryPath,
        provider,
        exact: stem === lowerNeedle || stem.endsWith(`-${lowerNeedle}`),
      })
    }
  }

  return candidates
}

async function detectProvider(filePath: string): Promise<Provider> {
  const input = createReadStream(filePath, { encoding: "utf8" })
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObject(record)) continue
      const type = asString(record.type)
      if (["session_meta", "turn_context", "response_item", "event_msg"].includes(type ?? "")) return "codex"
      if (record.message !== undefined || record.sessionId !== undefined) return "claude"
    }
  } finally {
    reader.close()
    input.destroy()
  }
  throw new Error(`Could not recognize the JSONL transcript format: ${filePath}`)
}

function extractId(filePath: string): string {
  return basename(filePath).match(UUID_PATTERN)?.[0] ?? basename(filePath, ".jsonl")
}

export async function resolveTranscript(query: string, options: ResolveOptions = {}): Promise<Candidate> {
  let requestedProvider = options.provider
  let needle = query.trim()
  const providerPrefix = needle.match(/^(codex|claude):(.*)$/i)
  if (providerPrefix) {
    requestedProvider = providerPrefix[1]?.toLowerCase() as Provider
    needle = providerPrefix[2]?.trim() ?? ""
  }
  if (!needle) throw new SessionNotFoundError("Give cxp a session ID or JSONL path.")

  const expanded = needle === "~" ? homedir() : needle.startsWith("~/") ? join(homedir(), needle.slice(2)) : needle
  const explicitPath = resolve(options.cwd ?? process.cwd(), expanded)
  if (await existsAsFile(explicitPath)) {
    const provider = await detectProvider(explicitPath)
    if (requestedProvider && provider !== requestedProvider) {
      throw new SessionNotFoundError(`That file is a ${provider} transcript, not ${requestedProvider}.`)
    }
    return { path: explicitPath, provider, exact: true }
  }

  const codexRoot = options.codexRoot ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  const claudeRoot = options.claudeRoot ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")
  const searches: Promise<Candidate[]>[] = []
  if (!requestedProvider || requestedProvider === "codex") searches.push(findJsonl(codexRoot, needle, "codex"))
  if (!requestedProvider || requestedProvider === "claude") searches.push(findJsonl(claudeRoot, needle, "claude"))
  const matches = (await Promise.all(searches)).flat()
  const exact = matches.filter((candidate) => candidate.exact)
  const ranked = exact.length > 0 ? exact : matches

  if (ranked.length === 0) {
    const scope = requestedProvider ? `${requestedProvider} transcripts` : "Codex and Claude transcripts"
    throw new SessionNotFoundError(`No match for “${needle}” in ${scope}.`)
  }
  if (ranked.length > 1) throw new AmbiguousSessionError(ranked)
  return ranked[0]!
}

function initialStats(lines: number, malformed: number): TranscriptStats {
  return { lines, malformed, user: 0, assistant: 0, tools: 0, reasoning: 0, encryptedReasoning: 0, system: 0 }
}

function normalizeCodex(filePath: string, records: JsonObject[], lines: number, malformed: number): Transcript {
  const items: TranscriptItem[] = []
  const stats = initialStats(lines, malformed)
  const tools = new Map<string, TranscriptItem>()
  const orphanedOutputs = new Map<string, string>()
  let sequence = 0
  let sessionId = extractId(filePath)
  let cwd: string | undefined
  let model: string | undefined
  let version: string | undefined
  let createdAt: string | undefined

  const push = (item: Omit<TranscriptItem, "id">) => {
    const normalized = { ...item, id: `item-${sequence++}` }
    items.push(normalized)
    if (normalized.kind === "tool") stats.tools++
    else stats[normalized.kind]++
    return normalized
  }

  for (const record of records) {
    const type = asString(record.type)
    const payload = asObject(record.payload)
    const timestamp = asString(record.timestamp)

    if (type === "session_meta") {
      sessionId = asString(payload.session_id) ?? asString(payload.id) ?? sessionId
      cwd = asString(payload.cwd) ?? cwd
      version = asString(payload.cli_version) ?? version
      createdAt = asString(payload.timestamp) ?? timestamp ?? createdAt
      continue
    }
    if (type === "turn_context") {
      cwd = asString(payload.cwd) ?? cwd
      model = asString(payload.model) ?? model
      continue
    }
    if (type !== "response_item") continue

    const payloadType = asString(payload.type)
    if (payloadType === "message") {
      const role = asString(payload.role)
      const rawContent = textFromContent(payload.content).trim()
      const content = role === "user" ? stripInjectedUserContext(rawContent) : rawContent
      if (!content) continue
      if (role === "user") push({ kind: "user", timestamp, content })
      else if (role === "assistant") push({ kind: "assistant", timestamp, content })
      else if (role === "system" || role === "developer") {
        push({ kind: "system", timestamp, title: role, content })
      }
      continue
    }

    if (payloadType === "reasoning") {
      stats.reasoning++
      const content = textFromContent(payload.summary).trim()
      if (!content) {
        if (payload.encrypted_content) stats.encryptedReasoning++
        continue
      }
      items.push({ id: `item-${sequence++}`, kind: "reasoning", timestamp, content })
      continue
    }

    if (payloadType === "custom_tool_call" || payloadType === "function_call") {
      const callId = asString(payload.call_id) ?? asString(payload.id) ?? `call-${sequence}`
      const input = stringify(payload.input ?? payload.arguments)
      const tool = push({
        kind: "tool",
        timestamp,
        content: compactText(input) || "No input.",
        callId,
        toolName: asString(payload.name) ?? "tool",
        toolInput: input,
        toolStatus: "pending",
      })
      tools.set(callId, tool)
      const orphan = orphanedOutputs.get(callId)
      if (orphan !== undefined) {
        tool.toolOutput = orphan
        tool.toolStatus = looksLikeToolError(orphan) ? "error" : "ok"
        orphanedOutputs.delete(callId)
      }
      continue
    }

    if (payloadType === "custom_tool_call_output" || payloadType === "function_call_output") {
      const callId = asString(payload.call_id) ?? asString(payload.id)
      if (!callId) continue
      const output = textFromContent(payload.output) || stringify(payload.output)
      const tool = tools.get(callId)
      if (tool) {
        tool.toolOutput = output
        tool.toolStatus = looksLikeToolError(output) ? "error" : "ok"
      } else {
        orphanedOutputs.set(callId, output)
      }
    }
  }

  return {
    provider: "codex",
    id: sessionId,
    path: filePath,
    cwd,
    model,
    version,
    createdAt,
    items,
    stats,
  }
}

function normalizeClaude(filePath: string, records: JsonObject[], lines: number, malformed: number): Transcript {
  const items: TranscriptItem[] = []
  const stats = initialStats(lines, malformed)
  const tools = new Map<string, TranscriptItem>()
  const orphanedOutputs = new Map<string, { output: string; error: boolean }>()
  let sequence = 0
  let sessionId = extractId(filePath)
  let cwd: string | undefined
  let model: string | undefined
  let version: string | undefined
  let title: string | undefined
  let createdAt: string | undefined

  const push = (item: Omit<TranscriptItem, "id">) => {
    const normalized = { ...item, id: `item-${sequence++}` }
    items.push(normalized)
    if (normalized.kind === "tool") stats.tools++
    else stats[normalized.kind]++
    return normalized
  }

  for (const record of records) {
    const type = asString(record.type)
    const timestamp = asString(record.timestamp)
    sessionId = asString(record.sessionId) ?? asString(record.session_id) ?? sessionId
    cwd = asString(record.cwd) ?? cwd
    version = asString(record.version) ?? version
    createdAt ??= timestamp

    if (type === "ai-title") {
      title = asString(record.title) ?? asString(record.aiTitle) ?? title
      continue
    }
    if (type !== "user" && type !== "assistant") continue

    const message = asObject(record.message)
    const messageModel = asString(message.model)
    if (messageModel && !messageModel.startsWith("<")) model = messageModel
    else model ??= messageModel
    const sidechain = record.isSidechain === true
    const content = message.content

    if (type === "user") {
      if (typeof content === "string") {
        const userContent = stripInjectedUserContext(content)
        if (!userContent) continue
        push({
          kind: record.isMeta === true ? "system" : "user",
          timestamp,
          content: userContent,
          sidechain,
        })
        continue
      }

      if (!Array.isArray(content)) continue
      for (const rawBlock of content) {
        const block = asObject(rawBlock)
        if (block.type !== "tool_result") continue
        const callId = asString(block.tool_use_id)
        if (!callId) continue
        const output = textFromContent(block.content) || stringify(block.content)
        const error = block.is_error === true
        const tool = tools.get(callId)
        if (tool) {
          tool.toolOutput = output
          tool.toolStatus = error ? "error" : "ok"
        } else {
          orphanedOutputs.set(callId, { output, error })
        }
      }
      continue
    }

    const blocks = Array.isArray(content) ? content : [content]
    for (const rawBlock of blocks) {
      const block = asObject(rawBlock)
      const blockType = asString(block.type)
      if (blockType === "text") {
        const text = textFromContent(block).trim()
        if (text) push({ kind: "assistant", timestamp, content: text, sidechain })
      } else if (blockType === "thinking") {
        const thinking = textFromContent(block).trim()
        stats.reasoning++
        if (thinking) items.push({ id: `item-${sequence++}`, kind: "reasoning", timestamp, content: thinking, sidechain })
      } else if (blockType === "tool_use") {
        const callId = asString(block.id) ?? `call-${sequence}`
        const input = stringify(block.input)
        const tool = push({
          kind: "tool",
          timestamp,
          content: compactText(input) || "No input.",
          callId,
          toolName: asString(block.name) ?? "tool",
          toolInput: input,
          toolStatus: "pending",
          sidechain,
        })
        tools.set(callId, tool)
        const orphan = orphanedOutputs.get(callId)
        if (orphan) {
          tool.toolOutput = orphan.output
          tool.toolStatus = orphan.error ? "error" : "ok"
          orphanedOutputs.delete(callId)
        }
      }
    }
  }

  return {
    provider: "claude",
    id: sessionId,
    path: filePath,
    cwd,
    model,
    version,
    title,
    createdAt,
    items,
    stats,
  }
}

export async function loadTranscript(candidate: Pick<Candidate, "path" | "provider">): Promise<Transcript> {
  const { records, malformed, lines } = await readRecords(candidate.path)
  return candidate.provider === "codex"
    ? normalizeCodex(candidate.path, records, lines, malformed)
    : normalizeClaude(candidate.path, records, lines, malformed)
}

export function itemSearchText(item: TranscriptItem): string {
  return [item.kind, item.title, item.toolName, item.content, item.toolInput, item.toolOutput]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase()
}
