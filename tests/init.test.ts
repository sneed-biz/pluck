import { describe, expect, it } from "vitest";
import { accountIdFromWhoami, deploymentNames, renderConfig } from "../scripts/init.js";

describe("pluck init", () => {
  it("derives isolated resource names from a deployment name", () => {
    expect(deploymentNames("acme-pluck")).toEqual({
      worker: "acme-pluck",
      namespace: "acme-pluck",
      mainline: "acme-pluck-mainline",
      database: "acme-pluck",
      integrationQueue: "acme-pluck-integration",
      eventsQueue: "acme-pluck-artifacts-events",
    });
  });

  it("rejects unsafe Cloudflare resource names", () => {
    expect(() => deploymentNames("Pluck")).toThrow("Deployment names");
    expect(() => deploymentNames("-pluck")).toThrow("Deployment names");
    expect(() => deploymentNames("pluck-")).toThrow("Deployment names");
  });

  it("renders a secret-free generated Wrangler config", () => {
    const config = JSON.parse(renderConfig(deploymentNames("acme-pluck"), "account-1", "database-1", "queue-1"));
    expect(config).toMatchObject({
      name: "acme-pluck",
      artifacts: [{ binding: "ARTIFACTS", namespace: "acme-pluck", remote: true }],
      d1_databases: [{ database_id: "database-1" }],
      vars: {
        MAINLINE_REPO: "acme-pluck-mainline",
        ARTIFACTS_NAMESPACE: "acme-pluck",
        EVENTS_QUEUE_ID: "queue-1",
        CLOUDFLARE_ACCOUNT_ID: "account-1",
      },
    });
    expect(JSON.stringify(config)).not.toContain("PLUCK_API_TOKEN");
    expect(JSON.stringify(config)).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("extracts an account ID from Wrangler's text-only whoami output", () => {
    expect(accountIdFromWhoami("Account ID\nabc123def456abc123def456abc123de\n")).toBe("abc123def456abc123def456abc123de");
    expect(accountIdFromWhoami("Not logged in")).toBeUndefined();
  });
});
