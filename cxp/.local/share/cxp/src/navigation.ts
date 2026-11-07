/** Vim-style count prefix, consumed by the next command. */
export class NavigationCount {
  pending = ""

  read(key: { name: string; sequence: string; ctrl?: boolean; meta?: boolean; super?: boolean; option?: boolean }): number | undefined {
    if (!key.ctrl && !key.meta && !key.super && !key.option && /^[0-9]$/.test(key.sequence)) {
      if (this.pending || key.sequence !== "0") {
        this.pending = String(Math.min(999999, Number(this.pending + key.sequence)))
      }
      return undefined
    }
    const pending = this.pending
    this.pending = ""
    if (key.name.toLowerCase() === "escape" && pending) return undefined
    return pending ? Number(pending) : 1
  }
}
