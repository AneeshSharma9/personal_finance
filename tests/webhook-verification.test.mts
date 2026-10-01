import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { test } from "node:test";

process.env.PLAID_ENV = "sandbox";

const { verifyPlaidWebhook } = await import("@/lib/plaid/webhook");

/**
 * Build a webhook exactly the way Plaid does: an ES256 JWT whose header carries
 * the public JWK, and whose payload carries a SHA-256 of the request body.
 */
function makeVerificationHeader(
  body: string,
  options: {
    privateKey?: ReturnType<typeof generateKeyPairSync>["privateKey"];
    tamperSignature?: boolean;
    tamperHash?: boolean;
    issuedAt?: number;
    alg?: string;
  } = {},
): string {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const key = options.privateKey ?? privateKey;

  const jwk = publicKey.export({ format: "jwk" });
  const header = {
    alg: options.alg ?? "ES256",
    typ: "JWT",
    kid: "test-key-id",
    jwk,
  };

  const realHash = createHash("sha256").update(body).digest("hex");
  const payload = {
    iat: options.issuedAt ?? Math.floor(Date.now() / 1000),
    request_body_sha256: options.tamperHash ? "0".repeat(64) : realHash,
  };

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Plaid's ES256 signature is raw R||S (64 bytes), which is what Web Crypto
  // emits when signing without DER encoding.
  const der = sign("sha256", Buffer.from(signingInput), key);
  const raw = derToRaw(der);

  if (options.tamperSignature) {
    raw[raw.length - 1] ^= 0xff;
  }

  return `${signingInput}.${raw.toString("base64url")}`;
}

/** Node signs ECDSA as ASN.1 DER; Plaid sends raw R||S. Convert between them. */
function derToRaw(der: Buffer): Buffer {
  let offset = 0;
  assert.equal(der[offset++], 0x30, "expected DER SEQUENCE");

  const readLength = () => {
    const length = der[offset++];
    if (length < 0x80) return length;
    const count = length & 0x7f;
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      value = (value << 8) | der[offset++];
    }
    return value;
  };

  readLength();
  assert.equal(der[offset++], 0x02, "expected DER INTEGER for r");
  const rLength = readLength();
  const r = der.subarray(offset, offset + rLength);
  offset += rLength;

  assert.equal(der[offset++], 0x02, "expected DER INTEGER for s");
  const sLength = readLength();
  const s = der.subarray(offset, offset + sLength);

  return Buffer.concat([pad(r, 32), pad(s, 32)]);
}

/**
 * Right-pad (or verify) a DER integer into a fixed-width raw field.
 *
 * DER encodes a leading 0x00 byte when the high bit is set, so a coordinate can
 * legitimately be 33 bytes. In that case strip the sign byte rather than
 * silently producing a short buffer.
 */
function pad(value: Buffer, length: number): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) start += 1;
  const magnitude = value.subarray(start);

  assert.ok(
    magnitude.length <= length,
    `coordinate is ${magnitude.length} bytes, expected <= ${length}`,
  );

  const out = Buffer.alloc(length);
  magnitude.copy(out, length - magnitude.length);
  return out;
}

const VALID_BODY = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "abc123",
  environment: "sandbox",
  request_id: "req-1",
});

test("accepts a correctly signed webhook", async () => {
  const result = await verifyPlaidWebhook(
    makeVerificationHeader(VALID_BODY),
    VALID_BODY,
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body.webhook_code, "SYNC_UPDATES_AVAILABLE");
    assert.equal(result.body.item_id, "abc123");
    assert.equal(result.requestId, "req-1");
  }
});

test("rejects a missing header", async () => {
  const result = await verifyPlaidWebhook(null, VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Missing Plaid-Verification/);
});

test("rejects a non-JWT header", async () => {
  const result = await verifyPlaidWebhook("not-a-jwt", VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not a valid JWT/);
});

test("rejects a bad signature", async () => {
  const header = makeVerificationHeader(VALID_BODY, {
    tamperSignature: true,
  });
  const result = await verifyPlaidWebhook(header, VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /did not verify/);
});

test("rejects a signature made with a different key", async () => {
  const header = makeVerificationHeader(VALID_BODY);
  const parts = header.split(".");

  // Keep the original signature but swap in an unrelated public JWK, so the
  // signature cannot verify under the advertised key.
  const decodedHeader = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  ) as { jwk: JsonWebKey };
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  decodedHeader.jwk = other.publicKey.export({ format: "jwk" }) as JsonWebKey;

  parts[0] = Buffer.from(JSON.stringify(decodedHeader)).toString("base64url");

  const result = await verifyPlaidWebhook(parts.join("."), VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /did not verify/);
});

test("rejects a token whose hash does not match the body", async () => {
  // The signature is valid but was issued for a different body: the classic
  // replay-over-tampered-payload attack.
  const header = makeVerificationHeader(VALID_BODY, { tamperHash: true });
  const result = await verifyPlaidWebhook(header, VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /does not match the signed hash/);
});

test("rejects a token issued for one body applied to another", async () => {
  const header = makeVerificationHeader(VALID_BODY);
  const tamperedBody = VALID_BODY.replace("SYNC_UPDATES_AVAILABLE", "ITEM");

  const result = await verifyPlaidWebhook(header, tamperedBody);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /does not match the signed hash/);
});

test("rejects an expired token", async () => {
  const header = makeVerificationHeader(VALID_BODY, {
    issuedAt: Math.floor(Date.now() / 1000) - 3600,
  });
  const result = await verifyPlaidWebhook(header, VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /expired/);
});

test("rejects a token dated in the future", async () => {
  const header = makeVerificationHeader(VALID_BODY, {
    issuedAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const result = await verifyPlaidWebhook(header, VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /future/);
});

test("rejects an unexpected algorithm", async () => {
  const header = makeVerificationHeader(VALID_BODY, { alg: "HS256" });
  const result = await verifyPlaidWebhook(header, VALID_BODY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /ES256/);
});

test("a valid token over invalid JSON is reported, not thrown", async () => {
  const body = "not json";
  const header = makeVerificationHeader(body);
  const result = await verifyPlaidWebhook(header, body);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not valid JSON/);
});