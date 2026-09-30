import { describe, expect, test } from "bun:test"
import { messageText, parseLink, readThread, type Api } from "./read"

const link = "https://example.slack.com/archives/C123ABC456/p1790000000123456"

describe("Slack permalinks", () => {
  test("preserves microseconds and uses an explicit thread parent", () => {
    expect(parseLink(`${link}?thread_ts=1789999999.654321&cid=C123ABC456`)).toEqual({
      channel: "C123ABC456", ts: "1790000000.123456", thread: "1789999999.654321",
      origin: "https://example.slack.com",
    })
  })
  test("rejects non-Slack URLs and malformed timestamps", () => {
    for (const invalid of [link.replace(".slack.com", ".slack.com.attacker.test"),
      link.replace("https:", "http:"), link.replace("p1790000000123456", "p123"),
      `${link}?thread_ts=not-a-timestamp`])
      expect(() => parseLink(invalid)).toThrow()
  })
})

describe("thread reading", () => {
  test("finds the parent of a bare reply link and collects all pages", async () => {
    const calls: Array<{ method: string; form: Record<string, string> }> = []
    const request: Api = async (method, form) => {
      calls.push({ method, form })
      if (form.ts === "1790000000.123456") return {
        ok: true, messages: [{ ts: form.ts, thread_ts: "1789999999.654321" }],
      }
      if (!form.cursor) return {
        ok: true, messages: [{ ts: form.ts, text: "parent" }], has_more: true,
        response_metadata: { next_cursor: "page2" },
      }
      return { ok: true, messages: [{ ts: "1790000000.123456", text: "reply" }], has_more: false }
    }
    const result = await readThread(link, request)
    expect(result.thread_ts).toBe("1789999999.654321")
    expect(result.messages.map(m => m.text)).toEqual(["parent", "reply"])
    expect(result.complete).toBe(true)
    expect(calls.map(c => [c.form.ts, c.form.cursor ?? ""])).toEqual([
      ["1790000000.123456", ""], ["1789999999.654321", ""],
      ["1789999999.654321", "page2"],
    ])
  })
  test("does not turn access errors or partial responses into a complete read", async () => {
    for (const response of [
      { ok: false, error: "channel_not_found" },
      { ok: true, messages: [{ ts: "1790000000.123456" }], has_more: true },
      { ok: true, messages: [] },
      { ok: true, messages: [{ ts: "1790000001.111111" }] },
    ]) await expect(readThread(link, async () => response)).rejects.toThrow()
  })
  test("stops a repeating pagination cursor", async () => {
    await expect(readThread(link, async () => ({
      ok: true, messages: [{ ts: "1790000000.123456" }], has_more: true,
      response_metadata: { next_cursor: "same" },
    }))).rejects.toThrow("repeated a pagination cursor")
  })
})

test("renders evidence from blocks, attachments and file metadata", () => {
  const text = messageText({
    ts: "1790000000.123456", text: "Alert title",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Detailed failure and evidence URL" } }],
    attachments: [{ fields: [{ title: "Status", value: "Failed" }], text: "Legacy details" }],
    files: [{ title: "evidence.json", permalink: "https://example.slack.com/files/example" }],
  })
  for (const expected of ["Alert title", "Detailed failure and evidence URL", "Status: Failed", "Legacy details", "evidence.json"])
    expect(text).toContain(expected)
})

test("keeps rich text sentences and emoji together", () => {
  expect(messageText({ ts: "1790000000.123456", text: "Shipped :tada: today", blocks: [
    { type: "rich_text", elements: [{ type: "rich_text_section", elements: [
      { type: "text", text: "Shipped " }, { type: "emoji", name: "tada" },
      { type: "text", text: " today" },
    ] }] },
  ] })).toBe("Shipped :tada: today")
})
