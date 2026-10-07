import { describe, expect, it, vi } from "vitest";
import { writeArtifactsCommit } from "../src/git-write-adapter.js";

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
};

describe("writeArtifactsCommit", () => {
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
});
