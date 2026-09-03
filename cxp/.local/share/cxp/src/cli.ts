#!/usr/bin/env bun

import { basename } from "node:path"
import type { Provider, Transcript, TranscriptItem } from "./model"
import {
  AmbiguousSessionError,
  SessionNotFoundError,
  compactText,
  itemSearchText,
  loadTranscript,
  resolveTranscript,
  truncateText,
} from "./model"

const VERSION = "0.1.0"

interface CliOptions {
  query?: string
  provider?: Provider
  plain: boolean
  detailedTools: boolean
  showReasoning: boolean
  showSystem: boolean
}

const HELP = `cxp ${VERSION} — inspect local Codex and Claude chats

Usage:
  cxp [options] <session-id-or-jsonl-path>

Examples:
  cxp 01a067a2-3807-7571-97cb-b5dd4a13cab9
  cxp claude:88ba459a
  cxp ~/.claude/projects/example/session.jsonl

Options:
  --provider <name>  Search only codex or claude
  --plain            Print instead of opening the TUI
  --tools            Start with detailed tool input and output
  --reasoning        Start with reasoning summaries visible
  --system           Start with system and developer messages visible
  -h, --help         Show help
  -v, --version      Show version

Inside the TUI:
  j/k or arrows scroll   d/u page   g/G ends   / search   n/N matches
  t tool detail          r reasoning   s system   q quit`

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    plain: false,
    detailedTools: false,
    showReasoning: false,
    showSystem: false,
  }
  let positionalOnly = false

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (positionalOnly) {
      if (options.query) throw new Error("cxp accepts one session ID or path.")
      options.query = argument
      continue
    }
    if (argument === "--") {
      positionalOnly = true
    } else if (argument === "-h" || argument === "--help") {
      process.stdout.write(`${HELP}\n`)
      process.exit(0)
    } else if (argument === "-v" || argument === "--version") {
      process.stdout.write(`${VERSION}\n`)
      process.exit(0)
    } else if (argument === "--plain") {
      options.plain = true
    } else if (argument === "--tools") {
      options.detailedTools = true
    } else if (argument === "--reasoning") {
      options.showReasoning = true
    } else if (argument === "--system") {
      options.showSystem = true
    } else if (argument === "--provider" || argument.startsWith("--provider=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index]
      if (value !== "codex" && value !== "claude") throw new Error("--provider must be codex or claude.")
      options.provider = value
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`)
    } else if (options.query) {
      throw new Error("cxp accepts one session ID or path.")
    } else {
      options.query = argument
    }
  }

  if (!options.query) throw new SessionNotFoundError("Give cxp a session ID or JSONL path.")
  return options
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  if (Number.isNaN(date.valueOf())) return timestamp
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function toolBody(item: TranscriptItem, detailed: boolean): string {
  if (!detailed) {
    const output = item.toolOutput ? ` → ${compactText(item.toolOutput, 90)}` : ""
    return `${compactText(item.toolInput || item.content, 180)}${output}`
  }

  const sections = [`INPUT\n${truncateText(item.toolInput || item.content)}`]
  if (item.toolOutput !== undefined) sections.push(`OUTPUT\n${truncateText(item.toolOutput)}`)
  else sections.push("OUTPUT\nPending.")
  return sections.join("\n\n")
}

function labelFor(item: TranscriptItem): string {
  if (item.kind === "user") return "YOU"
  if (item.kind === "assistant") return "ASSISTANT"
  if (item.kind === "reasoning") return "REASONING"
  if (item.kind === "system") return "CONTEXT"
  return `TOOL · ${item.toolName ?? "unknown"}`
}

function visibleItems(
  transcript: Transcript,
  state: Pick<CliOptions, "showReasoning" | "showSystem">,
): TranscriptItem[] {
  return transcript.items.filter((item) => {
    if (item.kind === "reasoning") return state.showReasoning
    if (item.kind === "system") return state.showSystem
    return true
  })
}

function reasoningLabel(transcript: Transcript): string {
  const { reasoning, encryptedReasoning } = transcript.stats
  if (reasoning === 0) return "0 reasoning"
  if (encryptedReasoning === reasoning) return `${reasoning} reasoning encrypted`
  if (encryptedReasoning > 0) return `${reasoning} reasoning · ${encryptedReasoning} encrypted`
  return `${reasoning} reasoning`
}

function printPlain(transcript: Transcript, options: CliOptions): void {
  const stats = transcript.stats
  const metadata = [transcript.cwd, transcript.model, transcript.createdAt].filter(Boolean).join(" · ")
  const output = [
    `cxp · ${transcript.provider.toUpperCase()} · ${transcript.id}`,
    metadata,
    transcript.path,
    `${stats.user} user · ${stats.assistant} assistant · ${stats.tools} tools · ${reasoningLabel(transcript)}`,
    "",
  ]

  for (const item of visibleItems(transcript, options)) {
    const timestamp = formatTimestamp(item.timestamp)
    const suffix = [timestamp, item.sidechain ? "sidechain" : ""].filter(Boolean).join(" · ")
    output.push(`${labelFor(item)}${suffix ? ` · ${suffix}` : ""}`)
    output.push(item.kind === "tool" ? toolBody(item, options.detailedTools) : truncateText(item.content))
    output.push("")
  }

  process.stdout.write(`${output.join("\n").trimEnd()}\n`)
}

async function runTui(transcript: Transcript, options: CliOptions): Promise<void> {
  const {
    BoxRenderable,
    CliRenderEvents,
    MarkdownRenderable,
    RGBA,
    ScrollBoxRenderable,
    SyntaxStyle,
    TextRenderable,
    bold,
    createCliRenderer,
    fg,
    t,
  } = await import("@opentui/core")

  const palette = {
    background: "#0B1016",
    panel: "#111821",
    panelRaised: "#17202B",
    text: "#D7DEE7",
    muted: "#718096",
    faint: "#405064",
    user: "#64D2FF",
    assistant: "#9BE9A8",
    tool: "#F2C97D",
    reasoning: "#C7A7FF",
    system: "#8B9AAF",
    danger: "#FF7B72",
    match: "#FFD866",
  } as const

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
    backgroundColor: palette.background,
    useMouse: true,
    targetFps: 30,
  })
  renderer.setTerminalTitle(`cxp · ${transcript.provider} · ${transcript.id.slice(0, 8)}`)

  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(palette.text) },
    "markup.heading": { fg: RGBA.fromHex(palette.text), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(palette.text), bold: true },
    "markup.heading.2": { fg: RGBA.fromHex(palette.text), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(palette.text), bold: true },
    "markup.list": { fg: RGBA.fromHex(palette.muted) },
    "markup.raw": { fg: RGBA.fromHex(palette.tool) },
    "markup.link": { fg: RGBA.fromHex(palette.user), underline: true },
    "markup.quote": { fg: RGBA.fromHex(palette.muted), italic: true },
    "comment": { fg: RGBA.fromHex(palette.muted), italic: true },
    "string": { fg: RGBA.fromHex(palette.assistant) },
    "number": { fg: RGBA.fromHex(palette.reasoning) },
    "keyword": { fg: RGBA.fromHex(palette.user), bold: true },
    "function": { fg: RGBA.fromHex(palette.tool) },
  })

  const state = {
    detailedTools: options.detailedTools,
    showReasoning: options.showReasoning,
    showSystem: options.showSystem,
    mode: "browse" as "browse" | "search",
    query: "",
    searchDraft: "",
    matchIndex: -1,
    matches: [] as string[],
  }
  const hasReadableReasoning = transcript.items.some((item) => item.kind === "reasoning")

  const app = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    minWidth: 0,
    flexDirection: "column",
    backgroundColor: palette.background,
  })
  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 3,
    flexShrink: 0,
    paddingX: 2,
    border: ["bottom"],
    borderColor: palette.faint,
    backgroundColor: palette.panel,
    flexDirection: "column",
  })
  const titleText = new TextRenderable(renderer, { id: "title", height: 1, truncate: true, selectable: false })
  const metaText = new TextRenderable(renderer, {
    id: "metadata",
    height: 1,
    fg: palette.muted,
    truncate: true,
    selectable: true,
  })
  header.add(titleText)
  header.add(metaText)

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    width: "100%",
    flexGrow: 1,
    minHeight: 0,
    focusable: true,
    scrollY: true,
    viewportCulling: true,
    backgroundColor: palette.background,
    contentOptions: {
      flexDirection: "column",
      paddingTop: 1,
      paddingBottom: 1,
    },
    verticalScrollbarOptions: {
      trackOptions: { backgroundColor: palette.panel },
    },
  })

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 2,
    flexShrink: 0,
    paddingX: 2,
    border: ["top"],
    borderColor: palette.faint,
    backgroundColor: palette.panel,
  })
  const footerText = new TextRenderable(renderer, { id: "status", height: 1, truncate: true, selectable: false })
  footer.add(footerText)
  app.add(header)
  app.add(scroll)
  app.add(footer)
  renderer.root.add(app)

  const roleColor = (kind: TranscriptItem["kind"]) => {
    if (kind === "user") return palette.user
    if (kind === "assistant") return palette.assistant
    if (kind === "tool") return palette.tool
    if (kind === "reasoning") return palette.reasoning
    return palette.system
  }

  const currentMatchId = () => state.matches[state.matchIndex]

  const updateHeader = () => {
    const { stats } = transcript
    const compact = renderer.width < 84
    const displayId = compact ? `${transcript.id.slice(0, 13)}…` : transcript.id
    const counts = compact
      ? `${stats.user}u ${stats.assistant}a ${stats.tools}t`
      : `${stats.user} user · ${stats.assistant} assistant · ${stats.tools} tools · ${reasoningLabel(transcript)}`
    titleText.content = t`${bold(fg(palette.text)("cxp"))}  ${bold(fg(roleColor(transcript.provider === "codex" ? "assistant" : "reasoning"))(transcript.provider.toUpperCase()))}  ${fg(palette.text)(displayId)}  ${fg(palette.muted)(counts)}`

    const timestamp = transcript.createdAt ? new Date(transcript.createdAt).toLocaleString() : ""
    const malformed = stats.malformed > 0 ? `${stats.malformed} malformed lines` : ""
    metaText.content = [transcript.title, transcript.cwd, transcript.model, timestamp, malformed, basename(transcript.path)]
      .filter(Boolean)
      .join("  ·  ")
  }

  const recomputeMatches = () => {
    const query = state.query.toLowerCase()
    state.matches = query
      ? visibleItems(transcript, state)
          .filter((item) => itemSearchText(item).includes(query))
          .map((item) => item.id)
      : []
    if (state.matches.length === 0) state.matchIndex = -1
    else if (state.matchIndex < 0 || state.matchIndex >= state.matches.length) state.matchIndex = 0
  }

  const addTranscriptItem = (item: TranscriptItem) => {
    const color = roleColor(item.kind)
    const isCurrentMatch = item.id === currentMatchId()
    const container = new BoxRenderable(renderer, {
      id: item.id,
      width: "100%",
      minWidth: 0,
      flexShrink: 0,
      flexDirection: "column",
      paddingLeft: renderer.width < 72 ? 1 : 2,
      paddingRight: renderer.width < 72 ? 1 : 3,
      paddingBottom: 1,
      marginBottom: 1,
      border: ["left"],
      borderStyle: isCurrentMatch ? "heavy" : "single",
      borderColor: isCurrentMatch ? palette.match : color,
      backgroundColor: isCurrentMatch ? palette.panelRaised : palette.background,
    })
    const timestamp = formatTimestamp(item.timestamp)
    const status = item.kind === "tool" ? item.toolStatus ?? "pending" : ""
    const statusColor = status === "error" ? palette.danger : status === "ok" ? palette.assistant : palette.muted
    const suffix = [timestamp, item.sidechain ? "sidechain" : ""].filter(Boolean).join(" · ")
    const itemHeader = new TextRenderable(renderer, {
      height: 1,
      width: "100%",
      truncate: true,
      selectable: false,
      content: t`${bold(fg(color)(labelFor(item)))}${status ? fg(statusColor)(`  ${status}`) : ""}${suffix ? fg(palette.muted)(`  ${suffix}`) : ""}`,
    })
    container.add(itemHeader)

    const body = item.kind === "tool" ? toolBody(item, state.detailedTools) : truncateText(item.content)
    if (item.kind === "tool") {
      container.add(
        new TextRenderable(renderer, {
          width: "100%",
          flexShrink: 0,
          content: body,
          fg: palette.text,
          wrapMode: "word",
          selectable: true,
          tabIndicator: "›",
          tabIndicatorColor: palette.faint,
        }),
      )
    } else {
      container.add(
        new MarkdownRenderable(renderer, {
          width: "100%",
          flexShrink: 0,
          content: body,
          syntaxStyle,
          fg: item.kind === "reasoning" || item.kind === "system" ? palette.muted : palette.text,
          conceal: true,
          concealCode: false,
          tableOptions: {
            style: "columns",
            widthMode: "full",
            wrapMode: "word",
            selectable: true,
          },
        }),
      )
    }
    scroll.add(container)
  }

  const renderTranscript = (targetId?: string, preserveScroll = true) => {
    const previousTop = preserveScroll ? scroll.scrollTop : 0
    for (const child of scroll.getChildren()) child.destroyRecursively()
    for (const item of visibleItems(transcript, state)) addTranscriptItem(item)
    renderer.requestRender()
    setTimeout(() => {
      if (targetId) scroll.scrollChildIntoView(targetId)
      else scroll.scrollTo(previousTop)
    }, 0)
  }

  const jumpToMatch = (direction: 1 | -1) => {
    if (state.matches.length === 0) return
    state.matchIndex = (state.matchIndex + direction + state.matches.length) % state.matches.length
    renderTranscript(currentMatchId(), false)
  }

  let lastFooter = ""
  const updateFooter = () => {
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
    const progress = maxScroll === 0 ? 100 : Math.round((scroll.scrollTop / maxScroll) * 100)
    let content: string
    if (state.mode === "search") {
      content = `/${state.searchDraft}█  Enter search · Esc cancel`
    } else {
      const match = state.query
        ? state.matches.length > 0
          ? `${state.matchIndex + 1}/${state.matches.length}`
          : "no matches"
        : ""
      const reasoningMode = hasReadableReasoning ? (state.showReasoning ? "on" : "off") : "encrypted"
      const modes = `tools:${state.detailedTools ? "full" : "summary"}  reasoning:${reasoningMode}  context:${state.showSystem ? "on" : "off"}`
      content =
        renderer.width >= 104
          ? `j/k scroll  d/u page  g/G ends  / find  n/N match  t/r/s views  q quit   ${modes}${match ? `  ·  ${match}` : ""}  ·  ${progress}%`
          : `j/k d/u g/G  / n/N  t:${state.detailedTools ? "full" : "sum"} r:${hasReadableReasoning ? (state.showReasoning ? "on" : "off") : "enc"} s:${state.showSystem ? "on" : "off"} q${match ? `  ${match}` : ""}  ${progress}%`
    }
    if (content === lastFooter) return
    lastFooter = content
    footerText.content = state.mode === "search" ? t`${fg(palette.match)(content)}` : t`${fg(palette.muted)(content)}`
  }

  updateHeader()
  recomputeMatches()
  renderTranscript(undefined, false)
  updateFooter()
  scroll.focus()

  const footerTimer = setInterval(updateFooter, 80)

  const handled = (key: { preventDefault(): void; stopPropagation(): void }) => {
    key.preventDefault()
    key.stopPropagation()
    updateFooter()
  }

  renderer.keyInput.on("keypress", (key) => {
    const keyName = key.name.toLowerCase()
    if (state.mode === "search") {
      if (keyName === "escape") {
        state.mode = "browse"
        state.searchDraft = state.query
        handled(key)
        return
      }
      if (keyName === "return" || keyName === "enter") {
        state.mode = "browse"
        state.query = state.searchDraft.trim()
        state.matchIndex = -1
        recomputeMatches()
        renderTranscript(currentMatchId(), false)
        handled(key)
        return
      }
      if (keyName === "backspace") {
        state.searchDraft = state.searchDraft.slice(0, -1)
        handled(key)
        return
      }
      if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") {
        state.searchDraft += key.sequence
        handled(key)
      }
      return
    }

    if (keyName === "q") {
      handled(key)
      renderer.destroy()
    } else if (keyName === "/" || keyName === "slash") {
      state.mode = "search"
      state.searchDraft = state.query
      handled(key)
    } else if (keyName === "j") {
      scroll.scrollBy(1)
      handled(key)
    } else if (keyName === "k") {
      scroll.scrollBy(-1)
      handled(key)
    } else if (keyName === "d") {
      scroll.scrollBy(0.5, "viewport")
      handled(key)
    } else if (keyName === "u") {
      scroll.scrollBy(-0.5, "viewport")
      handled(key)
    } else if (keyName === "g" && (key.shift || key.sequence === "G")) {
      scroll.scrollTo(scroll.scrollHeight)
      handled(key)
    } else if (keyName === "g") {
      scroll.scrollTo(0)
      handled(key)
    } else if (keyName === "n") {
      jumpToMatch(key.shift || key.sequence === "N" ? -1 : 1)
      handled(key)
    } else if (keyName === "t") {
      state.detailedTools = !state.detailedTools
      renderTranscript()
      handled(key)
    } else if (keyName === "r") {
      if (hasReadableReasoning) {
        state.showReasoning = !state.showReasoning
        recomputeMatches()
        renderTranscript()
      }
      handled(key)
    } else if (keyName === "s") {
      state.showSystem = !state.showSystem
      recomputeMatches()
      renderTranscript()
      handled(key)
    } else if (keyName === "escape" && state.query) {
      state.query = ""
      state.searchDraft = ""
      state.matchIndex = -1
      recomputeMatches()
      renderTranscript()
      handled(key)
    }
  })

  renderer.on(CliRenderEvents.RESIZE, () => {
    updateHeader()
    renderTranscript()
    updateFooter()
  })
  renderer.once(CliRenderEvents.DESTROY, () => {
    clearInterval(footerTimer)
    syntaxStyle.destroy()
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const candidate = await resolveTranscript(options.query!, { provider: options.provider })
  const transcript = await loadTranscript(candidate)
  if (options.plain || !process.stdout.isTTY || !process.stdin.isTTY) printPlain(transcript, options)
  else await runTui(transcript, options)
}

try {
  await main()
} catch (error) {
  if (error instanceof AmbiguousSessionError) {
    process.stderr.write(`${error.message}\n${error.candidates.map((candidate) => `  ${candidate.provider}: ${candidate.path}`).join("\n")}\n`)
  } else if (error instanceof Error) {
    process.stderr.write(`cxp: ${error.message}\n`)
    if (error instanceof SessionNotFoundError) process.stderr.write("Run cxp --help for usage.\n")
  } else {
    process.stderr.write(`cxp: ${String(error)}\n`)
  }
  process.exitCode = 1
}
