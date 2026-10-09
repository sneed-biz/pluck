import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSubscription, deleteWorkspaceSubscription } from "../src/subscriptions.js";

describe("Cloudflare Queue subscriptions", () => {
  it("creates a repository-scoped Artifacts push subscription", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true, result: { id: "subscription-1" } }), { status: 200 }));

    await expect(createWorkspaceSubscription({
      accountId: "account-1",
      apiToken: "token-1",
      queueId: "queue-1",
      namespace: "pluck-test",
      repoName: "task-1",
    })).resolves.toBe("subscription-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-1/event_subscriptions/subscriptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "pluck-pluck-test-task-1",
          enabled: true,
          events: ["pushed"],
          source: { type: "artifacts.repo", namespace: "pluck-test", repo_name: "task-1" },
          destination: { type: "queues.queue", queue_id: "queue-1" },
        }),
      }),
    );
    fetchMock.mockRestore();
  });

  it("deletes an existing subscription and tolerates an already deleted one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await deleteWorkspaceSubscription({ accountId: "account-1", apiToken: "token-1", queueId: "queue-1" }, "subscription-1");
    await deleteWorkspaceSubscription({ accountId: "account-1", apiToken: "token-1", queueId: "queue-1" }, "subscription-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});
