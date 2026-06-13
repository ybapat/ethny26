/**
 * reportV3.ts — decode a Chainlink V3 (crypto) Data Streams report blob.
 *
 * The `fullReport` hex returned by the REST/WS API is:
 *   abi.encode(
 *     bytes32[3] reportContext,
 *     bytes      reportBlob,
 *     bytes32[]  rawRs,
 *     bytes32[]  rawSs,
 *     bytes32    rawVs
 *   )
 * The inner `reportBlob` itself ABI-decodes to the V3 tuple (CHAINLINK.md §4):
 *   (bytes32 feedId,
 *    uint32  validFromTimestamp,
 *    uint32  observationsTimestamp,
 *    uint192 nativeFee,
 *    uint192 linkFee,
 *    uint32  expiresAt,
 *    int192  price,
 *    int192  bid,
 *    int192  ask)
 *
 * price/bid/ask are scaled by 10^decimals (ETH/USD = 18, CHAINLINK.md §4).
 *
 * NB: We have no live sample to test against, so the decoder is proven by
 * round-trip against `encodeV3ReportForTest`. It MUST be re-checked against a
 * real signed report once Data Streams API access lands — the OCR
 * `reportContext`/signature framing around the inner blob is reconstructed from
 * the documented schema, not from a captured payload.
 */

export interface ReportV3 {
  feedId: string;
  validFromTimestamp: number;
  observationsTimestamp: number;
  expiresAt: number;
  price: number;
  bid: number;
  ask: number;
}

const WORD = 32;

/* --------------------------- low-level helpers --------------------------- */

function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = "0" + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return "0x" + s;
}

/** Read a 32-byte word at word index `w` as an unsigned bigint. */
function readWordUint(buf: Uint8Array, byteOffset: number): bigint {
  let v = 0n;
  for (let i = 0; i < WORD; i++) {
    v = (v << 8n) | BigInt(buf[byteOffset + i]);
  }
  return v;
}

/** Encode an unsigned bigint into a 32-byte big-endian word. */
function writeWordUint(value: bigint): Uint8Array {
  const out = new Uint8Array(WORD);
  let v = value;
  for (let i = WORD - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Interpret an N-bit unsigned bigint stored in a word as a signed (two's-complement) value. */
function toSigned(value: bigint, bits: number): bigint {
  const max = 1n << BigInt(bits - 1);
  if (value >= max) {
    return value - (1n << BigInt(bits));
  }
  return value;
}

/** Convert a signed int192-scale value to a float by dividing by 10^decimals. */
function scaledToFloat(value: bigint, decimals: number): number {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  // Build a decimal string to keep precision, then parse to float.
  const fracStr = frac.toString().padStart(decimals, "0");
  const num = Number(`${whole.toString()}.${fracStr}`);
  return negative ? -num : num;
}

/* ------------------------------- decoder -------------------------------- */

/**
 * Decode a V3 `fullReport` hex blob into a ReportV3. `decimals` defaults to 18
 * (ETH/USD per CHAINLINK.md §4).
 *
 * Validated by round-trip with `encodeV3ReportForTest`; re-verify against a
 * live report once API access lands.
 */
export function decodeV3Report(fullReportHex: string, decimals: number = 18): ReportV3 {
  const buf = hexToBytes(fullReportHex);

  // Outer tuple head (5 fields):
  //   word 0: offset to reportContext (bytes32[3], static — but encoded by ref
  //           because it's part of a dynamic tuple) -> actually fixed-size array
  //           of static elements is itself static, so it is inlined.
  // The outer structure is:
  //   bytes32[3] reportContext  (static, 3 words, inlined)
  //   bytes      reportBlob      (dynamic -> head holds offset)
  //   bytes32[]  rawRs           (dynamic -> head holds offset)
  //   bytes32[]  rawSs           (dynamic -> head holds offset)
  //   bytes32    rawVs           (static, 1 word, inlined)
  //
  // Head layout (word indices):
  //   0,1,2 : reportContext[0..2]
  //   3     : offset to reportBlob (relative to start of buf)
  //   4     : offset to rawRs
  //   5     : offset to rawSs
  //   6     : rawVs
  const reportBlobOffset = Number(readWordUint(buf, 3 * WORD));

  // reportBlob is `bytes`: first word at offset = length, then the data.
  const blobLen = Number(readWordUint(buf, reportBlobOffset));
  const blobStart = reportBlobOffset + WORD;
  const blob = buf.subarray(blobStart, blobStart + blobLen);

  // The inner blob is the ABI-encoding of the V3 tuple. All fields are static,
  // so they sit one per 32-byte word in order.
  const feedIdWord = blob.subarray(0 * WORD, 1 * WORD);
  const validFromTimestamp = Number(readWordUint(blob, 1 * WORD));
  const observationsTimestamp = Number(readWordUint(blob, 2 * WORD));
  // word 3 = nativeFee (uint192), word 4 = linkFee (uint192) — inert, skipped.
  const expiresAt = Number(readWordUint(blob, 5 * WORD));
  // int192 is ABI-encoded sign-extended across the full 256-bit word, so we
  // interpret the whole word as a signed 256-bit value.
  const priceRaw = toSigned(readWordUint(blob, 6 * WORD), 256);
  const bidRaw = toSigned(readWordUint(blob, 7 * WORD), 256);
  const askRaw = toSigned(readWordUint(blob, 8 * WORD), 256);

  return {
    feedId: bytesToHex(feedIdWord),
    validFromTimestamp,
    observationsTimestamp,
    expiresAt,
    price: scaledToFloat(priceRaw, decimals),
    bid: scaledToFloat(bidRaw, decimals),
    ask: scaledToFloat(askRaw, decimals),
  };
}

/* ------------------------------- encoder -------------------------------- */

/** Convert a float price to a scaled int192 bigint (rounded). */
function floatToScaled(value: number, decimals: number): bigint {
  const negative = value < 0;
  const abs = Math.abs(value);
  const s = abs.toFixed(decimals); // e.g. "2484.121000000000000000"
  const [whole, frac = ""] = s.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  const combined = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  return negative ? -combined : combined;
}

/** Encode a signed bigint into a two's-complement 32-byte word. */
function writeWordInt(value: bigint): Uint8Array {
  const masked = value < 0n ? value + (1n << 256n) : value;
  return writeWordUint(masked);
}

function feedIdToWord(feedId: string): Uint8Array {
  const bytes = hexToBytes(feedId);
  const out = new Uint8Array(WORD);
  // Right-pad-left? feedId is bytes32 -> left-aligned (high bytes), so copy at start.
  out.set(bytes.subarray(0, WORD), 0);
  return out;
}

/**
 * ABI-encode the same `fullReport` structure that `decodeV3Report` reads, so the
 * decoder can be proven by round-trip. nativeFee/linkFee/signatures are filled
 * with deterministic placeholder values (they are inert on Canton).
 */
export function encodeV3ReportForTest(r: ReportV3, decimals: number = 18): string {
  // ---- inner reportBlob: V3 tuple, all static, 9 words ----
  const blobWords: Uint8Array[] = [
    feedIdToWord(r.feedId),
    writeWordUint(BigInt(r.validFromTimestamp)),
    writeWordUint(BigInt(r.observationsTimestamp)),
    writeWordUint(0n), // nativeFee (inert)
    writeWordUint(0n), // linkFee (inert)
    writeWordUint(BigInt(r.expiresAt)),
    writeWordInt(floatToScaled(r.price, decimals)),
    writeWordInt(floatToScaled(r.bid, decimals)),
    writeWordInt(floatToScaled(r.ask, decimals)),
  ];
  const blob = concat(blobWords);

  // ---- outer tuple ----
  // head: 3 (reportContext) + 1 (blob offset) + 1 (rawRs offset) + 1 (rawSs offset) + 1 (rawVs)
  const headWords = 7;
  const headBytes = headWords * WORD;

  // dynamic tail: reportBlob, then rawRs (empty array), then rawSs (empty array)
  // reportBlob bytes encoding: length word + padded data
  const blobPaddedLen = Math.ceil(blob.length / WORD) * WORD;
  const blobEncoded = new Uint8Array(WORD + blobPaddedLen);
  blobEncoded.set(writeWordUint(BigInt(blob.length)), 0);
  blobEncoded.set(blob, WORD);

  // rawRs: empty bytes32[] -> just a length word of 0
  const rawRsEncoded = writeWordUint(0n);
  const rawSsEncoded = writeWordUint(0n);

  const reportBlobOffset = headBytes;
  const rawRsOffset = reportBlobOffset + blobEncoded.length;
  const rawSsOffset = rawRsOffset + rawRsEncoded.length;

  const head: Uint8Array[] = [
    writeWordUint(0n), // reportContext[0]
    writeWordUint(0n), // reportContext[1]
    writeWordUint(0n), // reportContext[2]
    writeWordUint(BigInt(reportBlobOffset)),
    writeWordUint(BigInt(rawRsOffset)),
    writeWordUint(BigInt(rawSsOffset)),
    writeWordUint(0n), // rawVs
  ];

  const full = concat([
    ...head,
    blobEncoded,
    rawRsEncoded,
    rawSsEncoded,
  ]);
  return bytesToHex(full);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
