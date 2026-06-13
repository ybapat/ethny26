/**
 * hmac.ts — Chainlink Data Streams HMAC authentication (CHAINLINK.md §2).
 *
 * Every REST + WS request to the Data Streams engine carries three headers:
 *   Authorization                    = API key (UUID)
 *   X-Authorization-Timestamp        = current time in MILLISECONDS
 *   X-Authorization-Signature-SHA256 = hex HMAC-SHA256 of the string-to-sign
 *
 * String-to-sign (single spaces, no newlines):
 *   METHOD PATH BODY_HASH API_KEY TIMESTAMP
 *
 * Signature is HEX, not base64.
 */
import { createHash, createHmac } from "node:crypto";

/**
 * Hex SHA-256 of the request body. For an empty body (all GET/WS requests)
 * this equals EMPTY_BODY_SHA256 from config.ts.
 */
export function bodyHashHex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * The exact string-to-sign: `METHOD PATH BODY_HASH API_KEY TIMESTAMP`.
 * - METHOD is uppercased.
 * - PATH must include the query string.
 * - Single spaces, no trailing newline.
 */
export function stringToSign(
  method: string,
  path: string,
  bodyHashHexValue: string,
  apiKey: string,
  timestampMs: number,
): string {
  return `${method.toUpperCase()} ${path} ${bodyHashHexValue} ${apiKey} ${timestampMs}`;
}

/**
 * Compute the three auth headers for a request. The HMAC-SHA256 is keyed with
 * the API secret and emitted as hex.
 */
export function signRequest(opts: {
  method: string;
  path: string;
  body?: string;
  apiKey: string;
  apiSecret: string;
  timestampMs: number;
}): {
  Authorization: string;
  "X-Authorization-Timestamp": string;
  "X-Authorization-Signature-SHA256": string;
} {
  const bodyHash = bodyHashHex(opts.body ?? "");
  const toSign = stringToSign(
    opts.method,
    opts.path,
    bodyHash,
    opts.apiKey,
    opts.timestampMs,
  );
  const signature = createHmac("sha256", opts.apiSecret)
    .update(toSign, "utf8")
    .digest("hex");
  return {
    Authorization: opts.apiKey,
    "X-Authorization-Timestamp": String(opts.timestampMs),
    "X-Authorization-Signature-SHA256": signature,
  };
}
