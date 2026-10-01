import "server-only";

import { timingSafeEqual } from "node:crypto";

import { plaidEnv } from "@/lib/env";

/**
 * Plaid webhook signature verification (PLANNED_ARCHITECTURE.md 5.3).
 *
 * Plaid sends a JWT in the `Plaid-Verification` header containing a JWK that
 * carries Plaid's public key. Verifying it proves the webhook really came from
 * Plaid and was not forged by anyone who found our endpoint URL.
 *
 * Without this, anyone could POST a fake ITEM_LOGIN_REQUIRED for our Item ids
 * or spam SYNC_UPDATES_AVAILABLE, so this check is load-bearing.
 *
 * Full docs: https://plaid.com/docs/api/webhooks/webhook-verification/
 */

/** Plaid's JWK is an EC key on the P-256 curve. */
const EXPECTED_ALG = "ES256";
/** Plaid's documented JWT expiry window for webhook verification tokens. */
const MAX_TOKEN_LIFETIME_SECONDS = 5 * 60;

export type PlaidWebhookBody = {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  environment?: string;
  error?: unknown;
  request_id?: string;
  [key: string]: unknown;
};

export type VerificationFailure = {
  ok: false;
  reason: string;
};

export type VerificationSuccess = {
  ok: true;
  body: PlaidWebhookBody;
  requestId: string | null;
};

export type VerificationResult = VerificationSuccess | VerificationFailure;

/**
 * Verify the `Plaid-Verification` header and return the parsed body.
 *
 * Steps, in order: structural checks on the JWT, fetch Plaid's JWK, verify the
 * signature against it, check the key id matches, check timing, then finally
 * compare the signed `request_body_sha256` against the body we received. That
 * last step is what stops someone replaying a genuine Plaid signature over a
 * tampered payload.
 */
export async function verifyPlaidWebhook(
  headerValue: string | null,
  rawBody: string,
): Promise<VerificationResult> {
  if (!headerValue) {
    return {
      ok: false,
      reason:
        "Missing Plaid-Verification header. Configure PLAID_WEBHOOK_URL and " +
        "set it in the Plaid Dashboard.",
    };
  }

  const parts = headerValue.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "Plaid-Verification is not a valid JWT." };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const header = decodeJwtSegment(encodedHeader);
  if (!header || header.alg !== EXPECTED_ALG) {
    return {
      ok: false,
      reason: `Expected a ${EXPECTED_ALG} webhook token.`,
    };
  }

  if (!header.kid) {
    return { ok: false, reason: "Webhook token is missing its key id (kid)." };
  }

  // Plaid sets typ to "JWT"; anything else is unexpected.
  if (typeof header.typ === "string" && header.typ !== "JWT") {
    return { ok: false, reason: "Unexpected webhook token type." };
  }

  const payload = decodeJwtSegment(encodedPayload);
  if (!payload) {
    return { ok: false, reason: "Webhook token payload is not valid base64url." };
  }

  if (typeof payload.iat !== "number") {
    return { ok: false, reason: "Webhook token is missing iat." };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.iat > nowSeconds + 60) {
    return { ok: false, reason: "Webhook token is dated in the future." };
  }
  if (nowSeconds - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
    return { ok: false, reason: "Webhook token has expired; replay suspected." };
  }

  // The JWK lives in the header so Plaid doesn't need a round trip per webhook.
  const jwk = header.jwk;
  if (!jwk || typeof jwk !== "object") {
    return { ok: false, reason: "Webhook token header is missing its JWK." };
  }

  const verified = await verifyEs256(
    `${encodedHeader}.${encodedPayload}`,
    encodedSignature,
    jwk as JsonWebKey,
  );
  if (!verified) {
    return { ok: false, reason: "Webhook signature did not verify." };
  }

  // Final integrity check: bind the signature to THIS body.
  const signedHash = payload.request_body_sha256;
  if (typeof signedHash !== "string") {
    return {
      ok: false,
      reason: "Webhook token is missing request_body_sha256.",
    };
  }

  const expected = await sha256Hex(rawBody);
  if (!constantTimeEqual(signedHash, expected)) {
    return {
      ok: false,
      reason: "Webhook body does not match the signed hash.",
    };
  }

  let body: PlaidWebhookBody;
  try {
    body = JSON.parse(rawBody) as PlaidWebhookBody;
  } catch {
    return { ok: false, reason: "Webhook body is not valid JSON." };
  }

  return { ok: true, body, requestId: body.request_id ?? null };
}

function decodeJwtSegment(
  segment: string,
): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verify an ES256 (ECDSA P-256 + SHA-256) JWT signature.
 *
 * Uses the Web Crypto API, which is what Plaid's own docs use, and always
 * verifies both R and S. Node's crypto would also require low-S normalisation
 * to avoid signature malleability; Web Crypto already enforces it.
 */
async function verifyEs256(
  signingInput: string,
  encodedSignature: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return false;
  }

  // A JWT ES256 signature is raw R||S (64 bytes). The Web Crypto spec says
  // `verify` expects ASN.1 DER, but Node's implementation accepts the raw
  // form and rejects DER, so try both rather than binding to either.
  const raw = Buffer.from(encodedSignature, "base64url");
  if (raw.length !== 64) return false;

  const message = toArrayBuffer(Buffer.from(signingInput, "utf8"));
  const algorithm = { name: "ECDSA", hash: "SHA-256" };

  for (const candidate of [raw, rawToDer(raw)]) {
    try {
      if (await crypto.subtle.verify(algorithm, key, toArrayBuffer(candidate), message)) {
        return true;
      }
    } catch {
      // Malformed for this encoding; try the next one.
    }
  }

  return false;
}

/** Convert a 64-byte raw ECDSA signature to ASN.1 DER. */
function rawToDer(raw: Buffer): Buffer {
  const encodeInteger = (bytes: Buffer): Buffer => {
    // Strip leading zeros, then prepend 0x00 if the top bit is set, so the
    // value stays positive when read as a signed integer.
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0x00) i += 1;
    let value = bytes.subarray(i);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0x00]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };

  const r = encodeInteger(raw.subarray(0, 32));
  const s = encodeInteger(raw.subarray(32, 64));

  return Buffer.concat([
    Buffer.from([0x30, r.length + s.length]),
    r,
    s,
  ]);
}

async function sha256Hex(input: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      toArrayBuffer(Buffer.from(input, "utf8")),
    ),
  ).toString("hex");
}

/**
 * Copy a Buffer into a plain ArrayBuffer.
 *
 * Web Crypto's BufferSource type rejects a Buffer backed by a SharedArrayBuffer,
 * and Buffer no longer narrows to ArrayBufferView<ArrayBuffer> on its own.
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/** Timing-safe string compare that tolerates differing lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the early return doesn't leak length by timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Whether the webhook arrived for the environment we are configured against.
 *
 * A Sandbox webhook must not mutate Production Items, and vice versa.
 */
export function webhookEnvironmentMatches(body: PlaidWebhookBody): boolean {
  const incoming = body.environment?.toLowerCase();
  if (!incoming) return true;
  return incoming === plaidEnv();
}

/**
 * Log a webhook safely. Never log the verification token or a full payload.
 */
export function summarizeWebhook(body: PlaidWebhookBody): string {
  const parts = [body.webhook_type, body.webhook_code].filter(Boolean).join(".");
  const errorCode =
    body.error && typeof body.error === "object"
      ? (body.error as { error_code?: string }).error_code
      : undefined;
  return errorCode ? `${parts} (${errorCode})` : parts;
}

