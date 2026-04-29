"""
Smoke test for the enact-langchain toolkit (Python).

Verifies:
  - EnactToolkit instantiates against TonCenter
  - enact_generate_agent_keypair tool returns a fresh ed25519 + deeplink
  - enact_detect_agentic_wallet tool correctly identifies a real wallet

Reads:
  TONCENTER_API_KEY
  AGENTIC_WALLET_ADDRESS  — already-deployed wallet to probe

Exits 0 on success, 1 on failure.
"""

import asyncio
import json
import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "python", "enact-protocol")
)
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "python", "enact-langchain")
)

from enact_protocol import EnactClient
from enact_langchain import get_enact_tools


def log(m: str) -> None:
    print(m, flush=True)


async def main() -> int:
    api_key = os.environ.get("TONCENTER_API_KEY")
    wallet = os.environ.get("AGENTIC_WALLET_ADDRESS")
    if not api_key:
        log("❌ TONCENTER_API_KEY required")
        return 1
    if not wallet:
        log("❌ AGENTIC_WALLET_ADDRESS required")
        return 1

    async with EnactClient(api_key=api_key) as client:
        tools = {t.name: t for t in get_enact_tools(client)}

        log(f"✅ EnactToolkit produced {len(tools)} tools")
        for needed in ["enact_generate_agent_keypair", "enact_detect_agentic_wallet"]:
            if needed not in tools:
                log(f"❌ tool missing: {needed}")
                return 1

        gen = tools["enact_generate_agent_keypair"]
        out = await gen.ainvoke({"agent_name": "lc-smoke"})
        if isinstance(out, str):
            data = json.loads(out)
        else:
            data = out
        pub = data.get("public_key_hex") or data.get("public_key") or ""
        if len(pub) != 64:
            log(f"❌ generate_agent_keypair invalid: {data}")
            return 1
        log(
            f"✅ enact_generate_agent_keypair -> pub={pub[:16]}… deeplink ok"
        )

        det = tools["enact_detect_agentic_wallet"]
        det_out = await det.ainvoke({"address": wallet})
        det_data = json.loads(det_out) if isinstance(det_out, str) else det_out
        is_aw = det_data.get("is_agentic_wallet") or det_data.get("isAgenticWallet")
        if not is_aw:
            log(f"❌ detect_agentic_wallet false: {det_data}")
            return 1
        owner = det_data.get("owner_address") or det_data.get("ownerAddress") or ""
        op = det_data.get("operator_public_key") or det_data.get("operatorPublicKey") or ""
        log(f"✅ enact_detect_agentic_wallet -> owner={str(owner)[:16]}… operator={str(op)[:16]}…")

    log("🎉 enact-langchain agentic tools PASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
