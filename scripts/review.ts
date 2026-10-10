import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

type Job = {
  id: string;
  sourceNamespace: string;
  sourceRepo: string;
  sourceCommit: string;
  beforeCommit: string;
  status: "queued" | "processing" | "blocked" | "conflict" | "integrated";
  detail: string | null;
  attemptCount: number;
};

type RepoInfo = { remote: string };
type TokenInfo = { plaintext: string };

export function formatConflicts(jobs: Job[]): string {
  const conflicts = jobs.filter((job) => job.status === "conflict" || job.status === "blocked");
  if (conflicts.length === 0) return "No conflicts require review.";
  const rows = conflicts.map((job) => [job.id, job.sourceRepo, conflictSummary(job.detail), String(job.attemptCount)]);
  return formatTable(["ID", "WORKSPACE", "CONFLICT", "ATTEMPTS"], rows);
}

function conflictSummary(detail: string | null): string {
  if (!detail) return "integration blocked";
  try {
    const conflicts = JSON.parse(detail) as { path?: unknown; reason?: unknown }[];
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      const first = conflicts[0];
      return `${typeof first.reason === "string" ? first.reason : "conflict"}: ${typeof first.path === "string" ? first.path : "unknown"}${conflicts.length > 1 ? ` (+${conflicts.length - 1})` : ""}`;
    }
  } catch {}
  return detail.replace(/\s+/g, " ").slice(0, 72);
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const line = (row: string[]) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join("  ");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

function run(command: string, args: string[], options: { cwd?: string; input?: string; quiet?: boolean } = {}): string {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", input: options.input, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function wranglerJson(args: string[]): unknown {
  return JSON.parse(run("npx", ["wrangler", ...args, "--json"]));
}

function result<T>(value: unknown): T {
  if (value && typeof value === "object" && "result" in value) return (value as { result: T }).result;
  return value as T;
}

function repoInfo(repo: string, namespace: string): RepoInfo {
  return result<RepoInfo>(wranglerJson(["artifacts", "repos", "get", repo, "--namespace", namespace]));
}

function repoToken(repo: string, namespace: string): string {
  return result<TokenInfo>(wranglerJson(["artifacts", "repos", "issue-token", repo, "--namespace", namespace, "--scope", "read", "--ttl", "900"])).plaintext;
}

function authenticatedRemote(remote: string, token: string): string {
  const url = new URL(remote);
  url.username = "x";
  url.password = token.split("?")[0];
  return url.toString();
}

function prompt(message: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return readline.question(message).finally(() => readline.close());
}

async function api<T>(baseUrl: string, token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Pluck API returned ${response.status}`);
  return value;
}

export async function listConflicts(baseUrl: string, token: string): Promise<void> {
  const response = await api<{ jobs: Job[] }>(baseUrl, token, "/api/jobs?limit=100");
  console.log(formatConflicts(response.jobs));
}

export async function reviewJob(input: { baseUrl: string; token: string; namespace: string; mainline: string; jobId: string; keep: boolean; noEditor: boolean }): Promise<void> {
  const response = await api<{ job: Job }>(input.baseUrl, input.token, `/api/jobs/${encodeURIComponent(input.jobId)}`);
  const job = response.job;
  if (job.status !== "conflict" && job.status !== "blocked") throw new Error(`Job ${job.id} is ${job.status}, not ready for review`);

  console.log(`Reviewing ${job.id}\nWorkspace: ${job.sourceRepo}\nConflict: ${conflictSummary(job.detail)}\n`);
  const root = mkdtempSync(path.join(os.tmpdir(), "pluck-review-"));
  const worktree = path.join(root, "worktree");
  let retain = input.keep;
  try {
    const mainline = repoInfo(input.mainline, input.namespace);
    const source = repoInfo(job.sourceRepo, job.sourceNamespace);
    run("git", ["clone", "--quiet", authenticatedRemote(mainline.remote, repoToken(input.mainline, input.namespace)), worktree]);
    const reviewBase = run("git", ["rev-parse", "HEAD"], { cwd: worktree });
    run("git", ["config", "user.name", "Pluck Reviewer"], { cwd: worktree });
    run("git", ["config", "user.email", "reviewer@pluck.local"], { cwd: worktree });
    run("git", ["remote", "add", "source", authenticatedRemote(source.remote, repoToken(job.sourceRepo, job.sourceNamespace))], { cwd: worktree });
    run("git", ["fetch", "--quiet", "source", job.sourceCommit], { cwd: worktree });
    const cherryPick = spawnSync("git", ["cherry-pick", job.sourceCommit], { cwd: worktree, encoding: "utf8", stdio: "inherit" });
    if (cherryPick.status !== 0) {
      console.log(`\nResolve the conflict in ${worktree}, then run:\n  git add <resolved-files>\n  git cherry-pick --continue\n`);
      if (!input.noEditor && process.env.EDITOR) run(process.env.EDITOR, [worktree]);
      const state = run("git", ["status", "--porcelain"], { cwd: worktree });
      if (state || run("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { cwd: worktree })) {
        retain = true;
        throw new Error(`Resolve the conflict and rerun with --keep. Worktree retained at ${worktree}`);
      }
    }
    const patch = run("git", ["diff", "--binary", `${reviewBase}..HEAD`], { cwd: worktree });
    if (!patch) throw new Error("The reviewed change is empty; no resolution submitted");
    run("git", ["diff", "--check", `${reviewBase}..HEAD`], { cwd: worktree });
    console.log(`\nResolution patch:\n\n${patch}`);
    if ((await prompt("Submit this resolution? [y/N] ")).trim().toLowerCase() !== "y") {
      console.log(`Resolution not submitted. Worktree retained at ${worktree}`);
      return;
    }
    await api(input.baseUrl, input.token, `/api/jobs/${encodeURIComponent(job.id)}/resolve`, "POST", { patch });
    console.log(`Resolution submitted for ${job.id}.`);
  } finally {
    if (!retain) rmSync(root, { recursive: true, force: true });
    else console.log(`Review worktree retained at ${worktree}`);
  }
}
