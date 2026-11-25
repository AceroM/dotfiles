// Stamping: ask the review bot to look at a PR, by posting the message you
// would otherwise type by hand into #bot-pr-stamper —
//
//   @Purple Rhino stamp this https://github.com/org/repo/pull/16961
//
// One message per PR, because the bot answers in a thread under each one: a
// single message naming four PRs would come back as one tangled thread.
//
// It posts as you, through the session the Slack desktop app already holds
// (see @dotfiles/slack) — no bot token, nothing to configure. Both the channel
// and the bot are looked up by name and the ids cached, so renaming the channel
// or pointing this at a different bot is an env var, not a code change.

import { channelId, creds, post, userId, userIdInChannel } from "@dotfiles/slack";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNEL = process.env.STACKS_STAMP_CHANNEL || "bot-pr-stamper";
const BOT = process.env.STACKS_STAMP_BOT || "Purple Rhino";
const CACHE = join(homedir(), ".local/state/stacks-stamp.json");

export type StampTarget = {
  channelName: string;
  channel: string; // C…
  botName: string;
  bot: string; // U…
};

type Cache = Record<string, { channel: string; bot: string }>;

// ---------------------------------------------------------------------------
// Stamping as the Juniors Cheesecake bot
// ---------------------------------------------------------------------------
//
// A machine with no signed-in Slack desktop app (the Mac mini) has no session
// to post as you. There the stamp goes out as the Juniors Cheesecake bot, which
// is a member of #bot-pr-stamper: its xoxb token sits in the login keychain
// (service "orchestrator", account SLACK_BOT_TOKEN), or in
// STACKS_STAMP_BOT_TOKEN. A bot token can't look up a private channel or walk
// the directory, so the default channel/bot ids are pinned below.
//
// STACKS_STAMP_AS=bot forces the bot, =me forces your session; unset, your
// session wins and the bot is only the fallback when it can't be found.

const PINNED: Cache = {
  "bot-pr-stamper|Purple Rhino": { channel: "C0C2F3SA43T", bot: "U0AH07TRKLP" },
};

async function keychainBotToken(): Promise<string | null> {
  if (process.env.STACKS_STAMP_BOT_TOKEN) return process.env.STACKS_STAMP_BOT_TOKEN;
  try {
    const p = Bun.spawn(
      ["security", "find-generic-password", "-s", "orchestrator", "-a", "SLACK_BOT_TOKEN", "-w"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 && out.startsWith("xoxb-") ? out : null;
  } catch {
    return null;
  }
}

let botMode: Promise<string | null> | null = null;

/** The bot token to stamp with, or null to post as you. Decided once per run. */
function stampBotToken(): Promise<string | null> {
  if (!botMode) {
    botMode = (async () => {
      const as = process.env.STACKS_STAMP_AS;
      if (as === "me") return null;
      if (as === "bot") {
        const t = await keychainBotToken();
        if (!t) throw new Error("STACKS_STAMP_AS=bot but no SLACK_BOT_TOKEN in the keychain (service orchestrator)");
        return t;
      }
      try {
        await creds();
        return null; // your Slack session works: post as you
      } catch (e) {
        const t = await keychainBotToken();
        if (t) return t;
        throw e;
      }
    })();
  }
  return botMode;
}

/** Who the stamp will be posted as, for the dry-run line. */
export async function stampPoster(): Promise<"me" | "Juniors Cheesecake bot"> {
  return (await stampBotToken()) ? "Juniors Cheesecake bot" : "me";
}

async function botPost(token: string, channel: string, text: string): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });
  const r = (await res.json()) as { ok?: boolean; error?: string; ts?: string };
  if (!r.ok) throw new Error(`chat.postMessage as the bot: ${r.error ?? "failed"}`);
  return r.ts ?? "";
}

async function readCache(): Promise<Cache> {
  try {
    return (await Bun.file(CACHE).json()) as Cache;
  } catch {
    return {}; // missing or corrupt — resolving again is cheap enough
  }
}

/**
 * The channel and bot to stamp at. Resolving the names costs two slow API
 * calls and a walk of the member directory, so the ids are cached under the
 * names they came from: change either name and it resolves again.
 */
export async function stampTarget(): Promise<StampTarget> {
  const key = `${CHANNEL}|${BOT}`;
  const cache = await readCache();
  const hit = cache[key];
  if (hit?.channel && hit?.bot)
    return { channelName: CHANNEL, channel: hit.channel, botName: BOT, bot: hit.bot };
  if ((await stampBotToken()) !== null) {
    const pinned = PINNED[key];
    if (!pinned)
      throw new Error(`stamping as the bot needs pinned ids for ${key}: add them to PINNED in stamp.ts`);
    return { channelName: CHANNEL, ...pinned, botName: BOT };
  }

  const channel = await channelId(CHANNEL);
  // The channel is the better authority on which account the name means: this
  // workspace has two live apps called "Purple Rhino", and only the one already
  // answering in #bot-pr-stamper is the one a stamp is for. The directory is
  // the fallback for a channel too new to have learned that yet.
  const bot = (await userIdInChannel(channel, BOT)) ?? (await userId(BOT));
  cache[key] = { channel, bot };
  try {
    await Bun.write(CACHE, JSON.stringify(cache, null, 2));
  } catch {
    // a cache we cannot write is not a reason to fail the stamp
  }
  return { channelName: CHANNEL, channel, botName: BOT, bot };
}

/** Forget the cached ids, so the next stamp resolves the names again. */
export async function forgetStampTarget(): Promise<void> {
  const cache = await readCache();
  delete cache[`${CHANNEL}|${BOT}`];
  try {
    await Bun.write(CACHE, JSON.stringify(cache, null, 2));
  } catch {
    // nothing to do — the next resolve just pays full price
  }
}

/**
 * What lands in the channel. `<@U…>` is Slack's escape for a mention, so this
 * reads as "@Purple Rhino stamp this …" and actually pings the bot; a note is
 * appended after the link, where the bot reads it as part of the request.
 */
export function stampText(target: StampTarget, prUrl: string, note = ""): string {
  const extra = note.trim();
  return `<@${target.bot}> stamp this ${prUrl}${extra ? ` — ${extra}` : ""}`;
}

/** Post one stamp. Returns the message ts, which is also its thread. */
export async function stampOne(
  target: StampTarget,
  prUrl: string,
  note = "",
): Promise<string> {
  const text = stampText(target, prUrl, note);
  const token = await stampBotToken();
  return token ? botPost(token, target.channel, text) : post(target.channel, text);
}
