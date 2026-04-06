/**
 * ENACT Protocol — E2E Encryption for Job Results
 *
 * Uses TON-native cryptography: ed25519 → x25519 (curve25519) → ECDH → AES-256-CBC.
 * Only client and evaluator can decrypt submitted results. Contract unchanged.
 */

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ─── ed25519 → x25519 Key Conversion ───

/**
 * Convert ed25519 secret key seed (32 bytes) to x25519 secret key.
 * Standard algorithm: SHA-512(seed) → clamp first 32 bytes.
 */
export function ed25519SecretToX25519(secretKey: Buffer): Buffer {
    // secretKey is 64 bytes (seed + public). Take the 32-byte seed.
    const seed = secretKey.subarray(0, 32);
    const hash = createHash('sha512').update(seed).digest();
    const x = Buffer.from(hash.subarray(0, 32));
    // Clamp
    x[0] &= 248;
    x[31] &= 127;
    x[31] |= 64;
    return x;
}

/**
 * Convert ed25519 public key (32 bytes) to x25519 public key.
 * Uses the birational map from Edwards to Montgomery curve.
 */
export function ed25519PubToX25519(publicKey: Buffer): Buffer {
    // Use Node.js crypto for the conversion
    const { createPublicKey, createPrivateKey } = require('crypto');

    // Import ed25519 public key as KeyObject
    const edKey = createPublicKey({
        key: Buffer.concat([
            // Ed25519 public key DER prefix
            Buffer.from('302a300506032b6570032100', 'hex'),
            publicKey,
        ]),
        format: 'der',
        type: 'spki',
    });

    // Node.js 18+ supports convertKey for ed25519 → x25519
    // Fallback: manual conversion using the Edwards→Montgomery formula
    try {
        const xKey = edKey.export({ type: 'spki', format: 'der' });
        // If we can do this natively, great
    } catch {}

    // Manual Edwards → Montgomery conversion
    // u = (1 + y) / (1 - y) mod p, where y is the ed25519 point coordinate
    const p = 2n ** 255n - 19n;
    const y = bufToBigInt(publicKey);
    const numerator = mod(1n + y, p);
    const denominator = mod(1n - y, p);
    const u = mod(numerator * modInverse(denominator, p), p);
    return bigIntToBuf(u, 32);
}

function bufToBigInt(buf: Buffer): bigint {
    let result = 0n;
    for (let i = buf.length - 1; i >= 0; i--) {
        result = (result << 8n) | BigInt(buf[i]); // little-endian
    }
    return result;
}

function bigIntToBuf(n: bigint, len: number): Buffer {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
        buf[i] = Number(n & 0xFFn);
        n >>= 8n;
    }
    return buf;
}

function mod(a: bigint, p: bigint): bigint {
    return ((a % p) + p) % p;
}

function modInverse(a: bigint, p: bigint): bigint {
    return modPow(a, p - 2n, p); // Fermat's little theorem
}

function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
    let result = 1n;
    base = mod(base, modulus);
    while (exp > 0n) {
        if (exp & 1n) result = mod(result * base, modulus);
        exp >>= 1n;
        base = mod(base * base, modulus);
    }
    return result;
}

// ─── ECDH Shared Secret ───

/**
 * Compute x25519 ECDH shared secret, then derive AES key with SHA-256.
 */
function computeSharedSecret(myX25519Secret: Buffer, theirX25519Public: Buffer): Buffer {
    const { diffieHellman, createPublicKey, createPrivateKey } = require('crypto');

    const privKey = createPrivateKey({
        key: Buffer.concat([
            Buffer.from('302e020100300506032b656e04220420', 'hex'), // X25519 private key DER prefix
            myX25519Secret,
        ]),
        format: 'der',
        type: 'pkcs8',
    });

    const pubKey = createPublicKey({
        key: Buffer.concat([
            Buffer.from('302a300506032b656e032100', 'hex'), // X25519 public key DER prefix
            theirX25519Public,
        ]),
        format: 'der',
        type: 'spki',
    });

    const shared = diffieHellman({ privateKey: privKey, publicKey: pubKey });
    // Derive AES-256 key from shared secret
    return createHash('sha256').update(shared).digest();
}

// ─── AES-256-CBC Encrypt / Decrypt ───

function aesEncrypt(plaintext: Buffer, key: Buffer): { ciphertext: Buffer; iv: Buffer } {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext: encrypted, iv };
}

function aesDecrypt(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Public API ───

export interface EncryptedEnvelope {
    type: 'job_result_encrypted';
    version: 1;
    senderPublicKey: string; // hex, ed25519 public key of provider
    recipients: {
        role: 'client' | 'evaluator';
        encryptedKey: string; // base64, AES key encrypted via ECDH
        iv: string; // base64
    }[];
    ciphertext: string; // base64, AES-encrypted result
    iv: string; // base64, IV for ciphertext
    submittedAt: string;
}

/**
 * Encrypt a result for client and evaluator.
 *
 * @param result - plaintext result string
 * @param senderSecretKey - provider's ed25519 secret key (64 bytes)
 * @param senderPublicKey - provider's ed25519 public key (32 bytes)
 * @param recipientPublicKeys - { client: ed25519 pub 32b, evaluator: ed25519 pub 32b }
 */
export function encryptResult(
    result: string,
    senderSecretKey: Buffer,
    senderPublicKey: Buffer,
    recipientPublicKeys: { client: Buffer; evaluator: Buffer },
): EncryptedEnvelope {
    // Generate random AES key
    const aesKey = randomBytes(32);

    // Encrypt result with AES
    const { ciphertext, iv } = aesEncrypt(Buffer.from(result, 'utf-8'), aesKey);

    // Convert sender's ed25519 secret → x25519 secret
    const senderX25519 = ed25519SecretToX25519(senderSecretKey);

    // For each recipient: ECDH → encrypt AES key
    const recipients: EncryptedEnvelope['recipients'] = [];
    for (const [role, pubKey] of [['client', recipientPublicKeys.client], ['evaluator', recipientPublicKeys.evaluator]] as const) {
        const recipientX25519Pub = ed25519PubToX25519(pubKey);
        const sharedAesKey = computeSharedSecret(senderX25519, recipientX25519Pub);
        const encrypted = aesEncrypt(aesKey, sharedAesKey);
        recipients.push({
            role,
            encryptedKey: encrypted.ciphertext.toString('base64'),
            iv: encrypted.iv.toString('base64'),
        });
    }

    return {
        type: 'job_result_encrypted',
        version: 1,
        senderPublicKey: senderPublicKey.toString('hex'),
        recipients,
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        submittedAt: new Date().toISOString(),
    };
}

/**
 * Decrypt an encrypted result.
 *
 * @param envelope - the encrypted envelope from IPFS
 * @param role - 'client' or 'evaluator'
 * @param recipientSecretKey - recipient's ed25519 secret key (64 bytes)
 */
export function decryptResult(
    envelope: EncryptedEnvelope,
    role: 'client' | 'evaluator',
    recipientSecretKey: Buffer,
): string {
    const recipient = envelope.recipients.find(r => r.role === role);
    if (!recipient) throw new Error(`No encrypted key for role: ${role}`);

    // Convert recipient's ed25519 secret → x25519 secret
    const recipientX25519 = ed25519SecretToX25519(recipientSecretKey);

    // Convert sender's ed25519 public → x25519 public
    const senderPub = Buffer.from(envelope.senderPublicKey, 'hex');
    const senderX25519Pub = ed25519PubToX25519(senderPub);

    // ECDH → shared secret → decrypt AES key
    const sharedAesKey = computeSharedSecret(recipientX25519, senderX25519Pub);
    const aesKey = aesDecrypt(
        Buffer.from(recipient.encryptedKey, 'base64'),
        sharedAesKey,
        Buffer.from(recipient.iv, 'base64'),
    );

    // Decrypt ciphertext with AES key
    const plaintext = aesDecrypt(
        Buffer.from(envelope.ciphertext, 'base64'),
        aesKey,
        Buffer.from(envelope.iv, 'base64'),
    );

    return plaintext.toString('utf-8');
}
