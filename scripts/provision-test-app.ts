import { execFileSync } from "node:child_process";
import fs from "node:fs";

const namespace = "pluck-test";
const mainline = "pluck-test-mainline";
const database = "pluck-test";
const queue = "pluck-test-integration";
const eventsQueue = "pluck-test-artifacts-events";
const config = "wrangler.test.jsonc";

function run(args: string[]): string {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function requireTestName(value: string): void {
  if (!value.startsWith("pluck-test")) throw new Error(`Refusing non-test resource: ${value}`);
}

requireTestName(namespace);
requireTestName(mainline);
requireTestName(database);
requireTestName(queue);
requireTestName(eventsQueue);

const configured = fs.readFileSync(config, "utf8");
const databaseId = configured.match(/database_id": "([0-9a-f-]+)"/)?.[1];
if (!databaseId || databaseId === "REPLACE_WITH_TEST_D1_ID") {
  throw new Error(`Provision ${database} first, then put its ID in ${config}`);
}

run(["artifacts", "namespaces", "get", namespace]);
const repo = JSON.parse(run(["artifacts", "repos", "create", mainline, "--namespace", namespace, "--default-branch", "main", "--json"]));
const queues = JSON.parse(run(["queues", "list", "--json"])) as { result?: { name: string; queue_id?: string; id?: string }[] };
const eventQueue = queues.result?.find((candidate) => candidate.name === eventsQueue);
if (!eventQueue) {
  run(["queues", "create", eventsQueue]);
}
const refreshedQueues = JSON.parse(run(["queues", "list", "--json"])) as { result?: { name: string; queue_id?: string; id?: string }[] };
const eventQueueId = refreshedQueues.result?.find((candidate) => candidate.name === eventsQueue)?.queue_id
  ?? refreshedQueues.result?.find((candidate) => candidate.name === eventsQueue)?.id;
if (!eventQueueId) throw new Error(`Could not resolve queue ID for ${eventsQueue}`);

console.log(JSON.stringify({ databaseId, queue, eventsQueue, eventsQueueId: eventQueueId, namespace, repository: repo.name, config }, null, 2));
