#!/usr/bin/env node
/**
 * OWS Policy: ENACT Protocol Safety Rules
 *
 * Install via:
 *   ows policy add --name enact-safety --executable ./enact-policy.js
 *
 * Policy receives PolicyContext on stdin, returns PolicyResult on stdout.
 *
 * Rules:
 *   1. Max transaction value: 100 TON
 *   2. Rate limit: max 10 transactions per hour (persisted to disk)
 *
 * TODO (v2): Parse TON BOC to extract destination address and enforce
 * ENACT contract allowlist. Currently BOC is opaque bytes — destination
 * check requires a TON Cell deserializer which is out of scope for a
 * lightweight policy script.
 */

const fs = require('fs');
const path = require('path');

// Max value per transaction (in nanoTON)
const MAX_VALUE_NANOTON = 100_000_000_000n; // 100 TON
const MAX_TXS_PER_HOUR = 10;

// Persistent rate limit file
const RATE_LIMIT_FILE = path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.ows',
    'enact-rate-limit.json',
);

function loadTimestamps() {
    try {
        const data = JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveTimestamps(timestamps) {
    const dir = path.dirname(RATE_LIMIT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(timestamps));
}

function parseInput() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('Invalid JSON input')); }
        });
    });
}

function respond(allow, reason) {
    process.stdout.write(JSON.stringify({ allow, reason }));
    process.exit(0);
}

async function main() {
    const context = await parseInput();
    const { transaction, chainId } = context;

    // Only enforce on TON chain
    if (chainId !== 'ton:mainnet' && chainId !== 'ton') {
        return respond(true, 'Non-TON chain, no ENACT restrictions');
    }

    // Value check
    if (transaction && transaction.value) {
        const value = BigInt(transaction.value);
        if (value > MAX_VALUE_NANOTON) {
            return respond(false,
                `Value ${Number(value) / 1e9} TON exceeds limit of ${Number(MAX_VALUE_NANOTON) / 1e9} TON`
            );
        }
    }

    // Rate limiting (persisted across process invocations)
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const timestamps = loadTimestamps().filter(t => t > oneHourAgo);

    if (timestamps.length >= MAX_TXS_PER_HOUR) {
        return respond(false,
            `Rate limit: ${timestamps.length}/${MAX_TXS_PER_HOUR} transactions in the last hour`
        );
    }

    timestamps.push(now);
    saveTimestamps(timestamps);

    return respond(true, 'ENACT transaction approved');
}

main().catch(e => respond(false, `Policy error: ${e.message}`));
