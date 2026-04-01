/**
 * OWS Signer Adapter for ENACT Protocol
 *
 * Bridges Open Wallet Standard (OWS) with @ton/ton WalletContractV5R1.
 * OWS handles key storage and signing. @ton/ton handles Cell construction.
 *
 * Architecture:
 *   ┌─────────────┐    Cell.hash()    ┌─────────────┐
 *   │  @ton/ton   │ ──── 32 bytes ──► │  OWS vault  │
 *   │  constructs │ ◄── 64-byte sig ─ │  signs with │
 *   │  messages   │                   │  Ed25519 key│
 *   └─────────────┘                   └─────────────┘
 *
 * Limitation (OWS v1.1): OWS does not expose public keys via API.
 * We derive publicKey from the mnemonic at init, then immediately
 * zero out the secret key. The private key is NEVER used for signing —
 * all signing goes through OWS signMessage().
 *
 * Feature request: OWS getPublicKey(walletName, chainId) would
 * eliminate the need for mnemonic-based derivation entirely.
 *
 * @example
 *   const signer = await createOWSSigner('agent-treasury');
 *   // signer.publicKey  — Buffer, for WalletContractV5R1.create()
 *   // signer.sign       — (Cell) => Promise<Buffer>, for sendTransfer()
 *   // signer.address    — TON address string
 */

import { Cell } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

// OWS types (from @open-wallet-standard/core v1.1.2)
interface OWSSignResult {
    signature: string;   // hex-encoded, 64 bytes for Ed25519
    recoveryId?: number; // undefined for Ed25519
}

interface OWSModule {
    exportWallet(nameOrId: string, passphrase?: string | null, vaultPathOpt?: string | null): string;
    signMessage(wallet: string, chain: string, message: string, passphrase?: string | null, encoding?: string | null, index?: number | null, vaultPathOpt?: string | null): OWSSignResult;
    getWallet(nameOrId: string, vaultPathOpt?: string | null): { id: string; name: string; accounts: Array<{ chainId: string; address: string; derivationPath: string }>; createdAt: string };
}

const TON_CHAIN = 'ton:mainnet';

export interface OWSSigner {
    /** Ed25519 public key (32 bytes) — use for WalletContractV5R1.create({ publicKey }) */
    publicKey: Buffer;

    /** TON address (non-bounceable UQ... format) from OWS wallet */
    address: string;

    /** OWS wallet name */
    walletName: string;

    /**
     * Signer callback compatible with @ton/ton SendArgsSignable.
     * Receives the unsigned message Cell, hashes it, signs via OWS,
     * returns 64-byte Ed25519 signature.
     *
     * Usage: contract.sendTransfer({ signer: owsSigner.sign, seqno, ... })
     */
    sign: (message: Cell) => Promise<Buffer>;
}

/**
 * Create an OWS-backed signer for TON transactions.
 *
 * @param walletName - OWS wallet name (e.g. "agent-treasury")
 * @param options.passphrase - OWS vault passphrase (if set)
 * @param options.vaultPath - Custom vault path (default: ~/.ows)
 *
 * @returns OWSSigner with publicKey, address, and sign callback
 *
 * @throws If OWS wallet doesn't exist or has no TON account
 * @throws If @open-wallet-standard/core is not installed
 */
export async function createOWSSigner(
    walletName: string,
    options?: { passphrase?: string; vaultPath?: string },
): Promise<OWSSigner> {
    // Dynamic import — OWS is a native module, may not be available on all platforms
    let ows: OWSModule;
    try {
        ows = require('@open-wallet-standard/core');
    } catch {
        throw new Error(
            'OWS not available. Install: npm install @open-wallet-standard/core\n' +
            'Note: OWS requires native binaries (Linux/macOS). Windows is not yet supported.',
        );
    }

    const passphrase = options?.passphrase ?? null;
    const vaultPath = options?.vaultPath ?? null;

    // 1. Verify wallet exists and has TON account
    const wallet = ows.getWallet(walletName, vaultPath);
    const tonAccount = wallet.accounts.find(a => a.chainId === TON_CHAIN);
    if (!tonAccount) {
        throw new Error(`OWS wallet "${walletName}" has no TON account. Available chains: ${wallet.accounts.map(a => a.chainId).join(', ')}`);
    }

    // 2. Derive public key from mnemonic
    //    OWS v1.1 doesn't expose public keys via API.
    //    We extract the mnemonic, derive the keypair, keep ONLY publicKey,
    //    and immediately zero the secret key.
    const mnemonic = ows.exportWallet(walletName, passphrase, vaultPath);
    const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '));
    const publicKey = Buffer.from(keyPair.publicKey);

    // Zero out the secret key — we never use it for signing
    keyPair.secretKey.fill(0);

    // 3. Build signer callback
    const sign = async (message: Cell): Promise<Buffer> => {
        // @ton/ton passes the full unsigned Cell to signer.
        // We hash it (SHA-256, 32 bytes) — same as what domainSign() does internally.
        const hash = message.hash();

        // Sign the hash via OWS — Ed25519 signature, 64 bytes
        const result = ows.signMessage(
            walletName,
            TON_CHAIN,
            hash.toString('hex'),
            passphrase,
            'hex',      // encoding: treat input as hex bytes
            null,       // index: default (0)
            vaultPath,
        );

        return Buffer.from(result.signature, 'hex');
    };

    return {
        publicKey,
        address: tonAccount.address,
        walletName,
        sign,
    };
}
