# Pluck

Pluck is an MCP-native coordination layer for Cloudflare Artifacts. This repository contains the patch integration spike and the first Cloudflare Worker vertical slice.

Pluck is inspired by Cloudflare's [Artifacts Git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare/). The implementation in this repository is independently authored and is licensed under the MIT License.

## Run the spike

```sh
npm install
npm run typecheck
npm test
npm run probe
npm run db:migrate:local
npm run dev
```

The probe reports whether the installed `isomorphic-git` version exposes a patch API. The integrator intentionally fails closed when patch application is not proven. That is a deadline gate: Pluck must not push a partially applied tree.

## Open risks

- Live integration tests must use a separate Worker deployment, Artifacts namespace/repository, D1 database, and Queue. A deployment targeting the repository name `mainline` is rejected unless `ALLOW_PRODUCTION_MAINLINE=true` is explicitly configured.
- Artifacts binding and event payloads need to be verified against a real Workers Paid account.
- `isomorphic-git` must provide, or be paired with, a tested unified-diff application implementation compatible with Workers. Its public API alone is not assumed to provide a complete cherry-pick operation.
- The write adapter must push with `force: false` (never force-push). The D1 lease plus a single queue consumer serializes normal work; if the remote rejects the push as non-fast-forward, that rejection is the compare-and-swap signal. Re-read mainline, re-apply the patch, and retry.

## Intended integration flow

1. Cloudflare delivers `cf.artifacts.repo.pushed` events directly to the `pluck-artifacts-events` Queue through a repository-scoped event subscription.
   Cloudflare authenticates this delivery; Pluck does not expose a public webhook or shared webhook secret.
2. The event consumer validates the active registered workspace, namespace, main branch, and protected mainline rules, then deduplicates the event in D1 and enqueues it to `pluck-integration`.
3. Require a linear source commit with exactly one parent matching the push `before` SHA. Read the source commit, source tree, and current mainline tree through the Artifacts binding.
4. Apply the single-commit diff to current mainline HEAD.
5. Require `.agent/context.md`.
6. Create a new mainline commit with `Agent-Task`, `Agent-Workspace`, `Agent-Source-Commit`, and `Agent-Context` trailers.
7. Push only after the complete tree is available; otherwise record a conflict and push nothing.

## Control API and CLI

Workspace agents continue to use normal Git commits and pushes. The Artifacts push event is the automatic delivery signal; Pluck does not require a second submit call for a successful push.

The Worker exposes an authenticated read/recovery API for MCP and human clients:

- `GET /api/jobs?limit=25` lists recent integration jobs.
- `GET /api/jobs/:id` returns status, attempts, commit details, and conflict detail.
- `POST /api/jobs/:id/retry` requeues a terminal conflict or blocked job without bypassing validation.

Workspace lifecycle callers use owner-authenticated endpoints to manage native subscriptions:

- `POST /admin/workspaces` creates an Artifacts repository, creates its repository-scoped Queue subscription, and persists the subscription ID in D1.
- `DELETE /admin/workspaces/:namespace/:repo` deletes the Cloudflare subscription and deactivates the workspace.

Set the `PLUCK_API_TOKEN` Worker secret to enable the API. The CLI is a thin client over these routes:

Workspace lifecycle requests use an owner bearer token. Configure `WORKSPACE_OWNER_TOKENS` as a Worker secret JSON object mapping tokens to stable owner IDs; `ownerId` is derived server-side and is not accepted from request bodies. The bootstrap token remains reserved for `/admin/repos`.

```sh
PLUCK_URL=https://pluck-mcp.example.workers.dev PLUCK_TOKEN=... npm run pluck -- jobs
PLUCK_URL=https://pluck-mcp.example.workers.dev PLUCK_TOKEN=... npm run pluck -- status pluck/task-1:commit
PLUCK_URL=https://pluck-mcp.example.workers.dev PLUCK_TOKEN=... npm run pluck -- retry pluck/task-1:commit
```

The API is intentionally read-first. It cannot create commits, force-push mainline, or bypass source-parent, context, trailer, or patch validation. An MCP server can expose these same operations to agents without creating a competing write path.

## Isolated test app

Use `wrangler.test.jsonc` for live integration testing. It targets the separate `pluck-mcp-test` Worker, `pluck-test` Artifacts namespace, `pluck-test-mainline` repository, `pluck-test` D1 database, `pluck-test-integration` Queue, and `pluck-test-artifacts-events` Queue. Create the repository-level subscription with Cloudflare's Queue subscription API before pushing a workspace commit. Never point this config at the production `mainline` repository or production bindings.

After replacing the D1 placeholder with the provisioned test database ID:

```sh
npm run db:migrate:test
npm run deploy:test
```

The Worker uses the returned Git remote and short-lived token with a Workers-compatible Git writer. It retries stale compare-and-swap pushes three times, persists each attempt in D1, and records exhaustion as a terminal `conflict`. Every successful commit includes structured `Agent-*` trailers, and no remote push is forced.
