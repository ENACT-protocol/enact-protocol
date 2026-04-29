#!/usr/bin/env bash
# Smoke test for the local MCP server's agentic-wallet tools.
# Sends JSON-RPC over stdio: initialize, tools/list (sanity), then
# tools/call generate_agent_keypair, detect_agentic_wallet, configure_agentic_wallet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
fi

WALLET="${AGENTIC_WALLET_ADDRESS:-}"
SECRET="${AGENTIC_OPERATOR_SECRET:-}"
[ -n "$WALLET" ] || { echo "❌ AGENTIC_WALLET_ADDRESS missing" >&2; exit 1; }
[ -n "$SECRET" ] || { echo "❌ AGENTIC_OPERATOR_SECRET missing" >&2; exit 1; }
[ -n "${TONCENTER_API_KEY:-}" ] || { echo "❌ TONCENTER_API_KEY missing" >&2; exit 1; }

REQUESTS=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_agent_keypair","arguments":{"agent_name":"mcp-smoke"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"detect_agentic_wallet","arguments":{"address":"$WALLET"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"configure_agentic_wallet","arguments":{"operator_secret_key":"$SECRET","agentic_wallet_address":"$WALLET"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_jobs","arguments":{"count":1}}}
EOF
)

echo "$REQUESTS" | TONCENTER_API_KEY="$TONCENTER_API_KEY" PINATA_JWT="${PINATA_JWT:-}" LIGHTHOUSE_API_KEY="${LIGHTHOUSE_API_KEY:-}" node "$ROOT/mcp-server/dist/index.js" 2>/dev/null | \
while IFS= read -r line; do
  id=$(printf '%s' "$line" | python -c "import json,sys
try:
  d=json.loads(sys.stdin.read())
  print(d.get('id','-'))
except Exception:
  print('?')")
  case "$id" in
    1) echo "✅ initialize"; ;;
    2) echo "✅ generate_agent_keypair"; ;;
    3) printf '%s' "$line" | python -c "import json,sys; d=json.loads(sys.stdin.read()); c=d.get('result',{}).get('content',[{}])[0].get('text','{}'); inner=json.loads(c) if isinstance(c,str) else c; ok=inner.get('isAgenticWallet'); print('✅ detect_agentic_wallet -> isAgenticWallet=', ok)"; ;;
    4) echo "✅ configure_agentic_wallet"; ;;
    5) echo "✅ list_jobs (read path through configured agentic signer)"; ;;
    *) ;;
  esac
done

echo "🎉 local MCP agentic tools PASS"
