import git, { type CommitObject, type FsClient, type TreeObject } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { retryArtifactRead } from "./retry.js";

export type WriteFile = {
  path: string;
  content: string | Uint8Array;
  mode?: "100644" | "100755";
};

export type GitIdentity = {
  name: string;
  email: string;
  timestamp?: number;
  timezoneOffset?: number;
};

export type GitWriteRequest = {
  repo: ArtifactsWriteRepo;
  parent: string;
  branch: string;
  files: WriteFile[];
  message: string;
  author: GitIdentity;
  committer: GitIdentity;
  trailers: CommitTrailers;
  tokenTtlSeconds?: number;
};

export type CommitTrailers = {
  task: string;
  workspace: string;
  sourceCommit: string;
  context: string;
};

export type GitWriteResult =
  | { status: "pushed"; commit: string }
  | { status: "stale-mainline"; detail: string }
  | { status: "failed"; detail: string };

export type ArtifactsWriteRepo = Pick<ArtifactsRepo, "info" | "createToken" | "revokeToken" | "readBlob" | "readCommit" | "readTree">;

/**
 * Writes a complete snapshot to a disposable Git object database and pushes
 * it with a short-lived token. No remote or credential config is persisted.
 */
export async function writeArtifactsCommit(input: GitWriteRequest): Promise<GitWriteResult> {
  try {
    validateRequest(input);
    const fs = new MemoryFs();
    const dir = "/repo";
    await git.init({ fs, dir, defaultBranch: input.branch });

    await importCommit(input.repo, fs, dir, input.parent);
    const tree = await writeSnapshot(fs, dir, input.files);
    const now = Math.floor(Date.now() / 1000);
    const commit: CommitObject = {
      tree,
      parent: [input.parent],
      message: formatCommitMessage(input.message, input.trailers),
      author: identity(input.author, now),
      committer: identity(input.committer, now),
    };
    const commitSha = await git.writeCommit({ fs, dir, commit });
    await git.writeRef({ fs, dir, ref: `refs/heads/${input.branch}`, value: commitSha, force: true });

    const repoInfo = await input.repo.info();
    const token = await input.repo.createToken("write", input.tokenTtlSeconds ?? 300);
    try {
      const push = await git.push({
        fs,
        http,
        dir,
        url: repoInfo.remote,
        ref: input.branch,
        remoteRef: input.branch,
        force: false,
        onAuth: () => ({ username: "x-token", password: token.plaintext }),
      });
      const refResult = push.refs[`refs/heads/${input.branch}`] ?? push.refs[input.branch];
      if (refResult?.ok) return { status: "pushed", commit: commitSha };
      const detail = refResult?.error ?? push.error ?? "remote rejected the push";
      if (/non-fast-forward|non fast forward|stale|update rejected/i.test(detail)) {
        return { status: "stale-mainline", detail };
      }
      return { status: "failed", detail };
    } finally {
      await input.repo.revokeToken(token.id).catch(() => undefined);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/non-fast-forward|non fast forward|stale|update rejected/i.test(detail)) {
      return { status: "stale-mainline", detail };
    }
    return { status: "failed", detail };
  }
}

async function importCommit(repo: ArtifactsWriteRepo, fs: FsClient, dir: string, sha: string): Promise<void> {
  const commit = await retryArtifactRead(() => repo.readCommit(sha));
  if (!commit) throw new Error(`Parent commit not found: ${sha}`);
  const tree = await importTree(repo, fs, dir, commit.treeHash);
  await git.writeCommit({
    fs,
    dir,
    commit: {
      tree,
      parent: commit.parents,
      message: commit.message,
      author: { ...commit.author, timestamp: commit.authoredAt, timezoneOffset: 0 },
      committer: { ...commit.committer, timestamp: commit.committedAt, timezoneOffset: 0 },
    },
  });
}

async function importTree(repo: ArtifactsWriteRepo, fs: FsClient, dir: string, sha: string): Promise<string> {
  const entries = await retryArtifactRead(() => repo.readTree(sha));
  if (!entries) throw new Error(`Tree not found: ${sha}`);
  const tree: TreeObject = [];
  for (const entry of entries) {
    if (entry.type === "tree") {
      tree.push({ mode: entry.mode, path: entry.name, oid: await importTree(repo, fs, dir, entry.hash), type: "tree" });
    } else if (entry.type === "blob" || entry.type === "exec") {
      const blob = await retryArtifactRead(() => repo.readBlob(entry.hash));
      if (!blob) throw new Error(`Blob not found: ${entry.hash}`);
      tree.push({ mode: entry.mode, path: entry.name, oid: await git.writeBlob({ fs, dir, blob: new Uint8Array(await blob.arrayBuffer()) }), type: "blob" });
    } else {
      throw new Error(`Unsupported parent tree entry: ${entry.type}`);
    }
  }
  return git.writeTree({ fs, dir, tree });
}

async function writeSnapshot(fs: FsClient, dir: string, files: WriteFile[]): Promise<string> {
  const root = new Map<string, SnapshotNode>();
  for (const file of files) {
    const parts = file.path.split("/");
    let level = root;
    for (const part of parts.slice(0, -1)) {
      const existing = level.get(part);
      if (existing && existing.kind !== "tree") throw new Error(`Path collision: ${file.path}`);
      if (existing) level = existing.children;
      else {
        const node: SnapshotNode = { kind: "tree", children: new Map() };
        level.set(part, node);
        level = node.children;
      }
    }
    const name = parts.at(-1)!;
    if (level.has(name)) throw new Error(`Duplicate file path: ${file.path}`);
    level.set(name, { kind: "file", file });
  }
  return writeTreeLevel(fs, dir, root);
}

async function writeTreeLevel(fs: FsClient, dir: string, level: Map<string, SnapshotNode>): Promise<string> {
  const tree: TreeObject = [];
  for (const [path, node] of [...level.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (node.kind === "tree") tree.push({ mode: "040000", path, oid: await writeTreeLevel(fs, dir, node.children), type: "tree" });
    else tree.push({ mode: node.file.mode ?? "100644", path, oid: await git.writeBlob({ fs, dir, blob: toBytes(node.file.content) }), type: "blob" });
  }
  return git.writeTree({ fs, dir, tree });
}

type SnapshotNode = { kind: "tree"; children: Map<string, SnapshotNode> } | { kind: "file"; file: WriteFile };

function validateRequest(input: GitWriteRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) || input.branch.includes("..") || input.branch.endsWith("/") || input.branch.includes("@{")) {
    throw new Error("Invalid branch");
  }
  if (!/^[0-9a-f]{40}$/.test(input.parent)) throw new Error("Invalid parent commit");
  for (const file of input.files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("..") || file.path.endsWith("/")) throw new Error(`Invalid file path: ${file.path}`);
  }
  for (const [name, value] of Object.entries(input.trailers)) {
    if (!value.trim() || /[\r\n]/.test(value)) throw new Error(`Invalid commit trailer: ${name}`);
  }
  formatCommitMessage(input.message, input.trailers);
}

function formatCommitMessage(message: string, trailers: CommitTrailers): string {
  if (!message.trim() || /\nAgent-(?:Task|Workspace|Source-Commit|Context):/i.test(message)) throw new Error("Invalid commit message");
  return `${message.trim()}\n\nAgent-Task: ${trailers.task}\nAgent-Workspace: ${trailers.workspace}\nAgent-Source-Commit: ${trailers.sourceCommit}\nAgent-Context: ${trailers.context}`;
}

function identity(value: GitIdentity, now: number) {
  return { name: value.name, email: value.email, timestamp: value.timestamp ?? now, timezoneOffset: value.timezoneOffset ?? 0 };
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export class MemoryFs {
  readonly promises = new MemoryPromises();
  readFile = this.promises.readFile.bind(this.promises);
  writeFile = this.promises.writeFile.bind(this.promises);
  unlink = this.promises.unlink.bind(this.promises);
  readdir = this.promises.readdir.bind(this.promises);
  mkdir = this.promises.mkdir.bind(this.promises);
  rmdir = this.promises.rmdir.bind(this.promises);
  rm = this.promises.rm.bind(this.promises);
  exists = this.promises.exists.bind(this.promises);
  stat = this.promises.stat.bind(this.promises);
  lstat = this.promises.lstat.bind(this.promises);
  readlink = this.promises.readlink.bind(this.promises);
  symlink = this.promises.symlink.bind(this.promises);
}

class MemoryPromises {
  private readonly files = new Map<string, Uint8Array>();
  async readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> {
    const value = this.files.get(normalize(path));
    if (!value) throw fsError("ENOENT", path);
    return (typeof options === "string" || options?.encoding) ? new TextDecoder().decode(value) : value.slice();
  }
  async writeFile(path: string, data: Uint8Array | string): Promise<void> { this.files.set(normalize(path), typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)); }
  async unlink(path: string): Promise<void> { this.files.delete(normalize(path)); }
  async readdir(path: string): Promise<string[]> { const prefix = `${normalize(path)}/`; return [...new Set([...this.files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split("/")[0]))]; }
  async mkdir(): Promise<void> {}
  async rmdir(): Promise<void> {}
  async stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }> { const normalized = normalize(path); const file = this.files.get(normalized); if (file) return { isFile: () => true, isDirectory: () => false, size: file.length }; if ([...this.files.keys()].some((key) => key.startsWith(`${normalized}/`))) return { isFile: () => false, isDirectory: () => true, size: 0 }; throw fsError("ENOENT", path); }
  lstat = this.stat.bind(this);
  async readlink(path: string): Promise<string> { throw fsError("EINVAL", path); }
  async symlink(_target: string, path: string): Promise<void> { throw fsError("EINVAL", path); }
  async rm(path: string): Promise<void> { await this.unlink(path); }
  async exists(path: string): Promise<boolean> { try { await this.stat(path); return true; } catch { return false; } }
}

function fsError(code: string, path: string): Error & { code: string } {
  const error = new Error(`${code}: ${path}`) as Error & { code: string };
  error.code = code;
  return error;
}

function normalize(path: string): string { return path.replace(/^\/+/, "").replace(/\/+/g, "/"); }
