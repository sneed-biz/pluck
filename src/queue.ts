import type { ArtifactsPushEvent } from "./artifacts.js";

export type IntegrationJob = {
  id: string;
  sourceNamespace: string;
  sourceRepo: string;
  sourceCommit: string;
  beforeCommit: string;
  ref: string;
  receivedAt: string;
};

export function jobFromPushEvent(event: ArtifactsPushEvent, receivedAt = new Date().toISOString()): IntegrationJob {
  return {
    id: `${event.source.namespace}/${event.source.repoName}:${event.payload.after}`,
    sourceNamespace: event.source.namespace,
    sourceRepo: event.source.repoName,
    sourceCommit: event.payload.after,
    beforeCommit: event.payload.before,
    ref: event.payload.ref,
    receivedAt,
  };
}
