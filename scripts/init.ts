import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

export type InitOptions = {
  name?: string;
  accountId?: string;
  yes: boolean;
};

export type DestroyOptions = {
  name?: string;
  confirmation?: string;
};

export type DeploymentNames = {
  worker: string;
  namespace: string;
  mainline: string;
  database: string;
  integrationQueue: string;
  eventsQueue: string;
};

const namePattern = /^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$|^[a-z0-9]$/;
export const pluckBanner = `
  ▀▀▀▀▀██▄ ▀▀▀      ▓▒░  ▓▒░ ▀▀▀▀▀█░▒ █▓▒  ███
  ▓▒░  ███ ▓▒░      ▀▀▀  ▒░█ ▓▒░  ██░ ▀▀▀  ██▀
  ▒░█▄▀▀▀  ▒░█      ▓▒░  ░██ ▒░█      ▒░ ▀▀█▄
  ░██      ░██  ▒░  ▒░█  ███ ░██  ▒░  ░ █  ██░
  ███      ▀██▄▄███ ▀██▄▄██▀ ▀██▄▄███ ███  █░▒`;

export function deploymentNames(name: string): DeploymentNames {
  if (!namePattern.test(name)) throw new Error("Deployment names must be 1-54 lowercase letters, digits, or dashes, and cannot start or end with a dash");
  return {
    worker: name,
    namespace: name,
    mainline: `${name}-mainline`,
    database: name,
    integrationQueue: `${name}-integration`,
    eventsQueue: `${name}-artifacts-events`,
  };
}

export function renderConfig(names: DeploymentNames, accountId: string, databaseId: string, eventsQueueId: string): string {
  return `${JSON.stringify({
    $schema: "../node_modules/wrangler/config-schema.json",
    name: names.worker,
    workers_dev: true,
    main: "../src/worker.ts",
    compatibility_date: "2026-10-03",
    artifacts: [{ binding: "ARTIFACTS", namespace: names.namespace, remote: true }],
    queues: {
      producers: [{ binding: "INTEGRATION_QUEUE", queue: names.integrationQueue }],
      consumers: [
        { queue: names.integrationQueue, max_batch_size: 1, max_retries: 3 },
        { queue: names.eventsQueue, max_batch_size: 10, max_retries: 3 },
      ],
    },
    d1_databases: [{ binding: "DB", database_name: names.database, database_id: databaseId, migrations_dir: "../migrations" }],
    vars: {
      MAINLINE_REPO: names.mainline,
      ARTIFACTS_NAMESPACE: names.namespace,
      EVENTS_QUEUE_ID: eventsQueueId,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  }, null, 2)}\n`;
}

function wrangler(args: string[], input?: string): string {
  const result = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `wrangler ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function wranglerJson(args: string[]): unknown {
  return JSON.parse(wrangler([...args, "--json"]));
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const collection = object.result ?? object.accounts ?? object.databases ?? object.queues;
    return collection === undefined ? [object] : records(collection);
  }
  return [];
}

function stringValue(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}

export function accountIdFromWhoami(output: string): string | undefined {
  return output.match(/\b[0-9a-f]{32}\b/i)?.[0];
}

function findResource(value: unknown, name: string, idKeys: string[]): string | undefined {
  const resource = records(value).find((entry) => stringValue(entry, "name") === name);
  return resource ? stringValue(resource, ...idKeys) : undefined;
}

function ensureDatabase(name: string): { id: string; created: boolean } {
  const existing = findResource(wranglerJson(["d1", "list"]), name, ["uuid", "database_id", "id"]);
  if (existing) return { id: existing, created: false };
  wrangler(["d1", "create", name]);
  const id = findResource(wranglerJson(["d1", "list"]), name, ["uuid", "database_id", "id"]);
  if (!id) throw new Error(`Could not determine D1 database ID for ${name}`);
  return { id, created: true };
}

export function queueIdFromList(output: string, name: string): string | undefined {
  for (const line of output.split("\n")) {
    const columns = line.split("│").map((column) => column.trim()).filter(Boolean);
    if (columns[1] === name && /^[0-9a-f]{32}$/i.test(columns[0] ?? "")) return columns[0];
  }
  return undefined;
}

function ensureQueue(name: string): { id: string; created: boolean } {
  const existing = queueIdFromList(wrangler(["queues", "list"]), name);
  if (existing) return { id: existing, created: false };
  wrangler(["queues", "create", name]);
  const created = queueIdFromList(wrangler(["queues", "list"]), name);
  if (!created) throw new Error(`Could not determine Queue ID for ${name}`);
  return { id: created, created: true };
}

function ensureMainline(names: DeploymentNames): boolean {
  try {
    wrangler(["artifacts", "repos", "get", names.mainline, "--namespace", names.namespace]);
    return false;
  } catch {
    wrangler(["artifacts", "repos", "create", names.mainline, "--namespace", names.namespace, "--default-branch", "main"]);
    return true;
  }
}

function seedMainline(names: DeploymentNames): boolean {
  const log = wrangler(["artifacts", "repos", "get", names.mainline, "--namespace", names.namespace, "--json"]);
  const repo = JSON.parse(log) as { remote?: string; last_push_at?: string | null; result?: { remote?: string; last_push_at?: string | null } };
  const details = repo.result ?? repo;
  if (details.last_push_at) return false;
  const tokenResponse = wranglerJson(["artifacts", "repos", "issue-token", names.mainline, "--namespace", names.namespace, "--scope", "write", "--ttl", "900"]);
  const token = stringValue((records(tokenResponse)[0] ?? tokenResponse) as Record<string, unknown>, "plaintext", "token");
  if (!details.remote || !token) throw new Error("Could not issue a temporary token to seed mainline");
  const root = execFileSync("mktemp", ["-d", path.join(os.tmpdir(), "pluck-init-XXXXXX")], { encoding: "utf8" }).trim();
  try {
    const remote = new URL(details.remote);
    remote.username = "x";
    remote.password = token.split("?")[0];
    writeFileSync(path.join(root, "README.md"), `# ${names.worker} mainline\n`);
    mkdirSync(path.join(root, ".agent"), { recursive: true });
    writeFileSync(path.join(root, ".agent", "context.md"), "# Mainline Context\n\nThis repository is coordinated by Pluck.\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Pluck"], { cwd: root });
    execFileSync("git", ["config", "user.email", "pluck@example.com"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "Initialize Pluck mainline"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["push", remote.toString(), "HEAD:main"], { cwd: root, stdio: "ignore" });
    return true;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return prompt(question);
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    process.stdin.once("data", function read(character: Buffer) {
      const key = character.toString();
      if (key === "\r" || key === "\n") return finish();
      if (key === "\u0003") process.exit(130);
      if (key === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += key;
      }
      process.stdin.once("data", read);
    });
  });
}

async function requiredSecret(environment: string, label: string, nonInteractive: boolean): Promise<string> {
  if (process.env[environment]) return process.env[environment]!;
  if (nonInteractive) throw new Error(`${environment} is required when using --yes`);
  const value = await promptSecret(`${label}: `);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function generatedSecret(environment: string): string {
  return process.env[environment] ?? randomBytes(32).toString();
}

export function workerUrlFromDeployOutput(output: string): string | undefined {
  return output.match(/https:\/\/[^\s]+\.workers\.dev\b/)?.[0];
}

export function renderLocalConfig(values: { url: string; apiToken: string; ownerToken: string; namespace: string; mainline: string }): string {
  return [
    `PLUCK_URL=${values.url}`,
    `PLUCK_TOKEN=${values.apiToken}`,
    `PLUCK_OWNER_TOKEN=${values.ownerToken}`,
    `PLUCK_NAMESPACE=${values.namespace}`,
    `PLUCK_MAINLINE_REPO=${values.mainline}`,
    "",
  ].join("\n");
}

function putSecret(config: string, name: string, value: string): void {
  wrangler(["secret", "put", name, "--config", config], `${value}\n`);
}

export async function runInit(options: InitOptions): Promise<void> {
  const name = options.name ?? process.env.PLUCK_DEPLOYMENT_NAME ?? (options.yes ? undefined : await prompt("Pluck deployment name: "));
  if (!name) throw new Error("Provide --name or PLUCK_DEPLOYMENT_NAME when using --yes");
  const names = deploymentNames(name);
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? accountIdFromWhoami(wrangler(["whoami"]));
  if (!accountId) throw new Error("Could not determine a Cloudflare account ID; pass --account-id");

  const configDirectory = path.join(".pluck");
  const config = path.join(configDirectory, `${name}.wrangler.jsonc`);
  const localConfig = path.join(configDirectory, `${name}.env`);
  const existingConfig = existsSync(config);
  console.log(`\nInitializing Pluck deployment ${name} in Cloudflare account ${accountId}.`);
  if (existingConfig) console.log(`Reusing generated config: ${config}`);
  await fs.mkdir(configDirectory, { recursive: true });
  const database = ensureDatabase(names.database);
  console.log(`${database.created ? "Created" : "Reused"} D1 database: ${names.database}`);
  const integrationQueue = ensureQueue(names.integrationQueue);
  console.log(`${integrationQueue.created ? "Created" : "Reused"} integration Queue: ${names.integrationQueue}`);
  const eventsQueue = ensureQueue(names.eventsQueue);
  console.log(`${eventsQueue.created ? "Created" : "Reused"} Artifacts events Queue: ${names.eventsQueue}`);
  const mainlineCreated = ensureMainline(names);
  console.log(`${mainlineCreated ? "Created" : "Reused"} Artifacts namespace and mainline repository: ${names.namespace}/${names.mainline}`);
  console.log(`${seedMainline(names) ? "Seeded" : "Reused"} mainline branch: ${names.mainline}/main`);
  await fs.writeFile(config, renderConfig(names, accountId, database.id, eventsQueue.id));
  console.log(`Wrote generated config: ${config}`);

  console.log("Applying D1 migrations...");
  wrangler(["d1", "migrations", "apply", names.database, "--remote", "--config", config]);
  console.log("Deploying Pluck Worker...");
  const deploymentOutput = wrangler(["deploy", "--config", config]);
  let apiToken: string | undefined;
  let ownerToken: string | undefined;
  if (existingConfig) {
    console.log("Retaining existing Worker secrets.");
  } else {
    console.log("Generating Pluck access tokens and storing Worker secrets...");
    apiToken = generatedSecret("PLUCK_API_TOKEN");
    const bootstrapToken = generatedSecret("BOOTSTRAP_TOKEN");
    ownerToken = generatedSecret("PLUCK_OWNER_TOKEN");
    const ownerId = process.env.PLUCK_OWNER_ID ?? "owner-1";
    putSecret(config, "PLUCK_API_TOKEN", apiToken);
    putSecret(config, "BOOTSTRAP_TOKEN", bootstrapToken);
    putSecret(config, "WORKSPACE_OWNER_TOKENS", JSON.stringify({ [ownerToken]: ownerId }));
    const runtimeToken = process.env.CLOUDFLARE_API_TOKEN ?? await requiredSecret("PLUCK_RUNTIME_CLOUDFLARE_API_TOKEN", "Runtime Cloudflare API token", options.yes);
    putSecret(config, "CLOUDFLARE_API_TOKEN", runtimeToken);
    const workerUrl = workerUrlFromDeployOutput(deploymentOutput);
    if (!workerUrl) throw new Error("Could not determine the deployed Worker URL; no local Pluck configuration was written");
    await fs.writeFile(localConfig, renderLocalConfig({ url: workerUrl, apiToken, ownerToken, namespace: names.namespace, mainline: names.mainline }), { mode: 0o600 });
    chmodSync(localConfig, 0o600);
    console.log(`Wrote local CLI configuration: ${localConfig}`);
  }
  console.log(`
Pluck is ready.

Resources:
  Worker: ${names.worker}
  Namespace: ${names.namespace}
  Mainline repository: ${names.mainline}
  D1 database: ${names.database}
  Integration Queue: ${names.integrationQueue}
  Artifacts events Queue: ${names.eventsQueue}
  Generated config: ${config}

Next steps:
  npm run pluck -- create agent-a
  npm run pluck -- create agent-b

The CLI automatically reads .pluck/${name}.env for this deployment. Set PLUCK_CONFIG to select a config file when you have multiple deployments.`);
}

export async function runDestroy(options: DestroyOptions): Promise<void> {
  const name = options.name ?? await prompt("Pluck deployment name to destroy: ");
  if (!name) throw new Error("Provide --name");
  const names = deploymentNames(name);
  const confirmation = options.confirmation ?? await prompt(`This permanently deletes Pluck resources for ${name}. Type ${name} to continue: `);
  if (confirmation !== name) throw new Error("Destruction cancelled: confirmation did not match the deployment name");

  const config = path.join(".pluck", `${name}.wrangler.jsonc`);
  const localConfig = path.join(".pluck", `${name}.env`);
  console.log(`\nDestroying Pluck deployment ${name}.`);
  wrangler(["queues", "consumer", "remove", names.integrationQueue, names.worker]);
  console.log(`Removed Worker consumer from Queue: ${names.integrationQueue}`);
  wrangler(["queues", "consumer", "remove", names.eventsQueue, names.worker]);
  console.log(`Removed Worker consumer from Queue: ${names.eventsQueue}`);
  wrangler(["delete", names.worker, "--force"]);
  console.log(`Deleted Worker: ${names.worker}`);
  wrangler(["artifacts", "repos", "delete", names.mainline, "--namespace", names.namespace, "--force"]);
  console.log(`Deleted mainline repository: ${names.namespace}/${names.mainline}`);
  wrangler(["queues", "delete", names.integrationQueue]);
  console.log(`Deleted integration Queue: ${names.integrationQueue}`);
  wrangler(["queues", "delete", names.eventsQueue]);
  console.log(`Deleted Artifacts events Queue: ${names.eventsQueue}`);
  wrangler(["d1", "delete", names.database, "--skip-confirmation"]);
  console.log(`Deleted D1 database: ${names.database}`);
  await fs.rm(config, { force: true });
  await fs.rm(localConfig, { force: true });
  console.log(`Removed generated config and local credentials: ${config}\n\nThe empty Artifacts namespace ${names.namespace} remains because Wrangler does not support namespace deletion.`);
}
