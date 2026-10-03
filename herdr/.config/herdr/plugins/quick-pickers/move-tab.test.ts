import { describe, expect, test } from "bun:test";
import { moveTab, MoveTabError, type RpcCall } from "./move-tab";
import { RpcTransportError } from "./rpc";

type Node = { type: "pane"; pane_id: string } | {
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: Node;
  second: Node;
};
type FakeTab = { tab_id: string; workspace_id: string; label: string; root: Node; focused_pane_id: string; zoomed: boolean };
const leaf = (id: string): Node => ({ type: "pane", pane_id: id });
const split = (direction: "right" | "down", ratio: number, first: Node, second: Node): Node => ({ type: "split", direction, ratio, first, second });
const nested = () => split("right", 0.63,
  split("down", 0.35, leaf("source:p1"), leaf("source:p2")),
  split("right", 0.72, leaf("source:p3"), split("down", 0.42, leaf("source:p4"), leaf("source:p5"))),
);

function leaves(node: Node): string[] {
  return node.type === "pane" ? [node.pane_id] : [...leaves(node.first), ...leaves(node.second)];
}

function remove(node: Node, id: string): Node | undefined {
  if (node.type === "pane") return node.pane_id === id ? undefined : node;
  const first = remove(node.first, id);
  const second = remove(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function insert(node: Node, id: string, replacement: Node): Node {
  if (node.type === "pane") return node.pane_id === id ? replacement : node;
  return { ...node, first: insert(node.first, id, replacement), second: insert(node.second, id, replacement) };
}

function fixture(options: { root?: Node; focused?: string; zoomed?: boolean; failMoves?: number[]; failFocus?: boolean } = {}) {
  const root = options.root || nested();
  const original = structuredClone(root);
  const focused = options.focused || leaves(root)[leaves(root).length - 2] || leaves(root)[0];
  const tabs = new Map<string, FakeTab>([
    ["source:t7", { tab_id: "source:t7", workspace_id: "source", label: "Backend", root, focused_pane_id: focused, zoomed: options.zoomed || false }],
    ["destination:t1", { tab_id: "destination:t1", workspace_id: "destination", label: "Existing", root: leaf("destination:p1"), focused_pane_id: "destination:p1", zoomed: false }],
  ]);
  const terminals = new Map([...leaves(root), "destination:p1"].map((id) => [id, `terminal:${id}`]));
  const originalTerminals = new Set(leaves(root).map((id) => terminals.get(id)));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const failures = new Set(options.failMoves || []);
  let paneNumber = 10;
  let tabNumber = 10;
  let moveNumber = 0;
  let activeWorkspace = "source";
  let activeTab = "source:t7";

  function containing(id: string): FakeTab {
    const tab = [...tabs.values()].find((tab) => leaves(tab.root).includes(id));
    if (!tab) throw new Error(`Pane ${id} not found`);
    return tab;
  }

  const call: RpcCall = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params: structuredClone(params) });
    let result: unknown;
    if (method === "tab.get" || method === "layout.export") {
      const tab = tabs.get(String(params.tab_id));
      if (!tab) throw new Error("Tab not found");
      result = method === "tab.get"
        ? { tab: { tab_id: tab.tab_id, workspace_id: tab.workspace_id, label: tab.label } }
        : { layout: structuredClone(tab) };
    } else if (method === "pane.move") {
      if (failures.has(++moveNumber)) throw new Error("Injected move failure");
      const sourceId = String(params.pane_id);
      const source = containing(sourceId);
      if (source.zoomed) throw new Error("Cannot move a zoomed tab");
      const destination = params.destination as Record<string, unknown>;
      const targetWorkspace = destination.type === "new_tab"
        ? String(destination.workspace_id)
        : tabs.get(String(destination.tab_id))?.workspace_id;
      if (!targetWorkspace) throw new Error("Target space not found");
      const targetId = source.workspace_id === targetWorkspace ? sourceId : `${targetWorkspace}:p${++paneNumber}`;
      const terminal = terminals.get(sourceId)!;
      terminals.delete(sourceId);
      terminals.set(targetId, terminal);
      const remaining = remove(source.root, sourceId);
      if (remaining) {
        source.root = remaining;
        if (source.focused_pane_id === sourceId) source.focused_pane_id = leaves(remaining)[0];
      } else {
        tabs.delete(source.tab_id);
      }
      let target: FakeTab;
      if (destination.type === "new_tab") {
        const tabId = `${targetWorkspace}:t${++tabNumber}`;
        target = { tab_id: tabId, workspace_id: targetWorkspace, label: String(destination.label), root: leaf(targetId), focused_pane_id: targetId, zoomed: false };
        tabs.set(tabId, target);
      } else {
        target = tabs.get(String(destination.tab_id))!;
        const anchor = String(destination.target_pane_id);
        if (!target || !leaves(target.root).includes(anchor)) throw new Error("Invalid split target");
        target.root = insert(target.root, anchor, split(destination.split as "right" | "down", Number(destination.ratio), leaf(anchor), leaf(targetId)));
      }
      result = { move_result: { changed: true, pane: { pane_id: targetId, tab_id: target.tab_id, workspace_id: targetWorkspace } } };
    } else if (method === "pane.zoom") {
      const tab = containing(String(params.pane_id));
      tab.zoomed = params.mode === "on";
      result = { zoom: { zoomed: tab.zoomed } };
    } else if (method === "workspace.focus") {
      activeWorkspace = String(params.workspace_id);
      result = { type: "ok" };
    } else if (method === "tab.focus") {
      if (options.failFocus) throw new Error("Injected focus failure");
      activeTab = String(params.tab_id);
      if (!tabs.has(activeTab)) throw new Error("Cannot focus missing tab");
      result = { type: "ok" };
    } else if (method === "pane.focus") {
      const paneId = String(params.pane_id);
      containing(paneId).focused_pane_id = paneId;
      result = { type: "ok" };
    } else {
      throw new Error(`Unexpected RPC: ${method}`);
    }
    return result as T;
  };

  function terminalTree(node: Node): unknown {
    return node.type === "pane"
      ? { type: "pane", terminal: terminals.get(node.pane_id) }
      : { ...node, first: terminalTree(node.first), second: terminalTree(node.second) };
  }
  function expectedTree(node: Node): unknown {
    return node.type === "pane"
      ? { type: "pane", terminal: `terminal:${node.pane_id}` }
      : { ...node, first: expectedTree(node.first), second: expectedTree(node.second) };
  }
  return { call, calls, tabs, terminals, originalTerminals, focused, original, terminalTree, expectedTree, active: () => ({ workspace: activeWorkspace, tab: activeTab }) };
}

describe("moveTab", () => {
  test("moves an arbitrary split tree with its live terminals, title, focus, and zoom", async () => {
    const f = fixture({ zoomed: true, focused: "source:p4" });
    const movedId = await moveTab(f.call, "source:t7", "destination");
    const moved = f.tabs.get(movedId)!;
    expect(moved.workspace_id).toBe("destination");
    expect(moved.label).toBe("Backend");
    expect(moved.zoomed).toBe(true);
    expect(f.terminals.get(moved.focused_pane_id)).toBe("terminal:source:p4");
    expect(f.terminalTree(moved.root)).toEqual(f.expectedTree(f.original));
    expect(new Set(leaves(moved.root).map((id) => f.terminals.get(id)))).toEqual(f.originalTerminals);
    expect(f.tabs.has("source:t7")).toBe(false);
    expect(leaves(f.tabs.get("destination:t1")!.root)).toEqual(["destination:p1"]);
    expect(f.active()).toEqual({ workspace: "destination", tab: movedId });
    expect(f.calls.filter((call) => call.method === "pane.move")).toHaveLength(5);
    expect(f.calls.some((call) => ["layout.apply", "pane.close", "tab.close", "tab.create"].includes(call.method))).toBe(false);
  });

  test("moves a single terminal into its own destination tab", async () => {
    const f = fixture({ root: leaf("source:p1") });
    const movedId = await moveTab(f.call, "source:t7", "destination");
    expect(f.terminals.get(f.tabs.get(movedId)!.focused_pane_id)).toBe("terminal:source:p1");
    expect(f.calls.filter((call) => call.method === "pane.move")).toHaveLength(1);
  });

  test("choosing the current space makes no changes", async () => {
    const f = fixture({ zoomed: true });
    expect(await moveTab(f.call, "source:t7", "source")).toBe("source:t7");
    expect(f.calls.map((call) => call.method)).toEqual(["tab.get", "layout.export"]);
  });

  test("restores the entire original layout after a partial move and exposes its new tab ID", async () => {
    const f = fixture({ failMoves: [3], zoomed: true, focused: "source:p4" });
    let failure: MoveTabError | undefined;
    try {
      await moveTab(f.call, "source:t7", "destination");
    } catch (error) {
      failure = error as MoveTabError;
    }
    expect(failure).toBeInstanceOf(MoveTabError);
    expect(failure!.message).toContain("The tab was restored");
    expect(failure!.sourceWorkspaceId).toBe("source");
    const restored = f.tabs.get(failure!.recoveredTabId!)!;
    expect(f.terminalTree(restored.root)).toEqual(f.expectedTree(f.original));
    expect(restored.zoomed).toBe(true);
    expect(restored.label).toBe("Backend");
    expect(f.terminals.get(restored.focused_pane_id)).toBe("terminal:source:p4");
    expect([...f.tabs.values()].filter((tab) => tab.workspace_id === "destination")).toHaveLength(1);
    expect(f.active()).toEqual({ workspace: "source", tab: restored.tab_id });
    // A retry must use the recovered identity rather than the vanished source ID.
    expect(await moveTab(f.call, restored.tab_id, "destination")).toStartWith("destination:");
  });

  test("reports where to find panes if transfer and rollback both fail", async () => {
    const f = fixture({ failMoves: [2, 3] });
    try {
      await moveTab(f.call, "source:t7", "destination");
      throw new Error("Expected transfer to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MoveTabError);
      expect((error as MoveTabError).partial).toBe(true);
      expect((error as Error).message).toContain("panes may be split between source and destination");
    }
    expect(f.terminals.size).toBe(6);
  });

  test("restores source zoom when the first move fails", async () => {
    const f = fixture({ failMoves: [1], zoomed: true });
    await expect(moveTab(f.call, "source:t7", "destination")).rejects.toThrow("Move failed: Injected move failure");
    expect(f.tabs.get("source:t7")!.zoomed).toBe(true);
    expect(f.tabs.size).toBe(2);
  });

  test("a focus failure after transfer leaves the complete tab at its destination", async () => {
    const f = fixture({ failFocus: true });
    try {
      await moveTab(f.call, "source:t7", "destination");
      throw new Error("Expected focus to fail");
    } catch (error) {
      const failure = error as MoveTabError;
      expect(failure).toBeInstanceOf(MoveTabError);
      expect(failure.movedTabId).toBeDefined();
      expect(failure.destinationWorkspaceId).toBe("destination");
      expect(f.terminalTree(f.tabs.get(failure.movedTabId!)!.root)).toEqual(f.expectedTree(f.original));
    }
    expect(f.calls.filter((call) => call.method === "pane.move")).toHaveLength(5);
    expect(f.tabs.has("source:t7")).toBe(false);
  });

  for (const failedMove of [1, 3]) {
    test(`a lost reply after move ${failedMove} stops all mutations and marks the transfer uncertain`, async () => {
      const f = fixture({ zoomed: true });
      let moves = 0;
      const lostReply: RpcCall = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        // Apply the real mocked move before losing its reply: the caller cannot
        // assume a timed out request left the pane in its original position.
        const result = await f.call<T>(method, params);
        if (method === "pane.move" && ++moves === failedMove) {
          throw new RpcTransportError("pane.move timed out", true);
        }
        return result;
      };
      let failure: MoveTabError | undefined;
      try {
        await moveTab(lostReply, "source:t7", "destination");
      } catch (error) {
        failure = error as MoveTabError;
      }
      expect(failure).toBeInstanceOf(MoveTabError);
      expect(failure!.partial).toBe(true);
      expect(failure!.sourceWorkspaceId).toBe("source");
      expect(failure!.destinationWorkspaceId).toBe("destination");
      expect(failure!.message).toContain("Move status is uncertain");
      expect(f.calls.filter((call) => call.method === "pane.move")).toHaveLength(failedMove);
      expect(f.calls.at(-1)!.method).toBe("pane.move");
      expect(f.calls.filter((call) => call.method === "pane.zoom").map((call) => call.params.mode)).toEqual(["off"]);
      expect(f.terminals.size).toBe(6);
      expect([...f.tabs.values()].filter((tab) => tab.workspace_id === "destination")).toHaveLength(2);
    });
  }

  test("an executed move with a missing returned identity stops without rollback", async () => {
    const f = fixture();
    const incompleteReply: RpcCall = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const result = await f.call<T>(method, params);
      return method === "pane.move" ? { move_result: { changed: true } } as T : result;
    };
    try {
      await moveTab(incompleteReply, "source:t7", "destination");
      throw new Error("Expected incomplete reply to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MoveTabError);
      expect((error as MoveTabError).partial).toBe(true);
    }
    expect(f.calls.filter((call) => call.method === "pane.move")).toHaveLength(1);
    expect(f.calls.at(-1)!.method).toBe("pane.move");
  });
});
