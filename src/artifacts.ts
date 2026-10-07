export type ArtifactRepo = Pick<ArtifactsRepo, "readBlob" | "readCommit" | "readTree"> & Partial<Pick<ArtifactsRepo, "log">>;
export type ArtifactsBinding = Pick<Artifacts, "create" | "get">;

export type ArtifactFile = {
  path: string;
  content: string;
  blob: string;
};

export class ArtifactSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSnapshotError";
  }
}

export type ArtifactsPushEvent = {
  type: "cf.artifacts.repo.pushed";
  source: { namespace: string; repoName: string };
  payload: { ref: string; before: string; after: string };
};

export function isArtifactsPushEvent(value: unknown): value is ArtifactsPushEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ArtifactsPushEvent>;
  return (
    event.type === "cf.artifacts.repo.pushed" &&
    typeof event.source?.namespace === "string" &&
    typeof event.source?.repoName === "string" &&
    typeof event.payload?.ref === "string" &&
    typeof event.payload?.before === "string" &&
    typeof event.payload?.after === "string"
  );
}

export async function readTextSnapshot(repo: ArtifactRepo, ref: string): Promise<ArtifactFile[]> {
  const commit = await resolveCommit(repo, ref);
  if (!commit) throw new Error(`Commit not found: ${ref}`);

  const files: ArtifactFile[] = [];
  await walkTree(repo, commit.treeHash, "", files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveCommit(repo: ArtifactRepo, ref: string) {
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.readCommit(ref);
  if ("log" in repo && typeof repo.log === "function") return (await repo.log({ ref, limit: 1 }))[0] ?? null;
  return repo.readCommit(ref);
}

async function walkTree(repo: ArtifactRepo, treeHash: string, prefix: string, files: ArtifactFile[]) {
  const entries = await repo.readTree(treeHash);
  if (!entries) throw new Error(`Tree not found: ${treeHash}`);

  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === "tree") {
      await walkTree(repo, entry.hash, path, files);
      continue;
    }
    if (entry.type !== "blob" && entry.type !== "exec") {
      throw new ArtifactSnapshotError(`Unsupported tree entry at ${path}: ${entry.type}`);
    }

    const blob = await repo.readBlob(entry.hash);
    if (!blob) throw new Error(`Blob not found: ${entry.hash}`);
    if (blob.type && !blob.type.startsWith("text/")) {
      throw new ArtifactSnapshotError(`Binary blob is not supported at ${path}`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ArtifactSnapshotError(`Binary blob is not supported at ${path}`);
    }
    if (content.includes("\0")) throw new ArtifactSnapshotError(`Binary blob is not supported at ${path}`);
    files.push({ path, blob: entry.hash, content });
  }
}
