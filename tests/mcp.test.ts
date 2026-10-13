import { describe, expect, it } from "vitest";
import { loadPluckConfig } from "../scripts/mcp.js";

describe("Pluck MCP server", () => {
  it("requires a control API URL and token", () => {
    expect(() => loadPluckConfig({})).toThrow("PLUCK_URL and PLUCK_TOKEN are required");
  });

  it("normalizes the configured Worker URL and preserves the optional owner token", () => {
    expect(loadPluckConfig({ PLUCK_URL: "https://pluck.example/", PLUCK_TOKEN: "control", PLUCK_OWNER_TOKEN: "owner" })).toEqual({
      url: "https://pluck.example",
      token: "control",
      ownerToken: "owner",
    });
  });
});
