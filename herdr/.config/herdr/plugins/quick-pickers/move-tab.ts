import { RpcTransportError } from "./rpc";

export type RpcCall = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

type MoveFailureDetails = {
  recoveredTabId?: string;
  sourceWorkspaceId?: string;
  movedTabId?: string;
  destinationWorkspaceId?: string;
  partial?: boolean;
};
export class MoveTabError extends Error {
  readonly recoveredTabId?: string;
  readonly sourceWorkspaceId?: string;
  readonly movedTabId?: string;
  readonly destinationWorkspaceId?: string;
  readonly partial: boolean;

  constructor(message: string, details: MoveFailureDetails = {}) {
    super(message);
    this.name = "MoveTabError";
    Object.assign(this, details);
    this.partial = details.partial === true;
  }
}

type PaneNode = { type: "pane"; pane_id: string };
type SplitNode = {
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
};
type LayoutNode = PaneNode | SplitNode;
type Layout = {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  focused_pane_id: string;
  root: LayoutNode;
};
type Tab = { tab_id: string; workspace_id: string; label: string };
type MovedPane = { pane_id: string; tab_id: string; workspace_id: string };
type MoveResponse = { move_result: { changed: boolean; reason?: string; pane: MovedPane } };

function firstPane(node: LayoutNode): string {
  return node.type === "pane" ? node.pane_id : firstPane(node.first);
}

function paneIds(node: LayoutNode, ids: string[] = []): string[] {
  if (node.type === "pane") {
    if (!node.pane_id || ids.includes(node.pane_id)) throw new Error("The tab has an invalid pane layout");
    ids.push(node.pane_id);
  } else if (node.type === "split") {
    if (!["right", "down"].includes(node.direction) || !Number.isFinite(node.ratio)) {
      throw new Error("The tab has an invalid split layout");
    }
    paneIds(node.first, ids);
    paneIds(node.second, ids);
  } else {
    throw new Error("The tab has an invalid layout");
  }
  return ids;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Move the captured tab's live panes; layout.apply would restart its terminals. */
export async function moveTab(call: RpcCall, sourceTabId: string, destinationWorkspaceId: string): Promise<string> {
  const [{ tab }, { layout }] = await Promise.all([
    call<{ tab: Tab }>("tab.get", { tab_id: sourceTabId }),
    call<{ layout: Layout }>("layout.export", { tab_id: sourceTabId }),
  ]);
  if (!tab || !layout || tab.workspace_id !== layout.workspace_id || tab.tab_id !== layout.tab_id) {
    throw new Error("The source tab changed; reopen the move picker");
  }
  if (tab.workspace_id === destinationWorkspaceId) return tab.tab_id;

  const ids = paneIds(layout.root);
  if (!ids.includes(layout.focused_pane_id)) throw new Error("The tab's focused pane is unavailable");
  const currentIds = new Map(ids.map((id) => [id, id]));
  let movedCount = 0;
  let unzoomed = false;

  function uncertainMove(message: string): MoveTabError {
    return new MoveTabError(`Move status is uncertain: ${message}. Inspect ${tab.workspace_id} and ${destinationWorkspaceId} before moving again`, {
      partial: true,
      sourceWorkspaceId: tab.workspace_id,
      destinationWorkspaceId,
    });
  }

  async function move(originalId: string, destination: Record<string, unknown>): Promise<MovedPane> {
    let response: MoveResponse;
    try {
      response = await call<MoveResponse>("pane.move", {
        pane_id: currentIds.get(originalId),
        destination,
        focus: false,
      });
    } catch (error) {
      if (error instanceof RpcTransportError && error.mayHaveExecuted) {
        throw uncertainMove(error.message);
      }
      throw error;
    }
    const result = response?.move_result;
    if (!result || typeof result.changed !== "boolean") throw uncertainMove("Herdr returned an incomplete pane move status");
    if (!result.changed) throw new Error(result.reason ? `Herdr could not move this pane (${result.reason})` : "Herdr did not move the pane");
    movedCount += 1;
    if (!result.pane?.pane_id || !result.pane.tab_id || !result.pane.workspace_id) {
      throw uncertainMove("Herdr returned an incomplete pane move result");
    }
    currentIds.set(originalId, result.pane.pane_id);
    return result.pane;
  }

  async function rebuild(workspaceId: string): Promise<string> {
    const rootPane = await move(firstPane(layout.root), {
      type: "new_tab",
      workspace_id: workspaceId,
      label: tab.label,
    });
    const targetTabId = rootPane.tab_id;

    // Each subtree starts as its first leaf. Split it before expanding its children
    // so the saved first/second order and ratios survive arbitrary nested layouts.
    async function expand(node: LayoutNode): Promise<void> {
      if (node.type === "pane") return;
      await move(firstPane(node.second), {
        type: "tab",
        tab_id: targetTabId,
        target_pane_id: currentIds.get(firstPane(node.first)),
        split: node.direction,
        ratio: node.ratio,
      });
      await expand(node.first);
      await expand(node.second);
    }
    await expand(layout.root);
    return targetTabId;
  }

  async function focus(workspaceId: string, tabId: string): Promise<void> {
    await call("workspace.focus", { workspace_id: workspaceId });
    await call("tab.focus", { tab_id: tabId });
    await call("pane.focus", { pane_id: currentIds.get(layout.focused_pane_id) });
    if (layout.zoomed) await call("pane.zoom", { pane_id: currentIds.get(layout.focused_pane_id), mode: "on" });
  }

  let movedTabId: string;
  try {
    // pane.move rejects a zoomed source tab, even when moving its whole layout.
    if (layout.zoomed) {
      await call("pane.zoom", { pane_id: layout.focused_pane_id, mode: "off" });
      unzoomed = true;
    }
    movedTabId = await rebuild(destinationWorkspaceId);
  } catch (error) {
    // The server may still be applying a move whose reply was lost. Further
    // moves or rollback would race it and could split the sessions again.
    if (error instanceof MoveTabError && error.partial) throw error;
    const cause = errorMessage(error);
    if (movedCount > 0) {
      let restoredTabId: string;
      try {
        // A failed partial transfer still has panes in the original space. Move
        // every saved pane into a fresh source tab to recover the complete tree.
        restoredTabId = await rebuild(tab.workspace_id);
      } catch (rollbackError) {
        const detail = errorMessage(rollbackError);
        throw new MoveTabError(`Move failed: ${cause}. Recovery failed (${detail}); panes may be split between ${tab.workspace_id} and ${destinationWorkspaceId}`, {
          partial: true,
          sourceWorkspaceId: tab.workspace_id,
          destinationWorkspaceId,
        });
      }
      try {
        await focus(tab.workspace_id, restoredTabId);
      } catch {
        throw new MoveTabError(`Move failed: ${cause}. Panes were restored to ${tab.workspace_id}, but focus could not be restored`, {
          recoveredTabId: restoredTabId,
          sourceWorkspaceId: tab.workspace_id,
        });
      }
      // The source ID changes when the saved layout is recovered in a new tab.
      // Export its new identity so an open picker can safely retry this tab.
      throw new MoveTabError(`Move failed: ${cause}. The tab was restored in ${tab.workspace_id}`, {
        recoveredTabId: restoredTabId,
        sourceWorkspaceId: tab.workspace_id,
      });
    }
    if (unzoomed) {
      try {
        await call("pane.zoom", { pane_id: layout.focused_pane_id, mode: "on" });
      } catch {
        throw new MoveTabError(`Move failed: ${cause}. The original tab's zoom could not be restored`);
      }
    }
    throw new MoveTabError(`Move failed: ${cause}`);
  }

  try {
    await focus(destinationWorkspaceId, movedTabId);
  } catch (error) {
    // The transfer is complete; a focus failure must not send the sessions back.
    throw new MoveTabError(`Tab moved to ${destinationWorkspaceId}, but focusing it failed: ${errorMessage(error)}`, {
      movedTabId,
      destinationWorkspaceId,
    });
  }
  return movedTabId;
}
