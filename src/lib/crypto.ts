import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { tokenEncryptionKey } from "@/lib/env";

/**
 * AES-256-GCM encryption for Plaid access tokens at rest.
 *
 * Access tokens are bearer credentials: anyone holding one can read every
 * transaction on that Item. They are stored encrypted in `items` and only ever
 * decrypted server-side, immediately before a Plaid call.
 *
 * Losing or rotating TOKEN_ENCRYPTION_KEY makes every stored token
 * undecryptable, which means losing every linked Item and its Trial-plan slot
 * (docs/architecture.md section 2). Back it up.
 *
 * Ciphertext layout, all base64url so it survives JSON and headers:
 *   [ 12-byte IV | 16-byte GCM auth tag | ciphertext ]
 *
 * GCM is authenticated: any tampering fails the decrypt rather than returning
 * garbage.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export function encryptToken(plaintext: string): string {
  // An empty value would encrypt to exactly IV + tag bytes, which is
  // indistinguishable from a truncated payload. Plaid access tokens are never
  // empty, so reject it here rather than weakening the length check below.
  if (plaintext.length === 0) {
    throw new Error("Refusing to encrypt an empty Plaid access token.");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, tokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64url");
}

export function decryptToken(payload: string): string {
  const raw = Buffer.from(payload, "base64url");

  if (raw.length <= IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error(
      "Stored Plaid access token is malformed. Check that " +
        "TOKEN_ENCRYPTION_KEY has not changed since the Item was linked.",
    );
  }

  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, tokenEncryptionKey(), iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM auth failure means wrong key or corrupted ciphertext.
    throw new Error(
      "Failed to decrypt Plaid access token. This is almost always a changed " +
        "TOKEN_ENCRYPTION_KEY. Restoring the original key recovers the Items; " +
        "otherwise every linked Item must be re-linked.",
    );
  }
}

/**
 * Whether a stored token can still be decrypted with the current key.
 *
 * Lets the dashboard warn before a sync blows up, instead of after.
 */
export function canDecryptToken(payload: string): boolean {
  try {
    decryptToken(payload);
    return true;
  } catch {
    return false;
  }
}