import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const count = Number(process.argv[2] ?? 10);
const run = `20261008-${Date.now()}`;
const namespace = "pluck-test";
const mainlineName = "pluck-test-mainline";
const workerUrl = "https://pluck-mcp-test.shawnhitsback.workers.dev";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pluck-live-"));

function wrangler(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function token(repo: string): string {
  return JSON.parse(wrangler(["artifacts", "repos", "issue-token", repo, "--namespace", namespace, "--scope", "write", "--ttl", "900", "--json"])).plaintext;
}

function repoRemote(repo: string): string {
  return JSON.parse(wrangler(["artifacts", "repos", "get", repo, "--namespace", namespace, "--json"])).remote;
}

function authRemote(remote: string, plainToken: string): string {
  const url = new URL(remote);
  url.username = "x-token";
  url.password = plainToken;
  return url.toString();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("Agent count must be between 1 and 50");

const mainlineDir = path.join(root, "mainline");
const mainlineToken = token(mainlineName);
git(root, ["clone", authRemote(repoRemote(mainlineName), mainlineToken), mainlineDir]);
const base = git(mainlineDir, ["rev-parse", "HEAD"]);

async function createAgent(agent: number): Promise<{ repo: string; commit: string }> {
  const repo = `pluck-test-${run}-agent-${agent}`;
  JSON.parse(wrangler(["artifacts", "repos", "create", repo, "--namespace", namespace, "--default-branch", "main", "--json"]));
  const agentDir = path.join(root, `agent-${agent}`);
  await fs.cp(mainlineDir, agentDir, { recursive: true });
  await fs.mkdir(path.join(agentDir, "agents"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "agents", `${run}-agent-${agent}.txt`), `${run}-agent-${agent}\n`);
  git(agentDir, ["config", "user.name", "Live Agent"]);
  git(agentDir, ["config", "user.email", "live-agent@example.com"]);
  git(agentDir, ["add", "."]);
  git(agentDir, ["commit", "-m", `agent ${agent}`]);
  const sourceToken = token(repo);
  const remote = authRemote(repoRemote(repo), sourceToken);
  git(agentDir, ["remote", "set-url", "origin", remote]);
  git(agentDir, ["push", "origin", "HEAD:main"]);
  const commit = git(agentDir, ["rev-parse", "HEAD"]);
  const response = await fetch(`${workerUrl}/events/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "cf.artifacts.repo.pushed",
      source: { namespace, repoName: repo },
      payload: { ref: "refs/heads/main", before: base, after: commit },
    }),
  });
  if (response.status !== 202) throw new Error(`Webhook rejected for ${repo}: ${response.status} ${await response.text()}`);
  return { repo, commit };
}

if (!base) throw new Error("Test mainline has no base commit");
const results = [];
for (let agent = 1; agent <= count; agent++) results.push(await createAgent(agent));
console.log(JSON.stringify({ run, base, agents: results }, null, 2));
