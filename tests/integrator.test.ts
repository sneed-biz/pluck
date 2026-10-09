import { describe, expect, it } from "vitest";
import { applyTextPatch, integrateChange } from "../src/integrator.js";
import { snapshotPatch } from "../src/worker.js";

describe("integrateChange", () => {
  it("fails closed with actionable conflict state when patch application is unproven", () => {
    const result = integrateChange(
      { hasApplyPatch: false },
      {
        sourceCommit: "source-sha",
        mainlineCommit: "mainline-sha",
        event: {
          type: "cf.artifacts.repo.pushed",
          source: { type: "artifacts.repo", namespace: "pluck", repoName: "task-1" },
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
  it("applies multiple distant hunks in a realistic TypeScript file", () => {
    const before = [
      "import { readFile } from 'node:fs/promises';",
      "",
      "export async function loadConfig(path: string) {",
      "  const source = await readFile(path, 'utf8');",
      "  return JSON.parse(source);",
      "}",
      "",
      "export function isEnabled(config: { enabled?: boolean }) {",
      "  return config.enabled === true;",
      "}",
      "",
      "export function describe(config: { name: string }) {",
      "  return `config: ${config.name}`;",
      "}",
      "",
    ].join("\n");
    const after = before
      .replace("  return JSON.parse(source);", "  return JSON.parse(source) as Record<string, unknown>;")
      .replace("  return config.enabled === true;", "  return config.enabled !== false;");
    const result = applyTextPatch(
      snapshotPatch([{ path: "src/config.ts", blob: "before", content: before }], [{ path: "src/config.ts", blob: "after", content: after }]),
      [{ path: "src/config.ts", content: before }],
    );

    expect(result).toEqual({ status: "applied", files: [{ path: "src/config.ts", content: after }] });
  });

  it("rejects an overlapping hunk without applying other hunks from the same file", () => {
    const before = [
      "export function buildRequest(input: { id: string; token: string }) {",
      "  const headers = { Authorization: `Bearer ${input.token}` };",
      "  const body = JSON.stringify({ id: input.id });",
      "  return { headers, body };",
      "}",
      "",
      "export function logRequest(request: { body: string }) {",
      "  return `request=${request.body}`;",
      "}",
      "",
      "export function retryCount(attempt: number) {",
      "  return Math.min(attempt, 3);",
      "}",
      "",
    ].join("\n");
    const agent = before
      .replace("  const body = JSON.stringify({ id: input.id });", "  const body = JSON.stringify({ requestId: input.id });")
      .replace("  return Math.min(attempt, 3);", "  return Math.min(attempt, 5);");
    const conflictingMainline = before.replace(
      "  const body = JSON.stringify({ id: input.id });",
      "  const body = JSON.stringify({ id: input.id, source: 'mainline' });",
    );
    const result = applyTextPatch(
      snapshotPatch([{ path: "src/request.ts", blob: "before", content: before }], [{ path: "src/request.ts", blob: "agent", content: agent }]),
      [{ path: "src/request.ts", content: conflictingMainline }],
    );

    expect(result).toEqual({ status: "conflict", conflicts: [{ path: "src/request.ts", reason: "hunk-mismatch" }] });
  });

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
