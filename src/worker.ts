import { createTwoFilesPatch, formatPatch, structuredPatch } from "diff";
import { isArtifactsPushEvent, readTextSnapshot, type ArtifactFile, type ArtifactsBinding, type ArtifactsPushEvent } from "./artifacts.js";
import { applyTextPatch } from "./integrator.js";
import { writeArtifactsCommit, type CommitTrailers } from "./git-write-adapter.js";
import { jobFromPushEvent, type IntegrationJob } from "./queue.js";
import { D1JobStore } from "./state.js";

export type Env = {
  ARTIFACTS: ArtifactsBinding;
  INTEGRATION_QUEUE: Queue<IntegrationJob>;
  DB: D1Database;
  MAINLINE_REPO: string;
  BOOTSTRAP_TOKEN: string;
  MAX_STALE_RETRIES?: string;
};

const DEFAULT_STALE_RETRIES = 3;

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
        const result = await integrateJob(job, env, () => store.recordAttempt(job.id));
        if (result.status === "integrated") await store.update(job.id, "integrated", result.commit);
        else await store.update(job.id, "conflict", result.detail);
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

type IntegrationAttempt = { status: "integrated"; commit: string } | { status: "conflict"; detail: string };

async function integrateJob(job: IntegrationJob, env: Env, recordAttempt: () => Promise<number>): Promise<IntegrationAttempt> {
  const source = await env.ARTIFACTS.get(job.sourceRepo);
  const mainline = await env.ARTIFACTS.get(env.MAINLINE_REPO);
  const sourceCommit = await source.readCommit(job.sourceCommit);
  if (!sourceCommit) throw new Error(`Source commit not found: ${job.sourceCommit}`);
  if (sourceCommit.parents.length !== 1 || sourceCommit.parents[0] !== job.beforeCommit) {
    throw new Error(`Push is not a single-parent change from ${job.beforeCommit}`);
  }

  const sourceFiles = await readTextSnapshot(source, job.sourceCommit);
  const parentFiles = await readTextSnapshot(source, job.beforeCommit);
  const patch = snapshotPatch(parentFiles, sourceFiles);
  const trailers: CommitTrailers = {
    task: job.id,
    workspace: job.sourceNamespace,
    sourceCommit: job.sourceCommit,
    context: findContext(sourceFiles),
  };
  const retries = Math.max(0, Number(env.MAX_STALE_RETRIES ?? DEFAULT_STALE_RETRIES));
  let lastDetail = "stale mainline";

  for (let attempt = 0; attempt <= retries; attempt++) {
    await recordAttempt();
    const mainlineInfo = await mainline.info();
    const mainlineCommit = (await mainline.log({ ref: mainlineInfo.defaultBranch, limit: 1 }))[0] ?? null;
    if (!mainlineCommit) throw new Error(`Mainline branch not found: ${mainlineInfo.defaultBranch}`);
    const mainlineFiles = await readTextSnapshot(mainline, mainlineInfo.defaultBranch);
    const applied = applyTextPatch(patch, mainlineFiles);
    if (applied.status === "conflict") return { status: "conflict", detail: JSON.stringify(applied.conflicts) };

    const result = await writeArtifactsCommit({
      repo: mainline,
      parent: mainlineCommit.hash,
      branch: mainlineInfo.defaultBranch,
      files: applied.files,
      message: `Integrate ${job.sourceRepo}`,
      author: sourceCommit.author,
      committer: { name: "Pluck", email: "pluck@example.com" },
      trailers,
    });
    if (result.status === "pushed") return { status: "integrated", commit: result.commit };
    if (result.status !== "stale-mainline") return { status: "conflict", detail: result.detail };
    lastDetail = result.detail;
  }
  return { status: "conflict", detail: `stale-mainline after ${retries + 1} attempts: ${lastDetail}` };
}

export function snapshotPatch(before: ArtifactFile[], after: ArtifactFile[]): string {
  const oldFiles = new Map(before.map((file) => [file.path, file.content]));
  const newFiles = new Map(after.map((file) => [file.path, file.content]));
  const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
  return paths.map((path) => {
    const oldContent = oldFiles.get(path);
    const newContent = newFiles.get(path);
    if (oldContent === undefined) {
      const patch = structuredPatch("/dev/null", `b/${path}`, "", newContent ?? "", "", "");
      patch.isGit = true;
      patch.isCreate = true;
      patch.newMode = "100644";
      return formatPatch(patch);
    }
    if (newContent === undefined) {
      const patch = structuredPatch(`a/${path}`, "/dev/null", oldContent, "", "", "");
      patch.isGit = true;
      patch.isDelete = true;
      patch.oldMode = "100644";
      return formatPatch(patch);
    }
    return createTwoFilesPatch(`a/${path}`, `b/${path}`, oldContent, newContent, "", "");
  }).filter(Boolean).join("");
}

function findContext(files: ArtifactFile[]): string {
  const context = files.find((file) => file.path === ".agent/context.md");
  if (!context) throw new Error("Required .agent/context.md is missing");
  return context.content.trim();
}
