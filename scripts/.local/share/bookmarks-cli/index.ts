#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DIGIT_SLOTS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

const configHome =
  process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
const storeDir = join(configHome, "bookmarks-cli");
const storePath = join(storeDir, "bookmarks.json");

type Store = Record<string, string>;

function loadStore(): Store {
  if (!existsSync(storePath)) return {};
  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Store = {};
    for (const slot of DIGIT_SLOTS) {
      const v = (parsed as Record<string, unknown>)[slot];
      if (typeof v === "string" && v.length > 0) out[slot] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveStore(store: Store) {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

function isDigitSlot(slot: string): slot is (typeof DIGIT_SLOTS)[number] {
  return (DIGIT_SLOTS as readonly string[]).includes(slot);
}

function expandPath(input: string): string {
  let p = input;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function cmdList() {
  const store = loadStore();
  for (const slot of DIGIT_SLOTS) {
    const path = store[slot];
    console.log(`${slot}  ${path ?? "(empty)"}`);
  }
}

function cmdSet(args: string[]) {
  const slot = args[0];
  if (!slot) fail("usage: bm set <slot> [path]");
  if (!isDigitSlot(slot)) fail(`invalid slot '${slot}': must be 0-9`);

  const target = args[1] ? expandPath(args[1]) : process.cwd();

  if (!existsSync(target)) fail(`path does not exist: ${target}`);
  if (!statSync(target).isDirectory()) fail(`not a directory: ${target}`);

  const store = loadStore();
  store[slot] = target;
  saveStore(store);
  console.log(`${slot} → ${target}`);
}

function cmdRm(args: string[]) {
  const slot = args[0];
  if (!slot) fail("usage: bm rm <slot>");
  if (!isDigitSlot(slot)) fail(`invalid slot '${slot}': must be 0-9`);

  const store = loadStore();
  if (!(slot in store)) {
    console.log(`${slot} already empty`);
    return;
  }
  delete store[slot];
  saveStore(store);
  console.log(`${slot} cleared`);
}

function cmdPath(args: string[]) {
  const slot = args[0];
  if (!slot) process.exit(2);
  if (!isDigitSlot(slot)) process.exit(2);
  const store = loadStore();
  const path = store[slot];
  if (!path) process.exit(2);
  process.stdout.write(path + "\n");
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd ?? "list") {
    case "list":
    case "ls":
      cmdList();
      break;
    case "set":
      cmdSet(rest);
      break;
    case "rm":
    case "remove":
    case "unset":
      cmdRm(rest);
      break;
    case "path":
      cmdPath(rest);
      break;
    case "-h":
    case "--help":
    case "help":
      console.log(
        "bm — bookmarked directories\n\n" +
          "  bm [list]            list slots 0-9\n" +
          "  bm set <0-9> [path]  assign path (or $PWD) to slot\n" +
          "  bm rm <0-9>          clear a slot\n" +
          "  bm path <0-9>        print path for slot (exit 2 if unset)\n",
      );
      break;
    default:
      fail(`unknown command: ${cmd}`);
  }
}

main();
