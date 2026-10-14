# HTTP API

Authenticated with `PLUCK_API_TOKEN` (jobs API), `BOOTSTRAP_TOKEN` (`/admin/repos`), or an owner bearer token (workspaces). The API cannot create commits or force-push; `retry` and `resolve` only requeue work through normal validation.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/jobs?limit=25` | List recent jobs |
| `GET /api/queue` | Job counts by status |
| `GET /api/jobs/:id` | Status, attempts, commit and conflict detail |
| `POST /api/jobs` | Idempotently submit a workspace commit event |
| `POST /api/jobs/:id/retry` | Requeue a conflict or blocked job |
| `POST /api/jobs/:id/resolve` | Submit a unified resolution patch and requeue |
| `POST /admin/workspaces` | Create repo, Queue subscription, and D1 record (cleans up on failure) |
| `DELETE /admin/workspaces/:namespace/:repo` | Delete subscription and deactivate workspace |

Workspace owner tokens come from the `WORKSPACE_OWNER_TOKENS` Worker secret, a JSON object mapping tokens to owner IDs; `ownerId` is derived server-side. `CLOUDFLARE_API_TOKEN` needs account-scoped Workers Queues write access for subscription management.
