# MCP server

An optional local stdio server wrapping the control API. It never writes to Git.

```sh
npm run mcp
```

```json
{
  "mcpServers": {
    "pluck": {
      "command": "npx",
      "args": ["tsx", "scripts/mcp.ts"],
      "cwd": "/path/to/pluck"
    }
  }
}
```

Tools: `list_jobs`, `get_job`, `get_queue_status`, `retry_job`, `resolve_job`; plus `create_workspace` and `delete_workspace` when `PLUCK_OWNER_TOKEN` is set. Config loading matches the CLI (`PLUCK_URL` and `PLUCK_TOKEN` required).

## opencode

The repo ships an `opencode.json` that registers the server, so running `opencode` from the repo root exposes the Pluck tools with no extra setup. It reads the same `.pluck/*.env` config as the CLI (set `PLUCK_CONFIG` if you have more than one deployment).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pluck": { "type": "local", "command": ["npx", "tsx", "scripts/mcp.ts"], "enabled": true }
  }
}
```

An agent can call `create_workspace` to get its own repo and short-lived Git token, push one commit with `.agent/context.md` using plain Git, then use `list_jobs` and `get_job` to follow integration or `resolve_job` after a conflict.
