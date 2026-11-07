import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const worker = readFileSync(new URL("../browser-use/.local/share/browser-use/extension/background.js", import.meta.url), "utf8");

function event() {
  const listeners: Function[] = [];
  return {
    addListener(fn: Function) { listeners.push(fn); },
    async emit(...args: unknown[]) { await Promise.all(listeners.map((fn) => fn(...args))); },
  };
}

function browser() {
  const tabs = new Map<number, { id: number; groupId: number; windowId: number }>([
    [1, { id: 1, groupId: 10, windowId: 100 }],
    [2, { id: 2, groupId: -1, windowId: 100 }],
    [3, { id: 3, groupId: 20, windowId: 100 }],
  ]);
  const groups = new Map([
    [10, { id: 10, title: "Agents", windowId: 100 }],
    [20, { id: 20, title: "Personal", windowId: 100 }],
  ]);
  const grouped: number[] = [];
  const moved: number[] = [];
  const warnings: unknown[][] = [];
  const created = event();
  const navigationTarget = event();
  const noop = async () => {};
  const chrome = {
    runtime: {
      connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }),
      getManifest: () => ({ version: "test" }), onStartup: event(), onInstalled: event(),
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop, onClicked: event() },
    alarms: { create() {}, onAlarm: event() },
    commands: { onCommand: event() },
    storage: { local: { get: async () => ({}), set: noop } },
    debugger: { onDetach: event(), onEvent: event() },
    tabs: {
      onCreated: created, onRemoved: event(),
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("No tab");
        return { ...tab };
      },
      async query({ groupId }: { groupId?: number }) {
        return [...tabs.values()].filter((t) => groupId == null || t.groupId === groupId);
      },
      async move(id: number, { windowId }: { windowId: number }) {
        tabs.get(id)!.windowId = windowId;
        moved.push(id);
      },
      async group({ tabIds, groupId }: { tabIds: number[]; groupId: number }) {
        for (const id of tabIds) {
          expect(tabs.get(id)!.windowId).toBe(groups.get(groupId)!.windowId);
          tabs.get(id)!.groupId = groupId;
          grouped.push(id);
        }
        return groupId;
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async get(id: number) {
        if (!groups.has(id)) throw new Error("No group");
        return groups.get(id);
      },
      query: async ({ title }: { title: string }) => [...groups.values()].filter((g) => g.title === title),
    },
    webNavigation: { onCreatedNavigationTarget: navigationTarget },
  };
  runInNewContext(worker, {
    chrome, navigator: {}, setTimeout: () => 0, clearTimeout() {},
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  });
  const child = (id: number, windowId = 100, groupId = -1) => {
    const tab = { id, windowId, groupId };
    tabs.set(id, tab);
    return tab;
  };
  return { tabs, grouped, moved, warnings, created, navigationTarget, child };
}

test("a new tab inherits its Agents opener's group", async () => {
  const b = browser();
  await b.created.emit({ ...b.child(4), openerTabId: 1 });
  expect(b.grouped).toEqual([4]);
});

test("a noopener navigation target joins Agents without an openerTabId", async () => {
  const b = browser();
  await b.created.emit(b.child(4));
  expect(b.grouped).toEqual([]);
  await b.navigationTarget.emit({ tabId: 4, sourceTabId: 1 });
  expect(b.grouped).toEqual([4]);
});

test("tabs without an Agents source stay outside the group", async () => {
  const b = browser();
  await b.created.emit(b.child(4));
  await b.created.emit({ ...b.child(5), openerTabId: 2 });
  await b.navigationTarget.emit({ tabId: b.child(6).id, sourceTabId: 3 });
  expect(b.grouped).toEqual([]);
});

test("a popup moves to the Agents window before being grouped", async () => {
  const b = browser();
  await b.navigationTarget.emit({ tabId: b.child(4, 200).id, sourceTabId: 1 });
  expect(b.moved).toEqual([4]);
  expect(b.grouped).toEqual([4]);
});

test("duplicate creation events group once and rapid descendants wait for their source", async () => {
  const b = browser();
  const tab = b.child(4);
  const descendant = b.child(5);
  await Promise.all([
    b.created.emit({ ...tab, openerTabId: 1 }),
    b.navigationTarget.emit({ tabId: 4, sourceTabId: 1 }),
    b.created.emit({ ...descendant, openerTabId: 4 }),
  ]);
  expect(b.grouped).toEqual([4, 5]);
  await b.navigationTarget.emit({ tabId: 4, sourceTabId: 1 });
  expect(b.grouped).toEqual([4, 5]);
});

test("already grouped tabs and closed sources or targets are harmless", async () => {
  const b = browser();
  await b.created.emit({ ...b.child(4, 100, 10), openerTabId: 1 });
  await b.created.emit({ ...b.child(5), openerTabId: 99 });
  await b.navigationTarget.emit({ tabId: 99, sourceTabId: 1 });
  expect(b.grouped).toEqual([]);
  expect(b.warnings).toEqual([]);
});
