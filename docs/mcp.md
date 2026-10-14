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
