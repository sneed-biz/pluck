import type { IntegrationJob } from "./queue.js";

export type Workspace = {
  namespace: string;
  repoName: string;
  ownerId: string;
  subscriptionId: string;
  active: boolean;
};

export type JobStatus = "queued" | "processing" | "blocked" | "conflict" | "integrated";

export type JobRecord = IntegrationJob & {
  status: JobStatus;
  detail: string | null;
  attemptCount: number;
};

export type QueueStats = Record<JobStatus, number>;

export type JobStore = {
  enqueue(job: IntegrationJob): Promise<boolean>;
  claim(job: IntegrationJob): Promise<boolean>;
  recordAttempt(jobId: string): Promise<number>;
  update(jobId: string, status: Exclude<JobStatus, "queued" | "processing">, detail?: string): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;
  list(limit: number): Promise<JobRecord[]>;
  requeue(jobId: string): Promise<boolean>;
  resolve(jobId: string, patch: string): Promise<boolean>;
  queueStats(): Promise<QueueStats>;
  getWorkspace(namespace: string, repoName: string): Promise<Workspace | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  deactivateWorkspace(namespace: string, repoName: string): Promise<Workspace | null>;
};

export class D1JobStore implements JobStore {
  constructor(private readonly db: D1Database) {}

  async enqueue(job: IntegrationJob): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO integration_jobs
           (id, source_namespace, source_repo, source_commit, before_commit, ref, received_at, status, resolution_patch)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(job.id, job.sourceNamespace, job.sourceRepo, job.sourceCommit, job.beforeCommit, job.ref, job.receivedAt, job.resolutionPatch ?? null)
      .run();
    return result.meta.changes === 1;
  }

  async claim(job: IntegrationJob): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE integration_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'")
      .bind(job.id)
      .run();
    return result.meta.changes === 1;
  }

  async recordAttempt(jobId: string): Promise<number> {
    const result = await this.db
      .prepare("UPDATE integration_jobs SET attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING attempt_count")
      .bind(jobId)
      .first<{ attempt_count: number }>();
    if (!result) throw new Error(`Job not found: ${jobId}`);
    return result.attempt_count;
  }

  async update(jobId: string, status: Exclude<JobStatus, "queued" | "processing">, detail?: string): Promise<void> {
    await this.db
      .prepare("UPDATE integration_jobs SET status = ?, detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(status, detail ?? null, jobId)
      .run();
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const row = await this.db.prepare(
      `SELECT id, source_namespace, source_repo, source_commit, before_commit, ref,
              received_at, status, detail, attempt_count, resolution_patch
       FROM integration_jobs WHERE id = ?`,
    ).bind(jobId).first<JobRow>();
    return row ? toJobRecord(row) : null;
  }

  async list(limit: number): Promise<JobRecord[]> {
    const result = await this.db.prepare(
      `SELECT id, source_namespace, source_repo, source_commit, before_commit, ref,
              received_at, status, detail, attempt_count, resolution_patch
       FROM integration_jobs ORDER BY created_at DESC LIMIT ?`,
    ).bind(limit).all<JobRow>();
    return result.results.map(toJobRecord);
  }

  async requeue(jobId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE integration_jobs SET status = 'queued', detail = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('conflict', 'blocked')`,
    ).bind(jobId).run();
    return result.meta.changes === 1;
  }

  async resolve(jobId: string, patch: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE integration_jobs SET status = 'queued', detail = NULL, resolution_patch = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('conflict', 'blocked')`,
    ).bind(patch, jobId).run();
    return result.meta.changes === 1;
  }

  async queueStats(): Promise<QueueStats> {
    const result = await this.db.prepare("SELECT status, COUNT(*) AS count FROM integration_jobs GROUP BY status").all<{ status: JobStatus; count: number }>();
    const stats: QueueStats = { queued: 0, processing: 0, blocked: 0, conflict: 0, integrated: 0 };
    for (const row of result.results) stats[row.status] = row.count;
    return stats;
  }

  async getWorkspace(namespace: string, repoName: string): Promise<Workspace | null> {
    const row = await this.db.prepare(
      "SELECT namespace, repo_name, owner_id, subscription_id, active FROM workspaces WHERE namespace = ? AND repo_name = ?",
    ).bind(namespace, repoName).first<WorkspaceRow>();
    return row ? toWorkspace(row) : null;
  }

  async saveWorkspace(workspace: Workspace): Promise<void> {
    await this.db.prepare(
      `INSERT INTO workspaces (namespace, repo_name, owner_id, subscription_id, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(namespace, repo_name) DO UPDATE SET owner_id = excluded.owner_id,
       subscription_id = excluded.subscription_id, active = 1, updated_at = CURRENT_TIMESTAMP`,
    ).bind(workspace.namespace, workspace.repoName, workspace.ownerId, workspace.subscriptionId).run();
  }

  async deactivateWorkspace(namespace: string, repoName: string): Promise<Workspace | null> {
    const workspace = await this.getWorkspace(namespace, repoName);
    if (!workspace) return null;
    await this.db.prepare(
      "UPDATE workspaces SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE namespace = ? AND repo_name = ?",
    ).bind(namespace, repoName).run();
    return { ...workspace, active: false };
  }
}

type JobRow = {
  id: string;
  source_namespace: string;
  source_repo: string;
  source_commit: string;
  before_commit: string;
  ref: string;
  received_at: string;
  status: JobStatus;
  detail: string | null;
  attempt_count: number;
  resolution_patch: string | null;
};

type WorkspaceRow = {
  namespace: string;
  repo_name: string;
  owner_id: string;
  subscription_id: string;
  active: number;
};

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    sourceNamespace: row.source_namespace,
    sourceRepo: row.source_repo,
    sourceCommit: row.source_commit,
    beforeCommit: row.before_commit,
    ref: row.ref,
    receivedAt: row.received_at,
    status: row.status,
    detail: row.detail,
    attemptCount: row.attempt_count,
    resolutionPatch: row.resolution_patch ?? undefined,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { namespace: row.namespace, repoName: row.repo_name, ownerId: row.owner_id, subscriptionId: row.subscription_id, active: row.active === 1 };
}
