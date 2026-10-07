import { isArtifactsPushEvent, readTextSnapshot, type ArtifactsBinding, type ArtifactsPushEvent } from "./artifacts.js";
import { jobFromPushEvent, type IntegrationJob } from "./queue.js";
import { D1JobStore } from "./state.js";

export type Env = {
  ARTIFACTS: ArtifactsBinding;
  INTEGRATION_QUEUE: Queue<IntegrationJob>;
  DB: D1Database;
  MAINLINE_REPO: string;
  BOOTSTRAP_TOKEN: string;
};

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/admin/repos") {
      if (request.headers.get("Authorization") !== `Bearer ${env.BOOTSTRAP_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = await request.json().catch(() => ({})) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name : "mainline";
      const created = await env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
      return Response.json({ name: created.name, remote: created.remote, token: created.token });
    }

    if (request.method !== "POST" || new URL(request.url).pathname !== "/events/artifacts") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const body: unknown = await request.json().catch(() => null);
    if (!isArtifactsPushEvent(body) || !isWorkspacePushEvent(body, env.MAINLINE_REPO)) {
      return Response.json({ error: "invalid_artifacts_push_event" }, { status: 400 });
    }

    const job = jobFromPushEvent(body);
    const inserted = await new D1JobStore(env.DB).enqueue(job);
    if (inserted) await env.INTEGRATION_QUEUE.send(job, { contentType: "json" });
    return Response.json({ accepted: true, duplicate: !inserted, jobId: job.id }, { status: 202 });
  },

  async queue(batch, env): Promise<void> {
    const store = new D1JobStore(env.DB);
    for (const message of batch.messages) {
      const job = message.body;
      if (!await store.claim(job)) {
        message.ack();
        continue;
      }

      try {
        await inspectIntegrationInputs(job, env);
        await store.update(job.id, "blocked", "Artifacts snapshot is ready; commit/push adapter is not implemented yet");
        message.ack();
      } catch (error) {
        await store.update(job.id, "conflict", error instanceof Error ? error.message : String(error));
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, IntegrationJob>;

export function isWorkspacePushEvent(event: ArtifactsPushEvent, mainlineRepo: string): boolean {
  return event.payload.ref === "refs/heads/main" && event.source.repoName !== mainlineRepo;
}

async function inspectIntegrationInputs(job: IntegrationJob, env: Env): Promise<void> {
  const source = await env.ARTIFACTS.get(job.sourceRepo);
  const mainline = await env.ARTIFACTS.get(env.MAINLINE_REPO);
  const sourceCommit = await source.readCommit(job.sourceCommit);
  if (!sourceCommit) throw new Error(`Source commit not found: ${job.sourceCommit}`);
  if (sourceCommit.parents.length !== 1 || sourceCommit.parents[0] !== job.beforeCommit) {
    throw new Error(`Push is not a single-parent change from ${job.beforeCommit}`);
  }

  await readTextSnapshot(source, job.sourceCommit);
  const mainlineInfo = await mainline.info();
  await readTextSnapshot(mainline, mainlineInfo.defaultBranch);
}
