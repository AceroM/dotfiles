#!/usr/bin/env bun
//
// sn — live Slack notification inbox.
//
// Tails the feed Hammerspoon's notifications.lua writes for every Slack
// notification macOS records (Focus or not), newest first. Slack only records
// what your notification prefs allow: set a channel to "All new messages" to
// see it here.
//
//   j/k or arrows  move
//   enter or l     open the message in Slack
//   c              reply from here, as you (see slack.ts)
//   r              same, but threaded onto the message
//   q / esc        quit

import React, {
  Box,
  Text,
  render,
  useApp,
  useEffect,
  useInput,
  useRef,
  useState,
  useStdout,
} from "@dotfiles/opentui-cli"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { creds, reply, saveToken, type ReplyTarget } from "./slack"

const FEED = join(homedir(), ".local/state/slack-notifications.jsonl")
const MAX_ROWS = 400
const ACCENT = "#4aae8c" // same green as the Hammerspoon toast accent
const DANGER = "#e06c75"
const SELECTED_BG = "#39455a" // explicit slate; terminal-default `inverse` is unreliable

interface Notif {
  date: number // unix seconds
  title: string // workspace ("Numeral HQ")
  subtitle: string // channel or DM sender
  body: string
  iden: string
  link: string | null
  channel: string | null // set once notifdb.py matched the Slack log; needed to reply
  ts: string | null
  thread_ts: string | null
}

// A reply being typed. Rows without a channel cannot be answered — notifdb.py
// only learns the channel id when the notification is still in Slack's log.
interface Draft {
  iden: string
  target: ReplyTarget
  where: string // header label: the channel/sender, plus "· thread" when threaded
  text: string
  sending: boolean
  error: string | null
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

function loadFeed(): Notif[] {
  let raw = ""
  try {
    raw = readFileSync(FEED, "utf8")
  } catch {
    return []
  }
  const byIden = new Map<string, Notif>()
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (!row.iden || row.bundle !== "com.tinyspeck.slackmacgap") continue
      byIden.set(row.iden, {
        date: row.date ?? 0,
        title: row.title ?? "",
        subtitle: row.subtitle ?? "",
        body: (row.body ?? "").replace(/\s+/g, " ").trim(),
        iden: row.iden,
        link: row.link ?? null,
        channel: row.channel ?? null,
        ts: row.ts ?? null,
        thread_ts: row.thread_ts ?? null,
      })
    } catch {
      // torn write mid-append; the next poll re-reads a complete line
    }
  }
  return [...byIden.values()].sort((a, b) => b.date - a.date).slice(0, MAX_ROWS)
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function timeLabel(unix: number): string {
  const d = new Date(unix * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function pad(text: string, width: number): string {
  return text.length > width ? text.slice(0, width - 1) + "…" : text.padEnd(width)
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [rows, setRows] = useState<Notif[]>(loadFeed)
  const [cursor, setCursor] = useState(0)
  const [flash, setFlash] = useState("")
  const [draft, setDraft] = useState<Draft | null>(null)
  const feedSize = useRef(-1)
  // Key repeats and pastes deliver many events before React re-renders, so the
  // draft lives in a ref and state only mirrors it for display.
  const draftRef = useRef<Draft | null>(null)

  // Live tail: poll the feed's size and re-read on growth (it is small — the
  // Hammerspoon side prunes it). fs.watch misses atomic rewrites, so poll.
  useEffect(() => {
    const tick = () => {
      let size = 0
      try {
        size = statSync(FEED).size
      } catch {
        size = 0
      }
      if (size !== feedSize.current) {
        feedSize.current = size
        setRows(loadFeed())
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  const clampedCursor = Math.min(cursor, Math.max(0, rows.length - 1))

  const putDraft = (d: Draft | null) => {
    draftRef.current = d
    setDraft(d)
  }

  const editDraft = (edit: (text: string) => string) => {
    const d = draftRef.current
    if (!d || d.sending) return
    putDraft({ ...d, text: edit(d.text) })
  }

  // Open the box straight away and resolve credentials behind it, so typing can
  // start while the Keychain and Slack round-trips run.
  //
  // "reply" answers where the message already lives — inside its thread when it
  // is threaded, in the channel otherwise. "thread" always answers in a thread,
  // opening one on a top-level message. The two only differ on a top-level row.
  const openDraft = (row: Notif, mode: "reply" | "thread") => {
    if (!row.channel || !row.ts) {
      setFlash("no channel on this row — open it in Slack instead")
      return
    }
    const thread_ts = mode === "thread" ? (row.thread_ts ?? row.ts) : row.thread_ts
    const where = row.subtitle || row.title || row.channel
    putDraft({
      iden: row.iden,
      target: { channel: row.channel, ts: row.ts, thread_ts },
      where: thread_ts ? `${where} · thread` : where,
      text: "",
      sending: false,
      error: null,
    })
    creds().catch((e: Error) => {
      const d = draftRef.current
      if (d?.iden === row.iden) putDraft({ ...d, error: e.message })
    })
  }

  const sendDraft = () => {
    const d = draftRef.current
    if (!d || d.sending || !d.text.trim()) return
    putDraft({ ...d, sending: true, error: null })
    reply(d.target, d.text.trim())
      .then(() => {
        putDraft(null)
        setFlash(`replied in ${d.where}`)
      })
      .catch((e: Error) => {
        const cur = draftRef.current
        if (cur?.iden === d.iden) putDraft({ ...cur, sending: false, error: e.message })
      })
  }

  useInput((input, key) => {
    // The reply box owns the keyboard while it is open: every printable key is
    // text, so `q` types a q rather than quitting, and escape only closes it.
    const d = draftRef.current
    if (d) {
      if (key.escape) putDraft(null)
      else if (d.sending) return // in flight; only escape gets out
      else if (key.return) sendDraft()
      else if (key.backspace || key.delete) editDraft((t) => t.slice(0, -1))
      else if (key.ctrl && input === "u") editDraft(() => "")
      else if (key.ctrl && input === "w") editDraft((t) => t.replace(/\s*\S+\s*$/, ""))
      else if (input && !key.ctrl && !key.meta)
        // a paste arrives as one chunk; flatten it onto the single input line
        editDraft((t) => t + input.replace(/\s+/g, " "))
      return
    }

    if (input === "q" || key.escape) {
      exit()
      return
    }
    if (rows.length === 0) return
    const row = rows[clampedCursor]

    if (input === "c") {
      openDraft(row, "reply")
    } else if (input === "r") {
      openDraft(row, "thread")
    } else if (input === "j" || key.downArrow) {
      // functional update: key repeats can land within one render frame
      setCursor((c) => Math.min(c + 1, rows.length - 1))
    } else if (input === "k" || key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0))
    } else if (key.return || input === "l") {
      const url = row.link ?? "slack://open"
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
      setFlash(row.link ? `opened ${row.subtitle}` : "no channel link — opened Slack")
    }
  })

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(""), 1500)
    return () => clearTimeout(t)
  }, [flash])

  // border rows plus destination / input / hint, when the box is up
  const draftH = draft ? 5 : 0
  const height = Math.max(6, (stdout.rows ?? 30) - 4 - draftH) // header + hints + padding
  const width = stdout.columns ?? 100
  const channelWidth = Math.max(12, Math.min(24, Math.floor(width * 0.2)))

  // The Text shim truncates at the end, so window the draft by hand and keep the
  // tail — where the cursor is — visible on a long reply.
  const inputW = Math.max(12, width - 8)
  const typed = draft?.text ?? ""
  const shownDraft = typed.length > inputW ? `…${typed.slice(-(inputW - 1))}` : typed

  // Keep the selection inside the visible window.
  const top = Math.max(0, Math.min(clampedCursor - Math.floor(height / 2), rows.length - height))
  const visible = rows.slice(top, top + height)

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold> sn</Text>
        <Text dimColor> — slack notifications · {rows.length} shown</Text>
        {flash ? <Text color={ACCENT}> · {flash}</Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {rows.length === 0 ? (
          <Box flexDirection="column">
            <Text> </Text>
            <Text dimColor> no notifications yet</Text>
            <Text dimColor>
              {" "}
              hammerspoon appends every slack notification to{" "}
            </Text>
            <Text dimColor> ~/.local/state/slack-notifications.jsonl</Text>
            {!existsSync(FEED) ? (
              <Text color={DANGER}> feed file missing — is Hammerspoon running?</Text>
            ) : null}
          </Box>
        ) : (
          visible.map((row, i) => {
            const selected = top + i === clampedCursor
            // Explicit colors throughout: `inverse` swaps whatever the terminal's
            // defaults happen to be and renders inconsistently span to span.
            const bg = selected ? SELECTED_BG : undefined
            const fg = selected ? "#ffffff" : undefined
            return (
              <Text key={row.iden} wrap="truncate-end" backgroundColor={bg}>
                <Text color={ACCENT} backgroundColor={bg}>
                  {selected ? " ▸ " : "   "}
                </Text>
                <Text color={fg} dimColor={!selected} backgroundColor={bg}>
                  {pad(timeLabel(row.date), 7)}
                </Text>
                <Text color={fg} bold backgroundColor={bg}>
                  {pad(row.subtitle || row.title, channelWidth)}
                </Text>
                <Text color={fg} backgroundColor={bg}>
                  {" "}
                  {row.body}
                </Text>
              </Text>
            )
          })
        )}
      </Box>
      {/* reply box: esc closes, enter posts to the channel or thread */}
      {draft ? (
        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle="round"
          borderColor={draft.error ? DANGER : ACCENT}
          paddingX={1}
        >
          <Text wrap="truncate-end">
            <Text bold color={ACCENT}>
              reply
            </Text>
            <Text dimColor>{" → "}</Text>
            <Text>{draft.where}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={ACCENT}>{"❯ "}</Text>
            <Text>{shownDraft}</Text>
            {draft.sending ? null : <Text inverse> </Text>}
          </Text>
          <Text dimColor={!draft.error} color={draft.error ? DANGER : undefined} wrap="truncate-end">
            {draft.error
              ? draft.error
              : draft.sending
                ? "sending…"
                : "enter send · esc cancel · ctrl+w word · ctrl+u clear"}
          </Text>
        </Box>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {" "}
        j/k move · enter/l open in slack · c reply · r thread · q quit
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

// `sn auth --token xoxc-…` is the escape hatch for when Slack has rotated its
// token into a compacted leveldb block the scan cannot read. Copy it out of the
// Slack app's devtools (Application -> Local Storage -> localConfig_v2).
const argv = process.argv.slice(2)
if (argv[0] === "auth") {
  const token = argv[argv.indexOf("--token") + 1]
  if (!argv.includes("--token") || !token) {
    console.error("usage: sn auth --token xoxc-…")
    process.exit(2)
  }
  try {
    await saveToken(token)
    console.log("token saved to the login Keychain")
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
} else {
  await (await render(<App />)).waitUntilExit()
}
