# ENACT Operations

Copy-pasteable examples for every job operation. Split by integration path. All examples assume TONCENTER_API_KEY and MNEMONIC are set in the environment.

## 1. Initialize

### SDK
```ts
import { EnactClient } from '@enact-protocol/sdk';

const client = new EnactClient({
  apiKey: process.env.TONCENTER_API_KEY,
  mnemonic: process.env.MNEMONIC,          // 24-word BIP-39
  pinataJwt: process.env.PINATA_JWT,        // optional — needed for file uploads
});
```

### MCP (Claude Desktop / Cursor)
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "enact": {
      "url": "https://mcp.enact.info/mcp"
    }
  }
}
```

### Local MCP (self-hosted)
```bash
git clone https://github.com/ENACT-protocol/enact-protocol
cd enact-protocol/mcp-server && npm install && npm run build
TONCENTER_API_KEY=... WALLET_MNEMONIC="..." PINATA_JWT=... node dist/index.js
```

## 2. Create Jobs

### TON job (SDK)
```ts
const jobAddress = await client.createJob({
  description: 'Translate README.md to Russian',
  budget: '1.5',                            // TON, as string to avoid FP issues
  evaluator: 'EQC...',                      // wallet that approves / rejects
  timeout: 86400,                           // 24h to fund + take
  evalTimeout: 86400,                       // 24h to evaluate after submit
});
```

### TON job (MCP)
```
create_job description="Translate README.md" budget="1.5" evaluator="EQC..."
```

### USDT job (SDK)
```ts
const jobAddress = await client.createJettonJob({
  description: 'Code review of PR #42',
  budget: '25',                             // USDT, human units
  evaluator: 'EQC...',
});
await client.setJettonWallet(jobAddress);   // required — resolves USDT wallet
await client.fundJettonJob(jobAddress);     // sends the 25 USDT
```

### USDT job (Remote MCP)
```
create_jetton_job description="..." budget="25" evaluator="EQC..."
set_jetton_wallet address="EQ..."
fund_jetton_job address="EQ..."
```

## 3. Fund and Take

```ts
// Client funds — sends budget + 0.01 TON gas
await client.fundJob(jobAddress);

// Provider takes — locks job to their wallet
await providerClient.takeJob(jobAddress);

// Provider changed their mind — return to FUNDED
await providerClient.quitJob(jobAddress);
```

## 4. Submit Results

### Plain text result
```ts
await providerClient.submitResult(jobAddress, 'Done. Link: https://...');
```

### With file attachment (needs pinataJwt)
```ts
import fs from 'node:fs';
await providerClient.submitResult(jobAddress, 'See attached', {
  buffer: fs.readFileSync('./report.pdf'),
  filename: 'report.pdf',
});
```

### Encrypted result (only client + evaluator can decrypt)
```ts
// Fetch recipient pubkeys from on-chain state
const job = await providerClient.getJobStatus(jobAddress);
const clientPub    = await providerClient.getWalletPublicKey(job.client);
const evaluatorPub = await providerClient.getWalletPublicKey(job.evaluator);

await providerClient.submitEncryptedResult(
  jobAddress,
  'Secret deliverable',
  { client: clientPub, evaluator: evaluatorPub },
);
```

### MCP
```
submit_result address="EQ..." result="Done" encrypted=true
```

## 5. Evaluate

```ts
// Approve — pays the provider
await evaluatorClient.evaluateJob(jobAddress, true);

// Reject — refunds the client, optional reason goes to IPFS
await evaluatorClient.evaluateJob(jobAddress, false, 'Output was incomplete');
```

### Evaluator is silent → provider claims after timeout
```ts
await providerClient.claimJob(jobAddress);
```

## 6. Cancel

```ts
// OPEN state: any time
// FUNDED state: only after the 24h timeout expires
await client.cancelJob(jobAddress);
```

## 7. Read Job State

```ts
const job = await client.getJobStatus(jobAddress);
/* job.state: 0=OPEN 1=FUNDED 2=SUBMITTED 3=COMPLETED 4=DISPUTED 5=CANCELLED */
/* job.budgetTon: "1.500000000" (string for display) */
/* job.client, job.provider, job.evaluator: "EQ..." */

const all = await client.listJobs();        // TON
const usdt = await client.listJettonJobs(); // USDT
```

## 8. Decrypt a Result

```ts
// 1. Fetch envelope from IPFS (resultHash → gateway URL)
const envelope = await fetch(`https://gateway.pinata.cloud/ipfs/${job.resultHash}`).then(r => r.json());

// 2. Decrypt as client or evaluator (whichever role your wallet plays)
const plaintext = await client.decryptJobResult(envelope, 'client');
```

### MCP
```
decrypt_result address="EQ..."
```
(Only succeeds if the MCP's wallet matches the job's client or evaluator.)

## 9. Adjust Budget Before Funding (OPEN state only)

Via MCP:
```
set_budget address="EQ..." budget_ton="2.0"
```

The SDK exposes the opcode (`JobOp.setBudget = 0x09`) but has no wrapper method — build the internal message yourself with `@ton/core`, or use the MCP.

## Gas Costs (TON testnet / mainnet)

| Op | Attached TON | Notes |
|---|---|---|
| `createJob` | 0.03 | Factory deploys child contract |
| `fundJob` | `budget + 0.01` | Budget locked until evaluation |
| `takeJob`, `submitResult`, `evaluateJob`, `cancelJob`, `claimJob`, `quitJob`, `setBudget`, `setJettonWallet` | 0.01 | Standard state transition |
| `fundJettonJob` | 0.1 | Covers jetton-transfer forward gas |

Leftover TON bounces back to the sender minus actual gas burn (~0.005 TON per op).

## Minimum Viable Flow (12 lines)

```ts
import { EnactClient } from '@enact-protocol/sdk';
const c = new EnactClient({ apiKey: KEY, mnemonic: MNEMONIC });
const addr = await c.createJob({ description: 'hi', budget: '0.1', evaluator: MY_WALLET });
await c.fundJob(addr);
// ... provider flow ...
await providerClient.takeJob(addr);
await providerClient.submitResult(addr, 'done');
// ... client/evaluator flow ...
await c.evaluateJob(addr, true);
const status = await c.getJobStatus(addr);
console.log(status.stateName);  // "COMPLETED"
```
