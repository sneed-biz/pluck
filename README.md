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

- Artifacts binding and event payloads need to be verified against a real Workers Paid account.
- `isomorphic-git` must provide, or be paired with, a tested unified-diff application implementation compatible with Workers. Its public API alone is not assumed to provide a complete cherry-pick operation.
- The write adapter must push with `force: false` (never force-push). The D1 lease plus a single queue consumer serializes normal work; if the remote rejects the push as non-fast-forward, that rejection is the compare-and-swap signal. Re-read mainline, re-apply the patch, and retry.

## Intended integration flow

1. Receive a `cf.artifacts.repo.pushed` webhook at `/events/artifacts`.
   Ignore pushes from the `mainline` repository to prevent the integrator from consuming its own output.
2. Deduplicate the event in D1 and enqueue it to `pluck-integration`.
3. Require a linear source commit with exactly one parent matching the push `before` SHA. Read the source commit, source tree, and current mainline tree through the Artifacts binding.
4. Apply the single-commit diff to current mainline HEAD.
5. Require `.agent/context.md`.
6. Create a new mainline commit with `Agent-Task`, `Agent-Workspace`, `Agent-Source-Commit`, and `Agent-Context` trailers.
7. Push only after the complete tree is available; otherwise record a conflict and push nothing.

The Worker uses the returned Git remote and short-lived token with a Workers-compatible Git writer. It retries stale compare-and-swap pushes three times, persists each attempt in D1, and records exhaustion as a terminal `conflict`. Every successful commit includes structured `Agent-*` trailers, and no remote push is forced.
