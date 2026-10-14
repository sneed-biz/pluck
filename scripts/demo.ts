#!/usr/bin/env -S npx tsx

// Scripted demo: N agents work concurrently in their own Artifacts repos,
// Pluck integrates them into mainline, and two agents deliberately collide.
//
//   npm run demo -- [agents=6] [--keep]
//
// Needs a deployed Pluck (`npm run pluck -- init`) and wrangler auth.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const agentCount = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 6);
if (!Number.isInteger(agentCount) || agentCount < 3 || agentCount > 30) fail("Agent count must be between 3 and 30");

loadLocalConfig();
const baseUrl = need("PLUCK_URL").replace(/\/$/, "");
const apiToken = need("PLUCK_TOKEN");
const ownerToken = need("PLUCK_OWNER_TOKEN");
const namespace = need("PLUCK_NAMESPACE");
const mainlineName = need("PLUCK_MAINLINE_REPO");

const run = Date.now().toString(36);
const start = Date.now();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pluck-demo-"));
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const log = (message: string) => console.log(`${dim(`[${((Date.now() - start) / 1000).toFixed(1).padStart(5)}s]`)} ${message}`);

type Job = { id: string; sourceRepo: string; status: string; detail: string | null; attemptCount: number };
type Agent = { name: string; repo: string; role: "independent" | "collider"; jobId?: string };

const agents: Agent[] = [];
for (let i = 1; i <= agentCount - 2; i++) agents.push({ name: `agent-${i}`, repo: `demo-${run}-agent-${i}`, role: "independent" });
agents.push({ name: "agent-x", repo: `demo-${run}-agent-x`, role: "collider" });
agents.push({ name: "agent-y", repo: `demo-${run}-agent-y`, role: "collider" });

console.log(bold(`\nPluck demo: ${agentCount} agents, one shared mainline (${namespace}/${mainlineName})\n`));

try {
  log("Cloning mainline for the base commit");
  const mainlineDir = path.join(root, "mainline");
  await git(root, ["clone", "--quiet", await authRemote(mainlineName, "read"), mainlineDir]);
  const base = await git(mainlineDir, ["rev-parse", "HEAD"]);
  log(`Base commit ${base.slice(0, 8)}; starting all agents at once`);

  await Promise.all(agents.map((agent) => runAgent(agent, mainlineDir, base)));

  log("All agents have pushed. Waiting for Pluck to integrate...");
  const jobs = await waitForJobs(agents);
  report(jobs);
  await showMainline();
  console.log(`\n${bold("Next:")} resolve the conflict with normal Git:`);
  const conflict = jobs.find((job) => job.status === "conflict");
  console.log(conflict ? `  npm run pluck -- review ${conflict.id}` : "  (no conflict occurred)");
} finally {
  if (!keep) await cleanup();
  await fs.rm(root, { recursive: true, force: true });
}

async function runAgent(agent: Agent, mainlineDir: string, base: string): Promise<void> {
  const created = await api<{ remote: string; token: string }>("/admin/workspaces", "POST", ownerToken, { namespace, repoName: agent.repo });
  const dir = path.join(root, agent.name);
  await fs.cp(mainlineDir, dir, { recursive: true });
  if (agent.role === "independent") {
    await fs.mkdir(path.join(dir, "demo", run), { recursive: true });
    await fs.writeFile(path.join(dir, "demo", run, `${agent.name}.txt`), `Written by ${agent.name}\n`);
  } else {
    await fs.mkdir(path.join(dir, "demo", run), { recursive: true });
    await fs.writeFile(path.join(dir, "demo", run, "shared.md"), `# Shared plan\n\n${agent.name} wants this file to say: ${agent.name === "agent-x" ? "ship it" : "hold on"}\n`);
  }
  await fs.mkdir(path.join(dir, ".agent"), { recursive: true });
  await fs.writeFile(path.join(dir, ".agent", "context.md"), `# ${agent.name}\n\nTask: demo run ${run}.\nRole: ${agent.role}.\n`);
  await git(dir, ["config", "user.name", agent.name]);
  await git(dir, ["config", "user.email", `${agent.name}@pluck.demo`]);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "--quiet", "-m", `${agent.name}: demo change`]);
  const url = new URL(created.remote);
  url.username = "x";
  url.password = created.token.split("?")[0];
  await git(dir, ["push", "--quiet", url.toString(), "HEAD:refs/heads/main"]);
  const after = await git(dir, ["rev-parse", "HEAD"]);
  log(`${agent.name} pushed ${after.slice(0, 8)} to ${agent.repo}`);
  // Native Artifacts events normally trigger this; submitting is idempotent and makes the demo deterministic.
  const submitted = await api<{ jobId: string }>("/api/jobs", "POST", apiToken, { namespace, repoName: agent.repo, ref: "refs/heads/main", before: base, after });
  agent.jobId = submitted.jobId;
}

async function waitForJobs(list: Agent[]): Promise<Job[]> {
  const seen = new Map<string, string>();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { jobs } = await api<{ jobs: Job[] }>("/api/jobs?limit=100", "GET", apiToken);
    const ours = jobs.filter((job) => list.some((agent) => agent.repo === job.sourceRepo));
    for (const job of ours) {
      const label = `${job.sourceRepo}:${job.status}:${job.attemptCount}`;
      if (seen.get(job.id) === label) continue;
      seen.set(job.id, label);
      const agent = list.find((candidate) => candidate.repo === job.sourceRepo)!;
      log(`${agent.name.padEnd(8)} ${paint(job.status)}${job.attemptCount > 1 ? dim(` (attempt ${job.attemptCount})`) : ""}`);
    }
    if (ours.length === list.length && ours.every((job) => job.status === "integrated" || job.status === "conflict" || job.status === "blocked")) return ours;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  fail("Timed out waiting for jobs to finish");
}

function report(jobs: Job[]): void {
  const integrated = jobs.filter((job) => job.status === "integrated").length;
  const retried = jobs.filter((job) => job.attemptCount > 1).length;
  console.log(`\n${bold("Result:")} ${green(`${integrated} integrated`)}, ${red(`${jobs.length - integrated} conflict`)}, ${retried} resolved a race via CAS retry`);
  for (const job of jobs.filter((candidate) => candidate.status !== "integrated")) {
    console.log(`  ${job.sourceRepo}: ${job.detail?.replace(/\s+/g, " ").slice(0, 100) ?? "needs review"}`);
  }
}

async function showMainline(): Promise<void> {
  const dir = path.join(root, "mainline-after");
  await git(root, ["clone", "--quiet", await authRemote(mainlineName, "read"), dir]);
  console.log(`\n${bold("Mainline history")} ${dim("(provenance trailers)")}`);
  console.log(await git(dir, ["log", "-n", String(agentCount + 1), "--format=%C(yellow)%h%Creset %s%n%w(0,4,4)%(trailers:key=Agent-Workspace,key=Agent-Source-Commit)", "--color=always"]));
}

async function cleanup(): Promise<void> {
  log("Cleaning up demo workspaces (use --keep to retain)");
  await Promise.all(agents.map((agent) => fetch(`${baseUrl}/admin/workspaces/${encodeURIComponent(namespace)}/${encodeURIComponent(agent.repo)}`, { method: "DELETE", headers: { Authorization: `Bearer ${ownerToken}` } }).catch(() => undefined)));
}

function paint(status: string): string {
  return status === "integrated" ? green(status) : status === "conflict" || status === "blocked" ? red(status) : status;
}

async function authRemote(repo: string, scope: "read" | "write"): Promise<string> {
  const info = JSON.parse(await wrangler(["artifacts", "repos", "get", repo, "--namespace", namespace, "--json"])) as { remote?: string; result?: { remote: string } };
  const issued = JSON.parse(await wrangler(["artifacts", "repos", "issue-token", repo, "--namespace", namespace, "--scope", scope, "--ttl", "900", "--json"])) as { plaintext?: string; result?: { plaintext: string } };
  const url = new URL(info.remote ?? info.result!.remote);
  url.username = "x";
  url.password = (issued.plaintext ?? issued.result!.plaintext).split("?")[0];
  return url.toString();
}

async function wrangler(wranglerArgs: string[]): Promise<string> {
  return (await execFileAsync("npx", ["wrangler", ...wranglerArgs], { encoding: "utf8" })).stdout.trim();
}

async function git(cwd: string, gitArgs: string[]): Promise<string> {
  try {
    return (await execFileAsync("git", gitArgs, { cwd, encoding: "utf8" })).stdout.trim();
  } catch (error) {
    throw new Error(`git ${gitArgs[0]} failed: ${(error as { stderr?: string }).stderr?.replace(/x:[^@]+@/g, "x:***@").trim()}`);
  }
}

async function api<T>(route: string, method: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${route} failed: ${value.error ?? response.status}`);
  return value;
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is required (run \`npm run pluck -- init\` first, or set PLUCK_CONFIG)`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function loadLocalConfig(): void {
  const explicit = process.env.PLUCK_CONFIG;
  const configs = explicit ? [explicit] : existsSync(".pluck")
    ? readdirSync(".pluck").filter((file) => file.endsWith(".env")).map((file) => path.join(".pluck", file))
    : [];
  if (configs.length !== 1 || !existsSync(configs[0])) return;
  for (const line of readFileSync(configs[0], "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!process.env[key]) process.env[key] = line.slice(separator + 1);
  }
}
