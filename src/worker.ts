import { createTwoFilesPatch, formatPatch, parsePatch, structuredPatch } from "diff";
import { isArtifactsPushEvent, readTextSnapshot, type ArtifactFile, type ArtifactsBinding, type ArtifactsPushEvent } from "./artifacts.js";
import { applyTextPatch } from "./integrator.js";
import { writeArtifactsCommit, type CommitTrailers } from "./git-write-adapter.js";
import { jobFromPushEvent, type IntegrationJob } from "./queue.js";
import { D1JobStore } from "./state.js";
import { retryArtifactRead } from "./retry.js";
import { createWorkspaceSubscription, deleteWorkspaceSubscription } from "./subscriptions.js";

export type Env = {
  ARTIFACTS: ArtifactsBinding;
  INTEGRATION_QUEUE: Queue<IntegrationJob>;
  DB: D1Database;
  MAINLINE_REPO: string;
  ARTIFACTS_NAMESPACE?: string;
  ALLOW_PRODUCTION_MAINLINE?: string;
  BOOTSTRAP_TOKEN: string;
  MAX_STALE_RETRIES?: string;
  PLUCK_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  EVENTS_QUEUE_ID?: string;
  WORKSPACE_OWNER_TOKENS?: string;
};

const DEFAULT_STALE_RETRIES = 3;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleControlApi(request, env, url);
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/admin/repos") {
      if (request.headers.get("Authorization") !== `Bearer ${env.BOOTSTRAP_TOKEN}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = await request.json().catch(() => ({})) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name : "mainline";
      const created = await env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
      return Response.json({ name: created.name, remote: created.remote, token: created.token });
    }

    if (request.method === "POST" && new URL(request.url).pathname === "/admin/workspaces") {
      return provisionWorkspace(request, env);
    }
    if (request.method === "DELETE" && new URL(request.url).pathname.startsWith("/admin/workspaces/")) {
      return deleteWorkspace(request, env, new URL(request.url));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    const store = new D1JobStore(env.DB);
    for (const message of batch.messages) {
      if (isArtifactsPushEvent(message.body)) {
        await normalizeArtifactsEvent(message.body, env, store);
        message.ack();
        continue;
      }

      const job = message.body as IntegrationJob;
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
} satisfies ExportedHandler<Env, IntegrationJob | ArtifactsPushEvent>;

async function normalizeArtifactsEvent(event: ArtifactsPushEvent, env: Env, store: D1JobStore): Promise<void> {
  const workspace = await store.getWorkspace(event.source.namespace, event.source.repoName);
  if (!workspace?.active || !isWorkspacePushEvent(event, env.MAINLINE_REPO) || !isSafeIntegrationTarget(env)) return;
  const job = jobFromPushEvent(event, event.metadata?.eventTimestamp ?? new Date().toISOString());
  if (await store.enqueue(job)) await env.INTEGRATION_QUEUE.send(job, { contentType: "json" });
}

async function provisionWorkspace(request: Request, env: Env): Promise<Response> {
  const ownerId = authenticateWorkspaceOwner(request, env);
  if (!ownerId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.EVENTS_QUEUE_ID) {
    return Response.json({ error: "subscription_configuration_missing" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as { namespace?: unknown; repoName?: unknown };
  if (typeof body.namespace !== "string" || typeof body.repoName !== "string") {
    return Response.json({ error: "invalid_workspace" }, { status: 400 });
  }
  if (env.ARTIFACTS_NAMESPACE && body.namespace !== env.ARTIFACTS_NAMESPACE) {
    return Response.json({ error: "invalid_workspace_namespace" }, { status: 400 });
  }
  const repo = await env.ARTIFACTS.create(body.repoName, { setDefaultBranch: "main" });
  let subscriptionId: string | undefined;
  try {
    subscriptionId = await createWorkspaceSubscription({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      queueId: env.EVENTS_QUEUE_ID,
      namespace: body.namespace,
      repoName: body.repoName,
    });
    await new D1JobStore(env.DB).saveWorkspace({ namespace: body.namespace, repoName: body.repoName, ownerId, subscriptionId, active: true });
  } catch (error) {
    if (subscriptionId) {
      await deleteWorkspaceSubscription({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, queueId: env.EVENTS_QUEUE_ID }, subscriptionId).catch(() => undefined);
    }
    await env.ARTIFACTS.delete(body.repoName).catch(() => undefined);
    throw error;
  }
  return Response.json({ namespace: body.namespace, repoName: body.repoName, subscriptionId, remote: repo.remote, token: repo.token }, { status: 201 });
}

async function deleteWorkspace(request: Request, env: Env, url: URL): Promise<Response> {
  const ownerId = authenticateWorkspaceOwner(request, env);
  if (!ownerId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return Response.json({ error: "subscription_configuration_missing" }, { status: 503 });
  const [namespace, repoName] = url.pathname.split("/").slice(-2).map(decodeURIComponent);
  const store = new D1JobStore(env.DB);
  const workspace = await store.getWorkspace(namespace, repoName);
  if (!workspace) return Response.json({ error: "not_found" }, { status: 404 });
  if (!workspace.active) return Response.json({ error: "not_found" }, { status: 404 });
  if (workspace.ownerId !== ownerId) return Response.json({ error: "forbidden" }, { status: 403 });
  await deleteWorkspaceSubscription({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, queueId: env.EVENTS_QUEUE_ID ?? "" }, workspace.subscriptionId);
  await store.deactivateWorkspace(namespace, repoName);
  return Response.json({ deleted: true, namespace, repoName });
}

export function authenticateWorkspaceOwner(request: Request, env: Pick<Env, "WORKSPACE_OWNER_TOKENS">): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ") || !env.WORKSPACE_OWNER_TOKENS) return null;
  const token = authorization.slice("Bearer ".length);
  try {
    const owners = JSON.parse(env.WORKSPACE_OWNER_TOKENS) as Record<string, unknown>;
    const ownerId = owners[token];
    return typeof ownerId === "string" && ownerId.length > 0 ? ownerId : null;
  } catch {
    return null;
  }
}

async function handleControlApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.PLUCK_API_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.PLUCK_API_TOKEN}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const store = new D1JobStore(env.DB);
  if (request.method === "GET" && url.pathname === "/api/jobs") {
    const rawLimit = Number(url.searchParams.get("limit") ?? "25");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
    return Response.json({ jobs: await store.list(limit) });
  }

  if (request.method === "GET" && url.pathname === "/api/queue") {
    return Response.json({ queue: await store.queueStats() });
  }

  if (request.method === "POST" && url.pathname === "/api/jobs") {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.namespace !== "string" || typeof body.repoName !== "string" || typeof body.before !== "string" || typeof body.after !== "string" || body.ref !== "refs/heads/main") {
      return Response.json({ error: "invalid_job" }, { status: 400 });
    }
    const event = {
      type: "cf.artifacts.repo.pushed" as const,
      source: { type: "artifacts.repo" as const, namespace: body.namespace, repoName: body.repoName },
      payload: { ref: body.ref, before: body.before, after: body.after },
    };
    const workspace = await store.getWorkspace(body.namespace, body.repoName);
    if (!workspace?.active || !isWorkspacePushEvent(event, env.MAINLINE_REPO) || !isSafeIntegrationTarget(env)) {
      return Response.json({ error: "invalid_workspace" }, { status: 400 });
    }
    const job = jobFromPushEvent(event);
    const accepted = await store.enqueue(job);
    if (accepted) await env.INTEGRATION_QUEUE.send(job, { contentType: "json" });
    return Response.json({ accepted, jobId: job.id }, { status: accepted ? 202 : 200 });
  }

  const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === "GET" && match) {
    const job = await store.get(decodeURIComponent(match[1]));
    return job ? Response.json({ job }) : Response.json({ error: "not_found" }, { status: 404 });
  }

  const retryMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    const jobId = decodeURIComponent(retryMatch[1]);
    const job = await store.get(jobId);
    if (!job) return Response.json({ error: "not_found" }, { status: 404 });
    if (!(await store.requeue(jobId))) {
      return Response.json({ error: "job_not_retryable", status: job.status }, { status: 409 });
    }
    await env.INTEGRATION_QUEUE.send(job, { contentType: "json" });
    return Response.json({ accepted: true, jobId }, { status: 202 });
  }

  const resolveMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/resolve$/);
  if (request.method === "POST" && resolveMatch) {
    const jobId = decodeURIComponent(resolveMatch[1]);
    const job = await store.get(jobId);
    if (!job) return Response.json({ error: "not_found" }, { status: 404 });
    const body = await request.json().catch(() => ({})) as { patch?: unknown };
    if (typeof body.patch !== "string" || !isValidPatch(body.patch)) return Response.json({ error: "invalid_patch" }, { status: 400 });
    if (!(await store.resolve(jobId, body.patch))) return Response.json({ error: "job_not_resolvable", status: job.status }, { status: 409 });
    await env.INTEGRATION_QUEUE.send({ ...job, resolutionPatch: body.patch }, { contentType: "json" });
    return Response.json({ accepted: true, jobId }, { status: 202 });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export function isValidPatch(patch: string): boolean {
  try {
    return patch.trim().length > 0 && /(^|\n)@@\s/.test(patch) && parsePatch(patch).length > 0;
  } catch {
    return false;
  }
}

export function isWorkspacePushEvent(event: ArtifactsPushEvent, mainlineRepo: string): boolean {
  return event.payload.ref === "refs/heads/main" && event.source.repoName !== mainlineRepo;
}

export function isSafeIntegrationTarget(env: Pick<Env, "MAINLINE_REPO" | "ALLOW_PRODUCTION_MAINLINE">): boolean {
  return env.MAINLINE_REPO !== "mainline" || env.ALLOW_PRODUCTION_MAINLINE === "true";
}

async function inspectIntegrationInputs(job: IntegrationJob, env: Env): Promise<void> {
  const source = await env.ARTIFACTS.get(job.sourceRepo);
  const mainline = await env.ARTIFACTS.get(env.MAINLINE_REPO);
  const sourceCommit = await retryArtifactRead(() => source.readCommit(job.sourceCommit));
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
  const sourceCommit = await retryArtifactRead(() => source.readCommit(job.sourceCommit));
  if (!sourceCommit) throw new Error(`Source commit not found: ${job.sourceCommit}`);
  if (sourceCommit.parents.length !== 1 || sourceCommit.parents[0] !== job.beforeCommit) {
    throw new Error(`Push is not a single-parent change from ${job.beforeCommit}`);
  }

  const sourceFiles = await readTextSnapshot(source, job.sourceCommit);
  const parentFiles = await readTextSnapshot(source, job.beforeCommit);
  const patch = job.resolutionPatch ?? snapshotPatch(parentFiles, sourceFiles);
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
    const mainlineCommit = (await retryArtifactRead(() => mainline.log({ ref: mainlineInfo.defaultBranch, limit: 1 })))[0] ?? null;
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
