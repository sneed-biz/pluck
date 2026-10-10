import { describe, expect, it } from "vitest";
import { isArtifactsPushEvent, readTextSnapshot } from "../src/artifacts.js";
import { jobFromPushEvent } from "../src/queue.js";
import { authenticateWorkspaceOwner, isSafeIntegrationTarget, isValidPatch, isWorkspacePushEvent, snapshotPatch } from "../src/worker.js";
import { applyTextPatch } from "../src/integrator.js";

describe("Cloudflare integration contracts", () => {
  it("accepts and normalizes an Artifacts push event", () => {
    const event = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "pluck", repoName: "task-1" },
      payload: { ref: "refs/heads/main", before: "parent", after: "source" },
    } as const;

    expect(isArtifactsPushEvent(event)).toBe(true);
    expect(jobFromPushEvent(event, "2026-10-03T00:00:00.000Z")).toEqual({
      id: "pluck/task-1:source",
      sourceNamespace: "pluck",
      sourceRepo: "task-1",
      sourceCommit: "source",
      beforeCommit: "parent",
      ref: "refs/heads/main",
      receivedAt: "2026-10-03T00:00:00.000Z",
    });
  });

  it("rejects malformed push events", () => {
    expect(isArtifactsPushEvent({ type: "cf.artifacts.repo.pushed" })).toBe(false);
    expect(isArtifactsPushEvent(null)).toBe(false);
  });

  it("rejects mainline pushes to prevent an integration self-trigger loop", () => {
    const event = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "pluck", repoName: "mainline" },
      payload: { ref: "refs/heads/main", before: "parent", after: "source" },
    } as const;

    expect(isWorkspacePushEvent(event, "mainline")).toBe(false);
    expect(isWorkspacePushEvent({ ...event, source: { ...event.source, repoName: "task-1" } }, "mainline")).toBe(true);
  });

  it("requires explicit opt-in before targeting the production mainline name", () => {
    expect(isSafeIntegrationTarget({ MAINLINE_REPO: "mainline" })).toBe(false);
    expect(isSafeIntegrationTarget({ MAINLINE_REPO: "mainline", ALLOW_PRODUCTION_MAINLINE: "true" })).toBe(true);
    expect(isSafeIntegrationTarget({ MAINLINE_REPO: "isolated-mainline" })).toBe(true);
  });

  it("derives workspace ownership from a server-side token map", () => {
    const env = { WORKSPACE_OWNER_TOKENS: JSON.stringify({ "owner-token": "owner-1" }) };
    expect(authenticateWorkspaceOwner(new Request("https://pluck.test", { headers: { Authorization: "Bearer owner-token" } }), env)).toBe("owner-1");
    expect(authenticateWorkspaceOwner(new Request("https://pluck.test", { headers: { Authorization: "Bearer forged-owner" } }), env)).toBeNull();
    expect(authenticateWorkspaceOwner(new Request("https://pluck.test"), env)).toBeNull();
  });

  it("accepts unified resolution patches and rejects arbitrary text", () => {
    expect(isValidPatch("@@ -1 +1 @@\n-old\n+new\n")).toBe(true);
    expect(isValidPatch("not a patch")).toBe(false);
    expect(isValidPatch(" ")).toBe(false);
  });

  it("walks a Cloudflare Artifacts commit tree into a text snapshot", async () => {
    const repo = {
      readCommit: async () => ({
        hash: "commit",
        treeHash: "root",
        message: "fixture",
        author: { name: "a", email: "a@example.com" },
        committer: { name: "a", email: "a@example.com" },
        parents: [],
        authoredAt: 0,
        committedAt: 0,
      }),
      readTree: async (hash: string) => hash === "root"
        ? [{ name: "src", mode: "40000", hash: "src-tree", type: "tree" as const }]
        : [{ name: "app.ts", mode: "100644", hash: "blob", type: "blob" as const }],
      readBlob: async () => new Blob(["export const ok = true;"], { type: "text/plain" }),
    };

    await expect(readTextSnapshot(repo, "commit")).resolves.toEqual([
      { path: "src/app.ts", blob: "blob", content: "export const ok = true;" },
    ]);
  });

  it("retries transient commit, tree, and blob reads", async () => {
    let commits = 0;
    let trees = 0;
    let blobs = 0;
    const repo = {
      readCommit: async () => {
        if (++commits < 2) throw new Error("eventual consistency");
        return { hash: "commit", treeHash: "root", message: "fixture", author: { name: "a", email: "a@example.com" }, committer: { name: "a", email: "a@example.com" }, parents: [], authoredAt: 0, committedAt: 0 };
      },
      readTree: async () => {
        if (++trees < 2) throw new Error("eventual consistency");
        return [{ name: "app.ts", mode: "100644", hash: "blob", type: "blob" as const }];
      },
      readBlob: async () => {
        if (++blobs < 2) throw new Error("eventual consistency");
        return new Blob(["export const ok = true;"], { type: "text/plain" });
      },
    };

    await expect(readTextSnapshot(repo, "commit")).resolves.toEqual([{ path: "app.ts", blob: "blob", content: "export const ok = true;" }]);
    expect(commits).toBe(2);
    expect(trees).toBe(2);
    expect(blobs).toBe(2);
  });

  it("fails instead of dropping binary blobs from a snapshot", async () => {
    const repo = {
      readCommit: async () => ({
        hash: "commit",
        treeHash: "root",
        message: "fixture",
        author: { name: "a", email: "a@example.com" },
        committer: { name: "a", email: "a@example.com" },
        parents: [],
        authoredAt: 0,
        committedAt: 0,
      }),
      readTree: async () => [{ name: "logo.png", mode: "100644", hash: "blob", type: "blob" as const }],
      readBlob: async () => new Blob([new Uint8Array([0, 1, 2])], { type: "image/png" }),
    };

    await expect(readTextSnapshot(repo, "commit")).rejects.toThrow("Binary blob is not supported at logo.png");
  });

  it("fails on NUL bytes even when an Artifacts blob has no MIME type", async () => {
    const repo = {
      readCommit: async () => ({
        hash: "commit",
        treeHash: "root",
        message: "fixture",
        author: { name: "a", email: "a@example.com" },
        committer: { name: "a", email: "a@example.com" },
        parents: [],
        authoredAt: 0,
        committedAt: 0,
      }),
      readTree: async () => [{ name: "logo.bin", mode: "100644", hash: "blob", type: "blob" as const }],
      readBlob: async () => new Blob([new Uint8Array([0, 1, 2])]),
    };

    await expect(readTextSnapshot(repo, "commit")).rejects.toThrow("Binary blob is not supported at logo.bin");
  });

  it("emits and applies an explicit new-file patch", () => {
    const patch = snapshotPatch(
      [{ path: "README.md", blob: "base", content: "# app\n" }],
      [
        { path: "README.md", blob: "base", content: "# app\n" },
        { path: "src/new.ts", blob: "new", content: "export const added = true;\n" },
      ],
    );

    expect(patch).toContain("new file mode 100644");
    expect(applyTextPatch(patch, [{ path: "README.md", content: "# app\n" }])).toEqual({
      status: "applied",
      files: [
        { path: "README.md", content: "# app\n" },
        { path: "src/new.ts", content: "export const added = true;\n" },
      ],
    });
  });
});
