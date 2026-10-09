const API_BASE = "https://api.cloudflare.com/client/v4";

export type SubscriptionConfig = {
  accountId: string;
  apiToken: string;
  queueId: string;
};

export type WorkspaceSubscription = SubscriptionConfig & {
  namespace: string;
  repoName: string;
  name?: string;
};

export async function createWorkspaceSubscription(config: WorkspaceSubscription): Promise<string> {
  const response = await fetch(`${API_BASE}/accounts/${encodeURIComponent(config.accountId)}/event_subscriptions/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: config.name ?? `pluck-${config.namespace}-${config.repoName}`,
      enabled: true,
      events: ["pushed"],
      source: { type: "artifacts.repo", namespace: config.namespace, repo_name: config.repoName },
      destination: { type: "queues.queue", queue_id: config.queueId },
    }),
  });
  const body = await response.json() as { success?: boolean; result?: { id?: string }; errors?: { message?: string }[] };
  if (!response.ok || !body.success || !body.result?.id) {
    throw new Error(`Cloudflare subscription create failed: ${body.errors?.[0]?.message ?? response.statusText}`);
  }
  return body.result.id;
}

export async function deleteWorkspaceSubscription(config: SubscriptionConfig, subscriptionId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/accounts/${encodeURIComponent(config.accountId)}/event_subscriptions/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({})) as { errors?: { message?: string }[] };
    throw new Error(`Cloudflare subscription delete failed: ${body.errors?.[0]?.message ?? response.statusText}`);
  }
}
