import { api } from "./index"

export type Api = (method: string, form: Record<string, string>) => Promise<Record<string, unknown>>
export type Message = Record<string, unknown> & { ts: string; thread_ts?: string; text?: string }
type Page = Record<string, unknown> & {
  ok?: boolean
  error?: string
  messages?: Message[]
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
}

/** Keep timestamps as strings: converting a permalink to a number loses microseconds. */
export function parseLink(link: string) {
  const url = new URL(link)
  const match = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10,})(\d{6})\/?$/)
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || !match)
    throw new Error("expected an https://<workspace>.slack.com/archives/<channel>/p<timestamp> link")
  const ts = `${match[2]}.${match[3]}`
  const thread = url.searchParams.get("thread_ts")
  if (thread && !/^\d{10,}\.\d{6}$/.test(thread)) throw new Error("invalid thread_ts in Slack link")
  return { channel: match[1], ts, thread: thread ?? ts, origin: url.origin }
}

export function checked<T extends Record<string, unknown>>(method: string, result: T): T {
  if (!result.ok) throw new Error(`${method}: ${result.error ?? "failed"}`)
  return result
}

/** Read a whole thread, following both reply links and Slack's pagination. */
export async function readThread(link: string, request: Api = api) {
  const target = parseLink(link)
  let root = target.thread
  let cursor = ""
  const messages = new Map<string, Message>()
  const cursors = new Set<string>()
  for (let page = 0; page < 100; page++) {
    const result = checked("conversations.replies", await request("conversations.replies", {
      channel: target.channel, ts: root, limit: "100", ...(cursor ? { cursor } : {}),
    })) as Page
    const batch = result.messages ?? []
    // With a reply's ts, Slack can return only that reply. Restart at its parent.
    const parent = batch[0]?.thread_ts
    if (parent && parent !== root) {
      root = parent
      cursor = ""
      messages.clear()
      cursors.clear()
      continue
    }
    for (const message of batch) messages.set(message.ts, message)
    cursor = result.response_metadata?.next_cursor ?? ""
    if (!cursor) {
      if (result.has_more) throw new Error("Slack returned a partial thread without a pagination cursor")
      if (!messages.size) throw new Error("Slack returned no messages for this link")
      if (!messages.has(target.ts)) throw new Error("the linked message is missing from the returned thread")
      return {
        channel: target.channel,
        linked_ts: target.ts,
        thread_ts: root,
        messages: [...messages.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
        complete: true,
      }
    }
    if (cursors.has(cursor)) throw new Error("Slack repeated a pagination cursor; thread is incomplete")
    cursors.add(cursor)
  }
  throw new Error("thread exceeded 100 API pages; cannot claim a complete read")
}

// Alert bots often put the evidence in blocks and leave only a title in `text`.
function blockText(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(blockText)
  const node = value as Record<string, unknown>
  if (node.type === "link" && typeof node.url === "string")
    return [node.text && node.text !== node.url ? `<${node.url}|${node.text}>` : `<${node.url}>`]
  if (typeof node.text === "string") return [node.text]
  if (node.type === "emoji" && typeof node.name === "string") return [`:${node.name}:`]
  if (node.type === "user" && typeof node.user_id === "string") return [`<@${node.user_id}>`]
  if (node.type === "channel" && typeof node.channel_id === "string") return [`<#${node.channel_id}>`]
  if (node.type === "broadcast" && typeof node.range === "string") return [`<!${node.range}>`]
  if (node.type === "rich_text_section") return [blockText(node.elements).join("")]
  if (typeof node.type === "string" && node.type.startsWith("rich_text"))
    return [blockText(node.elements).join("\n")]
  return [node.text, node.elements, node.fields, node.blocks, node.title, node.description].flatMap(blockText)
}

export function messageText(message: Message): string {
  const parts = [message.text ?? "", ...blockText(message.blocks)]
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments as Record<string, unknown>[]) {
      for (const key of ["pretext", "title", "text", "fallback", "title_link"])
        if (typeof attachment[key] === "string") parts.push(attachment[key] as string)
      parts.push(...blockText(attachment.blocks))
      if (Array.isArray(attachment.fields))
        for (const field of attachment.fields as Record<string, unknown>[])
          parts.push([field.title, field.value].filter(v => typeof v === "string").join(": "))
    }
  }
  if (Array.isArray(message.files)) {
    for (const file of message.files as Record<string, unknown>[])
      parts.push(`File: ${file.title ?? file.name ?? file.id} ${file.permalink ?? ""}`)
  }
  return [...new Set(parts.filter(Boolean))].join("\n\n")
}

export function formatMessage(message: Message, channel?: string, origin?: string): string {
  const profile = message.bot_profile as { name?: string } | undefined
  const author = profile?.name ?? message.user ?? message.bot_id ?? "unknown"
  const date = new Date(Number(message.ts.split(".")[0]) * 1000).toISOString()
  const permalink = message.permalink ?? (channel && origin
    ? `${origin}/archives/${channel}/p${message.ts.replace(".", "")}` : "")
  return `[${date}] ${author} (${message.ts})\n${permalink}\n${messageText(message)}`
}
