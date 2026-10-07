import { describe, expect, it, vi } from "vitest";
import { MemoryFs, writeArtifactsCommit } from "../src/git-write-adapter.js";

function repo() {
  return {
    info: vi.fn(),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
    readBlob: vi.fn(),
    readCommit: vi.fn(),
    readTree: vi.fn(),
  };
}

const baseRequest = {
  repo: repo(),
  parent: "0123456789012345678901234567890123456789",
  branch: "main",
  files: [{ path: "bin/run.sh", content: "#!/bin/sh\necho ok\n", mode: "100755" as const }],
  message: "integrate change",
  author: { name: "Agent", email: "agent@example.com" },
  committer: { name: "Pluck", email: "pluck@example.com" },
  trailers: {
    task: "task-1",
    workspace: "workspace-1",
    sourceCommit: "0123456789012345678901234567890123456789",
    context: "context",
  },
};

describe("writeArtifactsCommit", () => {
  it("uses filesystem errors with Node-compatible codes", async () => {
    const fs = new MemoryFs();

    await expect(fs.promises.stat("missing")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.readlink("file")).rejects.toMatchObject({ code: "EINVAL" });
    await fs.promises.writeFile("text", "hello");
    await expect(fs.promises.readFile("text", { encoding: "utf8" })).resolves.toBe("hello");
  });

  it("rejects unsafe paths before accessing the repository", async () => {
    const request = { ...baseRequest, files: [{ path: "../escape", content: "nope" }] };
    const result = await writeArtifactsCommit(request);

    expect(result).toEqual({ status: "failed", detail: "Invalid file path: ../escape" });
    expect(request.repo.info).not.toHaveBeenCalled();
    expect(request.repo.createToken).not.toHaveBeenCalled();
  });

  it("rejects unsafe branch names before accessing the repository", async () => {
    const request = { ...baseRequest, branch: "main..tmp" };
    const result = await writeArtifactsCommit(request);

    expect(result).toEqual({ status: "failed", detail: "Invalid branch" });
    expect(request.repo.info).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied Agent trailers", async () => {
    const request = { ...baseRequest, message: "integrate\n\nAgent-Task: forged" };
    const result = await writeArtifactsCommit(request);

    expect(result).toEqual({ status: "failed", detail: "Invalid commit message" });
    expect(request.repo.info).not.toHaveBeenCalled();
  });

  it("rejects multiline trailer values", async () => {
    const request = { ...baseRequest, trailers: { ...baseRequest.trailers, context: "ok\nforged" } };
    const result = await writeArtifactsCommit(request);

    expect(result).toEqual({ status: "failed", detail: "Invalid commit trailer: context" });
    expect(request.repo.info).not.toHaveBeenCalled();
  });
});
