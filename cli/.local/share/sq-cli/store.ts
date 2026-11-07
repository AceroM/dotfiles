// sq's view of Slack: what conversations exist, which have unreads, and the
// messages inside the one you are looking at.
//
// Everything here is shaped by one constraint — `rtm.connect` is refused on
// this Enterprise Grid (`enterprise_is_restricted`), so there is no websocket
// and no push. What we do have is `client.counts`, which answers in ~200ms with
// the read state of every conversation at once. That single call is the engine:
// it drives the unread badges, and a change to a conversation's `latest` is
// what tells us to re-read its messages. Nothing else polls.
//
// The other half of feeling instant is never waiting for what does not change.
// Channel names, DM partners and display names live in a disk cache that is
// read synchronously at startup, so the sidebar is on screen before the first
// request goes out, and is refreshed behind it.

import { api } from "@dotfiles/slack"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(homedir(), ".cache/sq")
const CACHE_FILE = join(CACHE_DIR, "directory.json")
const CACHE_TTL = 12 * 60 * 60 * 1000 // names drift slowly; a refresh runs behind the cache anyway

export type Kind = "channel" | "dm" | "group"

export interface Conv {
  id: string
  kind: Kind
  name: string // "eng-prod", "andrew.smith", "jordan, shariar"
  unread: boolean
  mentions: number
  lastRead: string
  latest: string // ts of the newest message — the poll compares this
  starred: boolean
  muted: boolean
}

export interface Msg {
  ts: string
  user: string // id; "" for messages with no author (joins, bot posts)
  text: string
  threadTs: string | null
  replyCount: number
  edited: boolean
}

interface Directory {
  saved: number
  convs: Omit<Conv, "unread" | "mentions" | "lastRead" | "latest">[]
  users: Record<string, string> // id -> display name
  self: string // your own user id, for the optimistic echo of what you send
  team: string // workspace url, for "open this in Slack"
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

let users: Record<string, string> = {}
let self = ""
let team = ""

/** Your own user id, once the directory has landed. */
export function selfId(): string {
  return self
}

/** Permalink to a message, which the Slack app claims from the browser. */
export function permalink(channel: string, ts: string): string {
  const base = team || "https://app.slack.com"
  return `${base.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`
}

/**
 * Whatever the last run learned, read straight off disk. Never throws, and
 * never forgets: names picked up since are kept, so calling this twice cannot
 * undo a lookup.
 */
export function cached(): { convs: Conv[]; users: Record<string, string>; stale: boolean } {
  try {
    const d = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Directory
    users = { ...(d.users ?? {}), ...users }
    self = self || (d.self ?? "")
    team = team || (d.team ?? "")
    return {
      convs: (d.convs ?? []).map((c) => ({
        ...c,
        unread: false,
        mentions: 0,
        lastRead: "0",
        latest: "0",
      })),
      users,
      stale: Date.now() - (d.saved ?? 0) > CACHE_TTL,
    }
  } catch {
    return { convs: [], users: {}, stale: true }
  }
}

function save(convs: Conv[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const body: Directory = {
      saved: Date.now(),
      convs: convs.map(({ id, kind, name, starred, muted }) => ({ id, kind, name, starred, muted })),
      users,
      self,
      team,
    }
    writeFileSync(CACHE_FILE, JSON.stringify(body))
  } catch {
    // a cache that cannot be written just means a slower next start
  }
}

/** Display name for an id, or the id itself until the lookup lands. */
export function userName(id: string): string {
  return users[id] ?? id
}

/**
 * Names for ids we have never seen, in one round trip. `users.info` takes a
 * comma-separated list — undocumented, but it is what the desktop client does,
 * and it turns 40 lookups into one. Returns true when anything was learned, so
 * the caller knows to repaint.
 */
export async function learnUsers(ids: string[]): Promise<boolean> {
  const missing = [...new Set(ids.filter((id) => id && !users[id]))]
  if (missing.length === 0) return false
  for (let i = 0; i < missing.length; i += 50) {
    const r = (await api("users.info", { users: missing.slice(i, i + 50).join(",") })) as {
      ok?: boolean
      users?: Array<{ id: string; name?: string; real_name?: string; profile?: { display_name?: string } }>
    }
    for (const u of r.users ?? [])
      users[u.id] = u.profile?.display_name || u.name || u.real_name || u.id
  }
  return true
}

// ---------------------------------------------------------------------------
// The conversation list
// ---------------------------------------------------------------------------

/** Read state for everything, in one call. This is the poll. */
export async function counts(): Promise<Map<string, Pick<Conv, "unread" | "mentions" | "lastRead" | "latest">>> {
  const r = (await api("client.counts", { org_wide_aware: "true" })) as {
    ok?: boolean
    error?: string
    channels?: CountRow[]
    ims?: CountRow[]
    mpims?: CountRow[]
  }
  if (!r.ok) throw new Error(`client.counts — ${r.error ?? "failed"}`)
  const out = new Map<string, Pick<Conv, "unread" | "mentions" | "lastRead" | "latest">>()
  for (const row of [...(r.channels ?? []), ...(r.ims ?? []), ...(r.mpims ?? [])])
    out.set(row.id, {
      unread: Boolean(row.has_unreads),
      mentions: row.mention_count ?? 0,
      lastRead: row.last_read ?? "0",
      latest: row.latest ?? "0",
    })
  return out
}

interface CountRow {
  id: string
  has_unreads?: boolean
  mention_count?: number
  last_read?: string
  latest?: string
}

/**
 * Names and membership. `client.userBoot` hands over every channel you are in
 * plus your DMs in one call; group DMs only arrive as ids from `client.counts`,
 * so their names come from `conversations.genericInfo`, which encodes the
 * members in a slug ("mpdm-jordan--miguel--shariar-1").
 */
export async function directory(mpimIds: string[]): Promise<Conv[]> {
  const boot = (await api("client.userBoot", {})) as {
    ok?: boolean
    error?: string
    self?: { id: string }
    channels?: Array<{ id: string; name?: string; is_archived?: boolean; is_mpim?: boolean }>
    ims?: Array<{ id: string; user: string; is_open?: boolean }>
    starred?: string[]
    prefs?: Record<string, unknown>
    team?: { url?: string }
  }
  if (!boot.ok) throw new Error(`client.userBoot — ${boot.error ?? "failed"}`)

  const me = boot.self?.id ?? ""
  self = me
  team = boot.team?.url ?? ""
  const starred = new Set(boot.starred ?? [])
  const muted = new Set(mutedFrom(boot.prefs))
  const convs: Conv[] = []
  const blank = { unread: false, mentions: 0, lastRead: "0", latest: "0" }

  for (const c of boot.channels ?? []) {
    if (c.is_archived || c.is_mpim) continue
    convs.push({
      id: c.id,
      kind: "channel",
      name: c.name ?? c.id,
      starred: starred.has(c.id),
      muted: muted.has(c.id),
      ...blank,
    })
  }

  await learnUsers((boot.ims ?? []).map((i) => i.user))
  for (const i of boot.ims ?? [])
    convs.push({
      id: i.id,
      kind: "dm",
      name: i.user === me ? `${userName(i.user)} (you)` : userName(i.user),
      starred: starred.has(i.id),
      muted: muted.has(i.id),
      ...blank,
    })

  const unknown = mpimIds.filter((id) => !convs.some((c) => c.id === id))
  if (unknown.length > 0) {
    const info = (await api("conversations.genericInfo", {
      updated_channels: JSON.stringify(Object.fromEntries(unknown.map((id) => [id, 0]))),
    })) as { ok?: boolean; channels?: Array<{ id: string; name?: string }> }
    for (const c of info.channels ?? [])
      convs.push({
        id: c.id,
        kind: "group",
        name: groupName(c.name ?? c.id, userName(me)),
        starred: starred.has(c.id),
        muted: muted.has(c.id),
        ...blank,
      })
  }

  save(convs)
  return convs
}

/** "mpdm-jordan--miguel--shariar-1" -> "jordan, shariar" */
function groupName(slug: string, me: string): string {
  const parts = slug
    .replace(/^mpdm-/, "")
    .replace(/-\d+$/, "")
    .split("--")
    .filter((p) => p && p !== me)
  return parts.length > 0 ? parts.join(", ") : slug
}

/** Muted conversations, out of the notification prefs blob Slack ships. */
function mutedFrom(prefs: Record<string, unknown> | undefined): string[] {
  const flat = String(prefs?.muted_channels ?? "")
    .split(",")
    .filter(Boolean)
  try {
    const all = JSON.parse(String(prefs?.all_notifications_prefs ?? "{}")) as {
      channels?: Record<string, { muted?: boolean }>
    }
    for (const [id, p] of Object.entries(all.channels ?? {})) if (p?.muted) flat.push(id)
  } catch {
    // prefs are advisory; an unparseable blob just means nothing is muted here
  }
  return flat
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function toMsg(m: RawMsg): Msg {
  return {
    ts: m.ts,
    user: m.user ?? m.bot_id ?? "",
    text: m.text ?? "",
    threadTs: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
    replyCount: m.reply_count ?? 0,
    edited: Boolean(m.edited),
  }
}

interface RawMsg {
  ts: string
  user?: string
  bot_id?: string
  text?: string
  thread_ts?: string
  reply_count?: number
  edited?: unknown
  subtype?: string
}

/** Everyone a batch of messages refers to: who wrote them, and who they name. */
function peopleIn(msgs: Msg[]): string[] {
  const ids = msgs.map((m) => m.user)
  for (const m of msgs)
    for (const [, id] of m.text.matchAll(/<@([UWB][A-Z0-9]+)/g)) ids.push(id)
  return ids
}

/** The channel, oldest first. Every name in it is resolved before it returns. */
export async function history(channel: string, limit = 60): Promise<Msg[]> {
  const r = (await api("conversations.history", { channel, limit: String(limit) })) as {
    ok?: boolean
    error?: string
    messages?: RawMsg[]
  }
  if (!r.ok) throw new Error(`history — ${r.error ?? "failed"}`)
  const msgs = (r.messages ?? []).map(toMsg).reverse()
  await learnUsers(peopleIn(msgs))
  return msgs
}

/** One thread, oldest first — the parent message included, as Slack returns it. */
export async function replies(channel: string, ts: string): Promise<Msg[]> {
  const r = (await api("conversations.replies", { channel, ts, limit: "100" })) as {
    ok?: boolean
    error?: string
    messages?: RawMsg[]
  }
  if (!r.ok) throw new Error(`replies — ${r.error ?? "failed"}`)
  const msgs = (r.messages ?? []).map(toMsg)
  await learnUsers(peopleIn(msgs))
  return msgs
}

export async function send(channel: string, text: string, threadTs?: string | null): Promise<void> {
  const r = (await api("chat.postMessage", {
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  })) as { ok?: boolean; error?: string }
  if (!r.ok) throw new Error(r.error ?? "chat.postMessage failed")
}

/** Everything up to `ts` is read. Slack clears the badge everywhere you're signed in. */
export async function markRead(channel: string, ts: string): Promise<void> {
  if (!ts || ts === "0") return
  await api("conversations.mark", { channel, ts })
}

/**
 * Put the newest message back in the unread state. Slack has no "unread" call —
 * `last_read` is a high-water mark, so setting it one tick below the latest
 * message makes that message unread again, badge and all.
 */
export async function markUnread(channel: string, latest: string): Promise<void> {
  if (!latest || latest === "0") return
  const below = latest.replace(/\d+$/, (d) => String(Number(d) - 1).padStart(d.length, "0"))
  await api("conversations.mark", { channel, ts: below })
}
