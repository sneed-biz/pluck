import type { IntegrationJob } from "./queue.js";

export type JobStatus = "queued" | "processing" | "blocked" | "conflict" | "integrated";

export type JobRecord = IntegrationJob & {
  status: JobStatus;
  detail: string | null;
  attemptCount: number;
};

export type JobStore = {
  enqueue(job: IntegrationJob): Promise<boolean>;
  claim(job: IntegrationJob): Promise<boolean>;
  recordAttempt(jobId: string): Promise<number>;
  update(jobId: string, status: Exclude<JobStatus, "queued" | "processing">, detail?: string): Promise<void>;
};

export class D1JobStore implements JobStore {
  constructor(private readonly db: D1Database) {}

  async enqueue(job: IntegrationJob): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO integration_jobs
          (id, source_namespace, source_repo, source_commit, before_commit, ref, received_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(job.id, job.sourceNamespace, job.sourceRepo, job.sourceCommit, job.beforeCommit, job.ref, job.receivedAt)
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
}
