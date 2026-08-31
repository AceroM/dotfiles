#!/usr/bin/env python3
"""Read new rows out of the macOS notification database (usernoted db2).

Run by notifications.lua inside Hammerspoon, which holds Full Disk Access;
this child process inherits it. Prints one JSON object per line for every
notification delivered after --since (Apple epoch seconds), oldest first,
then a final `{"sentinel": <max delivered_date seen>}` line the caller
stores as its next --since.

macOS clears rows out of `record` when notifications are dismissed, and
rec_ids get reused after a clear, so the watermark is delivered_date (wall
clock), never rec_id.

For Slack rows the title/subtitle/body come from the database, but the
channel id does not exist there. Slack's own browser.log redacts all text
yet leaves channel/team/ts intact, and both sides share the same
`TEAMID_msgts` identifier, so joining the two yields a slack:// deep link.
"""

import argparse
import json
import os
import plistlib
import re
import sqlite3

APPLE_EPOCH = 978307200  # 2001-01-01 in unix seconds
DB = os.path.expanduser("~/Library/Group Containers/group.com.apple.usernoted/db2/db")
SLACK_LOG_DIR = os.path.expanduser("~/Library/Application Support/Slack/logs/default")
SLACK_BUNDLE = "com.tinyspeck.slackmacgap"


def slack_channel_map():
    """iden -> (channel, thread_ts|None) from Slack's NEW_NOTIFICATION log blocks."""
    mapping = {}
    for name in ("browser1.log", "browser.log"):  # oldest first so newest wins
        path = os.path.join(SLACK_LOG_DIR, name)
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(max(0, size - 400_000))
                text = f.read().decode("utf-8", "replace")
        except OSError:
            continue
        for block in re.split(r"Store: NEW_NOTIFICATION", text)[1:]:
            block = block[:4000]
            channel = re.search(r'"channel":\s*"([A-Z0-9]+)"', block)
            iden = re.search(r'"id":\s*"([A-Z0-9]+_[0-9]+\.[0-9]+)"', block)
            thread = re.search(r'"thread_ts":\s*"([0-9]+\.[0-9]+)"', block)
            if channel and iden:
                mapping[iden.group(1)] = (channel.group(1), thread.group(1) if thread else None)
    return mapping


def slack_fields(iden, channel_map):
    team, _, ts = iden.partition("_")
    channel, thread_ts = channel_map.get(iden, (None, None))
    link = None
    if team and channel:
        link = f"slack://channel?team={team}&id={channel}"
        if ts:
            link += f"&message={ts}"
        if thread_ts:
            link += f"&thread_ts={thread_ts}"
    return {"team": team or None, "channel": channel, "ts": ts or None,
            "thread_ts": thread_ts, "link": link}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=float, required=True, help="Apple epoch watermark")
    ap.add_argument("--bundles", default="", help="comma-separated bundle ids to emit")
    args = ap.parse_args()
    bundles = {b for b in args.bundles.split(",") if b}

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
    rows = con.execute(
        "SELECT r.delivered_date, r.presented, a.identifier, r.data"
        "  FROM record r JOIN app a USING (app_id)"
        " WHERE r.delivered_date IS NOT NULL AND r.delivered_date > ?"
        " ORDER BY r.delivered_date",
        (args.since,),
    ).fetchall()
    con.close()

    channel_map = None
    sentinel = args.since
    for delivered, presented, bundle, blob in rows:
        sentinel = max(sentinel, delivered)
        if bundles and bundle not in bundles:
            continue
        try:
            req = plistlib.loads(blob).get("req", {})
        except Exception:
            continue
        out = {
            "apple_date": delivered,
            "date": delivered + APPLE_EPOCH,
            "presented": bool(presented),
            "bundle": bundle,
            "title": req.get("titl", "") or "",
            "subtitle": req.get("subt", "") or "",
            "body": req.get("body", "") or "",
            "iden": req.get("iden", "") or "",
        }
        if bundle == SLACK_BUNDLE and out["iden"]:
            if channel_map is None:
                channel_map = slack_channel_map()
            out.update(slack_fields(out["iden"], channel_map))
        print(json.dumps(out, ensure_ascii=False))

    print(json.dumps({"sentinel": sentinel}))


if __name__ == "__main__":
    main()
