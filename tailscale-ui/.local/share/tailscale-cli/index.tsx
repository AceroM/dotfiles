#!/usr/bin/env bun

import React, { useCallback, useEffect, useState, render, Box, Text, theme, useApp, useInput } from "@dotfiles/opentui-cli"

type JsonObject = Record<string, any>
type Health = "up" | "down" | "unknown"
type RouteProtocol = "http" | "https" | "tcp" | "tls-terminated-tcp"
type Access = "tailnet" | "public"

export type Route = {
  id: string
  port: number
  protocol: RouteProtocol
  endpoint: string
  path: string
  target: string
  configureTarget?: string
  localPort?: number
  access: Access
  health: Health
}

type Snapshot = {
  routes: Route[]
  ports: number[]
  localPorts: number[]
  refreshedAt: Date
}

type CommandResult = { code: number; out: string; err: string }
type ConfirmAction =
  | { kind: "remove"; route: Route }
  | { kind: "access"; route: Route; access: Access }
  | { kind: "reset" }
type AddAction = {
  kind: "add"
  field: "local" | "tailscale"
  localPort: string
  tailscalePort: string
  access: Access
}
type PendingAction = ConfirmAction | AddAction

const colors = {
  // Keep every full-size surface on Zed's One Dark editor background. The
  // shared theme's darker panel color is chrome, not the editor canvas.
  bg: theme.background,
  panel: theme.background,
  selected: theme.selected,
  border: theme.border,
  text: theme.text,
  muted: theme.muted,
  faint: theme.muted,
  cyan: theme.accent,
  green: theme.green,
  yellow: theme.yellow,
  red: theme.red,
  purple: theme.magenta,
} as const

const funnelPorts = new Set([443, 8443, 10000])
const preferredHttpsPorts = [443, 8443, 10000, 9443]

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

function handlerTarget(handler: JsonObject): { display: string; configure?: string } {
  if (typeof handler.Proxy === "string") return { display: handler.Proxy, configure: handler.Proxy }
  if (typeof handler.Path === "string") return { display: `file:${handler.Path}`, configure: handler.Path }
  if (typeof handler.Text === "string") return { display: "inline text", configure: `text:${handler.Text}` }
  if (typeof handler.Redirect === "string") return { display: `redirect:${handler.Redirect}` }
  return { display: "unconfigured" }
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
  const allowFunnel = object(config.AllowFunnel)
  const routes: Route[] = []
  const seenPorts = new Set<number>()
  const publicPorts = new Set(
    Object.entries(allowFunnel)
      .filter(([, enabled]) => enabled === true)
      .flatMap(([key]) => hostPort(key)?.port ?? []),
  )

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
        target: target.display,
        configureTarget: target.configure,
        localPort: local,
        access: allowFunnel[key] === true ? "public" : "tailnet",
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
    const protocol = typeof handler.TerminateTLS === "string" && handler.TerminateTLS ? "tls-terminated-tcp" : "tcp"
    const endpointProtocol = protocol === "tls-terminated-tcp" ? "tls" : protocol
    routes.push({
      id: `tcp:${port}`,
      port,
      protocol,
      endpoint: `${endpointProtocol}://:${port}`,
      path: "",
      target: handler.TCPForward,
      configureTarget: handler.TCPForward,
      localPort: local,
      access: publicPorts.has(port) ? "public" : "tailnet",
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

function routeFlag(route: Route): string {
  return `--${route.protocol}=${route.port}`
}

function routePath(route: Route): string[] {
  return route.path && route.path !== "/" ? [`--set-path=${route.path}`] : []
}

export function removeRouteCommand(route: Route): string[] {
  return [
    "tailscale",
    route.access === "public" ? "funnel" : "serve",
    "--yes",
    routeFlag(route),
    ...routePath(route),
    "off",
  ]
}

export function changeAccessCommand(route: Route, access: Access): string[] {
  if (!route.configureTarget) throw new Error("This route type cannot be recreated from Tailscale status.")
  if (access === "public" && route.protocol === "http") throw new Error("Funnel does not support plain HTTP routes.")
  if (access === "public" && !funnelPorts.has(route.port)) {
    throw new Error("Funnel only supports ports 443, 8443, and 10000.")
  }
  return [
    "tailscale",
    access === "public" ? "funnel" : "serve",
    "--yes",
    "--bg",
    routeFlag(route),
    ...routePath(route),
    route.configureTarget,
  ]
}

export function addHttpsRouteCommand(localPort: number, tailscalePort: number, access: Access): string[] {
  if (access === "public" && !funnelPorts.has(tailscalePort)) {
    throw new Error("Funnel only supports ports 443, 8443, and 10000.")
  }
  return [
    "tailscale",
    access === "public" ? "funnel" : "serve",
    "--yes",
    "--bg",
    `--https=${tailscalePort}`,
    `http://127.0.0.1:${localPort}`,
  ]
}

function nextHttpsPort(used: Iterable<number>, access: Access = "tailnet"): number | undefined {
  const occupied = new Set(used)
  const choices = access === "public" ? preferredHttpsPorts.filter((port) => funnelPorts.has(port)) : preferredHttpsPorts
  return choices.find((port) => !occupied.has(port))
}

function validPort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined
}

function describeCommand(command: string[]): string {
  return command.map((part) => (/^[\w./:=+-]+$/.test(part) ? part : JSON.stringify(part))).join(" ")
}

function App() {
  const { exit } = useApp()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState("")
  const [selected, setSelected] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState<PendingAction>()
  const [mutating, setMutating] = useState(false)
  const [message, setMessage] = useState("")

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

  useEffect(() => {
    const total = snapshot?.routes.length ?? 0
    setSelected((value) => Math.min(value, Math.max(total - 1, 0)))
  }, [snapshot?.routes.length])

  const applyCommand = useCallback(async (command: string[], success: string) => {
    setMutating(true)
    setMessage(`running: ${describeCommand(command)}`)
    try {
      const result = await run(command)
      if (result.code !== 0) throw new Error(result.err.trim() || result.out.trim() || `command exited ${result.code}`)
      setPending(undefined)
      setMessage(success)
      await refresh()
    } catch (reason) {
      setMessage(`error: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setMutating(false)
    }
  }, [refresh])

  const confirm = useCallback((action: ConfirmAction) => {
    if (action.kind === "reset") {
      void applyCommand(["tailscale", "serve", "reset"], "All Serve and Funnel routes removed.")
      return
    }
    if (action.kind === "remove") {
      void applyCommand(removeRouteCommand(action.route), `Removed ${action.route.endpoint}.`)
      return
    }
    try {
      void applyCommand(
        changeAccessCommand(action.route, action.access),
        `${action.route.endpoint} is now ${action.access === "public" ? "public through Funnel" : "tailnet-only"}.`,
      )
    } catch (reason) {
      setPending(undefined)
      setMessage(`error: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }, [applyCommand])

  const submitAdd = useCallback((action: AddAction) => {
    const local = validPort(action.localPort)
    const exposed = validPort(action.tailscalePort)
    if (!local || !exposed) {
      setMessage("error: enter valid ports from 1 to 65535")
      return
    }
    if (snapshot?.ports.includes(exposed)) {
      setMessage(`error: Tailscale port ${exposed} already has a route`)
      return
    }
    try {
      void applyCommand(
        addHttpsRouteCommand(local, exposed, action.access),
        `Added HTTPS ${action.access === "public" ? "Funnel" : "Serve"} route on port ${exposed}.`,
      )
    } catch (reason) {
      setMessage(`error: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }, [applyCommand, snapshot?.ports])

  useInput((input, key) => {
    if (mutating) return

    if (pending?.kind === "add") {
      if (key.escape) {
        setPending(undefined)
        setMessage("Add cancelled.")
        return
      }
      if (key.tab || key.upArrow || key.downArrow) {
        setPending((current) => current?.kind === "add"
          ? { ...current, field: current.field === "local" ? "tailscale" : "local" }
          : current)
        return
      }
      if (input === "f") {
        setPending((current) => {
          if (current?.kind !== "add") return current
          const access = current.access === "tailnet" ? "public" : "tailnet"
          const port = validPort(current.tailscalePort)
          const fallback = nextHttpsPort(snapshot?.ports ?? [], access)
          return {
            ...current,
            access,
            tailscalePort: access === "public" && (!port || !funnelPorts.has(port)) ? String(fallback ?? "") : current.tailscalePort,
          }
        })
        setMessage("")
        return
      }
      if (key.return) {
        if (pending.field === "local") {
          setPending((current) => current?.kind === "add" ? { ...current, field: "tailscale" } : current)
        }
        else submitAdd(pending)
        return
      }
      if (key.backspace || key.delete) {
        setPending((current) => {
          if (current?.kind !== "add") return current
          const name = current.field === "local" ? "localPort" : "tailscalePort"
          return { ...current, [name]: current[name].slice(0, -1) }
        })
        setMessage("")
        return
      }
      const digits = input.replace(/\D/g, "")
      if (digits) {
        setPending((current) => {
          if (current?.kind !== "add") return current
          const name = current.field === "local" ? "localPort" : "tailscalePort"
          return { ...current, [name]: `${current[name]}${digits}`.slice(0, 5) }
        })
        setMessage("")
      }
      return
    }

    if (pending) {
      if (input === "y" || key.return) confirm(pending)
      else if (input === "n" || key.escape) {
        setPending(undefined)
        setMessage("Action cancelled.")
      }
      return
    }

    if (input === "q" || (key.ctrl && input === "c")) return exit()
    if (input === "r") return void refresh()
    const total = snapshot?.routes.length ?? 0
    const route = snapshot?.routes[selected]
    if (input === "a") {
      const port = nextHttpsPort(snapshot?.ports ?? [])
      setPending({ kind: "add", field: "local", localPort: "", tailscalePort: port ? String(port) : "", access: "tailnet" })
      setMessage("")
      return
    }
    if (input === "d" && route) {
      setPending({ kind: "remove", route })
      setMessage("")
      return
    }
    if (input === "f" && route) {
      const access = route.access === "public" ? "tailnet" : "public"
      try {
        changeAccessCommand(route, access)
        setPending({ kind: "access", route, access })
        setMessage("")
      } catch (reason) {
        setMessage(`error: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
      return
    }
    if (input === "x" && total) {
      setPending({ kind: "reset" })
      setMessage("")
      return
    }
    if (key.downArrow || input === "j") setSelected((value) => Math.min(value + 1, Math.max(total - 1, 0)))
    if (key.upArrow || input === "k") setSelected((value) => Math.max(value - 1, 0))
    if (key.pageDown) setSelected((value) => Math.min(value + 8, Math.max(total - 1, 0)))
    if (key.pageUp || input === "u") setSelected((value) => Math.max(value - 8, 0))
    if (input === "g") setSelected(0)
    if (input === "G") setSelected(Math.max(total - 1, 0))
  })

  const route = snapshot?.routes[selected]
  const listeningCount = snapshot?.routes.filter((item) => item.health === "up").length ?? 0
  const title = refreshing ? "refreshing…" : snapshot ? `updated ${snapshot.refreshedAt.toLocaleTimeString()}` : "loading…"
  const summary = snapshot
    ? `${snapshot.routes.length} routes · ${snapshot.ports.length} TS ports · ${snapshot.localPorts.length} targets · ${listeningCount} up`
    : "waiting for tailscale serve status"

  return (
    <Box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg} paddingX={1}>
      <Box height={2} flexDirection="column" flexShrink={0}>
        <Text color={colors.cyan} bold>Tailscale Serve</Text>
        <Text color={colors.muted}>{summary}  ·  {title}</Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box width="45%" flexShrink={0} flexDirection="column" border borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} paddingX={1}>
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
          {pending?.kind === "add" ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text color={colors.cyan} bold>ADD HTTPS ROUTE</Text>
              <Text color={colors.text}>Create a persistent reverse proxy to 127.0.0.1.</Text>
              <Text color={pending.field === "local" ? colors.cyan : colors.text} bold={pending.field === "local"}>
                local port     {pending.localPort || "_"}{pending.field === "local" ? "█" : ""}
              </Text>
              <Text color={pending.field === "tailscale" ? colors.cyan : colors.text} bold={pending.field === "tailscale"}>
                Tailscale HTTPS {pending.tailscalePort || "_"}{pending.field === "tailscale" ? "█" : ""}
              </Text>
              <Text color={pending.access === "public" ? colors.purple : colors.green}>
                access         {pending.access === "public" ? "PUBLIC / FUNNEL" : "TAILNET ONLY"}
              </Text>
            </Box>
          ) : pending?.kind === "remove" ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text color={colors.red} bold>REMOVE ROUTE?</Text>
              <Text color={colors.text}>{pending.route.endpoint}</Text>
              <Text color={colors.faint}>{describeCommand(removeRouteCommand(pending.route))}</Text>
            </Box>
          ) : pending?.kind === "access" ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text color={pending.access === "public" ? colors.purple : colors.green} bold>
                MAKE {pending.access === "public" ? "PUBLIC" : "TAILNET-ONLY"}?
              </Text>
              <Text color={colors.text}>{pending.route.endpoint}</Text>
              <Text color={colors.faint}>Access changes apply to every path on Tailscale port {pending.route.port}.</Text>
            </Box>
          ) : pending?.kind === "reset" ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text color={colors.red} bold>RESET ALL ROUTES?</Text>
              <Text color={colors.text}>This removes the entire Serve and Funnel configuration.</Text>
            </Box>
          ) : route ? (
            <Box flexDirection="column" paddingTop={1}>
              <Text color={colors.cyan} bold>{route.endpoint}</Text>
              <Text color={colors.text}>access       {route.access === "public" ? "PUBLIC / FUNNEL" : "TAILNET ONLY"}</Text>
              <Text color={colors.text}>Tailscale port {route.port}</Text>
              <Text color={colors.text}>upstream     {route.target}</Text>
              <Text color={healthColor(route.health)}>{route.localPort ? `local port   ${route.localPort} · ${healthLabel(route.health)}` : "local port   n/a"}</Text>
              <Text color={colors.faint}>route id     {route.id}</Text>
              <Box flexDirection="column" paddingTop={1}>
                <Text color={colors.muted} bold>ACTIONS</Text>
                <Text color={colors.text}>d remove route  ·  f {route.access === "public" ? "make tailnet-only" : "publish with Funnel"}</Text>
                <Text color={colors.text}>a add HTTPS route  ·  x reset all</Text>
              </Box>
            </Box>
          ) : (
            <Text color={error ? colors.red : colors.muted}>{error || "Select a route to inspect it."}</Text>
          )}
        </Box>
      </Box>

      <Box height={3} flexDirection="column" flexShrink={0} paddingTop={1}>
        <Text color={colors.muted}>
          {mutating
            ? "Updating Tailscale…"
            : pending?.kind === "add"
              ? "digits type  ·  tab fields  ·  f Serve/Funnel  ·  enter next/save  ·  esc cancel"
              : pending
                ? "y/enter confirm  ·  n/esc cancel"
                : "j/k move  ·  a add  ·  d remove  ·  f Serve/Funnel  ·  x reset  ·  r refresh  ·  q quit"}
        </Text>
        {(error || message) && <Text color={(error || message.startsWith("error:")) ? colors.red : colors.green} wrap="truncate">{error ? `error: ${error}` : message}</Text>}
      </Box>
    </Box>
  )
}

if (import.meta.main) {
  const instance = await render(<App />)
  await instance.waitUntilExit()
}
