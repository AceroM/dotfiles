#!/usr/bin/env bun

import React, { useCallback, useEffect, useMemo, useState, render, Box, Text, useApp, useInput } from "@dotfiles/opentui-cli"

type JsonObject = Record<string, any>
type Health = "up" | "down" | "unknown"

type Route = {
  id: string
  port: number
  protocol: string
  endpoint: string
  path: string
  target: string
  localPort?: number
  access: "tailnet" | "public"
  health: Health
}

type Snapshot = {
  routes: Route[]
  ports: number[]
  localPorts: number[]
  refreshedAt: Date
}

type CommandResult = { code: number; out: string; err: string }

const colors = {
  bg: "#282c34",
  panel: "#21252b",
  selected: "#3a4b5f",
  border: "#464b57",
  text: "#abb2bf",
  muted: "#636d83",
  faint: "#636d83",
  cyan: "#74ade8",
  green: "#98c379",
  yellow: "#e5c07b",
  red: "#e06c75",
  purple: "#c678dd",
} as const

async function run(command: string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  } catch (error) {
    return { code: 127, out: "", err: error instanceof Error ? error.message : String(error) }
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}
}

function localPort(target: string): number | undefined {
  try {
    const parsed = new URL(/^\w+:\/\//.test(target) ? target : `http://${target}`)
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) return undefined
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return /^\d+$/.test(target) ? Number(target) : undefined
  }
}

async function listening(port: number): Promise<Health> {
  const lsof = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"])
  if (lsof.code !== 127 && lsof.code !== 126) return lsof.out.trim() ? "up" : "down"

  const ss = await run(["ss", "-H", "-ltn", `sport = :${port}`])
  if (ss.code === 0) return ss.out.trim() ? "up" : "down"
  return "unknown"
}

function handlerTarget(handler: JsonObject): string {
  if (typeof handler.Proxy === "string") return handler.Proxy
  if (typeof handler.Path === "string") return `file:${handler.Path}`
  if (typeof handler.Redirect === "string") return `redirect:${handler.Redirect}`
  if (typeof handler.Text === "string") return "inline text"
  return "unconfigured"
}

function hostPort(value: string): { host: string; port: number } | undefined {
  const separator = value.lastIndexOf(":")
  if (separator < 0) return undefined
  const port = Number(value.slice(separator + 1))
  return Number.isInteger(port) ? { host: value.slice(0, separator), port } : undefined
}

async function loadSnapshot(): Promise<Snapshot> {
  const result = await run(["tailscale", "serve", "status", "--json"])
  if (result.code !== 0) throw new Error(result.err.trim() || "tailscale serve status failed")

  let config: JsonObject
  try {
    config = object(JSON.parse(result.out))
  } catch {
    throw new Error("tailscale returned invalid JSON")
  }

  const tcp = object(config.TCP)
  const web = object(config.Web)
  const routes: Route[] = []
  const seenPorts = new Set<number>()

  for (const [key, rawSite] of Object.entries(web)) {
    const site = hostPort(key)
    if (!site) continue
    seenPorts.add(site.port)
    const mode = object(tcp[String(site.port)])
    const protocol = mode.HTTP === true ? "http" : mode.HTTPS === true ? "https" : "tcp"
    const handlers = object(object(rawSite).Handlers)
    for (const [path, rawHandler] of Object.entries(handlers)) {
      const handler = object(rawHandler)
      const target = handlerTarget(handler)
      const local = localPort(typeof handler.Proxy === "string" ? handler.Proxy : "")
      routes.push({
        id: `${key}${path}`,
        port: site.port,
        protocol,
        endpoint: `${protocol}://${key}${path === "/" ? "" : path}`,
        path,
        target,
        localPort: local,
        access: object(config.AllowFunnel)[key] === true ? "public" : "tailnet",
        health: local ? "unknown" : "unknown",
      })
    }
  }

  for (const [portText, rawHandler] of Object.entries(tcp)) {
    const port = Number(portText)
    if (!Number.isInteger(port)) continue
    seenPorts.add(port)
    const handler = object(rawHandler)
    if (typeof handler.TCPForward !== "string") continue
    const local = localPort(handler.TCPForward)
    const protocol = typeof handler.TerminateTLS === "string" && handler.TerminateTLS ? "tls" : "tcp"
    routes.push({
      id: `tcp:${port}`,
      port,
      protocol,
      endpoint: `${protocol}://:${port}`,
      path: "",
      target: handler.TCPForward,
      localPort: local,
      access: "tailnet",
      health: "unknown",
    })
  }

  routes.sort((a, b) => a.port - b.port || a.endpoint.localeCompare(b.endpoint))
  const localPorts = [...new Set(routes.flatMap((route) => route.localPort ? [route.localPort] : []))].sort((a, b) => a - b)
  const health = new Map<number, Health>(await Promise.all(localPorts.map(async (port) => [port, await listening(port)] as const)))
  for (const route of routes) route.health = route.localPort ? health.get(route.localPort) ?? "unknown" : "unknown"

  return { routes, ports: [...seenPorts].sort((a, b) => a - b), localPorts, refreshedAt: new Date() }
}

function healthColor(health: Health): string {
  return health === "up" ? colors.green : health === "down" ? colors.red : colors.yellow
}

function healthLabel(health: Health): string {
  return health === "up" ? "LISTENING" : health === "down" ? "DOWN" : "UNKNOWN"
}

function App() {
  const { exit } = useApp()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState("")
  const [selected, setSelected] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      setSnapshot(await loadSnapshot())
      setError("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit()
    if (input === "r") return void refresh()
    const total = snapshot?.routes.length ?? 0
    if (key.downArrow || input === "j") setSelected((value) => Math.min(value + 1, Math.max(total - 1, 0)))
    if (key.upArrow || input === "k") setSelected((value) => Math.max(value - 1, 0))
    if (key.pageDown || input === "d") setSelected((value) => Math.min(value + 8, Math.max(total - 1, 0)))
    if (key.pageUp || input === "u") setSelected((value) => Math.max(value - 8, 0))
    if (input === "g") setSelected(0)
    if (input === "G") setSelected(Math.max(total - 1, 0))
  })

  const route = snapshot?.routes[selected]
  const listeningCount = snapshot?.routes.filter((item) => item.health === "up").length ?? 0
  const title = refreshing ? "refreshing…" : snapshot ? `updated ${snapshot.refreshedAt.toLocaleTimeString()}` : "loading…"
  const summary = snapshot
    ? `${snapshot.routes.length} routes · ${snapshot.ports.length} Tailscale ports · ${snapshot.localPorts.length} local targets · ${listeningCount} listening`
    : "waiting for tailscale serve status"

  return (
    <Box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg} paddingX={1}>
      <Box height={2} flexDirection="column" flexShrink={0}>
        <Text color={colors.cyan} bold>Tailscale Serve</Text>
        <Text color={colors.muted}>{summary}  ·  {title}</Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box width="45%" flexDirection="column" border borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} paddingX={1}>
          <Text color={colors.muted} bold>ROUTES</Text>
          <Box flexDirection="column" flexGrow={1} minHeight={0}>
            {snapshot?.routes.map((item, index) => {
              const active = index === selected
              return (
                <Box key={item.id} height={2} flexShrink={0} flexDirection="column" backgroundColor={active ? colors.selected : colors.panel}>
                  <Text wrap="truncate" color={active ? colors.cyan : colors.text} bold={active}>{active ? "❯ " : "  "}{item.endpoint}</Text>
                  <Text wrap="truncate" color={healthColor(item.health)}>  {healthLabel(item.health)} · {item.target}</Text>
                </Box>
              )
            })}
            {!snapshot && <Text color={error ? colors.red : colors.muted}>{error || "Loading…"}</Text>}
            {snapshot && !snapshot.routes.length && <Text color={colors.muted}>No Serve routes configured.</Text>}
          </Box>
        </Box>

        <Box flexGrow={1} minWidth={0} flexDirection="column" border borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} paddingX={2}>
          <Text color={colors.muted} bold>DETAILS</Text>
          {route ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text color={colors.cyan} bold>{route.endpoint}</Text>
              <Text color={colors.text}>access       {route.access === "public" ? "PUBLIC / FUNNEL" : "TAILNET ONLY"}</Text>
              <Text color={colors.text}>Tailscale port {route.port}</Text>
              <Text color={colors.text}>upstream     {route.target}</Text>
              <Text color={healthColor(route.health)}>{route.localPort ? `local port   ${route.localPort} · ${healthLabel(route.health)}` : "local port   n/a"}</Text>
              <Text color={colors.faint}>route id     {route.id}</Text>
            </Box>
          ) : (
            <Text color={error ? colors.red : colors.muted}>{error || "Select a route to inspect it."}</Text>
          )}
        </Box>
      </Box>

      <Box height={2} flexDirection="column" flexShrink={0} paddingTop={1}>
        <Text color={colors.muted}>j/k or arrows move  ·  d/u page  ·  r refresh  ·  q quit</Text>
        {error && <Text color={colors.red} wrap="truncate">error: {error}</Text>}
      </Box>
    </Box>
  )
}

const instance = await render(<App />)
await instance.waitUntilExit()

