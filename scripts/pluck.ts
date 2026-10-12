#!/usr/bin/env -S npx tsx

import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { pluckBanner, runDestroy, runInit } from "./init.js";
import { listConflicts, reviewJob } from "./review.js";

loadLocalConfig();
console.log(pluckBanner);

const baseUrl = process.env.PLUCK_URL;
const token = process.env.PLUCK_TOKEN;
const ownerToken = process.env.PLUCK_OWNER_TOKEN;
const [command, argument, patch, ...rest] = process.argv.slice(2);

if (command === "init" || command === "setup") {
  const args = [argument, patch, ...rest].filter((value): value is string => typeof value === "string");
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  await runInit({ name: option("--name"), accountId: option("--account-id"), yes: args.includes("--yes") });
  process.exit();
}

if (command === "destroy") {
  const args = [argument, patch, ...rest].filter((value): value is string => typeof value === "string");
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  await runDestroy({ name: option("--name"), confirmation: option("--confirm") });
  process.exit();
}

if (command === "conflicts") {
  if (!baseUrl || !token) usage("PLUCK_URL and PLUCK_TOKEN are required");
  await listConflicts(baseUrl, token);
  process.exit();
}

if (command === "review") {
  if (!baseUrl || !token) usage("PLUCK_URL and PLUCK_TOKEN are required");
  if (!argument) usage("usage: npm run pluck -- review <job-id> [--keep] [--no-editor]");
  const options = [patch, ...rest];
  const namespace = process.env.PLUCK_NAMESPACE;
  const mainline = process.env.PLUCK_MAINLINE_REPO;
  if (!namespace || !mainline) usage("PLUCK_NAMESPACE and PLUCK_MAINLINE_REPO are required for review");
  await reviewJob({ baseUrl, token, namespace, mainline, jobId: argument, keep: options.includes("--keep"), noEditor: options.includes("--no-editor") });
  process.exit();
}

if (!baseUrl || (!token && command !== "create" && command !== "delete")) {
  usage(command === "create" || command === "delete" ? "PLUCK_URL is required" : "PLUCK_URL and PLUCK_TOKEN are required");
}

const routes: Record<string, string> = {
  jobs: "/api/jobs",
  status: argument ? `/api/jobs/${encodeURIComponent(argument)}` : "/api/jobs",
  show: argument ? `/api/jobs/${encodeURIComponent(argument)}` : "",
  retry: argument ? `/api/jobs/${encodeURIComponent(argument)}/retry` : "",
  resolve: argument ? `/api/jobs/${encodeURIComponent(argument)}/resolve` : "",
  queue: "/api/queue",
};
if (command === "create") {
  if (!argument) usage("usage: npm run pluck -- create <repo-name> [namespace]");
  if (!ownerToken) usage("PLUCK_OWNER_TOKEN is required for create");
  const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/admin/workspaces`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ namespace: patch ?? process.env.PLUCK_NAMESPACE ?? "pluck", repoName: argument }),
  });
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
  if (!response.ok) process.exitCode = 1;
  process.exit();
}
if (command === "delete") {
  if (!argument) usage("usage: npm run pluck -- delete <repo-name> [namespace]");
  if (!ownerToken) usage("PLUCK_OWNER_TOKEN is required for delete");
  const namespace = patch ?? process.env.PLUCK_NAMESPACE ?? "pluck";
  const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/admin/workspaces/${encodeURIComponent(namespace)}/${encodeURIComponent(argument)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
  if (!response.ok) process.exitCode = 1;
  process.exit();
}
const path = routes[command ?? ""];
if (!path) usage("usage: npm run pluck -- init [--name <name>] [--account-id <id>] [--yes] | destroy --name <name> --confirm <name> | create <repo-name> [namespace] | delete <repo-name> [namespace] | jobs | conflicts | review <job-id> | queue | status <job-id> | retry <job-id> | resolve <job-id> <patch>");

const response = await fetch(`${baseUrl!.replace(/\/$/, "")}${path}`, {
  method: command === "retry" || command === "resolve" ? "POST" : "GET",
  headers: { Authorization: `Bearer ${token}`, ...(command === "resolve" ? { "Content-Type": "application/json" } : {}) },
  body: command === "resolve" ? JSON.stringify({ patch }) : undefined,
});
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;

function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

function loadLocalConfig(): void {
  const explicit = process.env.PLUCK_CONFIG;
  const configs = explicit ? [explicit] : existsSync(".pluck")
    ? readdirSync(".pluck").filter((file) => file.endsWith(".env")).map((file) => nodePath.join(".pluck", file))
    : [];
  if (configs.length !== 1 || !existsSync(configs[0])) return;
  for (const line of readFileSync(configs[0], "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!process.env[key]) process.env[key] = line.slice(separator + 1);
  }
}
