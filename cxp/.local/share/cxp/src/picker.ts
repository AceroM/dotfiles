import { BoxRenderable, CliRenderEvents, TextRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"
import type { RecentConversation } from "./model"

export interface PickerState { selectedPath?: string; query: string }

export async function pickConversation(
  conversations: RecentConversation[],
  state: PickerState,
  error = "",
): Promise<RecentConversation | undefined> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, clearOnShutdown: true, backgroundColor: "#0B1016" })
  renderer.setTerminalTitle("cxp · recent conversations")
  const app = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", paddingX: 1 })
  const header = new TextRenderable(renderer, { height: 1, truncate: true })
  const list = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: "#405064", paddingX: 1 })
  const detail = new BoxRenderable(renderer, { height: 2, flexShrink: 0, flexDirection: "column" })
  const detailTitle = new TextRenderable(renderer, { height: 1, truncate: true, fg: "#718096" })
  const detailPath = new TextRenderable(renderer, { height: 1, truncate: true, fg: "#718096" })
  detail.add(detailTitle)
  detail.add(detailPath)
  const footer = new TextRenderable(renderer, { height: 1, truncate: true, fg: "#718096" })
  app.add(header)
  app.add(list)
  app.add(detail)
  app.add(footer)
  renderer.root.add(app)
  let filtered: RecentConversation[] = []
  let selected = 0
  let searching = false
  let draft = state.query
  let result: RecentConversation | undefined
  const pageSize = () => Math.max(1, Math.floor((renderer.height - 6) / 2))
  const filter = () => {
    const query = state.query.toLowerCase()
    filtered = conversations.filter((c) => [c.title, c.cwd, c.provider, c.id, c.path].join(" ").toLowerCase().includes(query))
    selected = Math.max(0, filtered.findIndex((c) => c.path === state.selectedPath))
  }
  const draw = () => {
    const current = filtered[selected]
    state.selectedPath = current?.path
    header.content = t`${bold(fg("#64D2FF")("cxp"))}  recent conversations · ${filtered.length}/${conversations.length} · newest first`
    for (const child of list.getChildren()) child.destroyRecursively()
    const size = pageSize()
    const start = Math.floor(selected / size) * size
    for (const [offset, conversation] of filtered.slice(start, start + size).entries()) {
      const active = start + offset === selected
      const row = new BoxRenderable(renderer, { height: 2, flexShrink: 0, flexDirection: "column", backgroundColor: active ? "#17202B" : "#0B1016" })
      row.add(new TextRenderable(renderer, { height: 1, truncate: true, content: t`${fg(active ? "#64D2FF" : "#718096")(active ? "❯ " : "  ")}${fg(conversation.provider === "codex" ? "#9BE9A8" : "#C7A7FF")(conversation.provider.padEnd(6))}  ${fg("#D7DEE7")(conversation.title)}` }))
      row.add(new TextRenderable(renderer, { height: 1, truncate: true, fg: "#718096", content: `    ${new Date(conversation.modifiedAt).toLocaleString()} · ${conversation.cwd || "unknown project"} · ${conversation.id}` }))
      list.add(row)
    }
    if (!filtered.length) list.add(new TextRenderable(renderer, { content: conversations.length ? "No conversations match this filter." : "No JSONL conversations found." }))
    detailTitle.content = error || current?.title || ""
    detailPath.content = current?.path || ""
    const keys = renderer.width < 100
      ? "↑/↓ j/k  d/u  g/G  Enter open  / filter  Esc clear  q quit"
      : "j/k ↑/↓ select  d/u page  g/G ends  Enter open  / filter  Esc clear  q quit"
    footer.content = searching ? `/${draft}█  Enter apply · Esc cancel` : `${keys}  ${filtered.length ? `${selected + 1}/${filtered.length}` : ""}${state.query ? ` · /${state.query}` : ""}`
  }
  filter()
  draw()
  return await new Promise((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve(result))
    renderer.on(CliRenderEvents.RESIZE, draw)
    renderer.keyInput.on("keypress", (key) => {
      const name = key.name.toLowerCase()
      if (key.ctrl && name === "c") return
      key.preventDefault()
      key.stopPropagation()
      if (searching) {
        if (name === "escape") searching = false
        else if (name === "return" || name === "enter") {
          state.query = draft.trim()
          searching = false
          filter()
        } else if (name === "backspace") draft = draft.slice(0, -1)
        else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") draft += key.sequence
      } else if (name === "q") {
        renderer.destroy()
        return
      } else if (name === "return" || name === "enter") {
        if (!filtered[selected]) return
        result = filtered[selected]
        renderer.destroy()
        return
      } else if (name === "/" || name === "slash") {
        searching = true
        draft = state.query
      } else if (name === "escape") {
        state.query = ""
        filter()
      } else if (name === "j" || name === "down") selected++
      else if (name === "k" || name === "up") selected--
      else if (name === "d" || name === "pagedown") selected += pageSize()
      else if (name === "u" || name === "pageup") selected -= pageSize()
      else if (name === "g") selected = key.shift || key.sequence === "G" ? filtered.length - 1 : 0
      selected = Math.max(0, Math.min(selected, filtered.length - 1))
      draw()
    })
  })
}
