/**
 * cantonLedger.test.ts — unit tests for the PURE helpers in the real Canton
 * JSON Ledger API v2 client. No network is touched.
 * Run: `node --test test/cantonLedger.test.ts` from backend/.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CantonLedger,
  decToString,
  parseDecimal,
  unixToIso,
  isoToUnix,
  sideToVariant,
  variantToSide,
  parseMatchedPair,
  parseCloseRequest,
  extractCreatedEvents,
  buildExerciseCommand,
} from "../src/ledger/cantonLedger.ts";

/* --------------------------- decToString / parseDecimal ------------------ */

test("decToString / parseDecimal round-trip", () => {
  const cases = [0, 1, -1, 123.456, -0.0001, 1000000, 0.0000000001, -987654.321];
  for (const n of cases) {
    const s = decToString(n);
    assert.equal(typeof s, "string");
    assert.ok(s.includes("."), `expected decimal point in "${s}"`);
    assert.ok(Math.abs(parseDecimal(s) - n) < 1e-9, `round-trip ${n} → ${s}`);
  }
});

test("decToString formats zero and negative-zero as 0.0", () => {
  assert.equal(decToString(0), "0.0");
  assert.equal(decToString(-0), "0.0");
});

test("decToString trims trailing zeros but keeps one fractional digit", () => {
  assert.equal(decToString(1.5, 10), "1.5");
  assert.equal(decToString(2, 10), "2.0");
});

test("decToString honors requested decimal places", () => {
  assert.equal(decToString(1.23456789, 2), "1.23");
});

test("parseDecimal accepts both string and number", () => {
  assert.equal(parseDecimal("3.14"), 3.14);
  assert.equal(parseDecimal(42), 42);
});

/* ------------------------------ time helpers ----------------------------- */

test("unixToIso / isoToUnix round-trip a known timestamp", () => {
  // 2026-06-13T12:00:00Z
  const unix = Date.UTC(2026, 5, 13, 12, 0, 0) / 1000;
  const iso = unixToIso(unix);
  assert.equal(iso, "2026-06-13T12:00:00Z");
  assert.equal(isoToUnix(iso), unix);
});

test("unixToIso strips sub-second precision", () => {
  assert.equal(unixToIso(1_700_000_000), "2023-11-14T22:13:20Z");
});

/* ------------------------------ side variant ----------------------------- */

test("sideToVariant produces the agreed bare-string form", () => {
  assert.equal(sideToVariant("Long"), "Long");
  assert.equal(sideToVariant("Short"), "Short");
});

test("variantToSide accepts a plain string", () => {
  assert.equal(variantToSide("Long"), "Long");
  assert.equal(variantToSide("Short"), "Short");
});

test("variantToSide accepts the {Long:{}} object form", () => {
  assert.equal(variantToSide({ Long: {} }), "Long");
  assert.equal(variantToSide({ Short: {} }), "Short");
});

test("variantToSide accepts the {tag:...} object form", () => {
  assert.equal(variantToSide({ tag: "Long", value: {} }), "Long");
});

test("variantToSide throws on garbage", () => {
  assert.throws(() => variantToSide({ Sideways: {} }));
});

/* ----------------------------- parseMatchedPair -------------------------- */

test("parseMatchedPair maps flat Daml createArgument to nested MatchedPair", () => {
  const createArgument = {
    venue: "Venue::1220abc",
    longTrader: "Alice::1220aaa",
    shortTrader: "Bob::1220bbb",
    regulator: "Reg::1220rrr",
    market: "ETH-USD",
    collateralInstrument: "tMMF-USD",
    size: "2.5",
    entryPrice: "3000.0",
    longCollateralQty: "750.0",
    shortCollateralQty: "800.0",
    accruedFundingLong: "-12.5",
    lastFundingTime: "2026-06-13T11:00:00Z",
    openedAt: "2026-06-13T10:00:00Z",
  };

  const mp = parseMatchedPair("00cidabc", createArgument);

  assert.equal(mp.contractId, "00cidabc");
  assert.equal(mp.market, "ETH-USD");
  assert.equal(mp.collateralInstrument, "tMMF-USD");
  assert.equal(mp.size, 2.5);
  assert.equal(mp.entryPrice, 3000);
  assert.deepEqual(mp.long, { trader: "Alice::1220aaa", collateralQty: 750 });
  assert.deepEqual(mp.short, { trader: "Bob::1220bbb", collateralQty: 800 });
  assert.equal(mp.accruedFundingLong, -12.5);
  assert.equal(mp.lastFundingTime, Date.UTC(2026, 5, 13, 11, 0, 0) / 1000);
  assert.equal(mp.openedAt, Date.UTC(2026, 5, 13, 10, 0, 0) / 1000);
  // numeric fields really are numbers, not strings
  assert.equal(typeof mp.size, "number");
  assert.equal(typeof mp.lastFundingTime, "number");
});

test("parseMatchedPair tolerates numeric decimals and unix-number times", () => {
  const mp = parseMatchedPair("cid2", {
    market: "BTC-USD",
    size: 1,
    entryPrice: 65000,
    longCollateralQty: 6500,
    shortCollateralQty: 6500,
    accruedFundingLong: 0,
    lastFundingTime: 1_700_000_000,
    openedAt: 1_699_000_000,
  });
  assert.equal(mp.size, 1);
  assert.equal(mp.lastFundingTime, 1_700_000_000);
});

/* ---------------------------- parseCloseRequest -------------------------- */

test("parseCloseRequest maps flat Daml createArgument to CloseRequest", () => {
  const cr = parseCloseRequest("00creqcid", {
    matchedPairCid: "00pairCid",
    closingSide: "Short",
    requestedAt: "2026-06-13T12:30:00Z",
  });
  assert.equal(cr.contractId, "00creqcid");
  assert.equal(cr.matchedPairContractId, "00pairCid");
  assert.equal(cr.closingSide, "Short");
  assert.equal(cr.requestedAt, Date.UTC(2026, 5, 13, 12, 30, 0) / 1000);
});

test("parseCloseRequest accepts the {Long:{}} variant + alias field", () => {
  const cr = parseCloseRequest("c", {
    matchedPairContractId: "p",
    closingSide: { Long: {} },
    requestedAt: 1_700_000_000,
  });
  assert.equal(cr.matchedPairContractId, "p");
  assert.equal(cr.closingSide, "Long");
  assert.equal(cr.requestedAt, 1_700_000_000);
});

/* --------------------------- extractCreatedEvents ------------------------ */

test("extractCreatedEvents handles { activeContracts:[ {contractEntry...} ] }", () => {
  const envelope = {
    activeContracts: [
      {
        contractEntry: {
          JsActiveContract: {
            createdEvent: {
              contractId: "00aaa",
              templateId: "perp-dex:M:MatchedPair",
              createArgument: { market: "ETH-USD" },
            },
          },
        },
      },
    ],
  };
  const events = extractCreatedEvents(envelope);
  assert.equal(events.length, 1);
  assert.equal(events[0].contractId, "00aaa");
  assert.equal(events[0].templateId, "perp-dex:M:MatchedPair");
  assert.deepEqual(events[0].createArgument, { market: "ETH-USD" });
});

test("extractCreatedEvents handles NDJSON-style array of { created:{...} }", () => {
  const arr = [
    {
      created: {
        contractId: "00bbb",
        templateId: "perp-dex:M:CloseRequest",
        createArguments: { closingSide: "Long" },
      },
    },
    {
      created: {
        contractId: "00ccc",
        templateId: "perp-dex:M:CloseRequest",
        createArguments: { closingSide: "Short" },
      },
    },
  ];
  const events = extractCreatedEvents(arr);
  assert.equal(events.length, 2);
  assert.equal(events[0].contractId, "00bbb");
  assert.deepEqual(events[1].createArgument, { closingSide: "Short" });
});

test("extractCreatedEvents handles a flat created event object", () => {
  const events = extractCreatedEvents({
    contractId: "00ddd",
    templateId: "perp-dex:M:MatchedPair",
    createArgument: { size: "1.0" },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].contractId, "00ddd");
});

test("extractCreatedEvents returns [] for empty / unknown shapes", () => {
  assert.deepEqual(extractCreatedEvents(null), []);
  assert.deepEqual(extractCreatedEvents({}), []);
  assert.deepEqual(extractCreatedEvents({ activeContracts: [] }), []);
});

/* --------------------------- buildExerciseCommand ------------------------ */

test("buildExerciseCommand produces the correct v2 body shape", () => {
  const body = buildExerciseCommand({
    templateId: "perp-dex:M:MatchedPair",
    contractId: "00cid",
    choice: "ApplyFunding",
    choiceArgument: { fundingRate: "0.0001" },
    userId: "venue",
    actAs: ["Venue::122"],
    readAs: ["Reg::122"],
    commandId: "funding-1",
  });

  assert.deepEqual(body, {
    commands: [
      {
        ExerciseCommand: {
          templateId: "perp-dex:M:MatchedPair",
          contractId: "00cid",
          choice: "ApplyFunding",
          choiceArgument: { fundingRate: "0.0001" },
        },
      },
    ],
    userId: "venue",
    commandId: "funding-1",
    actAs: ["Venue::122"],
    readAs: ["Reg::122"],
  });
});

test("buildExerciseCommand defaults readAs to []", () => {
  const body = buildExerciseCommand({
    templateId: "t",
    contractId: "c",
    choice: "Liquidate",
    choiceArgument: {},
    userId: "u",
    actAs: ["A"],
    commandId: "id",
  });
  assert.deepEqual(body.readAs, []);
});

/* ------------------------------ construction ----------------------------- */

test("CantonLedger constructs without throwing (no network)", () => {
  assert.doesNotThrow(() => {
    new CantonLedger({
      baseUrl: "http://localhost:7575/",
      userId: "venue",
      actAs: ["Venue::122"],
      templateIds: {
        matchedPair: "perp-dex:M:MatchedPair",
        closeRequest: "perp-dex:M:CloseRequest",
        oraclePrice: "perp-dex:M:MockOraclePrice",
      },
    });
  });
});

test("CantonLedger constructs with optional auth/choices/verifier", () => {
  assert.doesNotThrow(() => {
    new CantonLedger({
      baseUrl: "http://localhost:7575",
      authToken: "jwt-token",
      userId: "venue",
      actAs: ["Venue::122"],
      readAs: ["Reg::122"],
      templateIds: {
        matchedPair: "perp-dex:M:MatchedPair",
        closeRequest: "perp-dex:M:CloseRequest",
        oraclePrice: "perp-dex:M:MockOraclePrice",
        verifier: "chainlink:V:Verifier",
      },
      choices: { applyFunding: "ApplyFundingV2" },
      decimals: 8,
    });
  });
});
