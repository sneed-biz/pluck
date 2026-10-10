import { describe, expect, it } from "vitest";
import { formatConflicts } from "../scripts/review.js";

describe("human conflict review", () => {
  it("renders actionable conflict summaries instead of raw job JSON", () => {
    expect(formatConflicts([
      {
        id: "pluck/agent-b:commit",
        sourceNamespace: "pluck",
        sourceRepo: "agent-b",
        sourceCommit: "commit",
        beforeCommit: "parent",
        status: "conflict",
        detail: JSON.stringify([{ path: "README.md", reason: "hunk-mismatch" }]),
        attemptCount: 2,
      },
    ])).toBe([
      "ID                    WORKSPACE  CONFLICT                  ATTEMPTS",
      "--------------------  ---------  ------------------------  --------",
      "pluck/agent-b:commit  agent-b    hunk-mismatch: README.md  2",
    ].join("\n"));
  });

  it("reports an empty review queue clearly", () => {
    expect(formatConflicts([])).toBe("No conflicts require review.");
  });
});
