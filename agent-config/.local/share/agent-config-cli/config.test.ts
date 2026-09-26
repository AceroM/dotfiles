import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  codexArgs,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "./config";

const tempDirs: string[] = [];

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-config-test-"));
  tempDirs.push(dir);
  return join(dir, "nested", "config.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe("agent config", () => {
  test("uses the launch profiles as defaults", async () => {
    const config = await loadConfig(await tempConfigPath());
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.profiles.cx.model).toBe("gpt-5.6-sol");
    expect(config.profiles.cxl.model).toBe("gpt-5.6-luna");
    expect(config.profiles.cxm.model).toBe("gpt-5.6-terra");
    expect(config.profiles.cxh.reasoning).toBe("xhigh");
  });

  test("preserves forward-compatible model and effort identifiers", () => {
    const config = normalizeConfig({
      profiles: {
        cx: {
          model: "future-codex-model",
          reasoning: "overdrive",
          access: "standard",
        },
        cxl: {
          model: "bad model with spaces",
          reasoning: "bad effort with spaces",
          access: "root",
        },
      },
    });

    expect(config.profiles.cx).toMatchObject({
      model: "future-codex-model",
      reasoning: "overdrive",
      access: "standard",
    });
    expect(config.profiles.cxl).toEqual(DEFAULT_CONFIG.profiles.cxl);
  });

  test("writes and reloads config", async () => {
    const path = await tempConfigPath();
    const config = normalizeConfig(DEFAULT_CONFIG);
    config.profiles.cxm.reasoning = "high";

    await saveConfig(config, path);

    expect(await loadConfig(path)).toEqual(config);
  });

  test("falls back to defaults for malformed JSON", async () => {
    const path = await tempConfigPath();
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, "{ definitely not json", "utf8");

    expect(await loadConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("builds explicit Codex arguments", () => {
    expect(codexArgs(DEFAULT_CONFIG.profiles.cx)).toEqual([
      "--no-daemon",
      "--yolo",
      "--model",
      "gpt-5.6-sol",
      "--config",
      "model_reasoning_effort=xhigh",
    ]);

    expect(
      codexArgs({ ...DEFAULT_CONFIG.profiles.cx, access: "standard" }),
    ).not.toContain("--yolo");
  });
});
