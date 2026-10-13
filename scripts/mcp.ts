#!/usr/bin/env -S npx tsx

import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type PluckConfig = {
  url: string;
  token: string;
  ownerToken?: string;
};

export function loadPluckConfig(env = process.env): PluckConfig {
  loadLocalConfig(env);
  if (!env.PLUCK_URL || !env.PLUCK_TOKEN) {
    throw new Error("PLUCK_URL and PLUCK_TOKEN are required");
  }
  return { url: env.PLUCK_URL.replace(/\/$/, ""), token: env.PLUCK_TOKEN, ownerToken: env.PLUCK_OWNER_TOKEN };
}

export async function pluckRequest(config: PluckConfig, path: string, init: RequestInit = {}, owner = false): Promise<unknown> {
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${owner ? config.ownerToken : config.token}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({ error: "invalid_response" }));
  if (!response.ok) throw new Error(`Pluck API request failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}

export function createMcpServer(config: PluckConfig): McpServer {
  const server = new McpServer({ name: "pluck", version: "0.1.0" });
  const control = (path: string, init?: RequestInit) => pluckRequest(config, path, init);

  server.registerTool("list_jobs", {
    description: "List recent Pluck integration jobs.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  }, async ({ limit }) => {
    try {
      return result(await control(`/api/jobs${limit ? `?limit=${limit}` : ""}`));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("get_job", {
    description: "Get an integration job's status, attempts, commit details, and conflict detail.",
    inputSchema: { jobId: z.string().min(1) },
  }, async ({ jobId }) => {
    try {
      return result(await control(`/api/jobs/${encodeURIComponent(jobId)}`));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("get_queue_status", {
    description: "Get D1-backed Pluck integration queue counts by job status.",
  }, async () => {
    try {
      return result(await control("/api/queue"));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("retry_job", {
    description: "Requeue a terminal conflict or blocked integration job. All normal validation still applies.",
    inputSchema: { jobId: z.string().min(1) },
  }, async ({ jobId }) => {
    try {
      return result(await control(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("resolve_job", {
    description: "Submit a unified resolution patch for a conflicted job and requeue it. All normal validation still applies.",
    inputSchema: { jobId: z.string().min(1), patch: z.string().min(1) },
  }, async ({ jobId, patch }) => {
    try {
      return result(await control(`/api/jobs/${encodeURIComponent(jobId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch }),
      }));
    } catch (error) {
      return failure(error);
    }
  });

  if (config.ownerToken) {
    server.registerTool("create_workspace", {
      description: "Create an owned workspace repository and native Artifacts event subscription.",
      inputSchema: { repoName: z.string().min(1), namespace: z.string().min(1) },
    }, async ({ repoName, namespace }) => {
      try {
        return result(await pluckRequest(config, "/admin/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace, repoName }),
        }, true));
      } catch (error) {
        return failure(error);
      }
    });

    server.registerTool("delete_workspace", {
      description: "Deactivate an owned workspace and remove its native event subscription. The repository is retained.",
      inputSchema: { repoName: z.string().min(1), namespace: z.string().min(1) },
    }, async ({ repoName, namespace }) => {
      try {
        return result(await pluckRequest(config, `/admin/workspaces/${encodeURIComponent(namespace)}/${encodeURIComponent(repoName)}`, { method: "DELETE" }, true));
      } catch (error) {
        return failure(error);
      }
    });
  }

  return server;
}

async function main(): Promise<void> {
  const server = createMcpServer(loadPluckConfig());
  await server.connect(new StdioServerTransport());
}

function loadLocalConfig(env: NodeJS.ProcessEnv): void {
  const explicit = env.PLUCK_CONFIG;
  const configs = explicit ? [explicit] : existsSync(".pluck")
    ? readdirSync(".pluck").filter((file) => file.endsWith(".env")).map((file) => nodePath.join(".pluck", file))
    : [];
  if (configs.length !== 1 || !existsSync(configs[0])) return;
  for (const line of readFileSync(configs[0], "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!env[key]) env[key] = line.slice(separator + 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
