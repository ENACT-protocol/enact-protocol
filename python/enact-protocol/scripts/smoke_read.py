"""Read-only smoke test against TON mainnet.

Usage::

    python scripts/smoke_read.py

Does not require a mnemonic or Pinata JWT. Optionally honour
``TONCENTER_API_KEY`` for faster (non-rate-limited) calls.
"""
from __future__ import annotations

import asyncio
import os
import sys

from enact_protocol import EnactClient


async def main() -> int:
    api_key = os.environ.get("TONCENTER_API_KEY")

    async with EnactClient(api_key=api_key) as client:
        ton_count = await client.get_job_count()
        if not api_key:
            await asyncio.sleep(1.2)
        usdt_count = await client.get_jetton_job_count()
        print(f"Factory totals: {ton_count} TON jobs, {usdt_count} USDT jobs")
        if not api_key:
            await asyncio.sleep(1.2)

        if ton_count == 0 and usdt_count == 0:
            print("No jobs on-chain yet — nothing to read.")
            return 0

        if ton_count > 0:
            addr = await client.get_job_address(0)
            print(f"\nFirst TON job #0 -> {addr}")
            if not api_key:
                await asyncio.sleep(1.2)
            status = await client.get_job_status(addr)
            print(f"  state:     {status.state_name}")
            print(f"  budget:    {status.budget_ton} TON ({status.budget} nano)")
            print(f"  client:    {status.client}")
            print(f"  provider:  {status.provider or '(none)'}")
            print(f"  evaluator: {status.evaluator}")
            print(f"  desc_hash: {status.desc_hash[:16]}...")

        if usdt_count > 0:
            if not api_key:
                await asyncio.sleep(1.2)
            addr = await client.get_job_address(0, client.jetton_factory_address)
            print(f"\nFirst USDT job #0 -> {addr}")
            if not api_key:
                await asyncio.sleep(1.2)
            status = await client.get_job_status(addr)
            print(f"  state:     {status.state_name}")
            print(f"  budget:    {status.budget} nanoUSDT")
            print(f"  client:    {status.client}")
            print(f"  evaluator: {status.evaluator}")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
