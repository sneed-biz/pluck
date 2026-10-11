# Pluck

Pluck is an MCP-native coordination layer for Cloudflare Artifacts. This repository contains the patch integration spike and the first Cloudflare Worker vertical slice.

Pluck is inspired by Cloudflare's [Artifacts Git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare/). The implementation in this repository is independently authored and is licensed under the MIT License.

## Quickstart

Pluck coordinates concurrent agent changes in isolated Cloudflare Artifacts repositories and integrates valid commits into a shared mainline repository. It is built for Cloudflare's [next Git platform competition](https://blog.cloudflare.com/next-git-platform-on-cloudflare/).

You need a Cloudflare Workers Paid plan with Artifacts access, Node.js, Git, and either an authenticated Wrangler session (`npx wrangler login`) or a `CLOUDFLARE_API_TOKEN` with access to your target account.

```sh
npm install
npx wrangler login
npm run pluck -- init --name my-pluck
```

`init` prints each created or reused resource, then creates or reuses a dedicated Artifacts namespace, mainline repository, D1 database, and two Queues; seeds mainline; applies migrations; deploys the Worker; and writes non-secret deployment configuration to `.pluck/my-pluck.wrangler.jsonc`. It prompts for Worker secrets and never writes them to disk. Its final output includes the environment variables and workspace commands for the next step. Rerun the command with the same name to reuse resources.

For CI or other unattended setup, supply `--yes --name my-pluck` along with `PLUCK_API_TOKEN`, `BOOTSTRAP_TOKEN`, `PLUCK_OWNER_TOKEN`, and `CLOUDFLARE_API_TOKEN`. Set `CLOUDFLARE_ACCOUNT_ID` when Wrangler cannot infer the intended account.

After setup, use the displayed Worker URL and the workspace-owner token to provision a workspace. Add `.agent/context.md`, make a linear commit on `main`, and push it; its native Artifacts push event starts integration automatically.

```sh
export PLUCK_URL=https://my-pluck.<account>.workers.dev
export PLUCK_OWNER_TOKEN='the-owner-token-you-provided-to-init'
export PLUCK_NAMESPACE=my-pluck
export PLUCK_MAINLINE_REPO=my-pluck-mainline
npm run pluck -- create agent-a
npm run pluck -- create agent-b
```

## Development checks

```sh
npm run typecheck
npm test
npm run probe
npm run db:migrate:local
npm run dev
```

The probe reports whether the installed `isomorphic-git` version exposes a patch API. The integrator intentionally fails closed when patch application is not proven. That is a deadline gate: Pluck must not push a partially applied tree.

## Operational notes

- Live integration tests must use a separate Worker deployment, Artifacts namespace/repository, D1 database, and Queue. A deployment targeting the repository name `mainline` is rejected unless `ALLOW_PRODUCTION_MAINLINE=true` is explicitly configured.
- Artifacts event delivery is native Cloudflare Queue delivery; the Worker does not expose a public webhook or shared webhook secret.
- `isomorphic-git` with the Workers web HTTP adapter and an in-memory filesystem provides the Git write path. The adapter is paired with the tested unified-diff application implementation in this repository.
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
- `GET /api/queue` returns D1-backed counts by job status.
- `GET /api/jobs/:id` returns status, attempts, commit details, and conflict detail.
- `POST /api/jobs` submits a registered workspace commit event idempotently.
- `POST /api/jobs/:id/retry` requeues a terminal conflict or blocked job without bypassing validation.
- `POST /api/jobs/:id/resolve` accepts a unified resolution patch and requeues the job; normal source-parent, context, patch, and CAS validation still applies.

Workspace lifecycle callers use owner-authenticated endpoints to manage native subscriptions. Provisioning creates the repository first, then the subscription and D1 record; failures clean up resources created during the attempt.

- `POST /admin/workspaces` creates an Artifacts repository, creates its repository-scoped Queue subscription, and persists the subscription ID in D1.
- `DELETE /admin/workspaces/:namespace/:repo` deletes the Cloudflare subscription and deactivates the workspace.

Set the `PLUCK_API_TOKEN` Worker secret to enable the jobs API. Set `BOOTSTRAP_TOKEN` for `/admin/repos`, and configure `WORKSPACE_OWNER_TOKENS` for workspace lifecycle requests. The CLI is a thin client over the jobs routes:

Workspace lifecycle requests use an owner bearer token. Configure `WORKSPACE_OWNER_TOKENS` as a Worker secret JSON object mapping tokens to stable owner IDs; `ownerId` is derived server-side and is not accepted from request bodies. The bootstrap token remains reserved for `/admin/repos`. Configure `CLOUDFLARE_API_TOKEN` with account-scoped Workers Queues write access for subscription management.

```sh
PLUCK_URL=https://pluck-mcp.example.workers.dev PLUCK_TOKEN=... npm run pluck -- jobs
PLUCK_URL=https://pluck-mcp.example.workers.dev PLUCK_TOKEN=... npm run pluck -- status pluck/task-1:commit
PLUCK_URL=https://pluck-mcp.example.workers.dev PLUCK_TOKEN=... npm run pluck -- retry pluck/task-1:commit
```

Clean agent changes integrate automatically. Review conflicts locally with standard Git tooling rather than constructing a patch by hand:

```sh
export PLUCK_NAMESPACE=pluck
export PLUCK_MAINLINE_REPO=pluck-mainline
npm run pluck -- conflicts
npm run pluck -- review pluck/task-1:commit
```

`review` issues short-lived read tokens through the authenticated Wrangler CLI, clones current mainline to a disposable local worktree, and cherry-picks the agent commit. Resolve any normal Git conflict, continue the cherry-pick, then confirm the generated patch. Pluck remains the only process that writes mainline. Use `--keep` to retain a worktree or `--no-editor` to skip launching `$EDITOR`.

Deactivate a workspace and remove its native event subscription with `npm run pluck -- delete <repo-name> [namespace]`. This retains the Artifacts repository. To permanently remove a Pluck deployment's Worker, mainline repository, D1 database, Queues, and generated config, use an explicit name-matching confirmation:

```sh
npm run pluck -- destroy --name my-pluck --confirm my-pluck
```

Cloudflare's Wrangler CLI does not support deleting Artifacts namespaces, so `destroy` deliberately retains the empty namespace.

Create a workspace repository with the owner credential:

```sh
export PLUCK_OWNER_TOKEN='your-workspace-owner-token'
npm run pluck -- create my-new-repo
npm run pluck -- create my-new-repo pluck
```

The command returns the provisioned Artifacts `remote` and short-lived Git `token`. Use those values to clone or set a Git remote, add `.agent/context.md`, and push a linear commit to `main`.

The API is intentionally read-first. It cannot create commits, force-push mainline, or bypass source-parent, context, trailer, or patch validation. An MCP server can expose these same operations to agents without creating a competing write path.

## Isolated test app

Use `wrangler.test.jsonc` for live integration testing. It targets the separate `pluck-mcp-test` Worker, `pluck-test` Artifacts namespace, `pluck-test-mainline` repository, `pluck-test` D1 database, `pluck-test-integration` Queue, and `pluck-test-artifacts-events` Queue. Provision workspace repositories and their repository-scoped subscriptions through `POST /admin/workspaces`; do not create the subscription manually. Never point this config at the production `mainline` repository or production bindings.

After the test resources exist and the D1 ID and event queue ID are configured:

```sh
npm run db:migrate:test
npm run deploy:test
```

The Worker uses the returned Git remote and short-lived token with a Workers-compatible Git writer. It retries stale compare-and-swap pushes three times, persists each attempt in D1, and records exhaustion as a terminal `conflict`. Every successful commit includes structured `Agent-*` trailers, and no remote push is forced.
