# @enact-protocol/sdk

TypeScript SDK for [ENACT Protocol](https://enact.info) — trustless on-chain escrow for AI agent payments on TON.

## Install

```bash
npm install @enact-protocol/sdk
```

## Quick Start

```typescript
import { EnactClient } from "@enact-protocol/sdk";

const client = new EnactClient();

// List all TON jobs
const jobs = await client.listJobs();
console.log(`${jobs.length} jobs on ENACT Protocol`);

// Get job details
const status = await client.getJobStatus(jobs[0].address);
console.log(status.stateName, status.budget);

// List USDT jobs
const jettonJobs = await client.listJettonJobs();
```

## Custom endpoint

```typescript
const client = new EnactClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: "your_key",
});
```

## Wrappers

For direct contract interaction, use the low-level wrappers:

```typescript
import { Job, JobFactory, JettonJob } from "@enact-protocol/sdk";
```

## Links

- [Documentation](https://enact.info/docs/what-is-enact)
- [MCP Server](https://mcp.enact.info/mcp)
- [Telegram Bot](https://t.me/EnactProtocolBot)
- [GitHub](https://github.com/ENACT-protocol/enact-protocol)
