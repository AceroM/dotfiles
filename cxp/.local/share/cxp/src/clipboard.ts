import { spawnSync } from "node:child_process"

export function copySessionId(id: string, terminalCopy: (text: string) => boolean): string {
  // Native clipboard access also works when a multiplexer filters OSC 52.
  if (process.platform === "darwin") {
    const result = spawnSync("pbcopy", { input: id, timeout: 2000 })
    if (result.status === 0) return `Copied session ID: ${id}`
    return "Could not copy session ID"
  }
  return terminalCopy(id) ? `Session ID sent to terminal clipboard: ${id}` : "Could not copy session ID"
}
