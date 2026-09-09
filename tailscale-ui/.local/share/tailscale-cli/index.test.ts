import { describe, expect, test } from "bun:test"
import { addHttpsRouteCommand, changeAccessCommand, removeRouteCommand, type Route } from "./index"

function route(overrides: Partial<Route> = {}): Route {
  return {
    id: "migz.example.ts.net:8443/",
    port: 8443,
    protocol: "https",
    endpoint: "https://migz.example.ts.net:8443",
    path: "/",
    target: "http://127.0.0.1:4321",
    configureTarget: "http://127.0.0.1:4321",
    localPort: 4321,
    access: "tailnet",
    health: "up",
    ...overrides,
  }
}

describe("Tailscale route commands", () => {
  test("removes only the selected root Serve route", () => {
    expect(removeRouteCommand(route())).toEqual([
      "tailscale", "serve", "--yes", "--https=8443", "off",
    ])
  })

  test("preserves a Funnel route's path when removing it", () => {
    expect(removeRouteCommand(route({ access: "public", path: "/api" }))).toEqual([
      "tailscale", "funnel", "--yes", "--https=8443", "--set-path=/api", "off",
    ])
  })

  test("publishes a route with Funnel's supported flags", () => {
    expect(changeAccessCommand(route(), "public")).toEqual([
      "tailscale", "funnel", "--yes", "--bg", "--https=8443", "http://127.0.0.1:4321",
    ])
  })

  test("rejects a public route on an unsupported Funnel port", () => {
    expect(() => changeAccessCommand(route({ port: 9443 }), "public")).toThrow("Funnel only supports")
  })

  test("adds a persistent tailnet-only HTTPS proxy", () => {
    expect(addHttpsRouteCommand(5173, 443, "tailnet")).toEqual([
      "tailscale", "serve", "--yes", "--bg", "--https=443", "http://127.0.0.1:5173",
    ])
  })
})
