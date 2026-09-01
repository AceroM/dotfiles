// Posting side of `sn` — everything the reply dialog needs to talk to Slack.
//
// There is no bot token here and nothing to configure: `sn` reuses the session
// the Slack desktop app already holds, so a reply arrives as you, from the same
// place the notification came from. Two halves have to line up:
//
//   cookie  `d=xoxd-…`, AES-128-CBC in Slack's Chromium cookie jar. The key is
//           the Keychain item "Slack Safe Storage" (readable without a prompt,
//           since Hammerspoon/Slack already granted this login session).
//   token   `xoxc-…`, in Slack's Local Storage leveldb.
//
// The cookie is stable, so it is decrypted fresh every time. The token rotates
// and leveldb compacts it into snappy-compressed blocks where a plain scan can
// only see fragments — so a token that works is cached in the Keychain and only
// re-scanned when Slack rejects it. A freshly written token always lands in the
// uncompressed write-ahead log first, which is exactly when the re-scan runs.
// If both fail: `sn auth --token xoxc-…` stores one by hand.

import { Database } from "bun:sqlite"
import { createDecipheriv, pbkdf2Sync } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const SLACK_APP = join(homedir(), "Library/Application Support/Slack")
const COOKIE_DB = join(SLACK_APP, "Cookies")
const LEVELDB = join(SLACK_APP, "Local Storage/leveldb")
const KEYCHAIN_SERVICE = "sn-slack-token" // where a validated xoxc token is cached

export interface SlackCreds {
  token: string
  cookie: string // already URL-encoded, as Slack stores it — do not re-encode
}

export interface ReplyTarget {
  channel: string
  ts: string
  thread_ts: string | null
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

async function keychain(service: string): Promise<string | null> {
  const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = (await new Response(p.stdout).text()).trim()
  return (await p.exited) === 0 && out ? out : null
}

async function keychainStore(service: string, value: string): Promise<void> {
  // -U updates in place when the item already exists.
  const p = Bun.spawn(
    ["security", "add-generic-password", "-U", "-s", service, "-a", "sn", "-w", value],
    { stdout: "ignore", stderr: "ignore" },
  )
  await p.exited
}

/** Decrypt the `d` session cookie out of Slack's Chromium cookie jar. */
async function readCookie(): Promise<string> {
  const key = await keychain("Slack Safe Storage")
  if (!key) throw new Error('no "Slack Safe Storage" key in the Keychain — is Slack installed?')

  let row: { v: Uint8Array } | null = null
  try {
    // Slack keeps the jar open; read-only still gets a consistent snapshot.
    const db = new Database(`file:${COOKIE_DB}?mode=ro`, { readonly: true })
    row = db
      .query("select encrypted_value as v from cookies where name = 'd' and host_key = '.slack.com'")
      .get() as { v: Uint8Array } | null
    db.close()
  } catch (e) {
    throw new Error(`cannot read Slack's cookie jar — ${(e as Error).message}`)
  }
  if (!row) throw new Error("no Slack `d` cookie — sign in to the Slack app first")

  // Chromium's v10 scheme: fixed salt/iterations, all-spaces IV.
  const dk = pbkdf2Sync(key, "saltysalt", 1003, 16, "sha1")
  const dec = createDecipheriv("aes-128-cbc", dk, Buffer.alloc(16, 0x20))
  dec.setAutoPadding(false) // recent Chromium prepends a domain hash, so unpad by hand
  const blob = Buffer.from(row.v).subarray(3) // strip the "v10" version prefix
  const plain = Buffer.concat([dec.update(blob), dec.final()]).toString("utf8")

  const start = plain.indexOf("xoxd-")
  if (start < 0) throw new Error("decrypted the cookie but found no xoxd- value in it")
  return plain.slice(start).replace(/[\x00-\x1f\x7f]+$/, "") // trim PKCS#7 padding bytes
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** Every xoxc-looking string in Slack's Local Storage, newest files first. */
async function scanTokens(): Promise<string[]> {
  const p = Bun.spawn(["sh", "-c", `strings -a "${LEVELDB}"/* 2>/dev/null`], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(p.stdout).text()
  await p.exited
  // A real token is xoxc-<team>-<user>-<session>-<64 hex>; the length floor drops
  // the bare "xoxc-" fragments left behind by snappy back-references.
  return [...new Set(text.match(/xoxc-[0-9A-Za-z-]{40,}/g) ?? [])]
}

async function validate(token: string, cookie: string): Promise<boolean> {
  try {
    const r = (await call("auth.test", { token, cookie }, {})) as { ok?: boolean }
    return Boolean(r.ok)
  } catch {
    return false
  }
}

/**
 * A token Slack currently accepts: the cached one if it still works, else the
 * first scanned candidate that does (which then replaces the cache).
 */
async function resolveToken(cookie: string): Promise<string> {
  const cached = await keychain(KEYCHAIN_SERVICE)
  if (cached && (await validate(cached, cookie))) return cached

  for (const token of await scanTokens()) {
    if (token === cached) continue // already known bad
    if (await validate(token, cookie)) {
      await keychainStore(KEYCHAIN_SERVICE, token)
      return token
    }
  }
  throw new Error(
    "no working Slack token found — open Slack to refresh it, or run `sn auth --token xoxc-…`",
  )
}

/** Store a token by hand, after checking Slack accepts it. */
export async function saveToken(token: string): Promise<void> {
  const cookie = await readCookie()
  if (!(await validate(token, cookie))) throw new Error("Slack rejected that token")
  await keychainStore(KEYCHAIN_SERVICE, token)
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function call(
  method: string,
  creds: SlackCreds,
  form: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Cookie: `d=${creds.cookie}`,
    },
    body: new URLSearchParams({ token: creds.token, ...form }),
  })
  return res.json()
}

let cached: Promise<SlackCreds> | null = null

/** Resolve credentials once per run; the dialog awaits this while you type. */
export function creds(): Promise<SlackCreds> {
  if (!cached) {
    cached = (async () => {
      const cookie = await readCookie()
      return { token: await resolveToken(cookie), cookie }
    })().catch((e) => {
      cached = null // a failed lookup should not poison the next attempt
      throw e
    })
  }
  return cached
}

/**
 * Post `text` as a reply to the notification's message. Threaded replies stay in
 * their thread; a top-level message is answered in the channel, matching what
 * clicking through to Slack and typing would do.
 */
export async function reply(target: ReplyTarget, text: string): Promise<void> {
  const c = await creds()
  const form: Record<string, string> = { channel: target.channel, text }
  if (target.thread_ts) form.thread_ts = target.thread_ts
  const r = (await call("chat.postMessage", c, form)) as { ok?: boolean; error?: string }
  if (!r.ok) throw new Error(r.error ?? "chat.postMessage failed")
}
