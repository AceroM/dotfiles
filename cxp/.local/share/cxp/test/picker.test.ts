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
  const conversations = ["first-full-session-id", "second-full-session-id", ...Array.from({ length: 13 }, (_, index) => `session-${index + 3}`)].map((id) => ({
    id, path: `/sessions/${id}.jsonl`, provider: "codex" as const, title: id, modifiedAt: 0,
  }))
  const state = { query: "", selectedPath: undefined as string | undefined }
  const pending = pickConversation(conversations, state)
  try {
    await screen.waitForFrame((frame) => frame.includes("first-full-session-id"))
    screen.mockInput.pressKey("3")
    screen.mockInput.pressKey("j")
    expect(state.selectedPath).toBe(conversations[3]!.path)
    screen.mockInput.pressKey("2")
    screen.mockInput.pressKey("k")
    expect(state.selectedPath).toBe(conversations[1]!.path)
    await screen.renderOnce()
    expect(screen.captureCharFrame()).toMatch(/❯\s+2\s+codex/)
    expect(screen.captureCharFrame()).toMatch(/\s1\s+codex\s+session-3/)
    screen.mockInput.pressKey("1")
    screen.mockInput.pressKey("2")
    screen.mockInput.pressKey("j")
    expect(state.selectedPath).toBe(conversations[13]!.path)
    screen.mockInput.pressKey("9")
    screen.mockInput.pressKey("j")
    expect(state.selectedPath).toBe(conversations[14]!.path)
    screen.mockInput.pressKey("5")
    screen.mockInput.pressEscape()
    await Bun.sleep(25)
    screen.mockInput.pressKey("k")
    expect(state.selectedPath).toBe(conversations[13]!.path)
    screen.mockInput.pressKey("9")
    screen.mockInput.pressKey("g")
    screen.mockInput.pressKey("j")
    expect(state.selectedPath).toBe(conversations[1]!.path)
    screen.mockInput.pressKey("y")
    await screen.renderOnce()
    expect(copied).toEqual(["second-full-session-id"])
    expect(screen.captureCharFrame()).toContain("Copied session ID: second-full-session-id")
    screen.mockInput.pressKey("/")
    screen.mockInput.pressKey("y")
    screen.mockInput.pressKey("3")
    screen.mockInput.pressKey("l")
    await screen.renderOnce()
    expect(screen.captureCharFrame()).toContain("/y3l")
    expect(copied).toHaveLength(1)
    screen.mockInput.pressEnter()
    screen.mockInput.pressKey("y")
    expect(copied).toHaveLength(1)
    screen.mockInput.pressEscape()
    await Bun.sleep(25)
    await screen.renderOnce()
    expect(state.selectedPath).toBe(conversations[0]!.path)
    screen.mockInput.pressKey("l")
    expect(await pending).toBe(conversations[0])
  } finally {
    screen.renderer.destroy()
  }
})
