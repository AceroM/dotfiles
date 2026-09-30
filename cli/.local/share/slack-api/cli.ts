import { api, channelId } from "./index"
import { checked, formatMessage, parseLink, readThread, type Message } from "./read"

const HELP = `Read Slack through the signed-in desktop session (macOS + Bun).

  slack-agent read <message-url> [--json]                 Full thread, including blocks
  slack-agent search '<query>' [--limit 20] [--page 1] [--json]
  slack-agent history '<#channel-or-id>' [--limit 20] [--cursor <cursor>] [--json]
  slack-agent whoami [--json]

Search accepts Slack filters: in:channel, from:user, after:YYYY-MM-DD.
Search/history return one page and expose pagination. This CLI only reads.`

function parseArgs(args: string[]) {
  const positional: string[] = []
  const options: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--json") { options.json = "true"; continue }
    if (["--limit", "--page", "--cursor"].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`)
      options[arg.slice(2)] = value
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`)
    else positional.push(arg)
  }
  return { positional, options }
}

function integer(value: string, max: number, name: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
    throw new Error(`${name} must be between 1 and ${max}`)
  return value
}

async function main(args: string[]) {
  if (!args.length || args.includes("--help") || args[0] === "help") { console.log(HELP); return }
  const [command, ...rest] = args
  if (!["read", "search", "history", "whoami"].includes(command)) throw new Error(`unknown command: ${command}`)
  const { positional, options } = parseArgs(rest)
  const allowed = command === "search" ? ["json", "limit", "page"]
    : command === "history" ? ["json", "limit", "cursor"] : ["json"]
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`)
  if (positional.length !== (command === "whoami" ? 0 : 1)) throw new Error(`invalid arguments for ${command}; run slack-agent --help`)
  const json = Boolean(options.json)
  if (command === "read") {
    const link = positional[0]
    const result = await readThread(link)
    if (json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`Thread ${result.channel} / ${result.thread_ts} (${result.messages.length} messages; complete)\n`)
      console.log(result.messages.map(m => formatMessage(m, result.channel, parseLink(link).origin)).join("\n\n---\n\n"))
    }
  } else if (command === "search") {
    const result = checked("search.messages", await api("search.messages", {
      query: positional[0], count: integer(options.limit ?? "20", 100, "limit"),
      page: integer(options.page ?? "1", 100, "page"), sort: "timestamp", sort_dir: "desc", highlight: "false",
    }))
    if (json) console.log(JSON.stringify(result, null, 2))
    else {
      const messages = result.messages as { matches?: Message[]; total?: number; pagination?: { page?: number; page_count?: number } } | undefined
      console.log(`${messages?.total ?? 0} matches; page ${messages?.pagination?.page ?? 1}/${messages?.pagination?.page_count ?? 1}\n`)
      console.log((messages?.matches ?? []).map(m => formatMessage(m)).join("\n\n---\n\n"))
    }
  } else if (command === "history") {
    const limit = integer(options.limit ?? "20", 100, "limit")
    const channel = /^[CDG][A-Z0-9]+$/.test(positional[0]) ? positional[0] : await channelId(positional[0])
    const result = checked("conversations.history", await api("conversations.history", {
      channel, limit, ...(options.cursor ? { cursor: options.cursor } : {}),
    }))
    if (json) console.log(JSON.stringify({ ...result, channel }, null, 2))
    else {
      const metadata = result.response_metadata as { next_cursor?: string } | undefined
      console.log(`Channel ${channel}; has_more=${Boolean(result.has_more)}; next_cursor=${metadata?.next_cursor ?? ""}\n`)
      console.log((result.messages as Message[] ?? []).map(m => formatMessage(m)).join("\n\n---\n\n"))
    }
  } else {
    const result = checked("auth.test", await api("auth.test", {}))
    if (json) console.log(JSON.stringify(result, null, 2))
    else console.log(`${result.team} (${result.team_id}) · ${result.user} (${result.user_id})\n${result.url}`)
  }
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)) }
  catch (error) { console.error(`slack-agent: ${(error as Error).message}`); process.exitCode = 1 }
}
