import { describe, expect, it } from "vitest";
import { applyTextPatch, integrateChange } from "../src/integrator.js";

describe("integrateChange", () => {
  it("fails closed with actionable conflict state when patch application is unproven", () => {
    const result = integrateChange(
      { hasApplyPatch: false },
      {
        sourceCommit: "source-sha",
        mainlineCommit: "mainline-sha",
        event: {
          type: "cf.artifacts.repo.pushed",
          source: { namespace: "pluck", repoName: "task-1" },
          payload: { ref: "refs/heads/main", before: "parent-sha", after: "source-sha" },
        },
      },
    );

    expect(result).toEqual({
      status: "conflict",
      failure: {
        code: "unsupported-patch-application",
        message: expect.stringContaining("verified unified-patch"),
        sourceCommit: "source-sha",
        mainlineCommit: "mainline-sha",
      },
    });
  });
});

describe("applyTextPatch", () => {
  it("applies a strict multi-file patch without a filesystem", () => {
    const result = applyTextPatch(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " export const value = 1;",
        "-export const name = 'old';",
        "+export const name = 'new';",
        " export const ready = true;",
        "",
      ].join("\n"),
      [{ path: "src/a.ts", content: "export const value = 1;\nexport const name = 'old';\nexport const ready = true;\n" }],
    );

    expect(result).toEqual({
      status: "applied",
      files: [{ path: "src/a.ts", content: "export const value = 1;\nexport const name = 'new';\nexport const ready = true;\n" }],
    });
  });

  it("reports a conflict and does not mutate the snapshot", () => {
    const result = applyTextPatch(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        " export const value = 1;",
        "-export const name = 'old';",
        "+export const name = 'new';",
        "",
      ].join("\n"),
      [{ path: "src/a.ts", content: "export const value = 1;\nexport const name = 'other';\n" }],
    );

    expect(result).toEqual({ status: "conflict", conflicts: [{ path: "src/a.ts", reason: "hunk-mismatch" }] });
  });

  it("allows an explicit resolution patch after a collision", () => {
    const conflictedMainline = "export const greeting = 'hello from agent A';\n";
    const resolutionPatch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-export const greeting = 'hello from agent A';",
      "+export const greeting = 'hello from agents A and B';",
      "",
    ].join("\n");

    expect(applyTextPatch(resolutionPatch, [{ path: "src/a.ts", content: conflictedMainline }])).toEqual({
      status: "applied",
      files: [{ path: "src/a.ts", content: "export const greeting = 'hello from agents A and B';\n" }],
    });
  });

  it("applies a strict new-file patch", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const added = true;",
      "+",
      "",
    ].join("\n");

    expect(applyTextPatch(patch, [{ path: "README.md", content: "# app\n" }])).toEqual({
      status: "applied",
      files: [
        { path: "README.md", content: "# app\n" },
        { path: "src/new.ts", content: "export const added = true;\n\n" },
      ],
    });
  });

  it("rejects a new-file patch when the target already exists", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export const added = true;",
      "",
    ].join("\n");

    expect(applyTextPatch(patch, [{ path: "src/new.ts", content: "different\n" }])).toEqual({
      status: "conflict",
      conflicts: [{ path: "src/new.ts", reason: "file-exists" }],
    });
  });
});
