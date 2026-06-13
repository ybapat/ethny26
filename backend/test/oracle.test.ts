/**
 * oracle.test.ts — unit tests for the oracle/price-source module.
 * Run: `node --test test/oracle.test.ts` from backend/.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { EMPTY_BODY_SHA256, FEED_IDS } from "../src/config.ts";
import { bodyHashHex, stringToSign, signRequest } from "../src/oracle/hmac.ts";
import {
  decodeV3Report,
  encodeV3ReportForTest,
  type ReportV3,
} from "../src/oracle/reportV3.ts";
import { DataStreamsClient } from "../src/oracle/dataStreams.ts";
import { DataStreamsPriceSource } from "../src/oracle/priceSource.ts";
import { parseWsFrame } from "../src/oracle/wsPriceSource.ts";

/* ------------------------------- hmac ----------------------------------- */

test("bodyHashHex('') equals EMPTY_BODY_SHA256", () => {
  assert.equal(bodyHashHex(""), EMPTY_BODY_SHA256);
});

test("stringToSign exact format with a fixed example", () => {
  const path = "/api/v1/reports/latest?feedID=0x0003abc";
  const s = stringToSign("get", path, EMPTY_BODY_SHA256, "my-api-key", 1716211845000);
  assert.equal(
    s,
    `GET /api/v1/reports/latest?feedID=0x0003abc ${EMPTY_BODY_SHA256} my-api-key 1716211845000`,
  );
});

test("signRequest is deterministic and produces a 64-char hex signature", () => {
  const opts = {
    method: "GET",
    path: "/api/v1/reports/latest?feedID=0x0003abc",
    apiKey: "my-api-key",
    apiSecret: "my-secret",
    timestampMs: 1716211845000,
  };
  const a = signRequest(opts);
  const b = signRequest(opts);
  assert.equal(a["X-Authorization-Signature-SHA256"], b["X-Authorization-Signature-SHA256"]);
  assert.equal(a.Authorization, "my-api-key");
  assert.equal(a["X-Authorization-Timestamp"], "1716211845000");
  const sig = a["X-Authorization-Signature-SHA256"];
  assert.equal(sig.length, 64);
  assert.match(sig, /^[0-9a-f]{64}$/);
});

/* ------------------------------ reportV3 -------------------------------- */

test("decodeV3Report round-trips a realistic ETH/USD sample (18 dp)", () => {
  const sample: ReportV3 = {
    feedId: FEED_IDS.ETH_USD,
    validFromTimestamp: 1716211800,
    observationsTimestamp: 1716211845,
    expiresAt: 1716298245,
    price: 2484.121,
    bid: 2484.0,
    ask: 2484.25,
  };
  const encoded = encodeV3ReportForTest(sample, 18);
  const decoded = decodeV3Report(encoded, 18);

  assert.equal(decoded.feedId, sample.feedId);
  assert.equal(decoded.validFromTimestamp, sample.validFromTimestamp);
  assert.equal(decoded.observationsTimestamp, sample.observationsTimestamp);
  assert.equal(decoded.expiresAt, sample.expiresAt);
  // float precision: compare within a tight tolerance
  assert.ok(Math.abs(decoded.price - sample.price) < 1e-9, `price ${decoded.price}`);
  assert.ok(Math.abs(decoded.bid - sample.bid) < 1e-9, `bid ${decoded.bid}`);
  assert.ok(Math.abs(decoded.ask - sample.ask) < 1e-9, `ask ${decoded.ask}`);
});

test("decodeV3Report handles negative (two's-complement) price", () => {
  const sample: ReportV3 = {
    feedId: FEED_IDS.ETH_USD,
    validFromTimestamp: 100,
    observationsTimestamp: 200,
    expiresAt: 300,
    price: -1.5,
    bid: -2.0,
    ask: -1.0,
  };
  const decoded = decodeV3Report(encodeV3ReportForTest(sample, 18), 18);
  assert.ok(Math.abs(decoded.price - -1.5) < 1e-9, `price ${decoded.price}`);
  assert.ok(Math.abs(decoded.bid - -2.0) < 1e-9, `bid ${decoded.bid}`);
  assert.ok(Math.abs(decoded.ask - -1.0) < 1e-9, `ask ${decoded.ask}`);
});

/* ---------------------------- dataStreams ------------------------------- */

test("DataStreamsClient.buildLatestRequest builds URL + 3 auth headers", () => {
  const client = new DataStreamsClient({
    restBase: "https://api.testnet-dataengine.chain.link",
    apiKey: "key-uuid",
    apiSecret: "secret",
    now: () => 1716211845000,
  });
  const { url, headers } = client.buildLatestRequest(FEED_IDS.ETH_USD);

  assert.ok(url.includes("/api/v1/reports/latest"));
  assert.ok(url.includes(`feedID=${FEED_IDS.ETH_USD}`));
  assert.equal(headers["Authorization"], "key-uuid");
  assert.ok("X-Authorization-Timestamp" in headers);
  assert.ok("X-Authorization-Signature-SHA256" in headers);
  // signed path must include the query string -> signature differs by feedID
  const other = client.buildLatestRequest("0x0003deadbeef");
  assert.notEqual(
    headers["X-Authorization-Signature-SHA256"],
    other.headers["X-Authorization-Signature-SHA256"],
  );
});

/* --------------------- DataStreamsPriceSource (real) -------------------- */

test("DataStreamsPriceSource: unknown market rejects (no network)", async () => {
  const client = new DataStreamsClient({
    restBase: "https://api.testnet-dataengine.chain.link",
    apiKey: "k",
    apiSecret: "s",
  });
  const src = new DataStreamsPriceSource({
    client,
    marketToFeedId: { "ETH-USD": FEED_IDS.ETH_USD },
  });
  await assert.rejects(() => src.getPerpPrice("NOPE-USD"));
});

test("DataStreamsPriceSource: RWA NAV via V9 is not wired yet", async () => {
  const client = new DataStreamsClient({
    restBase: "https://api.testnet-dataengine.chain.link",
    apiKey: "k",
    apiSecret: "s",
  });
  const src = new DataStreamsPriceSource({ client, marketToFeedId: { "ETH-USD": FEED_IDS.ETH_USD } });
  await assert.rejects(() => src.getRwaNav("tMMF-USD"));
});

/* --------------------------- WS frame parsing -------------------------- */

test("parseWsFrame decodes a {report:{feedID,fullReport}} push", () => {
  // Build a real V3 fullReport for ETH/USD, wrap it like the WS frame, parse it back.
  const sample: ReportV3 = {
    feedId: FEED_IDS.ETH_USD,
    validFromTimestamp: 1716211800,
    observationsTimestamp: 1716211845,
    expiresAt: 1716298245,
    price: 2484.121,
    bid: 2484.0,
    ask: 2484.3,
  };
  const fullReport = encodeV3ReportForTest(sample, 18);
  const frame = JSON.stringify({ report: { feedID: FEED_IDS.ETH_USD, fullReport } });

  const out = parseWsFrame(frame, 18);
  assert.equal(out.feedId, FEED_IDS.ETH_USD.toLowerCase());
  assert.ok(Math.abs(out.price - 2484.121) < 1e-6);
  assert.equal(out.asOf, 1716211845);
  // The signed blob is preserved unmodified for the on-ledger Verify choice.
  assert.equal(out.signedReport, fullReport);
});

test("parseWsFrame rejects a frame without report.fullReport", () => {
  assert.throws(() => parseWsFrame(JSON.stringify({ heartbeat: true }), 18));
});
