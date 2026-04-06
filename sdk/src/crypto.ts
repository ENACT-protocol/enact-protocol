/**
 * ENACT Protocol — E2E Encryption for Job Results
 *
 * Uses ed2curve + tweetnacl: ed25519 → x25519 → nacl.box (ECDH + xsalsa20-poly1305).
 * Only client and evaluator can decrypt submitted results. Contract unchanged.
 */

import nacl from 'tweetnacl';
import ed2curve from 'ed2curve';

// ─── Public API ───

export interface EncryptedEnvelope {
    type: 'job_result_encrypted';
    version: 1;
    senderPublicKey: string; // hex, ed25519 public key of provider
    recipients: {
        role: 'client' | 'evaluator';
        encryptedKey: string; // base64, secret key encrypted via nacl.box
        nonce: string; // base64
    }[];
    ciphertext: string; // base64, nacl.secretbox encrypted result
    nonce: string; // base64
    submittedAt: string;
}

/**
 * Encrypt a result for client and evaluator.
 */
export function encryptResult(
    result: string,
    senderSecretKey: Buffer,
    senderPublicKey: Buffer,
    recipientPublicKeys: { client: Buffer; evaluator: Buffer },
): EncryptedEnvelope {
    // Convert sender ed25519 → x25519
    const senderX25519Sec = ed2curve.convertSecretKey(new Uint8Array(senderSecretKey));

    // Encrypt result with random secret key + nacl.secretbox
    const secretKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(new TextEncoder().encode(result), nonce, secretKey);

    // For each recipient: nacl.box the secret key
    const recipients: EncryptedEnvelope['recipients'] = [];
    for (const [role, pubKey] of [['client', recipientPublicKeys.client], ['evaluator', recipientPublicKeys.evaluator]] as const) {
        const recipientX25519Pub = ed2curve.convertPublicKey(new Uint8Array(pubKey));
        if (!recipientX25519Pub) throw new Error(`Failed to convert ${role} public key to x25519`);
        const boxNonce = nacl.randomBytes(nacl.box.nonceLength);
        const encryptedKey = nacl.box(secretKey, boxNonce, recipientX25519Pub, senderX25519Sec);
        recipients.push({
            role,
            encryptedKey: Buffer.from(encryptedKey).toString('base64'),
            nonce: Buffer.from(boxNonce).toString('base64'),
        });
    }

    return {
        type: 'job_result_encrypted',
        version: 1,
        senderPublicKey: senderPublicKey.toString('hex'),
        recipients,
        ciphertext: Buffer.from(ciphertext).toString('base64'),
        nonce: Buffer.from(nonce).toString('base64'),
        submittedAt: new Date().toISOString(),
    };
}

/**
 * Decrypt an encrypted result.
 */
export function decryptResult(
    envelope: EncryptedEnvelope,
    role: 'client' | 'evaluator',
    recipientSecretKey: Buffer,
): string {
    const recipient = envelope.recipients.find(r => r.role === role);
    if (!recipient) throw new Error(`No encrypted key for role: ${role}`);

    // Convert recipient ed25519 secret → x25519 secret
    const recipientX25519Sec = ed2curve.convertSecretKey(new Uint8Array(recipientSecretKey));

    // Convert sender ed25519 public → x25519 public
    const senderX25519Pub = ed2curve.convertPublicKey(new Uint8Array(Buffer.from(envelope.senderPublicKey, 'hex')));
    if (!senderX25519Pub) throw new Error('Failed to convert sender public key');

    // nacl.box.open to get the secret key
    const encryptedKey = new Uint8Array(Buffer.from(recipient.encryptedKey, 'base64'));
    const boxNonce = new Uint8Array(Buffer.from(recipient.nonce, 'base64'));
    const secretKey = nacl.box.open(encryptedKey, boxNonce, senderX25519Pub, recipientX25519Sec);
    if (!secretKey) throw new Error('Decryption failed — wrong key or corrupted data');

    // nacl.secretbox.open to get plaintext
    const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertext, 'base64'));
    const nonce = new Uint8Array(Buffer.from(envelope.nonce, 'base64'));
    const plaintext = nacl.secretbox.open(ciphertext, nonce, secretKey);
    if (!plaintext) throw new Error('Decryption failed — corrupted ciphertext');

    return new TextDecoder().decode(plaintext);
}
