import { describe, expect, test } from "bun:test";
import {
  normalizeReasoningForModel,
  parseModelCache,
  parseModelListResponse,
  reasoningEffortsFor,
} from "./models";

const appServerModel = {
  model: "gpt-future-codex",
  displayName: "GPT Future Codex",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "overdrive", description: "Deep" },
  ],
  defaultReasoningEffort: "medium",
  isDefault: true,
};

describe("Codex model discovery", () => {
  test("parses models and efforts returned by app-server", () => {
    expect(
      parseModelListResponse(
        {
          id: 7,
          result: {
            data: [appServerModel, { ...appServerModel, hidden: true }],
            nextCursor: "page-2",
          },
        },
        7,
      ),
    ).toEqual({
      models: [
        {
          model: "gpt-future-codex",
          displayName: "GPT Future Codex",
          supportedReasoningEfforts: ["medium", "overdrive"],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      nextCursor: "page-2",
    });
  });

  test("parses Codex's local cache for offline fallback", () => {
    expect(
      parseModelCache({
        models: [
          {
            slug: "gpt-cached",
            display_name: "GPT Cached",
            visibility: "list",
            default_reasoning_level: "high",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            priority: 0,
          },
        ],
      }),
    ).toEqual([
      {
        model: "gpt-cached",
        displayName: "GPT Cached",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
        isDefault: true,
      },
    ]);
  });

  test("uses each model's advertised effort choices and default", () => {
    const catalog = parseModelListResponse(
      { id: 1, result: { data: [appServerModel], nextCursor: null } },
      1,
    ).models;

    expect(reasoningEffortsFor(catalog, "gpt-future-codex")).toEqual([
      "medium",
      "overdrive",
    ]);
    expect(
      normalizeReasoningForModel(catalog, "gpt-future-codex", "ultra"),
    ).toBe("medium");
  });
});
