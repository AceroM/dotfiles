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

import { channelId, post, userId, userIdInChannel } from "@dotfiles/slack";
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
  return post(target.channel, stampText(target, prUrl, note));
}
