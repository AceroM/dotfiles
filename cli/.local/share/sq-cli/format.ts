// Turning Slack's wire text into something a terminal can show.
//
// Slack does not send what you read: mentions arrive as <@U0974AF5AFQ>,
// channels as <#C04H2|general>, links as <https://…|label>, and &, < and > are
// escaped. Unwinding that is most of what makes a message legible here.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }

/** Slack's wire text -> plain text, with ids swapped for names. */
export function render(
  raw: string,
  name: (id: string) => string,
  channel: (id: string) => string = (id) => id,
): string {
  return raw
    .replace(/<@([UWB][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `@${label || name(id)}`)
    .replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => `#${label || channel(id)}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label) => label || "@group")
    .replace(/<!([a-z]+)(?:\|([^>]*))?>/g, (_, kind, label) => `@${label || kind}`)
    .replace(/<([^|>]+)\|([^>]*)>/g, (_, url, label) => label || url)
    .replace(/<([^|>]+)>/g, (_, url) => url)
    .replace(/&([a-z]+|#\d+);/gi, (m, e) => ENTITIES[String(e).toLowerCase()] ?? m)
}

/**
 * Greedy word wrap into display lines. The renderer needs the exact line count
 * to scroll by message rather than by guess, so wrapping happens here instead
 * of being left to the Text element.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("")
      continue
    }
    let line = ""
    for (const word of paragraph.split(/ +/)) {
      if (line === "") line = word
      else if (line.length + 1 + word.length <= width) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
      // a single unbroken word longer than the pane (a url) still has to land
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out.length > 0 ? out : [""]
}

/** "1789657165.717919" -> "10:42", or "Sep 10" once it is not today. */
export function clock(ts: string): string {
  const d = new Date(Number(ts.split(".")[0]) * 1000)
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

/** Cut to width with an ellipsis, or pad out to it. */
export function fit(text: string, width: number): string {
  if (width <= 1) return ""
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}
