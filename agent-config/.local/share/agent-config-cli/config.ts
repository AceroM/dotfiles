import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const PROFILE_NAMES = ["cx", "cxl", "cxm", "cxh"] as const;
export const ACCESS_MODES = ["yolo", "standard"] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];
export type Model = string;
export type ReasoningLevel = string;
export type AccessMode = (typeof ACCESS_MODES)[number];

export type Profile = {
  label: string;
  model: Model;
  reasoning: ReasoningLevel;
  access: AccessMode;
};

export type AgentConfig = {
  version: 1;
  profiles: Record<ProfileName, Profile>;
};

export const DEFAULT_CONFIG: AgentConfig = {
  version: 1,
  profiles: {
    cx: {
      label: "Default",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
      access: "yolo",
    },
    cxl: {
      label: "Low",
      model: "gpt-5.6-luna",
      reasoning: "medium",
      access: "yolo",
    },
    cxm: {
      label: "Medium",
      model: "gpt-5.6-terra",
      reasoning: "medium",
      access: "yolo",
    },
    cxh: {
      label: "High",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
      access: "yolo",
    },
  },
};

function isOneOf<T extends readonly string[]>(
  value: unknown,
  choices: T,
): value is T[number] {
  return typeof value === "string" && choices.includes(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function cloneDefault(): AgentConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function configPath(): string {
  if (process.env.AGENT_CONFIG_PATH) return process.env.AGENT_CONFIG_PATH;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "agent-config", "config.json");
}

export function normalizeConfig(raw: unknown): AgentConfig {
  const config = cloneDefault();
  if (!raw || typeof raw !== "object") return config;

  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== "object") return config;

  for (const name of PROFILE_NAMES) {
    const candidate = (profiles as Record<string, unknown>)[name];
    if (!candidate || typeof candidate !== "object") continue;

    const value = candidate as Record<string, unknown>;
    const profile = config.profiles[name];
    if (isIdentifier(value.model)) profile.model = value.model;
    if (isIdentifier(value.reasoning)) profile.reasoning = value.reasoning;
    if (isOneOf(value.access, ACCESS_MODES)) profile.access = value.access;
  }

  return config;
}

export async function loadConfig(path = configPath()): Promise<AgentConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError)
      return cloneDefault();
    throw error;
  }
}

export async function saveConfig(
  config: AgentConfig,
  path = configPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  const data = `${JSON.stringify(normalizeConfig(config), null, 2)}\n`;
  await writeFile(tempPath, data, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

export function codexArgs(profile: Profile): string[] {
  // Per-profile reasoning uses --config, so Codex must run in embedded mode.
  const args: string[] = ["--no-daemon"];
  if (profile.access === "yolo") args.push("--yolo");
  args.push(
    "--model",
    profile.model,
    "--config",
    `model_reasoning_effort=${profile.reasoning}`,
  );
  return args;
}

export function commandPreview(profile: Profile): string {
  return ["codex", ...codexArgs(profile)].join(" ");
}

export function isProfileName(value: string): value is ProfileName {
  return PROFILE_NAMES.includes(value as ProfileName);
}

export function resetProfile(name: ProfileName): Profile {
  return structuredClone(DEFAULT_CONFIG.profiles[name]);
}
