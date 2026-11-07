#!/usr/bin/env bun
//
// sq — Slack in the terminal.
//
// A conversation list on the left, the messages on the right, and a line to
// type in. Built so that nothing has to interrupt you: the unread counts are
// here when you come looking, instead of arriving as a banner.
//
//   list     j/k move · enter open · u toggle unread · a unread only
//            / filter · r refresh · q quit
//   chat     j/k move · enter or i write · t thread · o open in slack
//            u unread and back · esc back
//   writing  enter send · esc cancel · ctrl+w word · ctrl+u clear

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
import {
  cached,
  counts,
  directory,
  history,
  markRead,
  markUnread,
  permalink,
  replies,
  selfId,
  send,
  userName,
  type Conv,
  type Msg,
} from "./store"
import { clock, fit, render as renderText, wrap } from "./format"

// client.counts answers in ~200ms and carries every conversation's read state,
// so this one poll is the whole live story: badges, and the "latest" that tells
// us the open conversation has moved on.
const POLL_MS = 2500
const SIDEBAR = 24

const ACCENT = "#74ade8" // Zed One Dark accent
const DANGER = "#e06c75"
const MINE = "#98c379"
const SELECTED_BG = "#3a4b5f"

interface State {
  convs: Conv[]
  mode: "list" | "chat"
  cursor: number // index into the ordered sidebar
  openId: string | null
  msgs: Msg[]
  seenLatest: string // the ts the open conversation was at when we last read it
  thread: { ts: string; msgs: Msg[] } | null
  msgCursor: number
  filter: string
  filtering: boolean
  unreadOnly: boolean
  compose: string | null // null when not writing
  sending: boolean
  status: string
  error: string
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * What the sidebar shows, in the order it shows it. Unreads climb to the top —
 * mentions above the rest — and everything else falls back to most recent.
 * Muted conversations never climb: being muted is the whole point of muting.
 */
function ordered(s: State): Conv[] {
  const needle = s.filter.trim().toLowerCase()
  const rank = (c: Conv) => (c.muted ? 2 : c.mentions > 0 ? 0 : c.unread ? 1 : 2)
  return s.convs
    .filter((c) => {
      if (needle) return c.name.toLowerCase().includes(needle)
      if (s.unreadOnly) return c.unread
      return c.unread || c.latest !== "0" // a channel you have never touched is just noise
    })
    .sort((a, b) => rank(a) - rank(b) || Number(b.latest) - Number(a.latest))
}

// ---------------------------------------------------------------------------
// Message pane
// ---------------------------------------------------------------------------

interface Line {
  text: string
  kind: "head" | "body" | "meta"
  msg: number // index into the message array, for the selection gutter
  mine: boolean
}

/** Messages -> the exact lines the pane will draw, so scrolling can count them. */
function layout(
  msgs: Msg[],
  width: number,
  me: string,
  channel: (id: string) => string,
): Line[] {
  const lines: Line[] = []
  let lastUser = ""
  let lastAt = 0
  msgs.forEach((m, i) => {
    const at = Number(m.ts)
    const mine = m.user === me
    if (m.user !== lastUser || at - lastAt > 300) {
      lines.push({
        text: `${clock(m.ts)}  ${userName(m.user) || "unknown"}`,
        kind: "head",
        msg: i,
        mine,
      })
    }
    for (const line of wrap(renderText(m.text, userName, channel), width - 2))
      lines.push({ text: line, kind: "body", msg: i, mine })
    if (m.replyCount > 0)
      lines.push({
        text: `↳ ${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"} · t to open`,
        kind: "meta",
        msg: i,
        mine,
      })
    lastUser = m.user
    lastAt = at
  })
  return lines
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

// Read once, here: a useRef initializer runs on every render, and re-reading
// the cache each repaint both costs a synchronous file read and throws away the
// display names looked up since startup.
const START = cached()

function App() {
  const { exit } = useApp()
  const { stdout } = useStdout()

  // One state object behind a ref: the keyboard handler reads it synchronously
  // (key repeats outrun React's render), and every write repaints.
  const ref = useRef<State>({
    convs: START.convs,
    mode: "list",
    cursor: 0,
    openId: null,
    msgs: [],
    seenLatest: "",
    thread: null,
    msgCursor: 0,
    filter: "",
    filtering: false,
    unreadOnly: false,
    compose: null,
    sending: false,
    status: "",
    error: "",
  })
  const [, repaint] = useState(0)
  const set = (patch: Partial<State>) => {
    ref.current = { ...ref.current, ...patch }
    repaint((n) => n + 1)
  }
  const s = ref.current

  // --- loading -------------------------------------------------------------

  const loadHistory = async (id: string, latest: string) => {
    try {
      const msgs = await history(id)
      if (ref.current.openId !== id) return // you moved on while it was in flight
      const pinned = ref.current.msgCursor >= ref.current.msgs.length - 1
      set({
        msgs,
        seenLatest: latest,
        msgCursor: pinned ? Math.max(0, msgs.length - 1) : ref.current.msgCursor,
        error: "",
      })
      // reading it here is reading it: clear the badge on every other client too
      if (msgs.length > 0) markRead(id, msgs[msgs.length - 1].ts).catch(() => {})
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }

  const refreshNames = async () => {
    try {
      const rows = await counts()
      const convs = await directory([...rows.keys()])
      set({ convs: convs.map((c) => ({ ...c, ...(rows.get(c.id) ?? {}) })) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  }

  // The poll. Counts first — it is the cheap one — and only then the pieces it
  // says have changed.
  useEffect(() => {
    let alive = true
    let naming = false
    const tick = async () => {
      let rows: Awaited<ReturnType<typeof counts>>
      try {
        rows = await counts()
      } catch (e) {
        if (alive) set({ error: (e as Error).message })
        return
      }
      if (!alive) return
      const cur = ref.current
      const convs = cur.convs.map((c) => ({ ...c, ...(rows.get(c.id) ?? {}) }))
      set({ convs, error: "" })

      // A name we have never seen — a new DM, a channel joined elsewhere, or a
      // cold cache. Fetch the directory once, not on every tick.
      const unknown = [...rows.keys()].some((id) => !convs.some((c) => c.id === id))
      if ((unknown || convs.length === 0) && !naming) {
        naming = true
        refreshNames().finally(() => {
          naming = false
        })
      }

      const open = cur.openId
      if (open && !cur.thread) {
        const latest = rows.get(open)?.latest ?? ""
        if (latest && latest !== cur.seenLatest) loadHistory(open, latest)
      }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (!s.status) return
    const t = setTimeout(() => set({ status: "" }), 1800)
    return () => clearTimeout(t)
  }, [s.status])

  // --- actions -------------------------------------------------------------

  const open = (conv: Conv) => {
    set({
      openId: conv.id,
      mode: "chat",
      msgs: [],
      thread: null,
      msgCursor: 0,
      seenLatest: conv.latest,
    })
    loadHistory(conv.id, conv.latest)
  }

  const toggleUnread = (conv: Conv) => {
    const next = !conv.unread
    // Paint the new state now and let Slack catch up; a badge that waits on a
    // round trip feels broken.
    set({
      convs: ref.current.convs.map((c) =>
        c.id === conv.id ? { ...c, unread: next, mentions: next ? Math.max(1, c.mentions) : 0 } : c,
      ),
      status: next ? `${conv.name} marked unread` : `${conv.name} marked read`,
    })
    const call = next ? markUnread(conv.id, conv.latest) : markRead(conv.id, conv.latest)
    call.catch((e: Error) => set({ error: e.message }))
  }

  const openThread = () => {
    const cur = ref.current
    const m = cur.msgs[cur.msgCursor]
    if (!cur.openId || !m) return
    const root = m.threadTs ?? m.ts
    if (!m.threadTs && m.replyCount === 0) {
      set({ status: "no thread on this message" })
      return
    }
    set({ thread: { ts: root, msgs: [] }, msgCursor: 0 })
    replies(cur.openId, root)
      .then((msgs) => {
        if (ref.current.thread?.ts !== root) return
        set({ thread: { ts: root, msgs }, msgCursor: Math.max(0, msgs.length - 1) })
      })
      .catch((e: Error) => set({ error: e.message, thread: null }))
  }

  const sendCompose = () => {
    const cur = ref.current
    const text = (cur.compose ?? "").trim()
    if (!cur.openId || !text || cur.sending) return
    const channel = cur.openId
    const threadTs = cur.thread?.ts ?? null
    // Echo it immediately; the next poll replaces it with Slack's own copy.
    const echo: Msg = {
      ts: String(Date.now() / 1000),
      user: selfId(),
      text,
      threadTs,
      replyCount: 0,
      edited: false,
    }
    const msgs = [...(cur.thread ? cur.thread.msgs : cur.msgs), echo]
    set({
      compose: null,
      sending: false,
      ...(cur.thread ? { thread: { ts: cur.thread.ts, msgs } } : { msgs }),
      msgCursor: msgs.length - 1,
    })
    send(channel, text, threadTs).catch((e: Error) => {
      // take the echo back and hand the words back to the composer
      const cur2 = ref.current
      const without = (list: Msg[]) => list.filter((m) => m.ts !== echo.ts)
      set({
        error: `not sent — ${e.message}`,
        compose: text,
        msgs: without(cur2.msgs),
        ...(cur2.thread ? { thread: { ts: cur2.thread.ts, msgs: without(cur2.thread.msgs) } } : {}),
      })
    })
  }

  // --- keyboard ------------------------------------------------------------

  const editCompose = (edit: (t: string) => string) =>
    set({ compose: edit(ref.current.compose ?? "") })

  useInput((input, key) => {
    const cur = ref.current
    const list = ordered(cur)

    // Writing owns the keyboard: every printable key is text.
    if (cur.compose !== null) {
      if (key.escape) set({ compose: null })
      else if (key.return) sendCompose()
      else if (key.backspace || key.delete) editCompose((t) => t.slice(0, -1))
      else if (key.ctrl && input === "u") editCompose(() => "")
      else if (key.ctrl && input === "w") editCompose((t) => t.replace(/\s*\S+\s*$/, ""))
      else if (input && !key.ctrl && !key.meta)
        editCompose((t) => t + input.replace(/\s+/g, " "))
      return
    }

    // So does the filter box.
    if (cur.filtering) {
      if (key.escape) set({ filtering: false, filter: "", cursor: 0 })
      else if (key.return) set({ filtering: false })
      else if (key.backspace || key.delete) set({ filter: cur.filter.slice(0, -1), cursor: 0 })
      else if (input && !key.ctrl && !key.meta) set({ filter: cur.filter + input, cursor: 0 })
      return
    }

    if (cur.mode === "chat") {
      const shown = cur.thread ? cur.thread.msgs : cur.msgs
      if (key.escape) {
        if (cur.thread) set({ thread: null, msgCursor: Math.max(0, cur.msgs.length - 1) })
        else set({ mode: "list" })
      } else if (input === "q") {
        exit()
      } else if (input === "j" || key.downArrow) {
        set({ msgCursor: Math.min(cur.msgCursor + 1, shown.length - 1) })
      } else if (input === "k" || key.upArrow) {
        set({ msgCursor: Math.max(cur.msgCursor - 1, 0) })
      } else if (input === "G") {
        set({ msgCursor: Math.max(0, shown.length - 1) })
      } else if (key.return || input === "i" || input === "c") {
        set({ compose: "" })
      } else if (input === "t") {
        openThread()
      } else if (input === "o") {
        const m = shown[cur.msgCursor]
        if (cur.openId && m)
          Bun.spawn(["open", permalink(cur.openId, m.ts)], { stdout: "ignore", stderr: "ignore" })
      } else if (input === "u") {
        const conv = cur.convs.find((c) => c.id === cur.openId)
        if (conv) {
          toggleUnread({ ...conv, unread: false })
          set({ mode: "list", openId: null, thread: null })
        }
      }
      return
    }

    // list
    if (input === "q" || (key.escape && !cur.filter)) {
      exit()
    } else if (key.escape) {
      set({ filter: "", cursor: 0 })
    } else if (input === "j" || key.downArrow) {
      set({ cursor: Math.min(cur.cursor + 1, Math.max(0, list.length - 1)) })
    } else if (input === "k" || key.upArrow) {
      set({ cursor: Math.max(cur.cursor - 1, 0) })
    } else if (key.return || input === "l") {
      const conv = list[Math.min(cur.cursor, list.length - 1)]
      if (conv) open(conv)
    } else if (input === "u") {
      const conv = list[Math.min(cur.cursor, list.length - 1)]
      if (conv) toggleUnread(conv)
    } else if (input === "a") {
      set({ unreadOnly: !cur.unreadOnly, cursor: 0 })
    } else if (input === "/") {
      set({ filtering: true, filter: "", cursor: 0 })
    } else if (input === "r") {
      set({ status: "refreshing…" })
      refreshNames()
    }
  })

  // --- render --------------------------------------------------------------

  const width = stdout.columns ?? 100
  const composeH = s.compose !== null ? 3 : 0
  const height = Math.max(4, (stdout.rows ?? 30) - 3 - composeH)
  const paneW = Math.max(20, width - SIDEBAR - 2)

  const list = ordered(s)
  const cursor = Math.min(s.cursor, Math.max(0, list.length - 1))
  const unreadTotal = s.convs.filter((c) => c.unread && !c.muted).length
  const conv = s.convs.find((c) => c.id === s.openId) ?? null
  const shown = s.thread ? s.thread.msgs : s.msgs

  // sidebar window
  const sideTop = Math.max(0, Math.min(cursor - Math.floor(height / 2), list.length - height))
  const sideRows = list.slice(sideTop, sideTop + height)

  // message window: keep the selected message on screen, otherwise sit on the
  // newest, which is where a chat should be
  const named = (id: string) => s.convs.find((c) => c.id === id)?.name ?? id
  const bodyH = Math.max(1, height - 1) // the pane's own title row
  const lines = layout(shown, paneW, selfId(), named)
  const sel = Math.min(s.msgCursor, Math.max(0, shown.length - 1))
  const first = lines.findIndex((l) => l.msg === sel)
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.msg === sel)
  let top = Math.max(0, lines.length - bodyH)
  if (first >= 0 && first < top) top = Math.max(0, first - 2)
  if (last >= 0 && last > top + bodyH - 1) top = Math.max(0, last - bodyH + 1)
  const paneLines = lines.slice(top, top + bodyH)

  const typed = s.compose ?? ""
  const inputW = Math.max(12, width - 6)
  const shownInput = typed.length > inputW ? `…${typed.slice(-(inputW - 1))}` : typed

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold> sq</Text>
        <Text dimColor>
          {" "}
          · {unreadTotal} unread{s.unreadOnly ? " · unread only" : ""}
        </Text>
        {s.filtering || s.filter ? <Text color={ACCENT}> · /{s.filter}</Text> : null}
        {s.status ? <Text color={ACCENT}> · {s.status}</Text> : null}
        {s.error ? <Text color={DANGER}> · {s.error}</Text> : null}
      </Box>

      <Box flexGrow={1}>
        {/* conversations */}
        <Box flexDirection="column" flexShrink={0} width={SIDEBAR + 1}>
          {Array.from({ length: height }, (_, i) => {
            const c = sideRows[i]
            const selected = c && sideTop + i === cursor && s.mode === "list"
            const bg = selected ? SELECTED_BG : undefined
            if (!c)
              return (
                <Text key={`pad${i}`} dimColor>
                  {" ".repeat(SIDEBAR)}│
                </Text>
              )
            const badge = c.mentions > 0 ? String(c.mentions) : c.unread ? "·" : ""
            const label = `${c.kind === "channel" ? "#" : ""}${c.name}`
            return (
              <Text key={c.id} backgroundColor={bg} wrap="truncate-end">
                <Text color={c.mentions > 0 && !c.muted ? ACCENT : undefined} backgroundColor={bg}>
                  {c.unread && !c.muted ? " ●" : "  "}
                </Text>
                <Text
                  bold={c.unread && !c.muted}
                  dimColor={!c.unread && !selected}
                  backgroundColor={bg}
                >
                  {fit(label, SIDEBAR - 5)}
                </Text>
                <Text color={ACCENT} backgroundColor={bg}>
                  {badge.padStart(2)}
                </Text>
                <Text dimColor backgroundColor={bg}>
                  {" │"}
                </Text>
              </Text>
            )
          })}
        </Box>

        {/* messages */}
        <Box flexDirection="column" flexGrow={1}>
          {!conv ? (
            <Text dimColor> pick a conversation · enter opens it</Text>
          ) : (
            <>
              <Text wrap="truncate-end">
                <Text bold color={ACCENT}>
                  {" "}
                  {conv.kind === "channel" ? "#" : ""}
                  {conv.name}
                </Text>
                {s.thread ? <Text dimColor> · thread</Text> : null}
                {shown.length === 0 ? <Text dimColor> · loading…</Text> : null}
              </Text>
              {paneLines.map((l, i) => (
                <Text key={`${top + i}`} wrap="truncate-end">
                  <Text color={ACCENT}>
                    {/* the marker goes on the message's first line whatever it
                        is: consecutive messages from one author share a header,
                        so a body line is often all a message has */}
                    {top + i === first && s.mode === "chat" ? "▸" : " "}
                  </Text>
                  {l.kind === "head" ? (
                    <Text bold color={l.mine ? MINE : undefined}>
                      {l.text}
                    </Text>
                  ) : l.kind === "meta" ? (
                    <Text dimColor color={ACCENT}>
                      {"      "}
                      {l.text}
                    </Text>
                  ) : (
                    <Text>
                      {" "}
                      {l.text}
                    </Text>
                  )}
                </Text>
              ))}
            </>
          )}
        </Box>
      </Box>

      {s.compose !== null ? (
        <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text wrap="truncate-end">
            <Text color={ACCENT}>{"❯ "}</Text>
            <Text>{shownInput}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}

      <Text dimColor wrap="truncate-end">
        {" "}
        {s.compose !== null
          ? "enter send · esc cancel · ctrl+w word · ctrl+u clear"
          : s.mode === "chat"
            ? "j/k move · enter write · t thread · o slack · u unread · esc back · q quit"
            : "j/k move · enter open · u unread · a unread only · / filter · r refresh · q quit"}
      </Text>
    </Box>
  )
}

await (await render(<App />)).waitUntilExit()
