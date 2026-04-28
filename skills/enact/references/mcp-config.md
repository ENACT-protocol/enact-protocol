# MCP Host Configurations

Copy one of these into the host's MCP config file to use ENACT's 19 tools.

## Claude Desktop

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows).

### Remote (zero setup, remote wallet)
```json
{
  "mcpServers": {
    "enact": {
      "url": "https://mcp.enact.info/mcp"
    }
  }
}
```

### Local (your own mnemonic, your own TonCenter key)

First clone + build:
```bash
git clone https://github.com/ENACT-protocol/enact-protocol
cd enact-protocol/mcp-server && npm install && npm run build
```

Then point the host at the compiled file:
```json
{
  "mcpServers": {
    "enact": {
      "command": "node",
      "args": ["/absolute/path/to/enact-protocol/mcp-server/dist/index.js"],
      "env": {
        "TONCENTER_API_KEY": "...",
        "WALLET_MNEMONIC": "word1 word2 ... word24",
        "PINATA_JWT": "eyJhbGciOiJI..."
      }
    }
  }
}
```

## Cursor

File: `.cursor/mcp.json` in the project root.

Same schema as Claude Desktop — `mcpServers` → name → `url` or `command + args + env`.

## Cline (VS Code extension)

Cline reads `cline_mcp_settings.json`. Same shape.

## Supported env vars (local MCP only)

| Var | Default | Notes |
|---|---|---|
| `TONCENTER_API_KEY` | _(none)_ | Free key at https://t.me/tonapibot. Without it you're limited to ~1 RPS. |
| `WALLET_MNEMONIC` | _(none)_ | 24-word BIP-39, space-separated. Required for any write (create, fund, take, submit, evaluate). |
| `PINATA_JWT` | _(none)_ | **Required** — MCP throws without it on any tool that uploads to IPFS. Get one at https://app.pinata.cloud/developers/api-keys. |
| `FACTORY_ADDRESS` | `EQAFHo...sdxPECjX` | Override only if pointing at a non-mainnet fork. |
| `JETTON_FACTORY_ADDRESS` | `EQCgYm...6VTj` | Same. |

## Quick sanity check

After restarting the host, type:
> List my ENACT jobs

The LLM should call `list_jobs` and return the array. If you see "tool not found" the config didn't load — check the JSON syntax.
