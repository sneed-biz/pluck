import { applyPatches, parsePatch } from "diff";
import type { ArtifactsPushEvent } from "./artifacts.js";

export type IntegrationFailure = {
  code: "unsupported-patch-application" | "patch-failed";
  message: string;
  sourceCommit: string;
  mainlineCommit: string;
};

export type IntegrationResult =
  | { status: "integrated"; commit: string }
  | { status: "conflict"; failure: IntegrationFailure };

export type GitRuntime = {
  hasApplyPatch: boolean;
};

export type TextFile = {
  path: string;
  content: string;
};

export type PatchConflict = {
  path: string;
  reason: "binary" | "missing-source" | "hunk-mismatch";
};

export type PatchResult =
  | { status: "applied"; files: TextFile[] }
  | { status: "conflict"; conflicts: PatchConflict[] };

/**
 * Applies a Git unified patch to a text-file snapshot without using a local
 * filesystem. Strict matching prevents an agent change from being applied to
 * an unrelated location in current mainline.
 */
export function applyTextPatch(patchText: string, files: TextFile[]): PatchResult {
  const patches = parsePatch(patchText);
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const conflicts: PatchConflict[] = [];
  const writes = new Map<string, string | null>();

  applyPatches(patches, {
    loadFile: (patch, callback) => {
      const path = stripGitPrefix(patch.oldFileName ?? patch.newFileName ?? "");
      if (patch.isBinary) {
        callback(`Binary patch is not supported: ${path}`, "");
        return;
      }
      if (patch.isCreate) {
        callback(undefined, "");
        return;
      }
      const content = byPath.get(path);
      if (content === undefined) {
        callback(`Source file is missing from mainline: ${path}`, "");
        return;
      }
      callback(undefined, content);
    },
    patched: (patch, content, callback) => {
      const oldPath = stripGitPrefix(patch.oldFileName ?? "");
      const newPath = stripGitPrefix(patch.newFileName ?? oldPath);
      if (content === false) {
        conflicts.push({ path: newPath, reason: "hunk-mismatch" });
      } else if (patch.isDelete) {
        writes.set(oldPath, null);
      } else {
        writes.set(newPath, content);
        if (patch.isRename) writes.set(oldPath, null);
      }
      callback(null);
    },
    complete: (error) => {
      if (error && conflicts.length === 0) {
        conflicts.push({
          path: "unknown",
          reason: /missing/i.test(String(error)) ? "missing-source" : "hunk-mismatch",
        });
      }
    },
    fuzzFactor: 0,
    autoConvertLineEndings: true,
  });

  if (conflicts.length > 0) return { status: "conflict", conflicts };

  for (const [path, content] of writes) {
    if (content === null) byPath.delete(path);
    else byPath.set(path, content);
  }
  return {
    status: "applied",
    files: [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({ path, content })),
  };
}

function stripGitPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/**
 * The integrator still fails closed when its runtime adapter has not been
 * enabled. Never push a partial tree.
 */
export function integrateChange(
  runtime: GitRuntime,
  input: { sourceCommit: string; mainlineCommit: string; event: ArtifactsPushEvent },
): IntegrationResult {
  if (!runtime.hasApplyPatch) {
    return {
      status: "conflict",
      failure: {
        code: "unsupported-patch-application",
        message:
          "isomorphic-git does not expose a verified unified-patch application path in this runtime",
        sourceCommit: input.sourceCommit,
        mainlineCommit: input.mainlineCommit,
      },
    };
  }

  throw new Error("Patch application adapter is not implemented yet");
}
