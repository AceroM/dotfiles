import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModelOption = {
  model: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseModelListResponse(
  message: unknown,
  expectedId: number,
): { models: ModelOption[]; nextCursor: string | null } {
  if (!isObject(message) || message.id !== expectedId) {
    throw new Error("Codex returned an unexpected model-list response");
  }
  if (isObject(message.error)) {
    const detail =
      typeof message.error.message === "string"
        ? `: ${message.error.message}`
        : "";
    throw new Error(`Codex model discovery failed${detail}`);
  }

  const result = message.result;
  if (!isObject(result) || !Array.isArray(result.data)) {
    throw new Error("Codex returned an invalid model list");
  }

  const models = result.data.flatMap((value): ModelOption[] => {
    if (!isObject(value) || !isIdentifier(value.model) || value.hidden === true)
      return [];

    const supportedReasoningEfforts = unique(
      (Array.isArray(value.supportedReasoningEfforts)
        ? value.supportedReasoningEfforts
        : []
      ).flatMap((option): string[] => {
        if (!isObject(option) || !isIdentifier(option.reasoningEffort))
          return [];
        return [option.reasoningEffort];
      }),
    );
    if (!isIdentifier(value.defaultReasoningEffort)) return [];
    if (!supportedReasoningEfforts.includes(value.defaultReasoningEffort)) {
      supportedReasoningEfforts.push(value.defaultReasoningEffort);
    }

    return [
      {
        model: value.model,
        displayName:
          typeof value.displayName === "string" && value.displayName
            ? value.displayName
            : value.model,
        supportedReasoningEfforts,
        defaultReasoningEffort: value.defaultReasoningEffort,
        isDefault: value.isDefault === true,
      },
    ];
  });

  return {
    models,
    nextCursor:
      typeof result.nextCursor === "string" ? result.nextCursor : null,
  };
}

export function parseModelCache(raw: unknown): ModelOption[] {
  if (!isObject(raw) || !Array.isArray(raw.models)) {
    throw new Error("Codex's local model cache is invalid");
  }

  return raw.models.flatMap((value): ModelOption[] => {
    if (
      !isObject(value) ||
      !isIdentifier(value.slug) ||
      value.visibility !== "list" ||
      !isIdentifier(value.default_reasoning_level)
    ) {
      return [];
    }

    const supportedReasoningEfforts = unique(
      (Array.isArray(value.supported_reasoning_levels)
        ? value.supported_reasoning_levels
        : []
      ).flatMap((option): string[] => {
        if (!isObject(option) || !isIdentifier(option.effort)) return [];
        return [option.effort];
      }),
    );
    if (!supportedReasoningEfforts.includes(value.default_reasoning_level)) {
      supportedReasoningEfforts.push(value.default_reasoning_level);
    }

    return [
      {
        model: value.slug,
        displayName:
          typeof value.display_name === "string" && value.display_name
            ? value.display_name
            : value.slug,
        supportedReasoningEfforts,
        defaultReasoningEffort: value.default_reasoning_level,
        isDefault: value.priority === 0,
      },
    ];
  });
}

async function queryAppServer(): Promise<ModelOption[]> {
  const child = Bun.spawn(["codex", "app-server", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush();
  };

  const nextMessage = async (): Promise<unknown> => {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) return JSON.parse(line);
        continue;
      }

      const chunk = await reader.read();
      if (chunk.done) {
        const line = buffered.trim();
        if (line) return JSON.parse(line);
        throw new Error(
          "Codex app-server closed before returning its model list",
        );
      }
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };

  const response = async (id: number): Promise<unknown> => {
    while (true) {
      const message = await nextMessage();
      if (isObject(message) && message.id === id) return message;
    }
  };

  const discover = async (): Promise<ModelOption[]> => {
    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "ac", title: "Agent Config", version: "1" },
        capabilities: null,
      },
    });
    await response(0);
    send({ method: "initialized" });

    const models: ModelOption[] = [];
    let cursor: string | null = null;
    let id = 1;
    do {
      send({
        method: "model/list",
        id,
        params: { cursor, limit: 100, includeHidden: false },
      });
      const page = parseModelListResponse(await response(id), id);
      models.push(...page.models);
      cursor = page.nextCursor;
      id += 1;
    } while (cursor);

    if (models.length === 0)
      throw new Error("Codex returned no selectable models");
    return models;
  };

  try {
    return await Promise.race([
      discover(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill();
          reject(new Error("Codex model discovery timed out"));
        }, 3_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    child.stdin.end();
    child.kill();
    await child.exited;
  }
}

async function readModelCache(): Promise<ModelOption[]> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const raw = JSON.parse(
    await readFile(join(codexHome, "models_cache.json"), "utf8"),
  );
  const models = parseModelCache(raw);
  if (models.length === 0)
    throw new Error("Codex's local model cache has no selectable models");
  return models;
}

export async function loadModelCatalog(): Promise<ModelOption[]> {
  try {
    return await queryAppServer();
  } catch (appServerError) {
    try {
      return await readModelCache();
    } catch {
      throw appServerError;
    }
  }
}

export function reasoningEffortsFor(
  catalog: readonly ModelOption[],
  model: string,
  current?: string,
): readonly string[] {
  const efforts = catalog.find(
    (option) => option.model === model,
  )?.supportedReasoningEfforts;
  if (efforts?.length) return efforts;
  return current ? [current] : [];
}

export function normalizeReasoningForModel(
  catalog: readonly ModelOption[],
  model: string,
  reasoning: string,
): string {
  const option = catalog.find((candidate) => candidate.model === model);
  if (!option || option.supportedReasoningEfforts.includes(reasoning))
    return reasoning;
  return option.defaultReasoningEffort;
}
