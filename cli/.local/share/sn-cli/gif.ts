// Finding a GIF to send, without an API key.
//
// Giphy's public "beta" key is banned and Tenor's v1 demo key is gone — both
// now want an account key for a feature that has to work the moment you press
// `g`. So this reads Tenor's own search page, which is server-rendered: every
// result arrives as a <figure> carrying the gif url and an alt description good
// enough to pick from in a terminal ("a man in a suit is dancing in front of a
// crowd"). No key, no config, and the one thing that can break is the markup.
//
// What gets posted is the direct media.tenor.com .gif url, never the
// tenor.com/view/… page: Slack unfurls the first into an inline animated image
// and the second into a plain text card with no picture at all.

import { tmpdir } from "node:os"

export interface Gif {
  url: string // media.tenor.com …gif — the thing Slack unfurls
  alt: string // Tenor's own description, which is what you actually pick by
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim()
}

/** "deploy is on fire" -> the slug Tenor's search path expects. */
function slug(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "gif"
  )
}

/**
 * The grid serves a ~180px preview (…AAAAM); …AAAAC is the same gif at ~500px,
 * which is the size Slack shows for a Tenor link posted by hand. Only the size
 * code differs, so swap it — and let the caller confirm it exists before using
 * it, since a few uploads have no large rendition.
 */
export function large(url: string): string {
  return url.replace(/(\/[A-Za-z0-9_-]+AAAA)[A-Za-z0-9](\/[^/]+\.gif)$/, "$1C$2")
}

/** `large(url)` when Tenor actually has it, else the preview url unchanged. */
export async function bestUrl(url: string): Promise<string> {
  const big = large(url)
  if (big === url) return url
  try {
    const r = await fetch(big, { method: "HEAD", headers: { "User-Agent": UA } })
    return r.ok ? big : url
  } catch {
    return url
  }
}

/** Tenor's search results for `query`, newest markup permitting. */
export async function search(query: string, limit = 40): Promise<Gif[]> {
  const res = await fetch(`https://tenor.com/search/${slug(query)}-gifs`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`tenor returned ${res.status}`)
  const html = await res.text()

  const gifs: Gif[] = []
  const seen = new Set<string>()
  // One <figure class="UniversalGifListItem"> per result; anything without a
  // .gif in it is a sticker or a video-only upload and is not ours to send.
  for (const chunk of html.split("<figure").slice(1)) {
    const src = chunk.match(/src="(https:\/\/media[0-9]*\.tenor\.com\/[^"]+\.gif)"/)
    if (!src) continue
    const url = src[1]
    if (seen.has(url)) continue
    seen.add(url)
    const alt = chunk.match(/alt="([^"]*)"/)
    gifs.push({ url, alt: decode(alt?.[1] ?? "") || "(no description)" })
    if (gifs.length >= limit) break
  }
  if (gifs.length === 0)
    throw new Error(`no gifs for "${query}" — try fewer words`)
  return gifs
}

/**
 * Hand the descriptions to Claude and let it say which one someone asking for
 * `query` actually meant. Opt-in (the `a` key) because it costs a couple of
 * seconds, and it only ever moves the cursor — you still press enter yourself.
 */
export async function claudePick(query: string, gifs: Gif[]): Promise<number> {
  const list = gifs.map((g, i) => `${i + 1}. ${g.alt}`).join("\n")
  const prompt =
    `Someone wants to send a GIF in Slack. They asked for: "${query}".\n\n` +
    `These are the candidates, by their descriptions:\n${list}\n\n` +
    `Which one best fits? Answer with only its number, nothing else.`

  // Run it somewhere neutral: started in a repo, `claude -p` loads that
  // project's context first and a one-line answer takes four times as long.
  const p = Bun.spawn(["claude", "-p", "--model", "haiku", prompt], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = await new Response(p.stdout).text()
  if ((await p.exited) !== 0) throw new Error("claude exited nonzero — is it signed in?")
  const n = Number(out.match(/\d+/)?.[0])
  if (!n || n < 1 || n > gifs.length) throw new Error("claude did not name a candidate")
  return n - 1
}
