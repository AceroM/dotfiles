import { expect, mock, test } from "bun:test"
import * as core from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

const screen = await createTestRenderer({ width: 120, height: 24 })
const copied: string[] = []
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => screen.renderer }))
mock.module("../src/clipboard", () => ({
  copySessionId: (id: string) => { copied.push(id); return `Copied session ID: ${id}` },
}))
const { pickConversation } = await import("../src/picker")

test("y copies the selected full ID, stays in the picker, and remains text during search", async () => {
  const conversations = ["first-full-session-id", "second-full-session-id"].map((id) => ({
    id, path: `/sessions/${id}.jsonl`, provider: "codex" as const, title: id, modifiedAt: 0,
  }))
  const pending = pickConversation(conversations, { query: "" })
  try {
    await screen.waitForFrame((frame) => frame.includes("first-full-session-id"))
    screen.mockInput.pressKey("j")
    screen.mockInput.pressKey("y")
    await screen.renderOnce()
    expect(copied).toEqual(["second-full-session-id"])
    expect(screen.captureCharFrame()).toContain("Copied session ID: second-full-session-id")
    screen.mockInput.pressKey("/")
    screen.mockInput.pressKey("y")
    await screen.renderOnce()
    expect(screen.captureCharFrame()).toContain("/y")
    expect(copied).toHaveLength(1)
    screen.mockInput.pressEnter()
    screen.mockInput.pressKey("y")
    expect(copied).toHaveLength(1)
    screen.mockInput.pressKey("q")
    expect(await pending).toBeUndefined()
  } finally {
    screen.renderer.destroy()
  }
})
